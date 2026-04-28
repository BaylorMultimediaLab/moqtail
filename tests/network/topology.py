from mininet.topo import Topo
from mininet.net import Mininet
from mininet.link import TCLink, Link
from mininet.log import setLogLevel


class MoqtailTopo(Topo):
    """publisher -- s1 -- relay -- s2 -- client; relay is dual-homed."""

    def build(
        self,
        link1_bw: int = 10,
        link2_bw: int = 5,
        delay: str = "10ms",
        loss: float = 0,
    ):
        publisher = self.addHost("publisher", ip="10.0.1.1/24")
        relay = self.addHost("relay")
        client = self.addHost("client", ip="10.0.2.1/24")

        s1 = self.addSwitch("s1")
        s2 = self.addSwitch("s2")

        self.addLink(publisher, s1, cls=TCLink, bw=link1_bw, delay=delay, loss=loss)
        self.addLink(relay, s1, cls=TCLink, bw=link1_bw, delay=delay, loss=loss)
        self.addLink(relay, s2, cls=TCLink, bw=link2_bw, delay=delay, loss=loss)
        self.addLink(client, s2, cls=TCLink, bw=link2_bw, delay=delay, loss=loss)


def create_network(
    link1_bw: int = 10,
    link2_bw: int = 5,
    delay: str = "10ms",
    loss: float = 0,
) -> Mininet:
    setLogLevel("info")
    topo = MoqtailTopo(
        link1_bw=link1_bw,
        link2_bw=link2_bw,
        delay=delay,
        loss=loss,
    )
    net = Mininet(topo=topo, link=TCLink, autoSetMacs=True)

    relay = net.get("relay")
    relay.setIP("10.0.1.2/24", intf="relay-eth0")
    relay.setIP("10.0.2.2/24", intf="relay-eth1")

    # Root-namespace host on s2 so pytest can reach services in the client
    # netns (Chrome's CDP port). Plain Link, not TCLink — TCLink would throttle
    # the test's control channel along with the data path.
    root0 = net.addHost("root0", inNamespace=False)
    s2 = net.get("s2")
    root_link = net.addLink(root0, s2, cls=Link)

    net.start()

    root0.setIP("10.0.2.100/24", intf=root_link.intf1)

    # Routes go in after start() so the namespaces are fully up.
    client = net.get("client")
    client.cmd("ip route add 10.0.1.0/24 via 10.0.2.2")

    publisher = net.get("publisher")
    publisher.cmd("ip route add 10.0.2.0/24 via 10.0.1.2")

    return net
