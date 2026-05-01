#!/usr/bin/env bash
# Convenience wrapper for the paper experiment suite.
#
# Usage:
#   ./scripts/run-experiments.sh                 # all experiments
#   ./scripts/run-experiments.sh e1 e2           # selected experiments
#
# Each experiment runs through pytest under sudo (Mininet requires root),
# then aggregates per-cell summaries. Per-run artifacts land at:
#   tests/experiments/results/<test_id>/<timestamp>/
# Aggregates land at:
#   tests/experiments/results/<exp>/aggregate.csv + aggregate_summary.csv

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -eq 0 ]]; then
  EXPERIMENTS=(e1 e2 e3 e4 e6)
else
  EXPERIMENTS=("$@")
fi

# Estimated wall time per experiment (matches design doc § 8). Used only
# for the upfront ETA; the actual runtime depends on the host.
declare -A WALL=(
  [e1]=2 [e2]=27 [e3]=27 [e4]=33 [e6]=162
)
total=0
for e in "${EXPERIMENTS[@]}"; do
  total=$((total + ${WALL[$e]:-0}))
done
echo "[run-experiments] Will run: ${EXPERIMENTS[*]}"
echo "[run-experiments] Estimated wall time: ${total} minutes"
echo ""

# Step 1: Tears of Steel asset must exist.
ASSET="$ROOT_DIR/data/video/tears_of_steel_60s_720p.mp4"
if [[ ! -f "$ASSET" ]]; then
  echo "[run-experiments] Asset missing — running prepare_tears_of_steel.sh first."
  "$ROOT_DIR/scripts/prepare_tears_of_steel.sh"
fi

# Step 2: Build the Rust workspace with the vaapi feature (AMD path).
echo "[run-experiments] Building Rust workspace (release, --features publisher/vaapi)..."
cargo build --release --workspace --features publisher/vaapi 2>&1 | tail -10
echo ""

# Step 3 + 4: For each experiment, run pytest then aggregate.
for e in "${EXPERIMENTS[@]}"; do
  echo "[run-experiments] === Running ${e} ==="
  # The tests/experiments/test_<exp>_*.py glob matches a single file per experiment.
  if ! sudo -E uv --project tests/experiments run pytest "tests/experiments/test_${e}_"*.py -v; then
    echo "[run-experiments] Some ${e} cells failed — continuing to aggregate so partial data is preserved."
  fi

  # Aggregate. The aggregator only reads run dirs; never destructive.
  if ! (cd tests/experiments && uv run python aggregate.py "${e}"); then
    echo "[run-experiments] Aggregation for ${e} failed (likely no results yet)."
  fi
  echo ""
done

echo "[run-experiments] Done. Aggregates under tests/experiments/results/<exp>/aggregate*.csv"
