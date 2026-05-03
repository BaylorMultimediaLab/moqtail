"""Pytest fixtures for paper experiments.

Re-exports tests/network/conftest.py fixtures (`net`, `relay_proc`,
`publisher_proc`, `browser_page`, `collector`, `results_dir`, `config`,
`project_root`, `results_base`) so experiment tests share the regression
suite's Mininet/relay/publisher/Playwright lifecycle.

Per-experiment overrides (relay --cache-size, publisher --ladder-spec) live
in Task 7's follow-up; this file only sets up the import scaffolding.
"""
import sys
from pathlib import Path

# Make tests/network importable as a sibling. tests/experiments/pyproject.toml
# already lists "../network" in pythonpath, but doing this here too makes
# `pytest tests/experiments/...` invocations from arbitrary cwd robust.
_NETWORK_DIR = Path(__file__).resolve().parent.parent / "network"
if str(_NETWORK_DIR) not in sys.path:
    sys.path.insert(0, str(_NETWORK_DIR))

# Pull in every fixture and helper the regression suite defines.
from conftest import *  # noqa: F401,F403
from conftest import pytest_addoption  # noqa: F401  (pytest needs to find this hook)

import os
import subprocess
import time

import pytest


def _read_marker(request, name, default):
    """Read a single-positional-arg marker like @pytest.mark.foo(value)."""
    marker = request.node.get_closest_marker(name)
    if marker is None:
        return default
    return marker.args[0] if marker.args else marker.kwargs.get("value", default)


@pytest.fixture
def relay_cache_size(request):
    """Per-test override for relay --cache-size. Set via @pytest.mark.relay_cache_size(20)."""
    return _read_marker(request, "relay_cache_size", default=1000)


@pytest.fixture
def relay_proc(net, config, project_root, results_dir, relay_cache_size):
    """Override of tests/network's relay_proc that honors relay_cache_size.

    Mirrors the regression-suite implementation but adds --cache-size to the
    relay invocation. The default value (1000) matches the relay's own default
    so unannotated tests behave identically to the network suite.
    """
    relay = net.get("relay")
    relay_bin = str(project_root / config["binaries"]["relay"])
    cert_file = str(project_root / config["binaries"]["relay_cert"])
    key_file = str(project_root / config["binaries"]["relay_key"])
    stdout_path = results_dir / "relay.log"

    log_file = open(stdout_path, "w")
    proc = relay.popen(
        [
            relay_bin,
            "--cert-file", cert_file,
            "--key-file", key_file,
            "--port", "4433",
            "--cache-size", str(relay_cache_size),
        ],
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )

    for _ in range(30):
        result = relay.cmd("ss -ulnp | grep 4433")
        if "4433" in result:
            break
        time.sleep(0.5)
    else:
        proc.terminate()
        log_file.close()
        raise RuntimeError(f"Relay failed to start. Check {stdout_path}")

    yield proc, stdout_path
    proc.terminate()
    proc.wait(timeout=5)
    log_file.close()


@pytest.fixture
def publisher_ladder_spec(request):
    """Per-test override for publisher --ladder-spec.

    Defaults to the experiment ladder (720p with 5 rungs at the bitrates
    aligned with Bentaleb et al. 2019 + a 5 Mbps top tier). Override with
    @pytest.mark.publisher_ladder_spec("default") to fall back to the legacy
    resolution-coupled ladder.
    """
    return _read_marker(
        request,
        "publisher_ladder_spec",
        default="720p:400,800,1200,2500,5000",
    )


@pytest.fixture
def publisher_proc(net, config, project_root, relay_proc, publisher_ladder_spec):
    """Override of tests/network's publisher_proc.

    Uses the Tears of Steel 60-second 720p source by default. The publisher
    binary must be built with the vaapi feature for AMD GPU encoding:
    `cargo build --release --workspace --features publisher/vaapi`.
    """
    publisher = net.get("publisher")
    pub_bin = str(project_root / config["binaries"]["publisher"])
    video_path = str(project_root / "data/video/tears_of_steel_60s_720p.mp4")
    if not os.path.exists(video_path):
        raise RuntimeError(
            f"Tears of Steel asset missing at {video_path}. "
            f"Run: ./scripts/prepare_tears_of_steel.sh"
        )
    relay_ip = config["topology"]["relay_ip_pub"]

    proc = publisher.popen(
        [
            pub_bin,
            f"https://{relay_ip}:4433",
            "--namespace", "moqtail",
            "--video-path", video_path,
            "--ladder-spec", publisher_ladder_spec,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    time.sleep(5)

    if proc.poll() is not None:
        stdout = proc.stdout.read().decode() if proc.stdout else ""
        raise RuntimeError(f"Publisher exited early with code {proc.returncode}: {stdout}")

    yield proc
    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture(scope="session")
def results_base():
    """Override of tests/network's results_base. Experiment artifacts live under
    tests/experiments/results/, not the regression suite's directory."""
    base = Path(__file__).resolve().parent / "results"
    base.mkdir(exist_ok=True)
    return base


def pytest_configure(config):
    """Register the custom markers so pytest doesn't warn about unknown markers."""
    config.addinivalue_line(
        "markers", "relay_cache_size(n): override --cache-size for the relay (default 1000)"
    )
    config.addinivalue_line(
        "markers",
        "publisher_ladder_spec(s): override --ladder-spec for the publisher",
    )
    config.addinivalue_line(
        "markers",
        "abr_url_overrides(**kwargs): merge extra ABR settings into the page URL "
        "for this test (e.g. throughputSlowHalfLifeSeconds=4).",
    )
    config.addinivalue_line(
        "markers",
        "abr_settings_override(settings): inject window.__abrSettingsOverride before "
        "Connect click. Used by E6 to sweep ABR rule configurations.",
    )
