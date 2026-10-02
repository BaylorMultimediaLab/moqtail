#!/usr/bin/env python3
"""Realign a publisher GOP cache so that every group starts on its keyframe.

The publisher's software encode path (apps/publisher/src/encoder.rs,
encode_gop_sw) stamps each packet the encoder emits with the decode time and
keyframe flag of the frame it has just *sent*; x265 emits with a latency of
several frames, so group file k holds the last D frames of GOP k-1 followed by
the first N-D frames of GOP k, object 0 is a P-frame and the keyframe sits at
packet D. Every switch that "lands on a group boundary" then lands on a frame
the decoder cannot start from.

This tool re-chunks the packet sequence at the keyframes and re-stamps each
CMAF chunk (prft media time, mfhd sequence number, tfdt, trun sync flag) so
that group k = frames [k*N, (k+1)*N) and object 0 is the IDR. Trailing frames
that do not fill a group are dropped. meta.json is rewritten.

    python3 scripts/realign_cache.py data/encoded/tears_of_steel_240s_1080p            # in place (keeps a .bak copy)
    python3 scripts/realign_cache.py <cache> --out data/encoded/<cache>_aligned           # to a new directory
"""
import argparse
import json
import shutil
import struct
import sys
from pathlib import Path

RAP = {16, 17, 18, 19, 20, 21}


def boxes(buf: bytes):
    pos = 0
    while pos + 8 <= len(buf):
        (size,) = struct.unpack(">I", buf[pos:pos + 4])
        kind = buf[pos + 4:pos + 8]
        if size < 8:
            return
        yield pos, size, kind
        pos += size


def find_box(buf: bytes, kind: bytes, start: int = 0, end: int | None = None):
    end = len(buf) if end is None else end
    pos = start
    while pos + 8 <= end:
        (size,) = struct.unpack(">I", buf[pos:pos + 4])
        if size < 8:
            return None
        if buf[pos + 4:pos + 8] == kind:
            return pos, size
        pos += size
    return None


def chunk_info(pkt: bytes):
    """Offsets of the fields we re-stamp, plus whether the mdat holds a RAP."""
    prft = find_box(pkt, b"prft")
    moof = find_box(pkt, b"moof")
    mdat = find_box(pkt, b"mdat")
    if not (prft and moof and mdat):
        raise ValueError("packet is not prft+moof+mdat")
    mp, _ = prft
    mo, ms = moof
    mfhd = find_box(pkt, b"mfhd", mo + 8, mo + ms)
    traf = find_box(pkt, b"traf", mo + 8, mo + ms)
    tfdt = find_box(pkt, b"tfdt", traf[0] + 8, traf[0] + traf[1])
    trun = find_box(pkt, b"trun", traf[0] + 8, traf[0] + traf[1])
    # prft: fullbox(12) reference_track_ID(4) ntp(8) media_time(8)
    media_time_off = mp + 12 + 4 + 8
    seq_off = mfhd[0] + 12
    tfdt_off = tfdt[0] + 12  # version 1: u64
    assert pkt[tfdt[0] + 8] == 1, "tfdt must be version 1"
    (trun_flags,) = struct.unpack(">I", pkt[trun[0] + 8:trun[0] + 12])
    assert trun_flags & 0xFFFFFF == 0x000701, f"unexpected trun flags {trun_flags:#x}"
    flags_off = trun[0] + 12 + 4 + 4 + 4 + 4  # sample_count, data_offset, duration, size
    (duration,) = struct.unpack(">I", pkt[trun[0] + 12 + 4 + 4:trun[0] + 12 + 4 + 4 + 4])
    md, mds = mdat
    data = pkt[md + 8:md + mds]
    types, pos = [], 0
    while pos + 4 <= len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        if n == 0 or pos + 4 + n > len(data):
            break
        types.append((data[pos + 4] >> 1) & 0x3F)
        pos += 4 + n
    return {"media_time_off": media_time_off, "seq_off": seq_off, "tfdt_off": tfdt_off,
            "flags_off": flags_off, "duration": duration, "is_rap": any(t in RAP for t in types)}


def read_gop(path: Path) -> list[bytes]:
    data = path.read_bytes()
    (count,) = struct.unpack("<I", data[:4])
    pos, packets = 4, []
    for _ in range(count):
        (n,) = struct.unpack("<I", data[pos:pos + 4])
        packets.append(data[pos + 4:pos + 4 + n])
        pos += 4 + n
    return packets


def write_gop(path: Path, packets: list[bytes]) -> None:
    out = bytearray(struct.pack("<I", len(packets)))
    for p in packets:
        out += struct.pack("<I", len(p)) + p
    path.write_bytes(out)


def realign_variant(src: Path, dst: Path, gop_frames: int) -> tuple[int, int, int]:
    files = sorted(src.glob("*.gop"), key=lambda f: int(f.stem))
    flat: list[bytes] = []
    for f in files:
        flat.extend(read_gop(f))
    infos = [chunk_info(p) for p in flat]
    raps = [i for i, inf in enumerate(infos) if inf["is_rap"]]
    if not raps:
        raise SystemExit(f"{src}: no keyframes found")
    strides = {b - a for a, b in zip(raps, raps[1:])}
    if strides and strides != {gop_frames}:
        print(f"  WARNING {src.name}: keyframe spacing {sorted(strides)} is not uniformly {gop_frames}; "
              f"groups are cut at the keyframes, meta gop count follows the first")
    duration = infos[0]["duration"]
    dst.mkdir(parents=True, exist_ok=True)
    for old in dst.glob("*.gop"):
        old.unlink()
    # per-variant metadata (variant.json: resolution, bitrate, init segment data)
    for extra in src.iterdir():
        if extra.is_file() and extra.suffix != ".gop" and not (dst / extra.name).exists():
            shutil.copy2(extra, dst / extra.name)
    groups = 0
    seq = 0
    for gi, start in enumerate(raps):
        end = raps[gi + 1] if gi + 1 < len(raps) else len(flat)
        if gi + 1 >= len(raps) and end - start < gop_frames:
            break  # trailing partial group (the encoder's flush) is dropped
        packets = []
        for j in range(start, end):
            pkt = bytearray(flat[j])
            inf = infos[j]
            decode_time = (gi * gop_frames + (j - start)) * duration
            struct.pack_into(">Q", pkt, inf["media_time_off"], decode_time)
            struct.pack_into(">I", pkt, inf["seq_off"], seq)
            struct.pack_into(">Q", pkt, inf["tfdt_off"], decode_time)
            struct.pack_into(">I", pkt, inf["flags_off"], 0x02000000 if j == start else 0x01010000)
            seq += 1
            packets.append(bytes(pkt))
        write_gop(dst / f"{gi:06}.gop", packets)
        groups += 1
    return len(flat), groups, raps[0]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cache", type=Path)
    ap.add_argument("--out", type=Path, default=None, help="write here instead of in place")
    args = ap.parse_args()
    meta = json.loads((args.cache / "meta.json").read_text())
    fps = meta["framerate"]
    gop_frames = int(round(fps))
    src_root = args.cache
    if args.out is None:
        bak = args.cache.with_name(args.cache.name + ".bak")
        if bak.exists():
            raise SystemExit(f"{bak} exists; remove it or use --out")
        shutil.copytree(args.cache, bak)
        src_root = bak
        print(f"backup of the original cache: {bak}")
        dst_root = args.cache
    else:
        dst_root = args.out
        dst_root.mkdir(parents=True, exist_ok=True)
    counts = []
    for variant in meta["variants"]:
        n, groups, first_rap = realign_variant(src_root / variant, dst_root / variant, gop_frames)
        print(f"  {variant}: {n} frames -> {groups} aligned groups of {gop_frames} (first keyframe was packet {first_rap})")
        counts.append(groups)
    meta["gops_per_variant"] = min(counts)
    meta["realigned"] = True
    (dst_root / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {dst_root / 'meta.json'}: gops_per_variant {meta['gops_per_variant']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
