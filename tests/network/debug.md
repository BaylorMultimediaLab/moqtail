# Mininet ABR Test Suite — Guide & Troubleshooting

## Status: green. `test_sudden_drop` passes in ~66s on a machine with VA-API HEVC.

## Running the tests

From the repo root, after [setup.sh](setup.sh) has been run once:

```bash
sudo -E ./tests/network/.venv/bin/pytest tests/network/scenarios/ -v -s
```

Why the direct venv invocation instead of `sudo uv run`: if `uv` came from the Ubuntu snap (`/snap/bin/uv`), snap confinement mangles fd forwarding under sudo and pytest's stdout is silently dropped. Calling the venv's pytest avoids that.

## Host prerequisites

`setup.sh` installs the apt packages, Rust/Node deps, Playwright Chromium, Google Chrome, and regenerates/trusts the relay TLS cert. You also need:

- **Linux with Mininet-compatible kernel** — tests must run as root (network namespaces, tc qdiscs).
- **GPU with VA-API HEVC decode**. The publisher emits only hvc1 variants; Chrome on Linux decodes HEVC only via VA-API hardware, so a missing or software-only GPU path breaks the test. Verify: `vainfo | grep HEVC` should show `VAProfileHEVCMain : VAEntrypointVLD`. Tested on AMD RX 6800 (Mesa radeonsi 25.2). NVIDIA/Intel with HEVC VAAPI should also work.
- **`sudo` access**. The pytest invocation above runs as root.

## Why this setup is the way it is

- **Relay address is `10.0.2.2`, not `localhost`.** Every Mininet host has its own network namespace. From the client netns, `localhost` is the client's own loopback — the relay is only reachable via its shared-subnet IP (`relay_ip_client` in [config.yaml](config.yaml)).
- **`root0` host in [topology.py](topology.py).** pytest runs in the root netns; the headless Chrome runs inside the client netns. We add a `root0` host with `inNamespace=False` and a plain (unshaped) `Link` to `s2` so pytest can reach `10.0.2.0/24` without going through the shaped test path.
- **socat bridge inside the client netns.** Chrome silently ignores `--remote-debugging-address=0.0.0.0` on recent versions. We run `socat TCP-LISTEN:9222,bind=10.0.2.1 TCP:127.0.0.1:9222` inside the client netns so pytest's Playwright CDP client can reach Chrome at `10.0.2.1:9222`.
- **Google Chrome stable, not Chromium.** Chromium omits HEVC (patent). The Playwright-bundled Chromium fails the hvc1 MIME check. Chrome on Linux supports HEVC only through VA-API — so we keep GPU enabled and pass `--enable-features=VaapiVideoDecoder,...`.
- **mkcert CA in `/root/.pki/nssdb`.** Chrome validates QUIC server certs independently; `--ignore-certificate-errors` does not cover QUIC. Solution: give Chrome a real CA to trust. `mkcert -install` as a normal user does not install into root's NSS db (mkcert follows `$HOME`), so `setup.sh` does it explicitly.

## Per-run cleanup (if a previous run crashed)

The `net` fixture already deletes `root0-eth0` on teardown, so a clean pass needs no manual cleanup. If a run was SIGKILL'd or hung mid-setup, you may have to run:

```bash
sudo pkill -9 -f ovs-vsctl
sudo pkill -9 -f mnexec
sudo systemctl restart openvswitch-switch
sudo mn -c
sudo ip link del root0-eth0 2>/dev/null || true
```

Symptoms that you need this: the test hangs indefinitely during `*** Starting 2 switches`, or bails out with `Error creating interface pair (root0-eth0,s2-eth3): RTNETLINK answers: File exists`.

## Troubleshooting by symptom

### `Chromium exited with code 0 before CDP was ready`

Chrome binary launched but never bound port 9222. Most common cause on a fresh box: Chromium snap (Ubuntu's default `chromium-browser`) running under sudo in a netns. The fixture's `_find_chrome_binary()` now prefers `/usr/bin/google-chrome-stable`; if that isn't present, install it (`setup.sh` does this via Google's .deb).

### `RuntimeError: Chromium CDP port 9222 never came up`

Chrome launched but is stuck. Check `results/<run>/chrome.log` — dbus errors are harmless; look for a real crash signature. Often caused by missing `--no-sandbox` or `--disable-dev-shm-usage`.

### `net::ERR_QUIC_PROTOCOL_ERROR.QUIC_TLS_CERTIFICATE_UNKNOWN` in `browser_console.log`

QUIC cert verification failed. Two possible causes:

1. Relay cert's SAN doesn't include `10.0.2.2`. Check: `openssl x509 -in apps/relay/cert/cert.pem -noout -ext subjectAltName`. Fix: re-run `setup.sh` (it regenerates when SAN is wrong).
2. mkcert CA isn't trusted by root's Chrome. Check: `sudo certutil -d sql:/root/.pki/nssdb -L | grep mkcert`. Fix: re-run `setup.sh` as root.

### `MIME type not supported: video/mp4; codecs="hvc1.1.6.L93.B0"`

Chrome cannot decode HEVC. Either no VA-API HEVC on this host (check `vainfo | grep HEVC`) or GPU is disabled. The flags in [config.yaml](config.yaml) (`VaapiVideoDecoder`, `PlatformHEVCDecoderSupport`, no `--disable-gpu`) require a real GPU path. On hosts without HEVC HW decode, the test cannot pass without re-encoding the publisher source to H.264.

### `ABR pipeline never started after Connect click`

Client-JS hit an error during `handleConnect` (catch block → `disposePlayer`). The fixture's error message includes a page state dump (`Error: ...` in the DOM body) — check that string. Most common causes are the two above.

### `RuntimeError: Relay failed to start`

Relay couldn't bind UDP 4433. Check `results/<run>/relay.log`. Often a cert/key file path mismatch: `config.yaml` lists paths relative to the repo root.

### Background pytest under sudo produces no output

Snap confinement through sudo. Invoke `./tests/network/.venv/bin/pytest` directly (not `sudo uv run pytest`).

## Historical debug log

Preserved here so the next person hitting one of these failures finds the context. Each item is a problem we hit and the fix that was merged.

### 1. Relay readiness probe used TCP for a QUIC/UDP service

[conftest.py:95](conftest.py#L95) polled `ss -tlnp`, which shows only TCP listeners. QUIC uses UDP. Changed to `ss -ulnp`.

### 2. `config.yaml` binary paths had a `../../` prefix

The paths are joined with the repo root in the fixtures, so the prefix pointed outside the tree. Stripped.

### 3. Ubuntu Chromium is a snap

Running the snap inside a Mininet netns forked helpers until OOM. `_find_chrome_binary()` now uses Google Chrome / Playwright's bundled Chromium, both of which are plain ELF binaries.

### 4. Root netns couldn't route to the client netns

Pytest runs in the root netns; Chrome's CDP listens inside the client netns at `10.0.2.1:9222`. Root netns had no route into `10.0.2.0/24`. Added `root0` host (`inNamespace=False`) with a plain `Link` to `s2` at `10.0.2.100/24` — [topology.py:88-97](topology.py#L88).

### 5. Headless Chrome silent-exit

Added `--disable-dev-shm-usage` (the `/dev/shm` in netns/containers is usually too small for Chrome's shared-memory renderer). Later we also dropped `--disable-gpu` to enable HEVC decode.

### 6. No visibility into subprocess stdio

Wired chrome/http.server/socat stdout+stderr to `results_dir/*.log`, closed in the fixture's `finally`.

### 7. `uv` snap swallows stdout under sudo

`/snap/bin/uv` is the snap-packaged astral-uv. `sudo uv run pytest` produces zero stdout. Workaround documented at the top of this file.

### 8. Chrome ignores `--remote-debugging-address=0.0.0.0`

Modern Chromium binds CDP to 127.0.0.1 regardless of that flag. socat bridge inside the client netns fixes it — [conftest.py:237-251](conftest.py#L237).

### 9. Client-JS UI is idle until the user clicks Connect

The ABR pipeline is gated on `handleConnect`, so `window.__moqtailMetrics.abr` stays null. Fixture auto-fills relay URL + namespace with Playwright's `.fill()` (native setters don't trigger React's synthetic change events) and clicks Connect — [conftest.py:282-295](conftest.py#L282).

### 10. Browser console was invisible

Added `page.on("console", …)` and `page.on("pageerror", …)` mirroring to `results_dir/browser_console.log`. Surfaced the QUIC cert errors.

### 11. QUIC TLS cert rejected by Chrome

Two stacked problems:

1. Cert SAN only contained `localhost, 127.0.0.1, ::1`. `10.0.2.2` (what the client connects to) wasn't there — hostname verification would fail even if trusted.
2. Cert is mkcert-signed; `/root/.pki/nssdb` was empty. `mkcert -install` as root doesn't install into root's NSS (honors `$HOME`).

Fix: regenerate cert with the right SAN (`10.0.2.2 10.0.1.2 localhost 127.0.0.1 ::1`), then populate `/root/.pki/nssdb` with mkcert's rootCA.pem via `certutil`. Both automated in [setup.sh](setup.sh) steps 9 and 10.

### 12. Stuck `ovs-vsctl` after a killed run

ovsdb and mnexec survive an interrupted pytest. Per-run cleanup recipe documented above.

### 13. Stale `root0-eth0` veth in root netns

`mn -c` only cleans Mininet-managed namespaces. The `net` fixture now explicitly deletes `root0-eth0` on teardown ([conftest.py:73](conftest.py#L73)).

### 14. HEVC decode missing in Chromium and in gpu-disabled Chrome

`MIME type not supported: video/mp4; codecs="hvc1.1.6.L93.B0"` even after switching to Google Chrome. Chrome on Linux decodes HEVC only via VA-API hardware; `--disable-gpu` kills that path. Resolved by removing `--disable-gpu`, adding `--enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,PlatformHEVCDecoderSupport`, `--ignore-gpu-blocklist`, `--use-gl=angle`, `--use-angle=gl-egl` in [config.yaml](config.yaml) and installing `google-chrome-stable` (Playwright's Chromium omits HEVC entirely).
