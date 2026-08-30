# HEVC Playback on Linux: Diagnosis and Status

Investigation of why the MOQtail client-js failed to display video on an
NVIDIA + Intel hybrid Linux workstation, and how it was resolved.

**Status: SOLVED — use Firefox with a pinned certificate hash.** HEVC plays,
NVIDIA stays on the displays, and the publisher is unchanged. Jump to
[The working configuration](#the-working-configuration). The rest of this
document records why the other routes fail.

## The short version

MOQtail publishes HEVC only. On this machine, **no browser both connects to the
relay and displays the video**:

| Browser                      | Connects to relay                       | Decodes HEVC                      | Displays                      |
| ---------------------------- | --------------------------------------- | --------------------------------- | ----------------------------- |
| Chrome 151                   | yes                                     | yes (after driver work below)     | **no — every frame is black** |
| Firefox 153                  | yes, **with `serverCertificateHashes`** | yes (software, via system ffmpeg) | **yes**                       |
| Firefox 153, CA-trusted cert | no — HTTP/3 rejects the cert            | —                                 | —                             |

Chrome connects but cannot show HEVC, and no flag fixes it. Firefox shows HEVC
correctly once the certificate problem is worked around by pinning the leaf
hash instead of relying on the locally-installed CA.

## The working configuration

Measured on the live stack: **975 frames decoded, 1 dropped, sampled pixel mean
102 / max 254** (i.e. real picture, not black), with ABR switching
360p → 720p → 480p.

```bash
./scripts/gen-dev-cert.sh          # ECDSA P-256, 13-day validity, prints certHash
# start the relay with apps/relay/cert/ecdsa/{cert,key}.pem, then:
firefox "http://localhost:5173/?certHash=$(cat apps/relay/cert/ecdsa/hash.txt)"
```

Two things had to change in the client, both additive:

1. `player.ts` reads a `?certHash=` query parameter and passes it through as
   WebTransport `serverCertificateHashes`. Absent the parameter nothing changes,
   so the default CA-trusted path is untouched.
2. `estimateInitialBandwidth()` now tolerates a failing `getStats()`. Firefox
   ships `WebTransport.getStats` as a function that rejects with
   `NS_ERROR_NOT_IMPLEMENTED`; the old `typeof === 'function'` guard let that
   rejection escape and abort the connect _after_ the catalog arrived but
   _before_ `attachMedia()`. That is why the player showed "Error" with an empty
   `video.src` even though the MoQ session was healthy.

The certificate must be re-generated every 13 days — browsers only honour a
pinned hash for ECDSA P-256 certificates valid for 14 days or less.

## Test environment

| Item          | Value                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| OS            | Ubuntu 24.04, kernel 6.17.0-1020-oem                                        |
| GPUs          | Intel Arrow Lake-U iGPU (`card1`, i915) + NVIDIA RTX 5080 (`card2`, nvidia) |
| Display       | Two DisplayPort monitors wired to the **NVIDIA** card                       |
| NVIDIA driver | 595.58.03, `nvidia_drm modeset=1`                                           |
| Chrome        | 151.0.7922.71                                                               |
| Firefox       | 153.0.4 (snap)                                                              |
| libva         | 2.20.0 (VA-API 1.20)                                                        |

Because the monitors are on the NVIDIA card, switching the display GPU to the
iGPU (`prime-select intel`) is not viable — it would likely lose display output.

## Why the original error happened

The player feeds video to Media Source Extensions and checks support first:

```
apps/client-js/src/lib/player.ts:1245
  if (!MediaSource.isTypeSupported(mimeType)) {
    throw new Error(`MIME type not supported: ${mimeType}`);
```

The publisher is HEVC-only end to end — the encoder ladder, the `hvc1` sample
entry and `hvcC` box in the init segment, and the codec string in
`apps/publisher/src/catalog.rs:213` are all hardcoded HEVC. There is no codec
option on the publisher CLI.

Chrome on Linux ships **no software HEVC decoder**. It accepts HEVC only when it
finds a VA-API hardware decoder, and it binds VA-API to the GPU it renders on.
Here that is the NVIDIA card, which has no native VA-API, so Chrome logs:

```
WARNING:vaapi_wrapper.cc:130] Should skip nVidia device named: nvidia-drm
VERBOSE1:vaapi_wrapper.cc:1750] ...failed to find a suitable render node
```

and reports `MIME type not supported: video/mp4; codecs="hvc1.1.6.L93.B0"`.

Note the Intel iGPU **does** expose HEVC decode (`VAProfileHEVCMain`,
`Main10`, `Main12` via iHD 24.1.0) — Chrome simply never selects it, because it
renders on the NVIDIA GPU.

## What was fixed (and what it bought)

Ubuntu packages `nvidia-vaapi-driver` 0.0.8 (December 2022), which is too old:
Chrome initializes `VaapiVideoDecoder`, fails on the first decode, and falls back
to a software HEVC decoder that does not exist — a black picture, with
`video decoder fallback after initial decode error` in `chrome://media-internals`.

Current upstream (v0.0.17 + 42 commits, including recent decoder-init fixes) was
built and installed to `~/.local/lib/dri/`, selected via `LIBVA_DRIVERS_PATH` so
the distro package stays untouched:

```bash
# ffnvcodec headers (not packaged in Ubuntu)
git clone https://github.com/FFmpeg/nv-codec-headers.git
make -C nv-codec-headers PREFIX="$HOME/.local" install

# the driver itself
sudo apt install -y meson ninja-build libva-dev libegl-dev libdrm-dev \
  libgstreamer-plugins-bad1.0-dev
git clone https://github.com/elFarto/nvidia-vaapi-driver.git
cd nvidia-vaapi-driver
PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig" meson setup build --prefix="$HOME/.local"
ninja -C build
mkdir -p ~/.local/lib/dri && cp build/nvidia_drv_video.so ~/.local/lib/dri/
```

Verify:

```bash
LIBVA_DRIVERS_PATH=$HOME/.local/lib/dri LIBVA_DRIVER_NAME=nvidia \
  NVD_BACKEND=direct vainfo --display drm --device /dev/dri/renderD129
# => VA-API NVDEC driver [direct backend]
# => VAProfileHEVCMain / Main10 / Main12 / Main444 / Main444_10 / Main444_12
```

This genuinely works: `MediaSource.isTypeSupported` now returns true, the client
connects, and driving it over CDP shows **1946 frames decoded**, the playhead
advancing, and ABR up-switching 360p → 480p → 1080p. The
`fallback after initial decode error` warning is gone.

**But every decoded frame is black.** Sampling the video element into a canvas
gives pixel mean 0, max 0. The NVDEC→Chrome frame export path fails silently —
`NVD_LOG=1` shows no error at all; the driver believes it succeeded.

`scripts/run-chrome.sh` captures the working launch configuration.

## Chrome configurations tested

All against the live stack, measured by frames decoded and sampled pixel values.

| Configuration                         | Frames decoded | Picture |
| ------------------------------------- | -------------- | ------- |
| `direct` backend + ANGLE-GL (default) | 1946           | black   |
| zero-copy explicitly disabled         | 1727           | black   |
| zero-copy explicitly enabled          | 1948           | black   |
| `NVD_BACKEND=egl`                     | 0              | —       |
| `--disable-gpu-compositing`           | 0              | —       |
| ANGLE Vulkan (± `Vulkan` feature)     | 0              | —       |

Only `direct` + `--use-angle=gl` decodes at all, and it renders black.

Also tried and rejected, before the driver rebuild: `PlatformHEVCDecoderSupport`,
`AcceleratedVideoDecodeLinuxGL`, `VaapiIgnoreDriverChecks`, forcing Mesa EGL/GLX
(kills GPU acceleration entirely — `NO_WEBGL`), masking the NVIDIA render node in
a mount namespace, and running Chrome under a headless weston compositor the way
`tests/network/conftest.py` does.

This is consistent with upstream expectations: Chromium disabled VA-API on NVIDIA
by default, and `VaapiOnNvidiaGPUs` exists for developers to test. The
nvidia-vaapi-driver project does not claim Chrome support.

## Why Firefox cannot substitute

Firefox decodes HEVC in software through system ffmpeg, needing none of the above,
and supports WebTransport:

```
hevc=true  h264=true  canplay=probably  wt=true
```

But it cannot open the WebTransport session. The relay reports:

```
Error occurred in session 4: connection aborted by peer:
the cryptographic handshake failed: error 48
```

TLS alert 48 is `unknown_ca`. The certificate trust is **not** misconfigured:

- The mkcert CA in the Firefox profile matches the CA that signed the relay cert
  (serial `257884009192743845984776410650900229283` both sides)
- NSS reports `Chain is good!` for the relay cert against that profile
  (`vfychain -d sql:<profile> -u 1 -a apps/relay/cert/cert.pem`)
- Serving the **same certificate** over ordinary TLS, Firefox loads the page fine

So Firefox's TLS stack trusts the certificate while its HTTP/3 stack rejects it.
This is a known Firefox limitation with locally-issued certificates over HTTP/3 —
Chromium works against local HTTP/3 WebTransport servers where Firefox fails —
and no workaround is documented.

## Options not yet taken

1. **Add H.264 alongside HEVC in the publisher.** Most reliable: Chrome already
   connects, and decodes H.264 in software on any GPU. Requires encoder
   selection, `avc1` sample entry + `avcC` box, and an `avc1.PPCCLL` codec
   string in `apps/publisher/src/{encoder,catalog}.rs`, plus a cache re-encode.
   HEVC can remain the default, with H.264 as an option.
2. **Move Chrome's decode to the Intel iGPU.** ~~Untested.~~ **Tested 27 Aug
   2026 — cannot be done in software on this machine.** See the section below.
3. ~~**Short-lived ECDSA cert + `serverCertificateHashes`.**~~ **Done — this is
   the working configuration above.** Requires an ECDSA P-256 certificate with
   ≤ 14 day validity and a client change to pass `serverCertificateHashes` to the
   `WebTransport` constructor (`libs/moqtail-ts/src/client/client.ts:430`).
   Firefox's support for it is unverified, and the certificate needs reissuing
   every two weeks.

## Why "decode on the Intel iGPU" cannot work here

Chrome does **not** scan for a usable VA-API device. It derives the VA-API render
node from the GPU it is already rendering on. On this machine that GPU is
dictated by the X server, which is NVIDIA-driven because both monitors are wired
to the NVIDIA card — so VA-API always lands on NVIDIA, and HEVC always goes
through the broken NVDEC export path.

Four attempts to break that chain, all measured by the WebGL renderer string and
`MediaSource.isTypeSupported`:

| Attempt                                                                     | Chrome's GPU    | HEVC  |
| --------------------------------------------------------------------------- | --------------- | ----- |
| weston headless pinned to Intel (`DRI_PRIME=pci-0000_00_02_0`)              | NVIDIA RTX 5080 | false |
| `--gpu-launcher` injecting Mesa + Intel env into the GPU process            | NVIDIA RTX 5080 | false |
| bwrap namespace: only the Intel DRM node and only Mesa's EGL vendor visible | NVIDIA RTX 5080 | false |
| same namespace, X11 removed entirely                                        | GPU init fails  | false |

The third row is the decisive one. With `/dev/dri` containing **only** the Intel
render node, Chrome still rendered on the NVIDIA GPU — it reaches it through
GLX on the X server, not through EGL vendor files or DRM nodes — and still
logged `failed to find a suitable render node` without ever calling into libva.
Removing X removes the NVIDIA path, but then Chrome has no working GPU at all.

**The one route that would work is physical.** The Intel iGPU has six unused
display outputs (`card1-DP-1..4`, `card1-HDMI-A-1..2`, all disconnected). Moving
a monitor to a motherboard output and running the desktop session on the iGPU
makes Chrome's GPU Intel, which puts VA-API on the Intel decoder — and that
decoder demonstrably supports `VAProfileHEVCMain`, `Main10` and `Main12`. NVIDIA
would remain available for NVENC and compute through PRIME on-demand. This
requires no code change and keeps HEVC end to end, but it has not been tested,
because it needs the cable moved.

## Reproducing

The stack itself is unaffected by any of this and runs normally:

```bash
npm --prefix libs/moqtail-ts run build
cargo build --release
./scripts/run-stack.sh          # relay :4433, client-js :5173
./scripts/run-chrome.sh         # Chrome with HEVC decoding enabled
```

Then click **Connect**. Expect: status "Playing", ABR active, frames decoding,
picture black. Check `chrome://media-internals` for decoder selection.

## Cleanup

Everything added is additive and reversible:

- `scripts/run-chrome.sh` — new file
- `~/.local/lib/dri/nvidia_drv_video.so` — the built driver; delete the directory
  to fall back to the distro package
- `~/.local/{include,lib}` ffnvcodec headers and pkg-config file
- `sudo apt remove nvidia-vaapi-driver vainfo` — to undo the packaged install
