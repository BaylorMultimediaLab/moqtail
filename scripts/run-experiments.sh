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

# Step 2: Ensure Rust binaries are present. Skip the build if relay+publisher
# are already built — this lets you build as a regular user (whose rustup
# toolchain supports edition2024) and then run the suite as root, where the
# system cargo may be too old. Set MOQTAIL_FORCE_BUILD=1 to force rebuild.
NEED_BUILD=0
for bin in relay publisher; do
  if [[ ! -x "$ROOT_DIR/target/release/$bin" ]]; then
    NEED_BUILD=1
    break
  fi
done

if [[ "${MOQTAIL_FORCE_BUILD:-0}" == "1" || "$NEED_BUILD" == "1" ]]; then
  echo "[run-experiments] Building Rust workspace (release, --features publisher/vaapi)..."
  if ! cargo build --release --workspace --features publisher/vaapi 2>&1 | tail -10; then
    echo ""
    echo "[run-experiments] Build failed."
    echo "[run-experiments] If you're running as root and cargo is too old for"
    echo "[run-experiments] edition2024, build as your normal user first:"
    echo "[run-experiments]   exit  # back to non-root shell"
    echo "[run-experiments]   cargo build --release --workspace --features publisher/vaapi"
    echo "[run-experiments]   sudo -i  # or su"
    echo "[run-experiments]   ./scripts/run-experiments.sh"
    exit 1
  fi
else
  echo "[run-experiments] Reusing existing target/release/{relay,publisher} (set MOQTAIL_FORCE_BUILD=1 to rebuild)."
fi
echo ""

# If we're already root, drop the sudo prefix (cleaner output, no password prompt).
if [[ "$(id -u)" == "0" ]]; then
  PYTEST_PREFIX=()
else
  PYTEST_PREFIX=(sudo -E)
fi

# Step 3 + 4: For each experiment, run pytest then aggregate.
for e in "${EXPERIMENTS[@]}"; do
  echo "[run-experiments] === Running ${e} ==="
  # The tests/experiments/test_<exp>_*.py glob matches a single file per experiment.
  if ! "${PYTEST_PREFIX[@]}" uv --project tests/experiments run pytest "tests/experiments/test_${e}_"*.py -v; then
    echo "[run-experiments] Some ${e} cells failed — continuing to aggregate so partial data is preserved."
  fi

  # Aggregate. The aggregator runs with the same privileges as pytest so it
  # can write into the (potentially root-owned) results directory. Reads run
  # dirs; never destructive.
  if ! "${PYTEST_PREFIX[@]}" bash -c "cd tests/experiments && uv run python aggregate.py \"${e}\""; then
    echo "[run-experiments] Aggregation for ${e} failed (likely no results yet)."
  fi
  echo ""
done

# Restore ownership so the user can read/edit/git-add the results without sudo.
if [[ "$(id -u)" != "0" ]]; then
  sudo chown -R "$(id -u):$(id -g)" "$ROOT_DIR/tests/experiments/results" 2>/dev/null || true
fi

echo "[run-experiments] Done. Aggregates under tests/experiments/results/<exp>/aggregate*.csv"
