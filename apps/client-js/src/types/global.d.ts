import type { AbrMetrics } from '@/lib/abr';
import type { MetricsSnapshot } from '@/lib/metrics/types';

declare global {
  interface Window {
    __moqtailMetrics?: {
      abr: AbrMetrics | null;
      samples: MetricsSnapshot | null;
    };
  }
}
