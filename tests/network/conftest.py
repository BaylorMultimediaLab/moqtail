"""Pytest fixtures for Mininet ABR testing."""

import asyncio
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

import pytest
import yaml
from playwright.async_api import async_playwright

from metrics_collector import MetricsCollector
from relay_log_parser import RelayLogParser
from topology import create_network


def pytest_addoption(parser):
    parser.addoption(
        "--config",
        action="store",
        default=str(Path(__file__).parent / "config.yaml"),
        help="Path to test config YAML",
    )


@pytest.fixture(scope="session")
def config(request):
    """Load test configuration from YAML."""
    config_path = request.config.getoption("--config")
    with open(config_path) as f:
        return yaml.safe_load(f)


@pytest.fixture(scope="session")
def project_root():
    """Return the moqtail project root directory."""
    return Path(__file__).parent.parent.parent


@pytest.fixture(scope="session")
def results_base():
    """Return the base results directory, creating it if needed."""
    base = Path(__file__).parent / "results"
    base.mkdir(exist_ok=True)
    return base


@pytest.fixture
def results_dir(results_base, request):
    """Create a timestamped results directory for the current test."""
    test_name = request.node.name
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    d = results_base / test_name / timestamp
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture
def net(config):
    """Create and start the Mininet network. Tears down after the test."""
    topo_cfg = config["topology"]
    network = create_network(
        link1_bw=topo_cfg["link1_default_bw"],
        link2_bw=topo_cfg["link2_default_bw"],
        delay=topo_cfg["default_delay"],
        loss=topo_cfg["default_loss"],
    )
    yield network
    network.stop()


@pytest.fixture
def relay_proc(net, config, project_root, results_dir):
    """Start the relay process on h2. Returns (process, stdout_path)."""
    relay = net.get("relay")
    relay_bin = str(project_root / config["binaries"]["relay"])
    cert_file = str(project_root / config["binaries"]["relay_cert"])
    key_file = str(project_root / config["binaries"]["relay_key"])
    stdout_path = results_dir / "relay.log"

    proc = relay.popen(
        [relay_bin, "--cert-file", cert_file, "--key-file", key_file, "--port", "4433"],
        stdout=open(stdout_path, "w"),
        stderr=subprocess.STDOUT,
    )

    # Wait for relay to be ready (listen on port 4433)
    for _ in range(30):
        result = relay.cmd("ss -tlnp | grep 4433")
        if "4433" in result:
            break
        time.sleep(0.5)
    else:
        proc.terminate()
        raise RuntimeError(f"Relay failed to start. Check {stdout_path}")

    yield proc, stdout_path
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture
def publisher_proc(net, config, project_root, relay_proc):
    """Start the publisher process on h1. Depends on relay being up."""
    publisher = net.get("publisher")
    pub_bin = str(project_root / config["binaries"]["publisher"])
    video_path = str(project_root / config["binaries"]["video_path"])
    relay_ip = config["topology"]["relay_ip_pub"]

    proc = publisher.popen(
        [
            pub_bin,
            f"https://{relay_ip}:4433",
            "--namespace", "moqtail",
            "--video-path", video_path,
            "--max-variants", "4",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    # Give the publisher time to connect and start encoding
    time.sleep(5)

    if proc.poll() is not None:
        stdout = proc.stdout.read().decode() if proc.stdout else ""
        raise RuntimeError(f"Publisher exited early with code {proc.returncode}: {stdout}")

    yield proc
    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture
async def browser_page(net, config):
    """Launch headless Chromium inside the client namespace via CDP.

    Starts Chromium on h3 with Xvfb, connects Playwright via CDP.
    Navigates to the client-js app served on h3.
    """
    client = net.get("client")
    dist_path = str(Path(__file__).parent.parent.parent / config["client_js"]["dist_path"])
    relay_url = config["client_js"]["relay_url"]
    chromium_flags = config["chromium"]["flags"]

    # Start a simple HTTP server on h3 to serve client-js dist
    client.cmd(f"python3 -m http.server 8080 --directory {dist_path} &")
    time.sleep(1)

    # Start Xvfb on h3
    client.cmd("Xvfb :99 -screen 0 1920x1080x24 &")
    time.sleep(1)

    # Start Chromium with remote debugging on h3
    cdp_port = 9222
    chrome_cmd = (
        f"DISPLAY=:99 chromium-browser"
        f" --remote-debugging-port={cdp_port}"
        f" --remote-debugging-address=0.0.0.0"
        f" {' '.join(chromium_flags)}"
        f" http://localhost:8080"
        f" &"
    )
    client.cmd(chrome_cmd)
    time.sleep(3)

    # Connect Playwright to the Chromium instance running inside h3's namespace
    # We need to access it via the client's IP
    client_ip = config["topology"]["client_ip"]
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(f"http://{client_ip}:{cdp_port}")
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()

        # Wait for __moqtailMetrics to become available
        for _ in range(60):
            result = await page.evaluate("() => window.__moqtailMetrics !== undefined")
            if result:
                break
            await asyncio.sleep(1)
        else:
            raise RuntimeError("Client-JS never exposed __moqtailMetrics")

        yield page

        await browser.close()

    # Cleanup h3 processes
    client.cmd("kill %python3 2>/dev/null")
    client.cmd("kill %chromium-browser 2>/dev/null")
    client.cmd("kill %Xvfb 2>/dev/null")


@pytest.fixture
def collector():
    """Return a fresh MetricsCollector."""
    return MetricsCollector()


@pytest.fixture
def relay_parser():
    """Return a fresh RelayLogParser."""
    return RelayLogParser()


@pytest.fixture
def thresholds(config):
    """Return the threshold config for assertions."""
    return config["thresholds"]


@pytest.fixture
def quality_map(config):
    """Return the bandwidth-to-quality mapping."""
    return config["quality_map"]
