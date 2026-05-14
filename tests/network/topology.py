from mininet.topo import Topo
from mininet.net import Mininet
from mininet.link import TCLink, Link
from mininet.log import setLogLevel


# Logical → physical name mapping. Tests still address nodes by their logical
# names ("publisher", "relay", "client", "s1", "s2", "root0"); the WorkerNet
# wrapper in conftest.py translates these to the worker-suffixed physical
# names below before delegating to mininet.
#
# Worker-suffixed names exist because OVS bridges live in the root namespace
# (so `s1`/`s2` would collide between parallel pytest-xdist workers) and veth
# interface names are global at creation time. Linux IFNAMSIZ=16 caps the
# interface name at 15 chars, which is why these are abbreviated — `pub_w99-
# eth0` is 12 chars but `publisher_w0-eth0` is 17.
LOGICAL_NAMES = ("publisher", "relay", "client", "s1", "s2", "root0")


def physical_names(worker_idx: int) -> dict[str, str]:
    suffix = f"_w{worker_idx}"
    return {
        "publisher": f"pub{suffix}",
        "relay": f"rly{suffix}",
        "client": f"cli{suffix}",
        "s1": f"s1{suffix}",
        "s2": f"s2{suffix}",
        "root0": f"r0{suffix}",
    }


def client_alt_ip(worker_idx: int) -> str:
    """Per-worker management IP that pytest (root namespace) uses to reach the
    client netns. Distinct /24 per worker so the root-ns routing table is
    unambiguous when multiple parallel workers each have their own s2 bridge."""
    return f"169.254.{worker_idx}.1"


def _root0_ip(worker_idx: int) -> str:
    """Root-namespace IP on the root0_w<n>-eth0 interface, matched to the
    client's alt subnet so they share the s2 bridge L2 segment."""
    return f"169.254.{worker_idx}.100"


class MoqtailTopo(Topo):
    """publisher -- s1 -- relay -- s2 -- client; relay is dual-homed."""

    def build(
        self,
        worker_idx: int = 0,
        link1_bw: int = 10,
        link2_bw: int = 5,
        delay: str = "10ms",
        loss: float = 0,
    ):
        names = physical_names(worker_idx)

        publisher = self.addHost(names["publisher"], ip="10.0.1.1/24")
        relay = self.addHost(names["relay"])
        client = self.addHost(names["client"], ip="10.0.2.1/24")

        # `failMode=standalone` makes each switch a self-learning bridge with
        # no OpenFlow controller. The default Mininet controller (OVSController)
        # listens on port 6633 in the root namespace, which collides across
        # parallel pytest-xdist workers — only the first to bind wins and the
        # others hang in `net.start()`. We don't use any OpenFlow features
        # anywhere in this topology, so standalone is functionally identical.
        s1 = self.addSwitch(names["s1"], failMode="standalone")
        s2 = self.addSwitch(names["s2"], failMode="standalone")

        self.addLink(publisher, s1, cls=TCLink, bw=link1_bw, delay=delay, loss=loss)
        self.addLink(relay, s1, cls=TCLink, bw=link1_bw, delay=delay, loss=loss)
        self.addLink(relay, s2, cls=TCLink, bw=link2_bw, delay=delay, loss=loss)
        self.addLink(client, s2, cls=TCLink, bw=link2_bw, delay=delay, loss=loss)


def create_network(
    worker_idx: int = 0,
    link1_bw: int = 10,
    link2_bw: int = 5,
    delay: str = "10ms",
    loss: float = 0,
) -> Mininet:
    setLogLevel("info")
    topo = MoqtailTopo(
        worker_idx=worker_idx,
        link1_bw=link1_bw,
        link2_bw=link2_bw,
        delay=delay,
        loss=loss,
    )
    # controller=None pairs with failMode=standalone on each switch (see
    # MoqtailTopo.build) — Mininet won't try to spawn an OVSController, so
    # parallel xdist workers don't race for OpenFlow port 6633.
    net = Mininet(topo=topo, link=TCLink, autoSetMacs=True, controller=None)

    names = physical_names(worker_idx)

    relay = net.get(names["relay"])
    relay.setIP("10.0.1.2/24", intf=f"{relay.name}-eth0")
    relay.setIP("10.0.2.2/24", intf=f"{relay.name}-eth1")

    # Root-namespace host on s2 so pytest can reach services in the client
    # netns (Chrome's CDP port). Plain Link, not TCLink — TCLink would throttle
    # the test's control channel along with the data path.
    root0 = net.addHost(names["root0"], inNamespace=False)
    s2 = net.get(names["s2"])
    root_link = net.addLink(root0, s2, cls=Link)

    net.start()

    # Per-worker management subnet (169.254.<worker_idx>.0/24) gives the root
    # namespace a unique route to each worker's client netns. The in-netns
    # 10.0.1/24 and 10.0.2/24 subnets stay identical across workers — they're
    # isolated by netns so no collision.
    root0.setIP(f"{_root0_ip(worker_idx)}/24", intf=root_link.intf1)

    client = net.get(names["client"])
    # Second IP on the client netns side of s2 so root0 can address it on the
    # per-worker management subnet without disturbing the in-netns 10.0.2.1.
    client.cmd(f"ip addr add {client_alt_ip(worker_idx)}/24 dev {client.name}-eth0")
    client.cmd("ip route add 10.0.1.0/24 via 10.0.2.2")

    publisher = net.get(names["publisher"])
    publisher.cmd("ip route add 10.0.2.0/24 via 10.0.1.2")

    return net
