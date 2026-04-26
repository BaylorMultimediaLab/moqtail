from mininet.topo import Topo
from mininet.net import Mininet
from mininet.link import TCLink, Link
from mininet.log import setLogLevel


class MoqtailTopo(Topo):
    """Three-host topology: publisher -- s1 -- relay -- s2 -- client.

    Relay is dual-homed with one interface on each switch.
    link1 (publisher-s1-relay) and link2 (relay-s2-client) are shaped independently.
    """

    def build(
        self,
        link1_bw: int = 10,
        link2_bw: int = 5,
        delay: str = "10ms",
        loss: float = 0,
    ):
        # Hosts
        publisher = self.addHost("publisher", ip="10.0.1.1/24")
        relay = self.addHost("relay")
        client = self.addHost("client", ip="10.0.2.1/24")

        # Switches
        s1 = self.addSwitch("s1")
        s2 = self.addSwitch("s2")

        # link1: publisher <-> s1 <-> relay (publisher-side interface)
        self.addLink(
            publisher,
            s1,
            cls=TCLink,
            bw=link1_bw,
            delay=delay,
            loss=loss,
        )
        self.addLink(
            relay,
            s1,
            cls=TCLink,
            bw=link1_bw,
            delay=delay,
            loss=loss,
        )

        # link2: relay (client-side interface) <-> s2 <-> client
        self.addLink(
            relay,
            s2,
            cls=TCLink,
            bw=link2_bw,
            delay=delay,
            loss=loss,
        )
        self.addLink(
            client,
            s2,
            cls=TCLink,
            bw=link2_bw,
            delay=delay,
            loss=loss,
        )


def create_network(
    link1_bw: int = 10,
    link2_bw: int = 5,
    delay: str = "10ms",
    loss: float = 0,
) -> Mininet:
    """Create and return a started Mininet network with MoqtailTopo."""
    setLogLevel("info")
    topo = MoqtailTopo(
        link1_bw=link1_bw,
        link2_bw=link2_bw,
        delay=delay,
        loss=loss,
    )
    net = Mininet(topo=topo, link=TCLink, autoSetMacs=True)

    # Configure relay dual-homing: relay-eth0 is on s1 (10.0.1.x), relay-eth1 is on s2 (10.0.2.x)
    relay = net.get("relay")
    relay.setIP("10.0.1.2/24", intf="relay-eth0")
    relay.setIP("10.0.2.2/24", intf="relay-eth1")

    # Root-namespace host on s2 so pytest (which lives in the root netns) can
    # reach services inside the client netns — notably Chromium's CDP port.
    # Unshaped plain Link (TCLink here would throttle the control channel too).
    root0 = net.addHost("root0", inNamespace=False)
    s2 = net.get("s2")
    root_link = net.addLink(root0, s2, cls=Link)

    net.start()

    root0.setIP("10.0.2.100/24", intf=root_link.intf1)

    # Add routes after start so network namespaces are fully up
    client = net.get("client")
    client.cmd("ip route add 10.0.1.0/24 via 10.0.2.2")

    publisher = net.get("publisher")
    publisher.cmd("ip route add 10.0.2.0/24 via 10.0.1.2")

    return net
