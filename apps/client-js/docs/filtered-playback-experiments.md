# Filtered Playback Baseline Experiments

This guide reproduces switch behavior while playback is behind live and captures evidence for:

- jump-forward (positive playback-time discontinuity)
- jump-backward (negative playback-time discontinuity)
- misalignment (large alignment error between switches)
- discontinuity (error outcomes, group regressions, or large live-offset deltas)

## Prerequisites

1. **Running relay and publisher:** Ensure you have a moqtail relay running and a publisher streaming to it (e.g., on `https://localhost:4433` in the namespace `moqtail`).
2. **Working directory:** You must be in the moqtail project root.

## 0. Create Analysis Directory

```bash
mkdir -p logs analysis
```

## 1. Start the Player (Terminal A)

From project root, navigate to client and start dev:

```bash
cd apps/client-js
npm run dev
```

**Wait for output:**

```
  VITE v7.3.1  ready in 500 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

The Vite middleware now logs all metrics to `logs/client-metrics_YYYY-MM-DD_HH-MM-SS.csv` automatically.

## 2. Open Player UI (Terminal B, or Browser)

Open **`http://localhost:5173`** in your browser.

You should see the MOQtail player sidebar with:

- Connection fields (Relay URL, Namespace)
- Connect button
- Filtered Playback control section (currently OFF)

## 3. Configure Connection

In the browser sidebar:

1. **Relay URL:** `https://localhost:4433` (or your relay endpoint)
2. **Namespace:** `moqtail` (or your namespace)
3. Click **Connect**

Wait ~2–5 seconds. You should see:

- Status dot change to **green** (Catalog loaded)
- Video and Audio track lists populate in the sidebar

## 4. Enable Filtered Playback

Once tracks are loaded:

1. Toggle **Filtered Playback** checkbox to **ON**
2. Select **Metadata Delay Mode:** `Fixed delay` (for determinism)
3. Set **Fixed Metadata Delay:** `1200` ms (recommended starting point)
4. Keep ABR **auto-switch enabled** (do not disable for baseline)

**Now ready to capture Run 1.**

## 5. Run Capture — Run 1: 1200 ms Fixed Delay (5 minutes)

**Goal:** Auto-switch baseline + forced manual switches while behind live.

### Steps:

1. **Start playback:** Click the first video track in the sidebar to start playback.
   - Observe the video player begin (black background until buffered).
   - Wait **30 seconds** for metrics to stabilize. Watch **Playout State** and **Switch Baseline** panels.

2. **Observe behind-live:** After stabilization, you should see:
   - `Live Offset`: ~1–3 seconds (you are behind live edge)
   - `Metadata Delay`: increases to ~1200 ms when a group is detected
   - `Metadata Ready`: toggles between Yes/No as delay counts down
   - Video may pause periodically (gating).

3. **Trigger switches (Minute 1–4):** Force 3–5 track changes while behind live:
   - Disable auto-switch (in Settings panel if you have access, or rely on natural ABR event).
   - Click a different **Video** track in the sidebar (e.g., 720p → 1080p → 720p).
   - Wait 10 s between each switch.
   - **Observe Switch Baseline panel:** You should see fields populate with switch_outcome, playback_delta, alignment_error, etc.

4. **Note anomalies:** Watch for:
   - Video **stalls** (video paused while metadata gate is active)
   - **Jumps** in the progress bar (jump-forward or jump-backward)
   - **Repeated metadata delays** (indicates regrouping)

5. **End capture (Minute 5):** Click a track again to stop playback or just let it run.
   - **Do not close the browser or stop the dev server yet.**

### Metrics are now in: `logs/client-metrics_YYYY-MM-DD_HH-MM-SS.csv`

Note the **timestamp** of the file (you'll need it for analysis).

## 6. Analyze Run 1 (Terminal B, while dev server is running or after)

### Step 6a: List captured CSVs

```bash
ls -lh ../../logs/
```

You should see something like:

```
-rw-r--r--  client-metrics_2026-04-09_14-30-45.csv  (50–100 KB)
```

### Step 6b: Run short report (console output)

Replace `<TIMESTAMP>` with your actual file timestamp:

```bash
npm run analyze:switch-baseline -- --csv ../../logs/client-metrics_2026-04-09_14-30-45.csv
```

You will see a summary like:

```
=== Filtered Playback Switch Baseline Report ===
CSV: ../../logs/client-metrics_2026-04-09_14-30-45.csv
Events (behind-live only): 8

Outcome counts:
  success: 5
  rejected: 2
  error: 1

Finding counts:
  jump-forward: 3
  jump-backward: 2
  misalignment: 4
  discontinuity: 1

Sample events:
  [1] 2026-04-09T14:30:50.000Z outcome=success issues=jump-forward|misalignment ...
  ...
```

### Step 6c: Generate full JSON report

```bash
npm run analyze:switch-baseline -- \
  --csv ../../logs/client-metrics_2026-04-09_14-30-45.csv \
  --output-json ./analysis/run1_fixed-1200ms.json
```

This creates `analysis/run1_fixed-1200ms.json` with all events and metadata.

## 7. (Optional) Run Additional Variants

Repeat steps 3–6 with different delay configurations to build a comparison matrix.

### Variant A: 600 ms Delay (Low)

In browser sidebar:

- Fixed Metadata Delay: `600` ms
- Repeat capture (~5 min)

**Analysis:**

```bash
npm run analyze:switch-baseline -- \
  --csv ../../logs/client-metrics_<TIMESTAMP_2>.csv \
  --output-json ./analysis/run2_fixed-600ms.json
```

### Variant B: 2000 ms Delay (High)

In browser sidebar:

- Fixed Metadata Delay: `2000` ms
- Repeat capture (~5 min)

**Analysis:**

```bash
npm run analyze:switch-baseline -- \
  --csv ../../logs/client-metrics_<TIMESTAMP_3>.csv \
  --output-json ./analysis/run3_fixed-2000ms.json
```

### Variant C: Variable Delay (800–2000 ms)

In browser sidebar:

- Metadata Delay Mode: `Variable delay`
- Min Delay: `800` ms
- Max Delay: `2000` ms
- Repeat capture (~5 min)

**Analysis:**

```bash
npm run analyze:switch-baseline -- \
  --csv ../../logs/client-metrics_<TIMESTAMP_4>.csv \
  --output-json ./analysis/run4_variable-800-2000ms.json
```

## 8. Interpretation Rules

The analyzer **deduplicates** terminal switch events by signature (outcome + track pairs + timestamps). It reports one final event per unique switch **that occurred behind live** (live_offset_s ≥ behind-live-threshold, default 1.5 s).

**Classification logic:**

| Issue           | Condition                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jump-forward`  | `switch_playback_delta_s > jump-threshold` (default 0.35 s)                                                                                                                         |
| `jump-backward` | `switch_playback_delta_s < -jump-threshold` (default -0.35 s)                                                                                                                       |
| `misalignment`  | `\|switch_alignment_error_s\| > misalignment-threshold` (default 0.4 s)                                                                                                             |
| `discontinuity` | Any of: outcome is `rejected` \| `error`, OR group regression (`switch_group_delta < 0`), OR large live-offset shift (`\|switch_live_offset_delta_s\| > threshold`, default 1.25 s) |

**Thresholds are tunable** if you want to adjust sensitivity:

```bash
npm run analyze:switch-baseline -- \
  --csv ../../logs/client-metrics_<TIMESTAMP>.csv \
  --jump-threshold 0.50 \
  --misalignment-threshold 0.50 \
  --output-json ./analysis/run1_custom-thresholds.json
```

## 9. Summary and Next Steps

After running one or more variants:

### Step 9a: Review JSON Reports

Each JSON report (`analysis/run*.json`) contains:

```json
{
  "inputCsv": "...",
  "thresholds": { ... },
  "summary": {
    "totalEvents": 8,
    "outcomes": { "success": 5, "rejected": 2, "error": 1, "other": 0 },
    "findings": { "jumpForward": 3, "jumpBackward": 2, "misalignment": 4, "discontinuity": 1 }
  },
  "events": [ { "outcome": "success", "issues": ["jump-forward", "misalignment"], ... }, ... ]
}
```

### Step 9b: Fill in Findings Summary

Use this template for your investigation notes:

```text
EXPERIMENT RESULTS — Filtered Playback Behind-Live Baseline

Trial 1: 1200 ms Fixed Delay
  CSV: logs/client-metrics_2026-04-09_14-30-45.csv
  Total Behind-Live Switch Events: 8
  Outcomes: success=5, rejected=2, error=1

  Findings:
    jump-forward: 3 events
    jump-backward: 2 events
    misalignment: 4 events
    discontinuity: 1 event

  Example Events:
    - (success) 720→1080 @ playback 18.0s, delta=+0.9s, alignErr=0.9s → JUMP-FORWARD + MISALIGNMENT
    - (error) 1080→720 @ playback 17.2s, delta=-0.8s, groupDelta=-3 → JUMP-BACKWARD + DISCONTINUITY

Trial 2: 600 ms Fixed Delay
  CSV: logs/client-metrics_<TIMESTAMP>.csv
  Total Behind-Live Switch Events: 4
  Outcomes: success=3, rejected=1

  [Similar format...]

Trial 3: 2000 ms Fixed Delay
  [...]

COMPARATIVE ANALYSIS:
- Delay = 600 ms:  4 events, [breakdown]
- Delay = 1200 ms: 8 events, [breakdown]
- Delay = 2000 ms: [pending]
- Delay = Variable: [pending]

HYPOTHESIS:
- Longer delays correlate with more switch events (higher behind-live duration).
- Jump-forward occurs [X] conditions; jump-backward [Y].
- Primary failure mode: [describe pattern].

NEXT MITIGATION:
- Proposal A: [describe Milestone 4 time-alignment strategy]
- Proposal B: [alternative]
```

### Step 9c: Inspect Raw CSV (Optional)

View the full CSV if you need to inspect specific rows:

```bash
head -20 ../../logs/client-metrics_2026-04-09_14-30-45.csv  # First 20 rows (header + samples)
tail -20 ../../logs/client-metrics_2026-04-09_14-30-45.csv  # Last 20 rows
wc -l ../../logs/client-metrics_2026-04-09_14-30-45.csv     # Total row count
```

### Step 9d: Aggregate Multiple Runs (Bash)

Combine all JSON reports into a single matrix:

```bash
cd analysis
echo "Run summaries:" > combined-findings.txt
for f in *.json; do
  echo "" >> combined-findings.txt
  echo "=== $f ===" >> combined-findings.txt
  cat "$f" | grep -A 10 '"summary"' >> combined-findings.txt
done
cat combined-findings.txt
```

## 10. Summary

You now have a complete reproducible baseline. Key deliverables:

1. **CSV logs** in `logs/` with all switch telemetry (raw data).
2. **JSON reports** in `analysis/` with classification and statistics.
3. **Findings** written up per template (for investigation notes).
4. **Thresholds** tunable if classification is too loose or tight.

**Next phase (Milestone 4):** Use these findings to design and validate time-aligned switching logic that avoids jump-forward/jump-backward during behind-live filtering.
