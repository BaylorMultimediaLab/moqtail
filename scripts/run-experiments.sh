#!/usr/bin/env bash
# Convenience wrapper for the paper experiment suite.
#
# Usage:
#   ./scripts/run-experiments.sh                 # all experiments, serial
#   ./scripts/run-experiments.sh e1 e2           # selected experiments, serial
#   ./scripts/run-experiments.sh e4 e3 -n 4      # selected, 4 xdist workers
#   ./scripts/run-experiments.sh -n auto e4      # let xdist size to CPU count
#
# Flags:
#   -n N | --workers N    pytest-xdist worker count. `auto` picks ncpus.
#                         Each worker gets its own mininet topology with
#                         worker_idx-suffixed names (pub_w0, rly_w0, …) and
#                         a per-worker mgmt subnet 169.254.<idx>.0/24, so
#                         parallel workers don't collide in the root netns.
#                         Replay mode (--encoded-dir) is what makes this
#                         actually faster; live HEVC encode would saturate
#                         the VAAPI encode block before CPU.
#
# Each experiment runs through pytest under sudo (Mininet requires root),
# then aggregates per-cell summaries. Per-run artifacts land at:
#   tests/experiments/results/<test_id>/<timestamp>/
# Aggregates land at:
#   tests/experiments/results/<exp>/aggregate.csv + aggregate_summary.csv

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Parse args: split flags from positional experiment names. The flag may
# appear before, after, or interleaved with experiment names.
WORKERS=""
POSITIONAL=()
while (( $# > 0 )); do
  case "$1" in
    -n|--workers)
      [[ $# -lt 2 ]] && { echo "[run-experiments] -n/--workers requires a value" >&2; exit 2; }
      WORKERS="$2"; shift 2 ;;
    -n=*|--workers=*)
      WORKERS="${1#*=}"; shift ;;
    --)
      shift; POSITIONAL+=("$@"); break ;;
    *)
      POSITIONAL+=("$1"); shift ;;
  esac
done

if [[ ${#POSITIONAL[@]} -eq 0 ]]; then
  EXPERIMENTS=(e1 e2 e3 e4)
else
  EXPERIMENTS=("${POSITIONAL[@]}")
fi

# Estimated wall time per experiment (matches design doc § 8). Used only
# for the upfront ETA; the actual runtime depends on the host. Numbers
# assume serial + live-encode mode; replay + xdist parallelism cuts these
# substantially (~10x per-test load drop, plus N-way concurrency).
declare -A WALL=(
  [e1]=27 [e2]=27 [e3]=175 [e4]=175
)
total=0
for e in "${EXPERIMENTS[@]}"; do
  total=$((total + ${WALL[$e]:-0}))
done
echo "[run-experiments] Will run: ${EXPERIMENTS[*]}"
if [[ -n "$WORKERS" ]]; then
  echo "[run-experiments] Parallel: pytest-xdist -n ${WORKERS}"
fi
echo "[run-experiments] Estimated wall time (serial, live-encode): ${total} minutes"
echo ""

# Step 1: Tears of Steel asset must exist.
ASSET="$ROOT_DIR/data/video/tears_of_steel_60s_720p.mp4"
if [[ ! -f "$ASSET" ]]; then
  echo "[run-experiments] Asset missing — running prepare_tears_of_steel.sh first."
  "$ROOT_DIR/scripts/prepare_tears_of_steel.sh"
fi

# Step 2: Ensure Rust binaries are present AND fresh. The freshness check
# (find -newer) catches the "I edited subscription.rs but forgot to rebuild
# release" footgun — without it, the script silently runs the OLD binary
# against the NEW test expectations. We still skip the build when nothing
# changed so the "build as user, run as root with old cargo" workflow keeps
# working. Set MOQTAIL_FORCE_BUILD=1 to force rebuild.
NEED_BUILD=0
for bin in relay publisher; do
  bin_path="$ROOT_DIR/target/release/$bin"
  if [[ ! -x "$bin_path" ]]; then
    NEED_BUILD=1
    break
  fi
  # Any Rust source newer than the binary? -quit stops at the first hit.
  newer=$(find "$ROOT_DIR/apps/$bin" "$ROOT_DIR/libs/moqtail-rs" \
    \( -name '*.rs' -o -name 'Cargo.toml' \) -newer "$bin_path" -print -quit 2>/dev/null)
  if [[ -n "$newer" ]]; then
    echo "[run-experiments] $bin is stale (newer source: $newer) — rebuilding."
    NEED_BUILD=1
    break
  fi
done

if [[ "${MOQTAIL_FORCE_BUILD:-0}" == "1" || "$NEED_BUILD" == "1" ]]; then
  echo "[run-experiments] Building Rust workspace (release, --features publisher/vaapi)..."
  if ! cargo build --release --workspace --features publisher/vaapi 2>&1 | tail -10; then
    echo ""
    echo "[run-experiments] Build failed."
    echo "[run-experiments] If you're running as root and cargo is too old for"
    echo "[run-experiments] edition2024, build as your normal user first:"
    echo "[run-experiments]   exit  # back to non-root shell"
    echo "[run-experiments]   cargo build --release --workspace --features publisher/vaapi"
    echo "[run-experiments]   sudo -i  # or su"
    echo "[run-experiments]   ./scripts/run-experiments.sh"
    exit 1
  fi
else
  echo "[run-experiments] Reusing existing target/release/{relay,publisher} (set MOQTAIL_FORCE_BUILD=1 to rebuild)."
fi
echo ""

# If we're already root, drop the sudo prefix (cleaner output, no password prompt).
if [[ "$(id -u)" == "0" ]]; then
  PYTEST_PREFIX=()
else
  PYTEST_PREFIX=(sudo -E)
fi

# Step 2.5: Pre-warm the encoded-GOP cache for the experiment ladder. The
# publisher_proc fixture lazily runs `prepare` on the first test that needs
# a given (video, ladder) cache; with -n >= 2 multiple xdist workers would
# race that prepare on a cold cache. Doing it here, once, on the host
# eliminates that race and gets the GPU encode cost out of the test run.
LADDER="720p:400,800,1200,2500,5000"
VIDEO_STEM="tears_of_steel_60s_720p"
LADDER_SLUG="${LADDER//:/_}"; LADDER_SLUG="${LADDER_SLUG//,/-}"
CACHE_DIR="$ROOT_DIR/data/encoded/${VIDEO_STEM}__${LADDER_SLUG}"
if [[ ! -f "$CACHE_DIR/meta.json" ]]; then
  echo "[run-experiments] Pre-warming encoded cache at $CACHE_DIR (one-time, ~10s on VAAPI)..."
  mkdir -p "$CACHE_DIR"
  "$ROOT_DIR/target/release/publisher" \
    --video-path "$ASSET" \
    --encoded-dir "$CACHE_DIR" \
    --ladder-spec "$LADDER" \
    2>&1 | tail -5
  if [[ ! -f "$CACHE_DIR/meta.json" ]]; then
    echo "[run-experiments] Cache warm-up failed (no meta.json at $CACHE_DIR)." >&2
    exit 1
  fi
fi
echo ""

# xdist flag for pytest if -n was passed.
XDIST_ARGS=()
if [[ -n "$WORKERS" ]]; then
  XDIST_ARGS=(-n "$WORKERS")
fi

# Step 3 + 4: For each experiment, run pytest then aggregate.
for e in "${EXPERIMENTS[@]}"; do
  echo "[run-experiments] === Running ${e} ==="
  # The tests/experiments/test_<exp>_*.py glob matches a single file per experiment.
  # `--` separates uv's own flags from the pytest command line. Without it, uv
  # eats `-n 4` as its `--no-sync` short option and pytest never sees it (xdist
  # silently runs serially despite the plugin being loaded).
  if ! "${PYTEST_PREFIX[@]}" uv --project tests/experiments run -- pytest "tests/experiments/test_${e}_"*.py "${XDIST_ARGS[@]}" -v; then
    echo "[run-experiments] Some ${e} cells failed — continuing to aggregate so partial data is preserved."
  fi

  # Aggregate. The aggregator runs with the same privileges as pytest so it
  # can write into the (potentially root-owned) results directory. Reads run
  # dirs; never destructive.
  if ! "${PYTEST_PREFIX[@]}" bash -c "cd tests/experiments && uv run python aggregate.py \"${e}\""; then
    echo "[run-experiments] Aggregation for ${e} failed (likely no results yet)."
  fi
  echo ""
done

# Restore ownership so the user can read/edit/git-add the results without sudo.
if [[ "$(id -u)" != "0" ]]; then
  sudo chown -R "$(id -u):$(id -g)" "$ROOT_DIR/tests/experiments/results" 2>/dev/null || true
fi

echo "[run-experiments] Done. Aggregates under tests/experiments/results/<exp>/aggregate*.csv"
