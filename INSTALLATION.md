# MOQtail Installation Guide

Complete setup guide for running the MOQtail stack natively on **Linux**.

## Table of Contents

- [Linux Setup](#linux-setup)
  - [System Packages](#1-system-packages)
  - [Rust](#2-rust)
  - [Node.js](#3-nodejs-v18)
  - [Clone and Install](#4-clone-and-install)
  - [TLS Certificates](#5-tls-certificate-setup)
  - [Build and Run](#6-build-and-run)
  - [AMD GPU Hardware Encoding](#amd-gpu-hardware-encoding)

---

## Linux Setup

Tested on **Ubuntu 24.04**. The `ffmpeg-next` Rust crate links against system FFmpeg libraries detected via `pkg-config` — no vcpkg required.

### 1. System Packages

```bash
sudo apt update
sudo apt install -y \
  build-essential pkg-config git git-lfs \
  clang libclang-dev nasm \
  libavcodec-dev libavformat-dev libavutil-dev \
  libavfilter-dev libavdevice-dev \
  libswscale-dev libswresample-dev \
  mkcert libnss3-tools \
  weston
```

| Package                    | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `build-essential`          | C/C++ compiler and linker                                        |
| `libclang-dev`             | Required by `bindgen` (used by `ffmpeg-next`)                    |
| `nasm`                     | Required for some FFmpeg codec builds                            |
| `libav*-dev`, `libsw*-dev` | FFmpeg development headers and libraries                         |
| `mkcert` / `libnss3-tools` | Local TLS certificate generation                                 |
| `git-lfs`                  | Large file support for test video data                           |
| `weston`                   | Headless Wayland compositor used by the Mininet ABR test harness |

### 2. Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### 3. Node.js v18+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 4. Clone and Install

```bash
git clone https://github.com/BaylorMultimediaLab/moqtail.git
cd moqtail
```

#### Git submodule (test video data)

```bash
git lfs install
git submodule update --init --recursive
cd data && git lfs pull && cd ..
```

If the submodule clone hangs waiting for credentials, follow the same steps as [Windows](#clone-and-install) to embed a GitLab personal access token or supply your own video file:

```bash
mkdir -p data/video
cp /path/to/your/video.mp4 data/video/smoking_test_1080p.mp4
```

#### Node dependencies

Run from the repo root — npm workspaces install everything for all packages at once:

```bash
npm install
```

> Do not run `npm install` inside a subdirectory (e.g. `apps/client`) first. The root `prepare` script installs Husky, and subdirectory installs will fail if the root `node_modules` is not present yet.

### 5. TLS Certificate Setup

WebTransport requires TLS. Place `cert.pem` and `key.pem` in `apps/relay/cert/`.

```bash
mkcert -install
cd apps/relay/cert
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
cd ../../..
```

Then enable WebTransport in Chrome:

1. Navigate to `chrome://flags/#webtransport-developer-mode`
2. Set it to **Enabled**
3. Restart Chrome

### 6. Build and Run

Build the TypeScript client library first — `apps/client-js` imports `moqtail` from `libs/moqtail-ts/dist/`, and Vite will fail with `Failed to resolve entry for package "moqtail"` if `dist/` is missing:

```bash
npm --prefix libs/moqtail-ts run build
cargo build --release
./scripts/run-stack.sh
```

> You only need to rerun `npm --prefix libs/moqtail-ts run build` after changes inside `libs/moqtail-ts/src/`.

To use a custom video file:

```bash
./scripts/run-stack.sh data/video/my_video.mp4
```

To stop the stack:

```bash
./scripts/run-stack.sh stop
```

| Component | URL                    |
| --------- | ---------------------- |
| Relay     | https://localhost:4433 |
| Client-JS | http://localhost:5173  |

### AMD GPU Hardware Encoding (VAAPI)

Ubuntu's packaged FFmpeg does not include AMF (AMD's proprietary hardware encoder). Software encoding via `libx265` works out of the box with no extra setup. The publisher can optionally use open-source AMD hardware encoding via VAAPI (`hevc_vaapi`).

#### 1. Install VA-API runtime and driver

```bash
sudo apt install -y \
  libva2 libva-drm2 libva-x11-2 \
  mesa-va-drivers \
  vainfo
```

VAAPI encoders (`hevc_vaapi`, `h264_vaapi`) are included in the system FFmpeg and work with any AMD GPU running the `amdgpu` kernel driver. The publisher currently uses the default encoder selection, so no additional flags are needed unless you modify the encoder configuration.
