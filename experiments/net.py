"""Network shaping backends for the experiment runner.

Two backends:

* ``none``  -- no shaping; every ``apply`` is only logged. Use it on macOS or
  for smoke tests.
* ``netns`` -- Linux only, needs root. Creates a network namespace for the
  browser, joined to the host by a veth pair. The relay (and Vite) listen on
  the host side; the browser inside the namespace reaches them through the
  veth. The relay->client direction is shaped on the host-side veth egress,
  the client->relay direction on the namespace-side veth egress, so the
  bottleneck sits exactly where the notes place it: between relay and client.

Queue models (``queue`` in a profile):

* ``tail-drop`` -- HTB rate limit with a netem leaf of ``queue_pkts`` packets
  (FIFO, drop-tail). Delay and loss are applied on the same leaf.
* ``fq_codel`` -- HTB rate limit with an fq_codel leaf; delay/loss are applied
  by a netem on the namespace side instead (fq_codel and netem do not stack
  well on one interface).

Background TCP flows (iperf3) run from inside the namespace to an iperf3
server on the host, so they share the bottleneck with the video.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import time
from dataclasses import dataclass


@dataclass
class Shape:
    rate_mbps: float | None = None  # None = unlimited
    delay_ms: float = 0.0
    loss_pct: float = 0.0
    jitter_ms: float = 0.0


def sudo_prefix() -> list[str]:
    """`ip`/`tc` need root. Run them through non-interactive sudo when the runner
    itself is unprivileged (the browser, relay and publisher then stay the
    user's own processes). `sudo -v` once before a series, or a NOPASSWD rule
    for ip/tc/kill, keeps the prompt out of the run."""
    return [] if os.geteuid() == 0 else ["sudo", "-n"]


def _run(cmd: str, check: bool = True, quiet: bool = False) -> subprocess.CompletedProcess:
    argv = sudo_prefix() + shlex.split(cmd)
    if not quiet:
        print(f"[net] $ {' '.join(argv)}")
    return subprocess.run(argv, check=check, capture_output=True, text=True)


class NoneBackend:
    name = "none"

    def __init__(self, **_: object) -> None:
        pass

    def setup(self) -> None:
        print("[net] backend=none: no shaping will be applied")

    def apply(self, shape: Shape, queue: str, queue_pkts: int) -> None:
        print(f"[net] (not applied) {shape} queue={queue}/{queue_pkts}")

    def teardown(self) -> None:
        pass

    def wrap(self, cmd: list[str]) -> list[str]:
        """Command prefix to run a process on the client side (none here)."""
        return cmd

    @property
    def detaches_itself(self) -> bool:
        return False

    @property
    def relay_host(self) -> str:
        return "127.0.0.1"

    @property
    def vite_host(self) -> str:
        return "localhost"


class NetnsBackend:
    name = "netns"

    def __init__(
        self,
        ns: str = "moqc",
        host_if: str = "veth-moqh",
        ns_if: str = "veth-moqc",
        host_ip: str = "10.200.0.1",
        ns_ip: str = "10.200.0.2",
        prefix: int = 24,
    ) -> None:
        self.ns, self.host_if, self.ns_if = ns, host_if, ns_if
        self.host_ip, self.ns_ip, self.prefix = host_ip, ns_ip, prefix

    # -- lifecycle -----------------------------------------------------------
    def setup(self) -> None:
        if os.geteuid() != 0:
            probe = subprocess.run(["sudo", "-n", "true"], capture_output=True)
            if probe.returncode != 0:
                raise SystemExit("[net] backend=netns needs passwordless sudo for ip/tc: run `sudo -v` first "
                                 "(or add a NOPASSWD rule), then retry")
        self.teardown()
        _run(f"ip netns add {self.ns}")
        _run(f"ip link add {self.host_if} type veth peer name {self.ns_if}")
        _run(f"ip link set {self.ns_if} netns {self.ns}")
        _run(f"ip addr add {self.host_ip}/{self.prefix} dev {self.host_if}")
        _run(f"ip link set {self.host_if} up")
        _run(f"ip netns exec {self.ns} ip addr add {self.ns_ip}/{self.prefix} dev {self.ns_if}")
        _run(f"ip netns exec {self.ns} ip link set {self.ns_if} up")
        _run(f"ip netns exec {self.ns} ip link set lo up")
        _run(f"ip netns exec {self.ns} ip route add default via {self.host_ip}")
        # Large-ish MTU-independent sanity: ensure the host answers.
        _run(f"ip netns exec {self.ns} ping -c 1 -W 1 {self.host_ip}", check=False, quiet=True)

    def teardown(self) -> None:
        _run(f"ip netns del {self.ns}", check=False, quiet=True)
        _run(f"ip link del {self.host_if}", check=False, quiet=True)

    # -- shaping -------------------------------------------------------------
    def apply(self, shape: Shape, queue: str, queue_pkts: int) -> None:
        host = f"tc qdisc {{}} dev {self.host_if}"
        nsdev = f"ip netns exec {self.ns} tc qdisc {{}} dev {self.ns_if}"
        _run(host.format("del") + " root", check=False, quiet=True)
        _run(nsdev.format("del") + " root", check=False, quiet=True)

        half = shape.delay_ms / 2.0
        netem_common = f"delay {half}ms {shape.jitter_ms}ms" if shape.jitter_ms else f"delay {half}ms"
        if shape.loss_pct > 0:
            netem_common += f" loss {shape.loss_pct}%"

        if shape.rate_mbps is None:
            # Delay/loss only, no rate limit.
            _run(host.format("add") + f" root handle 1: netem {netem_common} limit {queue_pkts}")
            _run(nsdev.format("add") + f" root handle 1: netem {netem_common} limit {queue_pkts}")
            return

        rate = f"{shape.rate_mbps}mbit"
        # relay -> client: HTB rate limit on the host-side veth egress.
        _run(host.format("add") + " root handle 1: htb default 10")
        _run(f"tc class add dev {self.host_if} parent 1: classid 1:10 htb rate {rate} ceil {rate}")
        if queue == "fq_codel":
            _run(host.format("add") + " parent 1:10 handle 10: fq_codel")
            # Delay/loss for both directions live on the namespace side.
            _run(nsdev.format("add") + f" root handle 1: netem delay {shape.delay_ms}ms"
                 + (f" loss {shape.loss_pct}%" if shape.loss_pct > 0 else ""))
        else:
            _run(host.format("add") + f" parent 1:10 handle 10: netem {netem_common} limit {queue_pkts}")
            # client -> relay: the other half of the RTT, unshaped rate (ACK path).
            _run(nsdev.format("add") + f" root handle 1: netem {netem_common} limit {queue_pkts}")

    # -- helpers -------------------------------------------------------------
    def wrap(self, cmd: list[str]) -> list[str]:
        """Run `cmd` inside the namespace. Entering a namespace needs root; the
        command itself is dropped back to the invoking user so the browser
        never runs as root (Chromium refuses, Firefox misbehaves, and the
        profile would be root-owned)."""
        if os.geteuid() == 0:
            return ["ip", "netns", "exec", self.ns] + cmd
        user = os.environ.get("SUDO_USER") or os.environ.get("USER") or str(os.getuid())
        keep = [f"{k}={v}" for k, v in os.environ.items()
                if k in ("HOME", "PATH", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "LANG", "MOZ_LOG", "MOZ_LOG_FILE")]
        # `runuser` (util-linux) lets root become the user without consulting the
        # sudo policy. `setsid -w` detaches the command into its own session only
        # *after* sudo has run: Ubuntu's sudo caches credentials per terminal, so
        # the sudo itself must keep the runner's terminal (a session-less sudo
        # sees no timestamp and fails with "a password is required").
        return ["sudo", "-n", "ip", "netns", "exec", self.ns, "runuser", "-u", user, "--",
                "setsid", "-w", "env", *keep] + cmd

    @property
    def detaches_itself(self) -> bool:
        """The wrapped command creates its own session; the caller must not."""
        return os.geteuid() != 0

    @property
    def relay_host(self) -> str:
        return self.host_ip

    @property
    def vite_host(self) -> str:
        return self.host_ip


def make_backend(name: str, **kwargs: object):
    if name == "none":
        return NoneBackend(**kwargs)
    if name == "netns":
        return NetnsBackend(**kwargs)
    raise SystemExit(f"unknown net backend {name!r}")


class BackgroundFlows:
    """iperf3 TCP flows from the client side to the relay side.

    ``pattern`` is ``steady`` (N parallel flows for the whole run) or
    ``bursty`` (N flows on for ``on_s`` seconds, off for ``off_s``).
    """

    def __init__(self, backend, flows: int, pattern: str = "steady", on_s: float = 10, off_s: float = 10,
                 port: int = 5201, cc: str | None = None, log=None) -> None:
        self.backend, self.flows, self.pattern = backend, flows, pattern
        self.on_s, self.off_s, self.port, self.cc = on_s, off_s, port, cc
        self.server: subprocess.Popen | None = None
        self.client: subprocess.Popen | None = None
        self.log = log or (lambda *_: None)
        self._next_toggle = 0.0
        self._on = False

    def start(self, duration_s: float) -> None:
        if self.flows <= 0:
            return
        self.server = subprocess.Popen(["iperf3", "-s", "-p", str(self.port)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)
        if self.pattern == "steady":
            self._start_client(duration_s)
        else:
            self._next_toggle = time.time()
        self.log("BG_FLOWS", {"flows": self.flows, "pattern": self.pattern, "cc": self.cc, "port": self.port})

    def _start_client(self, seconds: float) -> None:
        cmd = ["iperf3", "-c", self.backend.relay_host, "-p", str(self.port), "-t", str(int(seconds)),
               "-P", str(self.flows)]
        if self.cc:
            cmd += ["-C", self.cc]
        self.client = subprocess.Popen(self.backend.wrap(cmd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       preexec_fn=None if self.backend.detaches_itself else os.setsid)
        self._on = True
        self.log("BG_FLOW_ON", {"flows": self.flows, "seconds": seconds})

    def tick(self) -> None:
        """Call periodically; drives the bursty pattern."""
        if self.flows <= 0 or self.pattern != "bursty":
            return
        now = time.time()
        if now < self._next_toggle:
            return
        if self._on:
            if self.client:
                self.client.terminate()
            self._on = False
            self.log("BG_FLOW_OFF", {})
            self._next_toggle = now + self.off_s
        else:
            self._start_client(self.on_s)
            self._next_toggle = now + self.on_s

    def stop(self) -> None:
        # The client may sit behind sudo/runuser wrappers: signal it by command line.
        subprocess.run(["pkill", "-TERM", "-f", f"iperf3 -c {self.backend.relay_host}"], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for p in (self.client, self.server):
            if p and p.poll() is None:
                p.terminate()
