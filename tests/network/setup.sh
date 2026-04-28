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

# 2. Install socat + NSS tools
# socat bridges the CDP port from client netns loopback to the client IP so pytest
# (root netns) can reach it. certutil is required to add the mkcert CA to
# /root/.pki/nssdb (see step 9) so Chrome running as root trusts the relay cert.
echo "[2/7] Installing socat + libnss3-tools + vainfo..."
apt-get install -y socat libnss3-tools vainfo
echo "  socat + certutil + vainfo installed."

# 3. Install mkcert
# We use mkcert for the relay's dev cert. Chromium rejects self-signed certs in
# QUIC even with --ignore-certificate-errors, so a real CA (mkcert's) is easier.
echo "[3/7] Installing mkcert..."
if ! command -v mkcert &>/dev/null; then
    apt-get install -y mkcert
    echo "  mkcert installed."
else
    echo "  mkcert already installed."
fi

# 3b. Install Google Chrome stable
# Playwright's bundled Chromium omits HEVC decoders (H.265 is patent-encumbered).
# The publisher emits hvc1-only variants, so headless Chromium fails with
# "MIME type not supported: video/mp4; codecs=hvc1...". Google Chrome stable
# ships HEVC support.
echo "[3b/7] Installing Google Chrome stable..."
if ! command -v google-chrome-stable &>/dev/null; then
    CHROME_DEB=$(mktemp --suffix=.deb)
    wget -q -O "$CHROME_DEB" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y "$CHROME_DEB"
    rm -f "$CHROME_DEB"
    echo "  google-chrome-stable installed."
else
    echo "  google-chrome-stable already installed."
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
            echo "  VAAPI HEVC available (required for Chrome to decode hvc1 client-side)."
            GPU_OK=1
        else
            echo "  Warning: VAAPI present but HEVC not supported on this device. Tests will fail — Chrome cannot decode the publisher's hvc1 output without HW HEVC."
        fi
    else
        [ -n "$AMD_NAME" ] && echo "  AMD GPU detected: $AMD_NAME"
        echo "  Warning: vainfo not installed; cannot verify VAAPI HEVC."
    fi
fi
if [ "$GPU_OK" -eq 0 ]; then
    echo "  Warning: no GPU with HEVC decode detected. Chrome in tests will reject hvc1 MIME type and the fixture will fail at 'ABR pipeline never started'."
fi

# 9. TLS certs — regenerate if the cert is missing or lacks the Mininet IPs in its SAN.
# Chrome in QUIC mode enforces both trust AND hostname match; without 10.0.2.2 in
# the SAN the client sees QUIC_TLS_CERTIFICATE_UNKNOWN.
echo ""
echo "=== TLS Certificate Check ==="
CERT="$REPO_ROOT/apps/relay/cert/cert.pem"
KEY="$REPO_ROOT/apps/relay/cert/key.pem"
NEED_REGEN=0
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    NEED_REGEN=1
elif ! openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | grep -q '10.0.2.2'; then
    echo "  Existing cert does not include 10.0.2.2 in SAN — regenerating."
    NEED_REGEN=1
fi
if [ "$NEED_REGEN" -eq 1 ]; then
    user_run "mkcert -install"
    mkdir -p "$(dirname "$CERT")"
    user_run "mkcert -cert-file '$CERT' -key-file '$KEY' 10.0.2.2 10.0.1.2 localhost 127.0.0.1 ::1"
    [ "$EUID" -eq 0 ] && [ "${SUDO_USER:-}" ] && chown -R "$(id -u "$RUN_USER"):$(id -g "$RUN_USER")" "$(dirname "$CERT")" || true
    echo "  Regenerated relay cert with Mininet IPs in SAN."
else
    echo "  TLS cert has 10.0.2.2 in SAN."
fi

# 10. Trust the mkcert CA from root's NSS db so Chrome running under sudo trusts
# the relay cert. `mkcert -install` as root still writes into $SUDO_USER's NSS db
# (it honors $HOME), so we install it explicitly here.
if [ "$EUID" -eq 0 ]; then
    CAROOT=$(user_run "mkcert -CAROOT" | tail -1)
    if [ -f "$CAROOT/rootCA.pem" ]; then
        echo "=== Installing mkcert CA into /root/.pki/nssdb ==="
        mkdir -p /root/.pki/nssdb
        if ! certutil -d sql:/root/.pki/nssdb -L 2>/dev/null | grep -q mkcert; then
            certutil -d sql:/root/.pki/nssdb -N --empty-password </dev/null 2>/dev/null || true
            certutil -d sql:/root/.pki/nssdb -A -t "C,," -n "mkcert" -i "$CAROOT/rootCA.pem"
            echo "  mkcert CA installed in root's NSS db."
        else
            echo "  mkcert CA already present in root's NSS db."
        fi
    else
        echo "  Warning: $CAROOT/rootCA.pem not found. Run 'mkcert -install' as $RUN_USER first."
    fi
else
    echo "  Warning: run setup.sh as root to install the mkcert CA into /root/.pki/nssdb."
fi

echo ""
echo "=== Setup Complete ==="
echo "Run tests with:"
echo "  sudo -E '$SCRIPT_DIR/.venv/bin/pytest' tests/network/scenarios/ -v -s"
echo ""
echo "Note: if '/snap/bin/uv' is your uv, 'sudo uv run' will swallow stdout under"
echo "snap confinement — invoke the venv's pytest directly as shown above."
