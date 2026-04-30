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

  const tfdt = findBox(buffer, traf.payloadStart, traf.payloadEnd, FOURCC_TFDT);
  if (!tfdt) return undefined;

  // Read version+flags then the baseMediaDecodeTime (u32 if version=0, u64 if version=1).
  // DataView must honor the Uint8Array's byteOffset.
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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
  // ms = ticks * 1000 / timescale
  return (Number(ticks) * 1000) / timescale;
}

interface BoxRange {
  payloadStart: number;
  payloadEnd: number;
}

const FOURCC_MOOF = 0x6d6f6f66; // 'moof'
const FOURCC_TRAF = 0x74726166; // 'traf'
const FOURCC_TFDT = 0x74666474; // 'tfdt'

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
