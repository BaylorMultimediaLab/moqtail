/**
 * Bidirectional PTS <-> group lookup. Used by the player to compute
 * `START_LOCATION_GROUP` for aligned switches: given the current
 * playhead PTS, find the group_id that contains it.
 *
 * Recorded boundaries are explicit `(groupId, startPTS_ms)` points
 * fed by the player's write handler as objects arrive. For PTS values
 * outside the recorded range, we extrapolate from the smallest-PTS
 * anchor using the supplied `gopDurationMs`. Extrapolation works
 * both forward (PTS > all anchors) and backward (PTS < all anchors).
 */
export class TimeMap {
  private boundaries: Array<{ groupId: number; startPTS_ms: number }> = [];
  private gopDurationMs: number;

  constructor(gopDurationMs: number) {
    if (gopDurationMs <= 0) {
      throw new Error(`TimeMap: gopDurationMs must be positive (got ${gopDurationMs})`);
    }
    this.gopDurationMs = gopDurationMs;
  }

  /**
   * Record an explicit group boundary. Idempotent on duplicate (groupId)
   * inserts. Boundaries are kept sorted by startPTS_ms.
   */
  recordGroupBoundary(groupId: number, startPTS_ms: number): void {
    if (this.boundaries.some(b => b.groupId === groupId)) return;
    this.boundaries.push({ groupId, startPTS_ms });
    this.boundaries.sort((a, b) => a.startPTS_ms - b.startPTS_ms);
  }

  /**
   * Return the groupId whose [startPTS, startPTS + gopDurationMs) covers `pts_ms`.
   * Returns `undefined` if no boundary has been recorded yet.
   *
   * Lookup strategy:
   *   1. If `pts_ms >= boundaries[i].startPTS_ms` for the largest valid i,
   *      that's the explicit window; the contained group is
   *      `boundaries[i].groupId + floor((pts_ms - boundaries[i].startPTS_ms) / gopDurationMs)`.
   *   2. If `pts_ms` is before every boundary, extrapolate from the earliest
   *      boundary using the same formula (the floor naturally gives smaller
   *      group IDs when the offset is negative).
   */
  groupContainingPTS(pts_ms: number): number | undefined {
    if (this.boundaries.length === 0) return undefined;

    // Find the largest boundary index whose startPTS <= pts_ms.
    let bestIdx = -1;
    for (let i = 0; i < this.boundaries.length; i++) {
      if (this.boundaries[i].startPTS_ms <= pts_ms) {
        bestIdx = i;
      } else {
        break;
      }
    }

    if (bestIdx >= 0) {
      const b = this.boundaries[bestIdx];
      const offsetGroups = Math.floor((pts_ms - b.startPTS_ms) / this.gopDurationMs);
      return b.groupId + offsetGroups;
    }

    // pts_ms is before every boundary -> extrapolate backward from earliest.
    const first = this.boundaries[0];
    const offsetGroups = Math.floor((pts_ms - first.startPTS_ms) / this.gopDurationMs);
    return first.groupId + offsetGroups;
  }
}
