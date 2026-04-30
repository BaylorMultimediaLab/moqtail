import type { AbrMetrics } from '@/lib/abr';
import type { MetricsSnapshot } from '@/lib/metrics/types';
import type { DiscontinuityRecord } from '@/lib/player';

declare global {
  interface Window {
    __moqtailMetrics?: {
      abr: AbrMetrics | null;
      samples: MetricsSnapshot | null;
      firstReceivedGroupId?: number;
      switchDiscontinuities?: DiscontinuityRecord[];
    };
  }
}
