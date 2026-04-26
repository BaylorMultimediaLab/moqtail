"""Pytest fixtures for Mininet ABR testing."""

import asyncio
import os
import shutil
import signal
import subprocess
import tempfile
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
    try:
        yield network
    finally:
        network.stop()
        # root0 lives in the root netns (inNamespace=False), so mininet.stop()
        # leaves its veth behind. The next run's addLink would fail with
        # "RTNETLINK answers: File exists". Delete it explicitly.
        subprocess.run(
            ["ip", "link", "del", "root0-eth0"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )


@pytest.fixture
def relay_proc(net, config, project_root, results_dir):
    """Start the relay process on h2. Returns (process, stdout_path)."""
    relay = net.get("relay")
    relay_bin = str(project_root / config["binaries"]["relay"])
    cert_file = str(project_root / config["binaries"]["relay_cert"])
    key_file = str(project_root / config["binaries"]["relay_key"])
    stdout_path = results_dir / "relay.log"

    log_file = open(stdout_path, "w")
    proc = relay.popen(
        [relay_bin, "--cert-file", cert_file, "--key-file", key_file, "--port", "4433"],
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )

    # Wait for relay to be ready (listening on UDP 4433 — MoQT runs over QUIC)
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


def _find_chrome_binary() -> str:
    """Locate a Chrome/Chromium binary with HEVC (hvc1) support.

    Prefers Google Chrome stable, which ships proprietary codecs; the Playwright
    Chromium bundle does not include HEVC and the client-js catalog is hvc1-only.
    Falls back to Playwright's bundled Chromium for environments without hvc1
    media (not sufficient for this test suite, but useful for other fixtures).

    Avoids the Ubuntu snap `chromium-browser`: snap confinement (AppArmor,
    systemd slices) fights Mininet netns and the shim spawns helpers until
    RAM is exhausted.
    """
    for candidate in ("/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"):
        if Path(candidate).exists():
            return candidate
    home = Path(os.environ.get("SUDO_USER") and f"/home/{os.environ['SUDO_USER']}" or os.path.expanduser("~"))
    cache = home / ".cache/ms-playwright"
    candidates = sorted(cache.glob("chromium-*/chrome-linux*/chrome"))
    if candidates:
        return str(candidates[-1])
    raise RuntimeError(
        "No Chrome/Chromium found. Install google-chrome-stable (for HEVC) "
        "or run `uv run playwright install chromium` in tests/network."
    )


@pytest.fixture
async def browser_page(net, config, results_dir):
    """Launch Chrome inside the client namespace on an Xvfb display via CDP.

    Runs headful under Xvfb, not --headless=new. With --headless=new on Linux +
    AMD VA-API, the GPU process crashes when it tries to allocate a platform
    GpuMemoryBuffer for decoded HEVC frames (SharedImageBackingFactory can't
    find a backing for gmb_type=platform → GPU exits 8704 →
    PIPELINE_ERROR_DISCONNECTED → the entire client spins in a retry loop that
    leaks RAM). Xvfb gives chrome a real X display so the full GPU path works.
    """
    client = net.get("client")
    dist_path = str(Path(__file__).parent.parent.parent / config["client_js"]["dist_path"])
    chromium_flags = config["chromium"]["flags"]
    client_ip = config["topology"]["client_ip"]
    relay_url = config["client_js"]["relay_url"]
    chrome_bin = _find_chrome_binary()

    user_data_dir = Path(tempfile.mkdtemp(prefix="moqtail-chrome-"))
    chrome_log_path = results_dir / "chrome.log"
    http_log_path = results_dir / "http_server.log"
    socat_log_path = results_dir / "socat.log"
    weston_log_path = results_dir / "weston.log"
    chrome_log = open(chrome_log_path, "w")
    http_log = open(http_log_path, "w")
    socat_log = open(socat_log_path, "w")
    weston_log = open(weston_log_path, "w")
    http_proc = None
    chrome_proc = None
    socat_proc = None
    weston_proc = None
    weston_runtime_dir = None

    try:
        # Serve client-js dist inside the client netns.
        # Mininet's popen uses `mnexec -da`, which already calls setsid(),
        # so we do NOT add start_new_session=True (double-setsid returns EPERM).
        http_proc = client.popen(
            ["python3", "-m", "http.server", "8080", "--directory", dist_path],
            stdout=http_log,
            stderr=subprocess.STDOUT,
        )
        await asyncio.sleep(1)

        # Start a headless Weston compositor inside the client netns and
        # point Chrome at its Wayland socket. Xvfb has no DRI3 support, so
        # Chrome's HEVC decoder fails to allocate dma-buf-backed SharedImages
        # and the GPU process exits 8704. Weston's headless backend wires up
        # DRM/render nodes directly, giving Chrome a real GPU path.
        weston_runtime_dir = Path(tempfile.mkdtemp(prefix="moqtail-weston-runtime-"))
        os.chmod(weston_runtime_dir, 0o700)
        wayland_socket = f"wayland-test-{os.getpid()}"
        weston_env = {**os.environ, "XDG_RUNTIME_DIR": str(weston_runtime_dir)}
        # --renderer=gl is required so weston advertises zwp_linux_dmabuf_v1,
        # which Chrome's GPU process needs to allocate dma-buf-backed
        # SharedImages for HW-decoded HEVC frames. The default `noop` renderer
        # is for protocol-level tests and doesn't expose those interfaces.
        weston_proc = client.popen(
            [
                "weston",
                "--backend=headless-backend.so",
                "--renderer=gl",
                f"--socket={wayland_socket}",
                "--width=1280",
                "--height=800",
            ],
            stdout=weston_log,
            stderr=subprocess.STDOUT,
            env=weston_env,
        )
        wayland_socket_path = weston_runtime_dir / wayland_socket
        for _ in range(60):
            if wayland_socket_path.exists():
                break
            await asyncio.sleep(0.1)
        else:
            raise RuntimeError(
                f"weston Wayland socket {wayland_socket_path} never appeared (see {weston_log_path})"
            )

        # Launch Chrome headful on the Weston Wayland socket.
        # Scrub WAYLAND_DISPLAY/DBUS from the user's desktop session and inject
        # our test compositor's socket + runtime dir.
        cdp_port = 9222
        scrubbed_env = {
            k: v
            for k, v in os.environ.items()
            if k
            not in (
                "WAYLAND_DISPLAY",
                "DBUS_SESSION_BUS_ADDRESS",
                "XDG_RUNTIME_DIR",
                "XDG_SESSION_TYPE",
                "DISPLAY",
            )
        }
        scrubbed_env["WAYLAND_DISPLAY"] = wayland_socket
        scrubbed_env["XDG_RUNTIME_DIR"] = str(weston_runtime_dir)
        scrubbed_env["XDG_SESSION_TYPE"] = "wayland"

        # Chrome 147+ still reads the legacy `antialiasing` key from
        # `org.gnome.settings-daemon.plugins.xsettings`. gnome-settings-daemon
        # 43+ moved it to a `.deprecated` schema, so on a current Ubuntu
        # GLib's g_error() (always-fatal) aborts Chrome at startup. Build a
        # patched schema dir that puts the key back in the original schema.
        schema_dir = Path(tempfile.mkdtemp(prefix="moqtail-gschemas-"))
        for src in Path("/usr/share/glib-2.0/schemas").glob("*.gschema.xml"):
            (schema_dir / src.name).write_text(src.read_text())
        for src in Path("/usr/share/glib-2.0/schemas").glob("*.enums.xml"):
            (schema_dir / src.name).write_text(src.read_text())
        xs = schema_dir / "org.gnome.settings-daemon.plugins.xsettings.gschema.xml"
        xs_text = xs.read_text()
        # Splice the deprecated `antialiasing` key into the live schema.
        injected_key = (
            '    <key name="antialiasing" '
            'enum="org.gnome.settings-daemon.GsdFontAntialiasingMode">\n'
            "      <default>'grayscale'</default>\n"
            "      <summary>Antialiasing</summary>\n"
            "      <description>(legacy)</description>\n"
            "    </key>\n  </schema>"
        )
        xs.write_text(xs_text.replace(
            '  </schema>\n  <schema id="org.gnome.settings-daemon.plugins.xsettings.deprecated">',
            injected_key + '\n  <schema id="org.gnome.settings-daemon.plugins.xsettings.deprecated">',
            1,
        ))
        subprocess.run(
            ["glib-compile-schemas", str(schema_dir)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        scrubbed_env["GSETTINGS_SCHEMA_DIR"] = str(schema_dir)
        chrome_proc = client.popen(
            [
                chrome_bin,
                f"--remote-debugging-port={cdp_port}",
                "--remote-debugging-address=0.0.0.0",
                f"--user-data-dir={user_data_dir}",
                "--enable-logging=stderr",
                "--v=1",
                *chromium_flags,
                "http://localhost:8080",
            ],
            stdout=chrome_log,
            stderr=subprocess.STDOUT,
            env=scrubbed_env,
        )
        print(f"[browser_page] chrome_proc pid={chrome_proc.pid}", flush=True)

        # Poll until the CDP port is listening (fail fast if chrome didn't start)
        for i in range(30):
            rc = chrome_proc.poll()
            listening = "9222" in client.cmd("ss -tlnp | grep 9222")
            if rc is not None and not listening:
                # Chrome's main process exited without ever binding CDP — real failure.
                raise RuntimeError(
                    f"Chromium exited with code {rc} before CDP was ready "
                    f"(see {chrome_log_path})"
                )
            if listening:
                print(f"[browser_page] CDP up after {i * 0.5:.1f}s "
                      f"(chrome_proc.poll={rc})", flush=True)
                break
            await asyncio.sleep(0.5)
        else:
            raise RuntimeError("Chromium CDP port 9222 never came up")

        # Chrome binds CDP to 127.0.0.1 only (recent versions ignore
        # --remote-debugging-address=0.0.0.0 for security). Bridge with socat
        # inside the client netns so pytest (root netns, reachable via root0)
        # can connect via 10.0.2.1:9222.
        socat_proc = client.popen(
            [
                "socat",
                f"TCP-LISTEN:{cdp_port},bind={client_ip},fork,reuseaddr",
                f"TCP:127.0.0.1:{cdp_port}",
            ],
            stdout=socat_log,
            stderr=subprocess.STDOUT,
        )
        for _ in range(20):
            if f"{client_ip}:{cdp_port}" in client.cmd(
                f"ss -tlnp | grep {cdp_port}"
            ) or f"*:{cdp_port}" in client.cmd(f"ss -tlnp | grep {cdp_port}"):
                break
            await asyncio.sleep(0.25)

        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(
                f"http://{client_ip}:{cdp_port}", timeout=15_000
            )
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else await context.new_page()

            # Mirror browser console + page errors into a file so we can see
            # why a Connect attempt failed (WebTransport errors, cert issues).
            console_log_path = results_dir / "browser_console.log"
            console_log = open(console_log_path, "w")
            page.on("console", lambda msg: console_log.write(
                f"[{msg.type}] {msg.text}\n"
            ) or console_log.flush())
            page.on("pageerror", lambda err: console_log.write(
                f"[pageerror] {err}\n"
            ) or console_log.flush())

            # Snapshot chrome://gpu in this Chrome session so we can audit the
            # GPU init / HW decoder list under Xvfb (different from the user's
            # desktop Chrome). Done in a throwaway tab so the main `page`
            # continues unaffected.
            try:
                gpu_page = await context.new_page()
                await gpu_page.goto("chrome://gpu", wait_until="domcontentloaded")
                # chrome://gpu populates asynchronously after the dom is ready;
                # poll for a marker string before snapshotting.
                for _ in range(30):
                    txt = await gpu_page.evaluate("() => document.body.innerText")
                    if "Graphics Feature Status" in txt:
                        break
                    await asyncio.sleep(0.5)
                (results_dir / "chrome_gpu.txt").write_text(txt or "(empty body)")
                await gpu_page.close()
            except Exception as e:
                (results_dir / "chrome_gpu.txt").write_text(f"chrome://gpu dump failed: {e}\n")

            # Chrome opened with the URL on argv, but the tab Playwright picks
            # up via CDP can be a blank/new-tab depending on startup ordering.
            # Navigate explicitly so the client-js app is guaranteed to load.
            # bufferTimeDefault=300 keeps ABR's ThroughputRule active for the
            # whole ramp run (buffer reaches ~95s at low-bitrate steps; BOLA
            # would otherwise hold high quality once buffer crosses the
            # default 18s threshold).
            await page.goto(
                "http://localhost:8080/?bufferTimeDefault=300",
                wait_until="domcontentloaded",
            )

            for _ in range(60):
                result = await page.evaluate("() => window.__moqtailMetrics !== undefined")
                if result:
                    break
                await asyncio.sleep(1)
            else:
                raise RuntimeError("Client-JS never exposed __moqtailMetrics")

            # Auto-connect: fill relay URL / namespace and click Connect.
            # The client-js UI sits idle until the user clicks, so ABR metrics
            # (window.__moqtailMetrics.abr) stay null.
            await page.locator('input[type="url"]').fill(relay_url)
            await page.locator('input[type="text"]').first.fill("moqtail")
            await page.get_by_role("button", name="Connect").click()

            # Wait until ABR pipeline is actually running (abr object populated).
            for _ in range(30):
                has_abr = await page.evaluate(
                    "() => window.__moqtailMetrics?.abr != null"
                )
                if has_abr:
                    break
                await asyncio.sleep(1)
            else:
                page_state = await page.evaluate(
                    "() => ({"
                    "status: document.querySelector('[data-status]')?.getAttribute('data-status'),"
                    "bodyText: document.body.innerText.slice(0, 2000),"
                    "metrics: window.__moqtailMetrics"
                    "})"
                )
                raise RuntimeError(
                    f"ABR pipeline never started after Connect click. "
                    f"Page state: {page_state}"
                )

            yield page

            await browser.close()
    finally:
        for proc in (socat_proc, chrome_proc, http_proc, weston_proc):
            if proc is None or proc.poll() is not None:
                continue
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                proc.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        # Chrome sometimes re-parents its main browser process to init before
        # the fixture's SIGTERM reaches it — especially when the GPU process
        # crashes during startup. Belt-and-suspenders: kill anything still
        # pointing at this run's user_data_dir (uniquely named per fixture).
        subprocess.run(
            ["pkill", "-KILL", "-f", f"--user-data-dir={user_data_dir}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        for f in (chrome_log, http_log, socat_log, weston_log):
            try:
                f.close()
            except Exception:
                pass
        shutil.rmtree(user_data_dir, ignore_errors=True)


@pytest.fixture
def collector(results_dir):
    """Return a fresh MetricsCollector.

    Always persists samples/switches to results_dir at teardown so a
    failing assertion doesn't eat the data we need to debug it.
    """
    c = MetricsCollector()
    yield c
    try:
        c.save_csv(results_dir / "metrics.csv")
        c.save_switches_json(results_dir / "switches.json")
    except Exception:
        pass


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
