#!/usr/bin/env bash
# Idempotent prep for the paper experiment harness (tests/experiments/):
#   1. Cut the first CLIP_SECONDS of Tears of Steel, scale to 1920x1080, encode
#      with low-latency-friendly params (no B-frames, fixed GOP, no scenecut) ->
#      data/video/tears_of_steel_120s_1080p.mp4
#   2. Pre-encode the multi-resolution GOP cache the harness replays (no GPU at
#      run time) -> data/encoded/tears_of_steel_120s_1080p/
#
# The clip runs 120s (2x the 60s collection window) so a client that joins at
# the live edge ~mid-startup still has a full window of runway before the
# publisher reaches end-of-stream — no loop seam inside a measurement.
#
# Source priority for step 1:
#   1. data/video/Tears of Steel - Blender VFX Open Movie.mp4 (user-provided)
#   2. data/video/.cache/tos_1080p.mov (downloaded from download.blender.org)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIP_SECONDS="${CLIP_SECONDS:-120}"
CLIP_TAG="${CLIP_SECONDS}s_1080p"
DEST="$ROOT_DIR/data/video/tears_of_steel_${CLIP_TAG}.mp4"
LOCAL_SOURCE="$ROOT_DIR/data/video/Tears of Steel - Blender VFX Open Movie.mp4"
CACHE_DIR="$ROOT_DIR/data/video/.cache"
CACHED="$CACHE_DIR/tos_1080p.mov"
URL="https://download.blender.org/demo/movies/ToS/tears_of_steel_1080p.mov"

# Pre-encoded GOP cache (multi-resolution ladder) consumed by publisher_proc via
# --encoded-dir. Ladder must match tests/experiments/conftest.py's default.
GOP_CACHE_DIR="$ROOT_DIR/data/encoded/tears_of_steel_${CLIP_TAG}"
PUB_BIN="$ROOT_DIR/target/release/publisher"
LADDER="240p@150,360p@200,480p@500,720p@1200,1080p@4000"

# --- Step 1: 1080p source clip -------------------------------------------------
if [[ -f "$DEST" ]]; then
  echo "[tos-prep] $DEST already exists; skipping source encode."
else
  mkdir -p "$(dirname "$DEST")"

  if [[ -f "$LOCAL_SOURCE" ]]; then
    SOURCE="$LOCAL_SOURCE"
    echo "[tos-prep] Using local source: $SOURCE"
  else
    mkdir -p "$CACHE_DIR"
    if [[ ! -f "$CACHED" ]]; then
      echo "[tos-prep] No local source. Downloading 1080p mezzanine (~700 MB)..."
      curl -L --fail --output "$CACHED" "$URL"
    fi
    SOURCE="$CACHED"
  fi

  # Pick GOP from input framerate so GOP duration is exactly 1.0s. Falls back to
  # 25 if probe fails (matches earlier behavior).
  FPS_RAW="$("${FFPROBE:-ffprobe}" -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "$SOURCE" 2>/dev/null || echo 25/1)"
  FPS_NUM="${FPS_RAW%/*}"
  FPS_DEN="${FPS_RAW#*/}"
  if [[ -z "$FPS_NUM" || -z "$FPS_DEN" || "$FPS_DEN" -eq 0 ]]; then
    GOP=25
  else
    GOP=$(( FPS_NUM / FPS_DEN ))
    [[ "$GOP" -lt 1 ]] && GOP=25
  fi
  echo "[tos-prep] Source framerate ${FPS_RAW} -> GOP=${GOP} (~1s)"

  echo "[tos-prep] Encoding ${CLIP_SECONDS}s 1080p target via ffmpeg..."
  "${FFMPEG:-ffmpeg}" -y -ss 0 -t "$CLIP_SECONDS" -i "$SOURCE" \
    -vf scale=1920:1080 \
    -c:v libx264 -preset slow -crf 18 \
    -keyint_min "$GOP" -g "$GOP" -sc_threshold 0 -bf 0 \
    -an \
    "$DEST"

  SHA="$(sha256sum "$DEST" | awk '{print $1}')"
  echo "[tos-prep] Wrote $DEST"
  echo "[tos-prep] sha256: $SHA"
fi

# --- Step 2: multi-resolution GOP cache (replayed by the harness, no GPU) ------
# Prepare mode encodes the ladder once to disk and exits (no MoQ connection);
# the harness then replays it via --encoded-dir. Skipped when the cache is
# already finalized or when the publisher binary isn't built yet.
if [[ -f "$GOP_CACHE_DIR/meta.json" ]]; then
  echo "[tos-prep] GOP cache already present at $GOP_CACHE_DIR."
elif [[ -x "$PUB_BIN" ]]; then
  echo "[tos-prep] Pre-encoding multi-res GOP cache via publisher prepare mode..."
  "$PUB_BIN" \
    --video-path "$DEST" \
    --encoded-dir "$GOP_CACHE_DIR" \
    --ladder-spec "$LADDER"
  echo "[tos-prep] Wrote GOP cache to $GOP_CACHE_DIR"
else
  echo "[tos-prep] Publisher binary not found at $PUB_BIN — skipping GOP cache."
  echo "[tos-prep] Build it, then re-run this script to populate the cache:"
  echo "[tos-prep]   cargo build --release --workspace --features publisher/vaapi"
fi
