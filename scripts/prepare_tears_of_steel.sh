#!/usr/bin/env bash
# Idempotent prep: download Blender's official 1080p H.264, cut to 60s, scale to 720p, encode with low-latency-friendly params.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT_DIR/data/video/tears_of_steel_60s_720p.mp4"
CACHE_DIR="$ROOT_DIR/data/video/.cache"
CACHED="$CACHE_DIR/tos_1080p.mov"
URL="https://download.blender.org/demo/movies/ToS/tears_of_steel_1080p.mov"

if [[ -f "$DEST" ]]; then
  echo "[tos-prep] $DEST already exists. Nothing to do."
  exit 0
fi

mkdir -p "$CACHE_DIR" "$(dirname "$DEST")"

if [[ ! -f "$CACHED" ]]; then
  echo "[tos-prep] Downloading Tears of Steel 1080p source (~700 MB)..."
  curl -L --fail --output "$CACHED" "$URL"
fi

echo "[tos-prep] Encoding 60s 720p target via ffmpeg..."
ffmpeg -y -ss 0 -t 60 -i "$CACHED" \
  -vf scale=1280:720 \
  -c:v libx264 -preset slow -crf 18 \
  -keyint_min 25 -g 25 -sc_threshold 0 -bf 0 \
  -an \
  "$DEST"

SHA="$(sha256sum "$DEST" | awk '{print $1}')"
echo "[tos-prep] Wrote $DEST"
echo "[tos-prep] sha256: $SHA"
