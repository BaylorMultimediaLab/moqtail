#!/usr/bin/env bash
# Idempotent prep: cut first 60s of Tears of Steel, scale to 1280x720, encode
# with low-latency-friendly params (no B-frames, fixed GOP, no scenecut). Used
# as the source video for the paper experiment harness in tests/experiments/.
#
# Source priority:
#   1. data/video/Tears of Steel - Blender VFX Open Movie.mp4 (user-provided)
#   2. data/video/.cache/tos_1080p.mov (downloaded from download.blender.org)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT_DIR/data/video/tears_of_steel_60s_720p.mp4"
LOCAL_SOURCE="$ROOT_DIR/data/video/Tears of Steel - Blender VFX Open Movie.mp4"
CACHE_DIR="$ROOT_DIR/data/video/.cache"
CACHED="$CACHE_DIR/tos_1080p.mov"
URL="https://download.blender.org/demo/movies/ToS/tears_of_steel_1080p.mov"

if [[ -f "$DEST" ]]; then
  echo "[tos-prep] $DEST already exists. Nothing to do."
  exit 0
fi

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

echo "[tos-prep] Encoding 60s 720p target via ffmpeg..."
"${FFMPEG:-ffmpeg}" -y -ss 0 -t 60 -i "$SOURCE" \
  -vf scale=1280:720 \
  -c:v libx264 -preset slow -crf 18 \
  -keyint_min "$GOP" -g "$GOP" -sc_threshold 0 -bf 0 \
  -an \
  "$DEST"

SHA="$(sha256sum "$DEST" | awk '{print $1}')"
echo "[tos-prep] Wrote $DEST"
echo "[tos-prep] sha256: $SHA"
