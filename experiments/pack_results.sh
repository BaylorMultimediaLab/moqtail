#!/usr/bin/env bash
# Bundle the files needed to review a set of runs, without browser profiles
# and process logs. Usage: experiments/pack_results.sh [results-dir] [out.tar.gz]
set -euo pipefail
RESULTS="${1:-results}"
OUT="${2:-results-$(date -u +%Y%m%dT%H%M%SZ).tar.gz}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
python3 experiments/analyze.py "$RESULTS"/*/ --quiet --csv "$RESULTS/aggregate.csv" --stats "$RESULTS/stats.csv" || true
tar -czf "$OUT" \
  --exclude='chrome-profile' --exclude='firefox-profile' --exclude='relay-logs' \
  --exclude='*.log' \
  "$RESULTS"
echo "wrote $OUT"
du -h "$OUT"
