#!/usr/bin/env python3
"""Integrity check of a publisher GOP cache (data/encoded/<name>).

For every variant and every NNNNNN.gop file (packets are CMAF chunks: prft+moof+mdat): packet count, that packet 0 is an
HEVC random-access picture (IDR/CRA/BLA), that no other packet is, and the
packet size profile. A group that is not 1 GOP = framerate packets, or whose
first packet is not a keyframe, would make a switch landing undecodable on its
own, independent of the mechanism.

    python3 scripts/check_cache.py data/encoded/tears_of_steel_240s_1080p
"""
import json
import struct
import sys
from pathlib import Path

RAP = {16, 17, 18, 19, 20, 21}  # BLA_W_LP..CRA_NUT


def mdat_payload(packet: bytes) -> bytes:
    """A cached packet is one CMAF chunk: prft + moof + mdat boxes. Return the mdat payload."""
    pos = 0
    while pos + 8 <= len(packet):
        (size,) = struct.unpack(">I", packet[pos:pos + 4])
        kind = packet[pos + 4:pos + 8]
        if size == 1:
            (size,) = struct.unpack(">Q", packet[pos + 8:pos + 16]); hdr = 16
        else:
            hdr = 8
        if size < hdr:
            break
        if kind == b"mdat":
            return packet[pos + hdr:pos + size]
        pos += size
    return b""


def nal_types(packet: bytes) -> list[int]:
    """HEVC NAL unit types of the chunk's mdat (HVCC length-prefixed NALs)."""
    data = mdat_payload(packet) or packet
    types, pos = [], 0
    while pos + 4 <= len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        if n == 0 or pos + 4 + n > len(data):
            break
        types.append((data[pos + 4] >> 1) & 0x3F)
        pos += 4 + n
    return types


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "data/encoded/video")
    meta = json.loads((root / "meta.json").read_text())
    fps = meta.get("framerate")
    print(f"{root}: framerate {fps}, gops_per_variant {meta.get('gops_per_variant')}, variants {meta.get('variants')}")
    bad = 0
    for variant in meta["variants"]:
        vdir = root / variant
        files = sorted(vdir.glob("*.gop"))
        counts, sizes, problems = [], [], []
        for f in files:
            data = f.read_bytes()
            (count,) = struct.unpack("<I", data[:4])
            pos, packets = 4, []
            for _ in range(count):
                (n,) = struct.unpack("<I", data[pos:pos + 4])
                packets.append(data[pos + 4:pos + 4 + n])
                pos += 4 + n
            counts.append(count)
            sizes.append(sum(len(p) for p in packets))
            if count == 0:
                problems.append(f"{f.name}: empty"); continue
            first = nal_types(packets[0])
            if not any(t in RAP for t in first):
                problems.append(f"{f.name}: packet 0 is not a random-access picture (nal types {first[:6]})")
            for k, p in enumerate(packets[1:], start=1):
                if any(t in RAP for t in nal_types(p)):
                    problems.append(f"{f.name}: packet {k} is a random-access picture (second keyframe inside the group)")
            if any(len(p) == 0 for p in packets):
                problems.append(f"{f.name}: empty packet")
        from collections import Counter
        c = Counter(counts)
        print(f"  {variant}: {len(files)} groups; packets per group {dict(sorted(c.items()))}; group bytes min/median/max "
              f"{min(sizes)}/{sorted(sizes)[len(sizes)//2]}/{max(sizes)}")
        for p in problems[:20]:
            print("    PROBLEM", p)
        bad += len(problems)
        if len(problems) > 20:
            print(f"    ... {len(problems) - 20} more")
    print("OK: every group starts with a keyframe and has one" if bad == 0 else f"{bad} problems")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
