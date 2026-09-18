from mininet.topo import Topo
from mininet.net import Mininet
from mininet.link import TCLink, Link
from mininet.log import setLogLevel
from mininet.node import OVSSwitch


class MoqtailTopo(Topo):
    """publisher -- s1_{b} -- relay -- s2_{b} -- client; relay is dual-homed.

    net_idx is used as the second IP octet (10.{b}.x.y) and as a switch-name
    suffix (s1_{b}, s2_{b}) so that multiple Mininet instances can coexist on
    the same host without OVS bridge or root-namespace interface name conflicts.
    """

    def build(
        self,
        link1_bw: int = 10,
        link2_bw: int = 5,
        delay: str = "10ms",
        loss: float = 0,
        net_idx: int = 0,
    ):
        b = net_idx
        publisher = self.addHost("publisher", ip=f"10.{b}.1.1/24")
        relay = self.addHost("relay")
        client = self.addHost("client", ip=f"10.{b}.2.1/24")

        # failMode="standalone": OVS runs the switches as self-learning L2
        # bridges with no OpenFlow controller. Without this, Mininet starts a
        # default controller bound to the process-global TCP port 6653; under
        # pytest-xdist every worker's net.start() then races for that single
        # port and all but one die with "Please shut down the controller which
        # is running on port 6653". A controllerless standalone bridge needs no
        # shared resource, so workers stay independent.
        s1 = self.addSwitch(f"s1_{b}", failMode="standalone")
        s2 = self.addSwitch(f"s2_{b}", failMode="standalone")

        self.addLink(publisher, s1, cls=TCLink, bw=link1_bw, delay=delay, loss=loss)
        self.addLink(relay, s1, cls=TCLink, bw=link1_bw, delay=delay, loss=loss)
        self.addLink(relay, s2, cls=TCLink, bw=link2_bw, delay=delay, loss=loss)
        self.addLink(client, s2, cls=TCLink, bw=link2_bw, delay=delay, loss=loss)


def create_network(
    link1_bw: int = 10,
    link2_bw: int = 5,
    delay: str = "10ms",
    loss: float = 0,
    net_idx: int = 0,
) -> Mininet:
    b = net_idx
    setLogLevel("info")
    topo = MoqtailTopo(
        link1_bw=link1_bw,
        link2_bw=link2_bw,
        delay=delay,
        loss=loss,
        net_idx=net_idx,
    )
    # controller=None pairs with the switches' failMode="standalone" (see
    # MoqtailTopo.build): no OpenFlow controller is created, so nothing binds
    # the global port 6653 and parallel xdist workers don't collide there.
    net = Mininet(
        topo=topo,
        link=TCLink,
        switch=OVSSwitch,
        controller=None,
        autoSetMacs=True,
    )

    relay = net.get("relay")
    relay.setIP(f"10.{b}.1.2/24", intf="relay-eth0")
    relay.setIP(f"10.{b}.2.2/24", intf="relay-eth1")

    # Root-namespace host on s2_{b} so pytest can reach services in the client
    # netns (Chrome's CDP port). Plain Link, not TCLink — TCLink would throttle
    # the test's control channel along with the data path.
    root0 = net.addHost(f"root0_{b}", inNamespace=False)
    s2 = net.get(f"s2_{b}")
    root_link = net.addLink(root0, s2, cls=Link)

    net.start()

    root0.setIP(f"10.{b}.2.100/24", intf=root_link.intf1)

    # Routes go in after start() so the namespaces are fully up.
    client = net.get("client")
    client.cmd(f"ip route add 10.{b}.1.0/24 via 10.{b}.2.2")

    publisher = net.get("publisher")
    publisher.cmd(f"ip route add 10.{b}.2.0/24 via 10.{b}.1.2")

    net._net_idx = net_idx
    return net
