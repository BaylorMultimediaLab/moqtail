#!/usr/bin/env bash
#
# Launch Chrome with HEVC hardware decoding enabled, then open the client-js UI.
#
# Chrome on Linux has no software HEVC decoder — it only plays HEVC when it can
# find a VA-API hardware decoder. On an NVIDIA GPU that requires the
# nvidia-vaapi-driver (NVDEC->VA-API bridge) plus Chrome's VaapiOnNvidiaGPUs
# feature, which is off by default because Chromium does not officially support
# VA-API on NVIDIA. Without this, the player fails at
# MediaSource.isTypeSupported() with:
#
#   MIME type not supported: video/mp4; codecs="hvc1.1.6.L93.B0"
#
# Prerequisites (one-time):
#   nvidia-drm.modeset=1     (already set by Ubuntu's nvidia packaging)
#   A build of nvidia-vaapi-driver in ~/.local/lib/dri/ — see NVIDIA_HEVC.md.
#   Ubuntu's packaged nvidia-vaapi-driver (0.0.8, Dec 2022) is too old: Chrome
#   initializes VaapiVideoDecoder, fails on the first decode, and falls back to
#   a software HEVC decoder that does not exist, producing a black picture.
#
# Verify the decoder is visible with:
#   LIBVA_DRIVERS_PATH=$HOME/.local/lib/dri LIBVA_DRIVER_NAME=nvidia \
#     NVD_BACKEND=direct vainfo --display drm --device /dev/dri/renderD129
# and look for VAProfileHEVCMain / VAProfileHEVCMain10.
#
# Usage:
#   ./scripts/run-chrome.sh            # open http://localhost:5173
#   ./scripts/run-chrome.sh <url>      # open a different URL

set -euo pipefail

URL="${1:-http://localhost:5173}"

# NVDEC-backed VA-API from the locally built driver, which takes precedence over
# the distro package in /usr/lib/x86_64-linux-gnu/dri/ without replacing it.
export LIBVA_DRIVERS_PATH="${LIBVA_DRIVERS_PATH:-$HOME/.local/lib/dri}"
export LIBVA_DRIVER_NAME=nvidia

# Upstream considers the `egl` backend broken on driver 525+ (this box runs 595).
# The `direct` backend needs a build newer than the packaged 0.0.8, which rejects
# it with "vaInitialize failed: operation failed". Override to `egl` to compare.
export NVD_BACKEND="${NVD_BACKEND:-direct}"

exec google-chrome \
  --enable-features=AcceleratedVideoDecodeLinuxGL,PlatformHEVCDecoderSupport,VaapiOnNvidiaGPUs \
  --ignore-gpu-blocklist \
  --use-gl=angle \
  --use-angle=gl \
  "$URL"
