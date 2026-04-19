#!/usr/bin/env bash
set -euo pipefail

echo "=== MOQtail Mininet ABR Test Setup ==="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Check for root (Mininet requires it)
if [ "$EUID" -ne 0 ]; then
    echo "Warning: apt-get steps require root. Re-run with sudo if install fails."
fi

# Determine how to run user-level commands (cargo, npm, uv).
# If launched via sudo, drop back to SUDO_USER so their cargo/nvm/local bin layout is used
# and caches (~/.cache/ms-playwright, target/) land in the invoking user's home.
# Preamble sourced inside each user_run shell so nvm/cargo/uv are on PATH.
# `bash -lc` only loads ~/.bash_profile/.profile, not ~/.bashrc (where nvm lives),
# so we source them explicitly here.
USER_PREAMBLE='
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.local/bin:$PATH"
'

if [ "$EUID" -eq 0 ] && [ "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
    RUN_USER="$SUDO_USER"
    echo "User-level steps will run as: $RUN_USER (via sudo -u)"
    user_run() { sudo -u "$RUN_USER" -H bash -lc "${USER_PREAMBLE}$*"; }
else
    RUN_USER="${USER:-$(id -un)}"
    user_run() { bash -lc "${USER_PREAMBLE}$*"; }
fi

# Reclaim stale root-owned artifacts from prior bad runs, so user_run can read them.
if [ "$EUID" -eq 0 ] && [ "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
    RUN_UID=$(id -u "$RUN_USER")
    RUN_GID=$(id -g "$RUN_USER")
    for path in \
        "$SCRIPT_DIR/.venv" \
        "$REPO_ROOT/target" \
        "$REPO_ROOT/apps/client-js/node_modules" \
        "$REPO_ROOT/apps/client-js/dist" \
        "$REPO_ROOT/node_modules"; do
        if [ -e "$path" ] && find "$path" -user root -print -quit 2>/dev/null | grep -q .; then
            echo "  Reclaiming root-owned files under $path for $RUN_USER"
            find "$path" -user root -exec chown "$RUN_UID:$RUN_GID" {} +
        fi
    done
fi

# 1. Install Mininet + Open vSwitch
echo "[1/7] Installing Mininet and Open vSwitch..."
if ! command -v mn &>/dev/null; then
    apt-get update
    apt-get install -y mininet openvswitch-switch
    echo "  Mininet installed."
else
    echo "  Mininet already installed."
fi

# 2. Install Xvfb
echo "[2/7] Installing Xvfb..."
if ! command -v Xvfb &>/dev/null; then
    apt-get install -y xvfb
    echo "  Xvfb installed."
else
    echo "  Xvfb already installed."
fi

# 3. Install Chromium
echo "[3/7] Installing Chromium..."
if ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null; then
    apt-get install -y chromium-browser || apt-get install -y chromium
    echo "  Chromium installed."
else
    echo "  Chromium already installed."
fi

# 4. Install uv (if not present) — runs as the invoking user
echo "[4/7] Checking uv..."
if ! user_run 'command -v uv' &>/dev/null; then
    user_run 'curl -LsSf https://astral.sh/uv/install.sh | sh'
    echo "  uv installed for $RUN_USER."
else
    echo "  uv already installed."
fi

# 5. Install Python dependencies — runs as the invoking user.
# Bind the venv to system Python + --system-site-packages so it can see the
# apt-installed `mininet` package at /usr/local/lib/python3.x/dist-packages.
echo "[5/7] Installing Python dependencies..."
user_run "cd '$SCRIPT_DIR' && rm -rf .venv && uv venv --python /usr/bin/python3 --system-site-packages && uv sync --python /usr/bin/python3 && NODE_OPTIONS=--no-deprecation uv run playwright install chromium"
echo "  Python deps installed."

# 6. Build Rust binaries — runs as the invoking user
echo "[6/7] Building Rust binaries..."
user_run "cd '$REPO_ROOT' && cargo build --release --bin relay --bin publisher"
echo "  Rust binaries built."

# 7. Build client-js — runs as the invoking user
echo "[7/7] Building client-js..."
user_run "cd '$REPO_ROOT' && npm run build --prefix apps/client-js"
echo "  client-js built."

# 8. Check for GPU acceleration (NVIDIA NVENC / AMD VAAPI)
echo ""
echo "=== GPU Check ==="
GPU_OK=0
if command -v nvidia-smi &>/dev/null; then
    nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
    echo "  NVIDIA GPU detected. NVENC should be available for publisher."
    GPU_OK=1
fi
if [ -e /dev/dri/renderD128 ]; then
    AMD_NAME=$(lspci 2>/dev/null | grep -iE 'vga.*(amd|ati|radeon)' | head -1 | sed 's/.*: //' || true)
    if command -v vainfo &>/dev/null; then
        if vainfo 2>/dev/null | grep -qE 'HEVC|H265'; then
            [ -n "$AMD_NAME" ] && echo "  AMD GPU detected: $AMD_NAME"
            echo "  VAAPI HEVC available for publisher."
            GPU_OK=1
        else
            echo "  Warning: VAAPI present but HEVC not supported on this device."
        fi
    else
        [ -n "$AMD_NAME" ] && echo "  AMD GPU detected: $AMD_NAME"
        echo "  Warning: vainfo not installed; cannot verify VAAPI HEVC. Install with: apt-get install -y vainfo"
    fi
fi
if [ "$GPU_OK" -eq 0 ]; then
    echo "  Warning: no NVIDIA/AMD GPU encoder detected. Publisher will fall back to software encoding (libx265)."
fi

# 9. Check for TLS certs
echo ""
echo "=== TLS Certificate Check ==="
if [ -f "$REPO_ROOT/apps/relay/cert/cert.pem" ] && [ -f "$REPO_ROOT/apps/relay/cert/key.pem" ]; then
    echo "  TLS certs found."
else
    echo "  Warning: TLS certs not found at apps/relay/cert/. Generate with mkcert:"
    echo "    mkcert -install"
    echo "    mkcert -cert-file apps/relay/cert/cert.pem -key-file apps/relay/cert/key.pem localhost 127.0.0.1 10.0.1.2 10.0.2.2"
fi

echo ""
echo "=== Setup Complete ==="
echo "Run tests with: sudo uv run --project tests/network pytest tests/network/scenarios/ -v"
