#!/usr/bin/env bash
set -euo pipefail

echo "=== MOQtail Mininet ABR Test Setup ==="

# Check for root (Mininet requires it)
if [ "$EUID" -ne 0 ]; then
    echo "Warning: Mininet installation requires root. Run with sudo if install steps fail."
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

# 4. Install uv (if not present)
echo "[4/7] Checking uv..."
if ! command -v uv &>/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    echo "  uv installed."
else
    echo "  uv already installed."
fi

# 5. Install Python dependencies
echo "[5/7] Installing Python dependencies..."
cd "$(dirname "$0")"
uv sync
uv run playwright install chromium
echo "  Python deps installed."

# 6. Build Rust binaries
echo "[6/7] Building Rust binaries..."
cd ../..
cargo build --release --bin relay --bin publisher
echo "  Rust binaries built."

# 7. Build client-js
echo "[7/7] Building client-js..."
npm run build --prefix apps/client-js
echo "  client-js built."

# 8. Check for NVIDIA GPU
echo ""
echo "=== GPU Check ==="
if command -v nvidia-smi &>/dev/null; then
    nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
    echo "  NVIDIA GPU detected. NVENC should be available for publisher."
else
    echo "  Warning: nvidia-smi not found. Publisher will fall back to software encoding (libx265)."
fi

# 9. Check for TLS certs
echo ""
echo "=== TLS Certificate Check ==="
if [ -f apps/relay/cert/cert.pem ] && [ -f apps/relay/cert/key.pem ]; then
    echo "  TLS certs found."
else
    echo "  Warning: TLS certs not found at apps/relay/cert/. Generate with mkcert:"
    echo "    mkcert -install"
    echo "    mkcert -cert-file apps/relay/cert/cert.pem -key-file apps/relay/cert/key.pem localhost 127.0.0.1 10.0.1.2 10.0.2.2"
fi

echo ""
echo "=== Setup Complete ==="
echo "Run tests with: sudo uv run pytest tests/network/scenarios/ -v"
