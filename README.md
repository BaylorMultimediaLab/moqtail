# MOQtail

Draft 14-compliant MOQT protocol libraries for publisher, subscriber and relay components, featuring various live and on-demand demo applications using the LOC and CMSF formats.

## moqtail-ts (MOQtail TypeScript Library)

The TypeScript client library for Media-over-QUIC (MoQ) applications, designed for seamless integration with WebTransport and MoQ relay servers.

### ✨ Features

- 🛡️ **TypeScript**: Type-safe development
- 🔗 **WebTransport**: Next-gen transport protocol support
- 🔥 **Hot Module Reloading**: Instant feedback during development

README available at: [moqtail-ts/README.md](libs/moqtail-ts/README.md)

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- [npm](https://www.npmjs.com/)

### Installation

```bash
# Clone the repository (if not already)
git clone https://github.com/moqtail/moqtail.git
cd moqtail

# Install dependencies
npm install
```

## moqtail-rs (MOQtail Rust Library)

The Rust library for Media-over-QUIC (MoQ) applications, providing core protocol functionalities and utilities.

## Relay

The relay is a Rust application that forwards MoQ messages between publishers and subscribers.

```bash
cargo run --bin relay -- --port 4433 --cert-file cert/cert.pem --key-file cert/key.pem
```

### ⚙️ Configuration

- **WebTransport**: Ensure your browser supports WebTransport and that you have trusted the local CA, see the [README.md](apps/relay/cert/README.md) of the relay for instructions.

## Network Tests (Mininet ABR)

End-to-end ABR scenarios under [tests/network/](tests/network/) run the publisher, relay, and a Chromium subscriber across a Mininet topology with configurable link shaping. Requires Linux with root (Mininet), `uv`, and the project's Rust/JS builds.

### First-time setup

```bash
sudo ./tests/network/setup.sh
```

This installs Mininet, Open vSwitch, Xvfb, Chromium, `uv`, Python deps (via `uv sync` + Playwright Chromium), and builds the `relay`/`publisher` binaries and `client-js`.

### Running the scenarios

```bash
# All scenarios
sudo uv run --project tests/network pytest tests/network/scenarios/ -v

# A single scenario
sudo uv run --project tests/network pytest tests/network/scenarios/test_sudden_drop.py -v
```

Available scenarios: [test_bandwidth_recovery.py](tests/network/scenarios/test_bandwidth_recovery.py), [test_gradual_ramp_down.py](tests/network/scenarios/test_gradual_ramp_down.py), [test_high_latency.py](tests/network/scenarios/test_high_latency.py), [test_oscillation_resistance.py](tests/network/scenarios/test_oscillation_resistance.py), [test_packet_loss.py](tests/network/scenarios/test_packet_loss.py), [test_publisher_degradation.py](tests/network/scenarios/test_publisher_degradation.py), [test_sudden_drop.py](tests/network/scenarios/test_sudden_drop.py).

Topology, link profiles, and run parameters live in [tests/network/config.yaml](tests/network/config.yaml).

## 🤝 Contributing

Contributions are welcome! Please open issues or submit pull requests for improvements, bug fixes, or documentation updates.
