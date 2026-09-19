import type { AbrMetrics } from '@/lib/abr';
import type { EventLog } from '@/lib/events/EventLog';
import type { MetricsSnapshot } from '@/lib/metrics/types';
import type { DiscontinuityRecord } from '@/lib/player';
import type { CMSFTrack } from 'moqtail';

declare global {
  interface Window {
    __moqtailMetrics?: {
      abr: AbrMetrics | null;
      samples: MetricsSnapshot | null;
      firstReceivedGroupId?: number;
      switchDiscontinuities?: DiscontinuityRecord[];
      /** Serialized catalog tracks, set after player.initialize() for experiment harness. */
      catalogTracks?: CMSFTrack[];
    };
    /** Experiment event log (see lib/events/EventLog.ts). */
    __moqtailEvents?: EventLog;
  }
}
