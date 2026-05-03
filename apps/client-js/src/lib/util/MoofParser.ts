/**
 * Walks an ISOBMFF byte buffer descending into moof -> traf -> tfdt and
 * returns baseMediaDecodeTime in milliseconds (using the supplied timescale).
 * Returns undefined if any box in the path is missing or malformed.
 *
 * Sibling parser pattern: see `readPrftCaptureMs` in player.ts (PRFT box,
 * flat layout). This walks nested boxes which PRFT does not require.
 */
export function parseMoofBaseMediaDecodeTime(
  buffer: Uint8Array,
  timescale: number,
): number | undefined {
  if (timescale <= 0) return undefined;

  const moof = findBox(buffer, 0, buffer.byteLength, FOURCC_MOOF);
  if (!moof) return undefined;

  const traf = findBox(buffer, moof.payloadStart, moof.payloadEnd, FOURCC_TRAF);
  if (!traf) return undefined;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return readTfdtMs(view, buffer, traf, timescale);
}

/**
 * Parses moof -> traf -> {tfdt, trun} and returns BOTH the first sample's
 * decode time and its duration in milliseconds. Use this when you need the
 * frame's end PTS (= decode + duration); the publisher emits one moof+mdat
 * per access unit (one frame), so a sample's duration is one frame interval.
 *
 * Returns undefined if any required box is missing/malformed, or if trun
 * does not advertise per-sample duration.
 */
export function parseMoofMediaInfo(
  buffer: Uint8Array,
  timescale: number,
): { decodeTimeMs: number; frameDurationMs: number } | undefined {
  if (timescale <= 0) return undefined;

  const moof = findBox(buffer, 0, buffer.byteLength, FOURCC_MOOF);
  if (!moof) return undefined;
  const traf = findBox(buffer, moof.payloadStart, moof.payloadEnd, FOURCC_TRAF);
  if (!traf) return undefined;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const decodeTimeMs = readTfdtMs(view, buffer, traf, timescale);
  if (decodeTimeMs === undefined) return undefined;

  const trun = findBox(buffer, traf.payloadStart, traf.payloadEnd, FOURCC_TRUN);
  if (!trun) return undefined;
  // trun payload layout:
  //   version+flags (4) | sample_count (4)
  //   data_offset (4)             [if flag 0x000001]
  //   first_sample_flags (4)      [if flag 0x000004]
  //   per first sample (in order, if flag set):
  //     sample_duration (4)       [0x000100]
  //     sample_size (4)           [0x000200]
  //     sample_flags (4)          [0x000400]
  //     sample_cts_offset (4)     [0x000800]
  if (trun.payloadEnd - trun.payloadStart < 8) return undefined;
  const trunFlags = view.getUint32(trun.payloadStart, false) & 0xffffff;
  if ((trunFlags & TRUN_FLAG_SAMPLE_DURATION) === 0) return undefined;

  let p = trun.payloadStart + 8; // past version+flags + sample_count
  if (trunFlags & TRUN_FLAG_DATA_OFFSET) p += 4;
  if (trunFlags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) p += 4;
  if (p + 4 > trun.payloadEnd) return undefined;
  const sampleDurationTicks = view.getUint32(p, false);
  const frameDurationMs = (sampleDurationTicks * 1000) / timescale;

  return { decodeTimeMs, frameDurationMs };
}

function readTfdtMs(
  view: DataView,
  buffer: Uint8Array,
  traf: BoxRange,
  timescale: number,
): number | undefined {
  const tfdt = findBox(buffer, traf.payloadStart, traf.payloadEnd, FOURCC_TFDT);
  if (!tfdt) return undefined;
  if (tfdt.payloadEnd - tfdt.payloadStart < 4) return undefined;
  const versionAndFlags = view.getUint32(tfdt.payloadStart, false);
  const version = (versionAndFlags >>> 24) & 0xff;

  let ticks: bigint;
  if (version === 1) {
    if (tfdt.payloadEnd - tfdt.payloadStart < 4 + 8) return undefined;
    ticks = view.getBigUint64(tfdt.payloadStart + 4, false);
  } else {
    if (tfdt.payloadEnd - tfdt.payloadStart < 4 + 4) return undefined;
    ticks = BigInt(view.getUint32(tfdt.payloadStart + 4, false));
  }
  return (Number(ticks) * 1000) / timescale;
}

interface BoxRange {
  payloadStart: number;
  payloadEnd: number;
}

const FOURCC_MOOF = 0x6d6f6f66; // 'moof'
const FOURCC_TRAF = 0x74726166; // 'traf'
const FOURCC_TFDT = 0x74666474; // 'tfdt'
const FOURCC_TRUN = 0x7472756e; // 'trun'

const TRUN_FLAG_DATA_OFFSET = 0x000001;
const TRUN_FLAG_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_FLAG_SAMPLE_DURATION = 0x000100;

/**
 * Scans ISOBMFF boxes in [start, end) for the first matching fourcc.
 * Returns the matched box's payload range, or undefined if not found
 * or if a malformed size is encountered (size < 8 or extends past end).
 */
function findBox(
  buffer: Uint8Array,
  start: number,
  end: number,
  fourcc: number,
): BoxRange | undefined {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let p = start;
  while (p + 8 <= end) {
    const size = view.getUint32(p, false);
    const type = view.getUint32(p + 4, false);
    if (size < 8 || p + size > end) return undefined; // malformed
    if (type === fourcc) {
      return { payloadStart: p + 8, payloadEnd: p + size };
    }
    p += size;
  }
  return undefined;
}
