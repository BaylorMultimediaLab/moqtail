"""Dynamic traffic shaping via tc/netem on Mininet host interfaces."""

from mininet.node import Host


def _get_intf_name(host: Host, index: int) -> str:
    return f"{host.name}-eth{index}"


def change_link_bw(host: Host, intf_index: int, bw_mbps: float) -> None:
    intf = _get_intf_name(host, intf_index)
    bw_kbps = int(bw_mbps * 1000)
    host.cmd(f"tc qdisc replace dev {intf} root tbf rate {bw_kbps}kbit burst 15k latency 50ms")


def change_link_delay(host: Host, intf_index: int, delay_ms: int, jitter_ms: int = 0) -> None:
    intf = _get_intf_name(host, intf_index)
    jitter_part = f" {jitter_ms}ms" if jitter_ms > 0 else ""
    host.cmd(f"tc qdisc replace dev {intf} root netem delay {delay_ms}ms{jitter_part}")


def change_link_loss(host: Host, intf_index: int, loss_pct: float) -> None:
    intf = _get_intf_name(host, intf_index)
    host.cmd(f"tc qdisc replace dev {intf} root netem loss {loss_pct}%")


def shape_link(
    host: Host,
    intf_index: int,
    bw_mbps: float | None = None,
    delay_ms: int | None = None,
    jitter_ms: int = 0,
    loss_pct: float | None = None,
) -> None:
    intf = _get_intf_name(host, intf_index)

    host.cmd(f"tc qdisc del dev {intf} root 2>/dev/null")

    netem_params = ""
    if delay_ms is not None:
        netem_params += f" delay {delay_ms}ms"
        if jitter_ms > 0:
            netem_params += f" {jitter_ms}ms"
    if loss_pct is not None and loss_pct > 0:
        netem_params += f" loss {loss_pct}%"

    if netem_params and bw_mbps is not None:
        bw_kbps = int(bw_mbps * 1000)
        host.cmd(f"tc qdisc add dev {intf} root handle 1: netem{netem_params}")
        host.cmd(
            f"tc qdisc add dev {intf} parent 1: handle 2: tbf rate {bw_kbps}kbit burst 15k latency 50ms"
        )
    elif netem_params:
        host.cmd(f"tc qdisc add dev {intf} root netem{netem_params}")
    elif bw_mbps is not None:
        bw_kbps = int(bw_mbps * 1000)
        host.cmd(f"tc qdisc add dev {intf} root tbf rate {bw_kbps}kbit burst 15k latency 50ms")


def shape_link2(net, bw_mbps: float | None = None, delay_ms: int | None = None,
                jitter_ms: int = 0, loss_pct: float | None = None) -> None:
    """Shape the relay-client link from both ends (relay-eth1 + client-eth0)."""
    relay = net.get("relay")
    client = net.get("client")
    shape_link(relay, 1, bw_mbps=bw_mbps, delay_ms=delay_ms, jitter_ms=jitter_ms, loss_pct=loss_pct)
    shape_link(client, 0, bw_mbps=bw_mbps, delay_ms=delay_ms, jitter_ms=jitter_ms, loss_pct=loss_pct)


def shape_link1(net, bw_mbps: float | None = None, delay_ms: int | None = None,
                jitter_ms: int = 0, loss_pct: float | None = None) -> None:
    """Shape the publisher-relay link from both ends (publisher-eth0 + relay-eth0)."""
    publisher = net.get("publisher")
    relay = net.get("relay")
    shape_link(publisher, 0, bw_mbps=bw_mbps, delay_ms=delay_ms, jitter_ms=jitter_ms, loss_pct=loss_pct)
    shape_link(relay, 0, bw_mbps=bw_mbps, delay_ms=delay_ms, jitter_ms=jitter_ms, loss_pct=loss_pct)
