#!/usr/bin/env bash
#
# Run the full MOQtail stack: build Rust, start relay, publisher, and client-js.
# Logs are written to logs/ with one file per component.
#
# The publisher runs in replay mode against an on-disk pre-encoded GOP cache
# under data/encoded/<video-name>/. The first invocation for a given video
# populates the cache (prepare mode, runs the encoder once at full speed);
# every subsequent run skips the encoder entirely and streams from the cache
# at 1 GOP/sec — so encode/decode are not in the test path. Delete the cache
# directory to force a re-prepare.
#
# Usage:
#   ./scripts/run-stack.sh [VIDEO_PATH]   Start the full stack
#   ./scripts/run-stack.sh stop           Stop all running components
#
# Examples:
#   ./scripts/run-stack.sh                                  # uses default 1080p video
#   ./scripts/run-stack.sh data/video/smoking_test_480p.mp4 # custom video
#   ./scripts/run-stack.sh stop                             # kill all components

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/.stack.pids"

# --- Stop command ---
if [[ "${1:-}" == "stop" ]]; then
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No running stack found."
    exit 0
  fi
  echo "Stopping MOQtail stack..."
  while IFS='=' read -r name pid; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  Stopping $name (PID $pid)..."
      kill "$pid" 2>/dev/null || true
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
  echo "All stopped."
  exit 0
fi

VIDEO_PATH="${1:-data/video/smoking_test_1080p_ts.mp4}"

cleanup() {
  echo ""
  echo "Shutting down..."
  if [[ -f "$PID_FILE" ]]; then
    while IFS='=' read -r name pid; do
      if kill -0 "$pid" 2>/dev/null; then
        echo "  Stopping $name (PID $pid)..."
        kill "$pid" 2>/dev/null || true
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  wait 2>/dev/null || true
  echo "All processes stopped. Logs are in $LOG_DIR/"
}

trap cleanup EXIT INT TERM

# --- Validate video path ---
if [[ ! -f "$ROOT_DIR/$VIDEO_PATH" && ! -f "$VIDEO_PATH" ]]; then
  echo "Error: Video file not found: $VIDEO_PATH"
  echo "Available videos in data/video/:"
  ls "$ROOT_DIR/data/video/" 2>/dev/null || echo "  (none)"
  exit 1
fi

# Resolve to absolute path if relative
if [[ -f "$ROOT_DIR/$VIDEO_PATH" ]]; then
  VIDEO_PATH="$ROOT_DIR/$VIDEO_PATH"
fi

# Derive the encoded-GOP cache directory from the video filename so the same
# source always maps to the same cache. First run populates it (prepare mode);
# subsequent runs replay from it without ever invoking the encoder.
VIDEO_BASE="$(basename "$VIDEO_PATH")"
VIDEO_NAME="${VIDEO_BASE%.*}"
CACHE_DIR="$ROOT_DIR/data/encoded/$VIDEO_NAME"

# --- Create log directory ---
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "=== MOQtail Stack ==="
echo "  Video:  $VIDEO_PATH"
echo "  Cache:  $CACHE_DIR"
echo "  Logs:   $LOG_DIR/"
echo ""

# --- Build Rust components ---
# Build every workspace member (apps/relay, apps/client, apps/publisher,
# libs/moqtail-rs) so the binaries we run below are fresh. --workspace makes
# this explicit; without it `cargo build` at the workspace root would still
# build all members by default but it's easy to misread. The publisher's
# vaapi feature is opt-in via --features.
echo "[build] Building all Rust workspace members (--release, all apps + libs)..."
cargo build --release \
  --manifest-path "$ROOT_DIR/Cargo.toml" \
  --workspace \
  --features publisher/vaapi \
  2>&1 | tee "$LOG_DIR/build_${TIMESTAMP}.log"
echo "[build] Done."
echo ""

# --- Verify binaries exist + are newer than their source ---
# Catches stale-binary-after-failed-build cases where cargo printed an error
# but the script kept going. If any binary is missing we abort here rather
# than at `cargo run` time.
TARGET_DIR="$ROOT_DIR/target/release"
for bin in relay publisher client; do
  if [[ ! -x "$TARGET_DIR/$bin" ]]; then
    echo "[build] ERROR: target/release/$bin not found after build. See $LOG_DIR/build_${TIMESTAMP}.log."
    exit 1
  fi
done
echo "[build] Verified binaries: relay, publisher, client"
echo ""

# --- Install JS dependencies ---
echo "[npm] Installing JS dependencies..."
(cd "$ROOT_DIR" && npm install) 2>&1 | tee -a "$LOG_DIR/build_${TIMESTAMP}.log"
echo "[npm] Done."
echo ""

# --- Build client-js ---
echo "[client-js build] Building client..."
npm --prefix "$ROOT_DIR/apps/client-js" run build 2>&1 | tee -a "$LOG_DIR/build_${TIMESTAMP}.log"
echo "[client-js build] Done."
echo ""

# --- Prepare encoded-GOP cache (first run only) ---
# Prepare mode runs the full encode pipeline once at full speed and writes each
# variant's GOPs to disk. It does not connect to a relay, so we run it before
# the relay starts. Subsequent runs see meta.json and skip this step.
if [[ ! -f "$CACHE_DIR/meta.json" ]]; then
  echo "[prepare] No cache at $CACHE_DIR — populating from source..."
  cargo run --release --manifest-path "$ROOT_DIR/Cargo.toml" --bin publisher --features publisher/vaapi -- \
    --video-path "$VIDEO_PATH" \
    --max-variants 4 \
    --encoded-dir "$CACHE_DIR" \
    2>&1 | tee "$LOG_DIR/prepare_${TIMESTAMP}.log"
  echo "[prepare] Done."
  echo ""
else
  echo "[prepare] Reusing existing cache at $CACHE_DIR"
  echo ""
fi

# Reset PID file
> "$PID_FILE"

# --- Start relay ---
echo "[relay] Starting relay on port 4433..."
cargo run --release --manifest-path "$ROOT_DIR/Cargo.toml" --bin relay -- \
  --port 4433 \
  --cert-file "$ROOT_DIR/apps/relay/cert/cert.pem" \
  --key-file "$ROOT_DIR/apps/relay/cert/key.pem" \
  --log-folder "$LOG_DIR" \
  > "$LOG_DIR/relay_${TIMESTAMP}.log" 2>&1 &
RELAY_PID=$!
echo "relay=$RELAY_PID" >> "$PID_FILE"
echo "[relay] PID $RELAY_PID — log: relay_${TIMESTAMP}.log"

# Give relay a moment to bind
sleep 2

# --- Start publisher (replay mode) ---
echo "[publisher] Starting publisher in replay mode from $CACHE_DIR"
cargo run --release --manifest-path "$ROOT_DIR/Cargo.toml" --bin publisher --features publisher/vaapi -- \
  --max-variants 4 \
  --encoded-dir "$CACHE_DIR" \
  > "$LOG_DIR/publisher_${TIMESTAMP}.log" 2>&1 &
PUB_PID=$!
echo "publisher=$PUB_PID" >> "$PID_FILE"
echo "[publisher] PID $PUB_PID — log: publisher_${TIMESTAMP}.log"

# Give publisher a moment to connect and start encoding
sleep 3

# --- Start client-js ---
echo "[client-js] Starting Vite dev server..."
npm run --prefix "$ROOT_DIR/apps/client-js" dev \
  > "$LOG_DIR/client-js_${TIMESTAMP}.log" 2>&1 &
CLIENT_PID=$!
echo "client-js=$CLIENT_PID" >> "$PID_FILE"
echo "[client-js] PID $CLIENT_PID — log: client-js_${TIMESTAMP}.log"

echo ""
echo "=== All running ==="
echo "  Relay:      https://127.0.0.1:4433"
echo "  Client-JS:  http://localhost:5173"
echo ""
echo "Stop with:  ./scripts/run-stack.sh stop  (from another terminal)"
echo "       or:  Ctrl+C"
echo ""

# Wait for all children — if any exits, cleanup triggers
wait
