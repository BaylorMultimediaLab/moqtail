# Experiment Quick Reference

Copy-paste commands and checklist for running filtered playback baseline experiments.

## Quick Start (Terminal A)

```bash
cd ~/Documents/Baylor/Spring\ 26/CSI_5v92_AF/BaylorMultimediaLab/moqtail
mkdir -p logs analysis

cd apps/client-js
npm run dev
```

Wait for output:

```
  VITE v7.3.1  ready in 500 ms
  ➜  Local:   http://localhost:5173/
```

## Browser: Connect & Configure

1. Go to `http://localhost:5173`
2. Relay URL: `https://localhost:4433`
3. Namespace: `moqtail`
4. Click **Connect**, wait for tracks to load
5. Toggle **Filtered Playback** ON
6. Metadata Delay Mode: **Fixed delay**
7. Fixed Metadata Delay: **1200 ms**

## Browser: Capture (5 min)

1. Click first video track to start
2. Wait 30 s for stabilization
3. Trigger 3–5 track switches (click different tracks in sidebar every 10 s)
4. Note file timestamp printed in console: `client-metrics_YYYY-MM-DD_HH-MM-SS.csv`

## Terminal B (or new tab): Analyze

```bash
# Go to client-js root
cd apps/client-js

# List captured CSV
ls -lh ../logs/

# Short report (replace YYYY-MM-DD_HH-MM-SS with your timestamp)
npm run analyze:switch-baseline -- --csv ../logs/client-metrics_YYYY-MM-DD_HH-MM-SS.csv

# Full JSON report
npm run analyze:switch-baseline -- \
  --csv ../logs/client-metrics_YYYY-MM-DD_HH-MM-SS.csv \
  --output-json ./analysis/run1_fixed-1200ms.json
```

## Variants (repeat capture + analysis for each)

### 600 ms Fixed

```bash
# Browser: Set Fixed Metadata Delay to 600 ms
# Capture 5 min, note timestamp
npm run analyze:switch-baseline -- \
  --csv ../logs/client-metrics_<TIMESTAMP_2>.csv \
  --output-json ./analysis/run2_fixed-600ms.json
```

### 2000 ms Fixed

```bash
# Browser: Set Fixed Metadata Delay to 2000 ms
# Capture 5 min, note timestamp
npm run analyze:switch-baseline -- \
  --csv ../logs/client-metrics_<TIMESTAMP_3>.csv \
  --output-json ./analysis/run3_fixed-2000ms.json
```

### Variable (800–2000 ms)

```bash
# Browser:
#  - Metadata Delay Mode: Variable delay
#  - Min: 800 ms, Max: 2000 ms
# Capture 5 min, note timestamp
npm run analyze:switch-baseline -- \
  --csv ../logs/client-metrics_<TIMESTAMP_4>.csv \
  --output-json ./analysis/run4_variable-800-2000ms.json
```

## Summary Table (after all runs)

| Delay Config | Total Events | Success | Rejected | Error | Jump-FWD | Jump-BCK | Misalign | Discontin |
| ------------ | ------------ | ------- | -------- | ----- | -------- | -------- | -------- | --------- |
| 600 ms       | ?            | ?       | ?        | ?     | ?        | ?        | ?        | ?         |
| 1200 ms      | ?            | ?       | ?        | ?     | ?        | ?        | ?        | ?         |
| 2000 ms      | ?            | ?       | ?        | ?     | ?        | ?        | ?        | ?         |
| Variable     | ?            | ?       | ?        | ?     | ?        | ?        | ?        | ?         |

## Notes

- **Jump-forward**: playback delta > +0.35 s
- **Jump-backward**: playback delta < -0.35 s
- **Misalignment**: alignment error > ±0.4 s
- **Discontinuity**: error outcome OR group regression OR live-offset delta > ±1.25 s
- **Behind-live threshold**: 1.5 s (only events when live_offset_s ≥ 1.5 are counted)

All CSV files auto-saved to `logs/`; all JSON reports in `analysis/`.
