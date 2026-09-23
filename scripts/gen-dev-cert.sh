#!/usr/bin/env bash
#
# Generate a short-lived ECDSA certificate for the relay and print the SHA-256
# hash the browser needs.
#
# Why this exists: Firefox's HTTP/3 stack rejects certificates issued by a
# locally-installed CA (mkcert), even when that CA is trusted — the relay sees
# TLS alert 48, unknown_ca. WebTransport's `serverCertificateHashes` bypasses CA
# validation entirely by pinning the leaf certificate, and both Firefox and
# Chrome honour it. That is what makes Firefox usable here, which matters
# because Firefox decodes HEVC in software and does not depend on the broken
# NVIDIA VA-API path. See NVIDIA_HEVC.md.
#
# Browsers only accept a pinned hash for certificates that are ECDSA P-256 with
# a validity period of 14 days or less, so this must be re-run every 13 days.
#
# Usage:
#   ./scripts/gen-dev-cert.sh
#
# Writes cert.pem, key.pem and hash.txt into apps/relay/cert (backing up an
# existing pair once as *.bak), which is where run-stack.sh and the experiment
# runner read the relay certificate from. The runner appends ?certHash= to the
# player URL automatically when hash.txt is present.

set -euo pipefail

OUT_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/apps/relay/cert}"
mkdir -p "$OUT_DIR"
for f in cert.pem key.pem; do
  if [[ -f "$OUT_DIR/$f" && ! -f "$OUT_DIR/$f.bak" ]]; then cp "$OUT_DIR/$f" "$OUT_DIR/$f.bak"; fi
done

openssl ecparam -name prime256v1 -genkey -noout -out "$OUT_DIR/key.pem"
openssl req -new -x509 -key "$OUT_DIR/key.pem" -out "$OUT_DIR/cert.pem" \
  -days 13 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1,IP:10.200.0.1" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"
chmod 600 "$OUT_DIR/key.pem"

# Emit base64url. Standard base64 contains '+' in roughly three quarters of
# certificates, and a bare '+' in a query string decodes to a space, so the
# player would silently drop the hash and fall back to failing with unknown_ca.
# player.ts maps '-'/'_' back before atob().
HASH="$(openssl x509 -in "$OUT_DIR/cert.pem" -outform der | openssl dgst -sha256 -binary | base64 | tr '+/' '-_')"
printf '%s' "$HASH" > "$OUT_DIR/hash.txt"

echo "Certificate: $OUT_DIR/cert.pem  (expires $(openssl x509 -in "$OUT_DIR/cert.pem" -noout -enddate | cut -d= -f2))"
echo "certHash:    $HASH"
echo
echo "Open the player with:"
echo "  firefox \"http://localhost:5173/?certHash=\$(cat $OUT_DIR/hash.txt)\""
echo "The experiment runner picks hash.txt up on its own."
