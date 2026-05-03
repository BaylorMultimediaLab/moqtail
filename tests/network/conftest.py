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
    config_path = request.config.getoption("--config")
    with open(config_path) as f:
        return yaml.safe_load(f)


@pytest.fixture(scope="session")
def project_root():
    return Path(__file__).parent.parent.parent


@pytest.fixture(scope="session")
def results_base():
    base = Path(__file__).parent / "results"
    base.mkdir(exist_ok=True)
    return base


@pytest.fixture
def results_dir(results_base, request):
    test_name = request.node.name
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    d = results_base / test_name / timestamp
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture
def net(config):
    # Clean any leaked Mininet state from a prior run BEFORE creating the
    # network. Without this, when a previous test errors during topology
    # construction, its `try/finally` cleanup never runs and leaves veth
    # pairs (client-eth0, s2-eth2, etc.) in the root namespace. The next
    # `addLink` then fails with "RTNETLINK answers: File exists" and
    # cascades through every subsequent test in the session.
    subprocess.run(
        ["mn", "-c"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )

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
        # root0 has inNamespace=False, so mininet.stop() leaves its veth behind
        # and the next run's addLink fails with "RTNETLINK answers: File exists".
        subprocess.run(
            ["ip", "link", "del", "root0-eth0"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )


@pytest.fixture
def relay_proc(net, config, project_root, results_dir):
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

    # MoQT is QUIC/UDP — `ss -tlnp` would never see it.
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

    time.sleep(5)

    if proc.poll() is not None:
        stdout = proc.stdout.read().decode() if proc.stdout else ""
        raise RuntimeError(f"Publisher exited early with code {proc.returncode}: {stdout}")

    yield proc
    proc.terminate()
    proc.wait(timeout=10)


def _find_chrome_binary() -> str:
    # Playwright's bundled Chromium omits HEVC (patent-encumbered) and the
    # client-js catalog is hvc1-only, so prefer Google Chrome stable. Avoid
    # the Ubuntu snap `chromium-browser`: snap confinement fights Mininet
    # netns and forks helpers until OOM.
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


def pytest_configure(config):
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


@pytest.fixture
async def browser_page(net, config, results_dir, request):
    # Headful under Weston, not --headless=new. With --headless=new on Linux +
    # AMD VA-API the GPU process exits 8704 trying to allocate a platform
    # GpuMemoryBuffer for HEVC frames → PIPELINE_ERROR_DISCONNECTED → the
    # client retries in a loop and leaks RAM.
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
        # mnexec -da already calls setsid(); double-setsid returns EPERM,
        # so don't pass start_new_session=True here.
        http_proc = client.popen(
            ["python3", "-m", "http.server", "8080", "--directory", dist_path],
            stdout=http_log,
            stderr=subprocess.STDOUT,
        )
        await asyncio.sleep(1)

        # Xvfb has no DRI3 support, so Chrome's HEVC decoder can't allocate
        # dma-buf-backed SharedImages and the GPU process exits 8704. Weston's
        # headless backend wires up DRM/render nodes directly.
        weston_runtime_dir = Path(tempfile.mkdtemp(prefix="moqtail-weston-runtime-"))
        os.chmod(weston_runtime_dir, 0o700)
        wayland_socket = f"wayland-test-{os.getpid()}"
        weston_env = {**os.environ, "XDG_RUNTIME_DIR": str(weston_runtime_dir)}
        # --renderer=gl makes weston advertise zwp_linux_dmabuf_v1, which
        # Chrome needs for HW-decoded HEVC frames. The default `noop` renderer
        # doesn't expose it.
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

        # Scrub the user's desktop Wayland/DBus env so Chrome attaches to our
        # test compositor, not theirs.
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
        # org.gnome.settings-daemon.plugins.xsettings, but gsd 43+ moved it
        # to a .deprecated schema — GLib's g_error() then aborts Chrome at
        # startup. Patch the schema so the key is back where Chrome expects.
        schema_dir = Path(tempfile.mkdtemp(prefix="moqtail-gschemas-"))
        for src in Path("/usr/share/glib-2.0/schemas").glob("*.gschema.xml"):
            (schema_dir / src.name).write_text(src.read_text())
        for src in Path("/usr/share/glib-2.0/schemas").glob("*.enums.xml"):
            (schema_dir / src.name).write_text(src.read_text())
        xs = schema_dir / "org.gnome.settings-daemon.plugins.xsettings.gschema.xml"
        xs_text = xs.read_text()
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

        for i in range(30):
            rc = chrome_proc.poll()
            listening = "9222" in client.cmd("ss -tlnp | grep 9222")
            if rc is not None and not listening:
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

        # Chrome ignores --remote-debugging-address=0.0.0.0 and binds CDP to
        # 127.0.0.1; socat inside the netns republishes it on client_ip so
        # pytest (root netns, reaching via root0) can connect.
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

            console_log_path = results_dir / "browser_console.log"
            console_log = open(console_log_path, "w")
            page.on("console", lambda msg: console_log.write(
                f"[{msg.type}] {msg.text}\n"
            ) or console_log.flush())
            page.on("pageerror", lambda err: console_log.write(
                f"[pageerror] {err}\n"
            ) or console_log.flush())

            try:
                gpu_page = await context.new_page()
                await gpu_page.goto("chrome://gpu", wait_until="domcontentloaded")
                # chrome://gpu populates async after DOM ready.
                for _ in range(30):
                    txt = await gpu_page.evaluate("() => document.body.innerText")
                    if "Graphics Feature Status" in txt:
                        break
                    await asyncio.sleep(0.5)
                (results_dir / "chrome_gpu.txt").write_text(txt or "(empty body)")
                await gpu_page.close()
            except Exception as e:
                (results_dir / "chrome_gpu.txt").write_text(f"chrome://gpu dump failed: {e}\n")

            # bufferTimeDefault=300 keeps ThroughputRule active for the whole
            # ramp run; BOLA would otherwise take over once buffer crosses
            # the default 18s threshold. Tests can layer extra ABR settings via
            # the @pytest.mark.abr_url_overrides(...) marker.
            url_params = {"bufferTimeDefault": "300"}
            override_marker = request.node.get_closest_marker("abr_url_overrides")
            if override_marker:
                for k, v in (override_marker.kwargs or {}).items():
                    url_params[k] = str(v)
            query = "&".join(f"{k}={v}" for k, v in url_params.items())
            await page.goto(
                f"http://localhost:8080/?{query}",
                wait_until="domcontentloaded",
            )

            for _ in range(60):
                result = await page.evaluate("() => window.__moqtailMetrics !== undefined")
                if result:
                    break
                await asyncio.sleep(1)
            else:
                raise RuntimeError("Client-JS never exposed __moqtailMetrics")

            # Test harness ABR override: experiment cells stamp this marker per
            # parametric instance (E6 sweep). The hook in apps/client-js/src/app.tsx
            # reads window.__abrSettingsOverride at AbrController construction; we
            # set it after page.goto but before Connect click so it lands in time.
            settings_marker = request.node.get_closest_marker("abr_settings_override")
            if settings_marker and settings_marker.args:
                settings = settings_marker.args[0]
                await page.evaluate(
                    "(s) => { window.__abrSettingsOverride = s; }", settings
                )

            # The client-js UI sits idle until Connect is clicked, so the ABR
            # pipeline (and window.__moqtailMetrics.abr) stays null without this.
            await page.locator('input[type="url"]').fill(relay_url)
            await page.locator('input[type="text"]').first.fill("moqtail")
            await page.get_by_role("button", name="Connect").click()

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
        # Chrome can reparent its main process to init before SIGTERM reaches
        # it (especially when the GPU process crashes early), so kill anything
        # still pointing at this run's user_data_dir.
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
    # Persist at teardown so a failing assertion doesn't eat the debug data.
    c = MetricsCollector()
    yield c
    try:
        c.save_csv(results_dir / "metrics.csv")
        c.save_switches_json(results_dir / "switches.json")
        c.save_discontinuities_csv(
            results_dir / "switch_discontinuities.csv",
            c.last_discontinuities,
        )
    except Exception:
        pass


@pytest.fixture
def relay_parser():
    return RelayLogParser()


@pytest.fixture
def thresholds(config):
    return config["thresholds"]


@pytest.fixture
def quality_map(config):
    return config["quality_map"]
