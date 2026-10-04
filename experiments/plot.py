#!/usr/bin/env python3
"""Paper figures from analyzed runs.

Reads each run's summary.json (analyze.py must have run) and, for the
trajectory figures, its client-events.jsonl and runner-events.jsonl. Runs are
grouped into conditions exactly as compare.py does (mechanism, client type,
network profile + background flows, controller arm), so every bar here is the
same population as the corresponding column of the comparison table.

    python3 experiments/plot.py results/*/ --out figures/
    python3 experiments/plot.py results-linux-*/grid/results/*/ --out figures/grid --format pdf,png
    python3 experiments/plot.py results/*/ --list            # conditions and rep counts only
    python3 experiments/plot.py results/*/ --filter ctl=grid  # one controller arm only

Figures (one file per metric or facet; `--facet` picks what becomes a panel):

  bars_<metric>        median over valid repetitions with the inter-quartile
                       range as the error bar and one dot per repetition
  summary              the headline metrics as a grid of such bar panels
  traj_live_edge_*     live-edge distance vs time since first frame, one thin
                       line per repetition and a thick median trajectory per
                       condition; vertical lines mark NET_CHANGE events
  traj_rung_*          played ladder rung vs time (same layout)
  traj_buffer_*        buffer level vs time (same layout)
  seam_*               ECDFs of per-switch seam costs (viewer pause, buffer
                       hole, visibility delay) over switches with their own
                       first frame, pooled over repetitions

Requires matplotlib (pip install matplotlib). Everything else is stdlib.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compare  # noqa: E402  (same directory; grouping and metric accessors)

FIELDS = ("mechanism", "client", "profile", "ctl")

# Metrics plotted as bars. Names must match compare.ROWS so that the figure and
# the table always compute the same thing.
BAR_METRICS = [
    "switches / min",
    "A->B->A reversals",
    "superseded",
    "stalls",
    "stalled s",
    "data starved s",
    "viewer pause p95 ms",
    "seam buffer hole p50 ms",
    "switch visibility p50 ms",
    "mean played rung index",
    "played kbps",
    "startup ms",
    "live-edge dist mean ms",
    "shift retained, last 60 s (s)",
    "time to half shift s",
    "down-reaction s (held 5 s)",
    "up-recovery s (held 5 s)",
    "landed on a keyframe (frac, sync flag)",
]
SUMMARY_METRICS = [
    "switches / min",
    "A->B->A reversals",
    "stalled s",
    "viewer pause p95 ms",
    "mean played rung index",
    "shift retained, last 60 s (s)",
]
SEAM_METRICS = [
    ("viewer_pause_ms", "viewer pause at the seam (ms)"),
    ("seam_buffer_hole_ms", "buffer hole at the seam (ms)"),
    ("switch_visibility_delay_ms", "switch visibility delay (ms)"),
]
ROW_BY_NAME = {name: fn for name, fn in compare.ROWS}


def condition(s: dict) -> dict[str, str]:
    """compare.cond_key as a field dict (mechanism, client, profile, ctl)."""
    lines = compare.cond_key(s).split("\n")
    return {"mechanism": lines[0], "client": lines[1], "profile": lines[2], "ctl": lines[3].removeprefix("ctl ")}


def slug(text: str) -> str:
    out = "".join(c if c.isalnum() else "-" for c in text.lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def load_runs(paths: list[Path], include_invalid: bool) -> list[dict]:
    runs = []
    seen: set[str] = set()
    for r in paths:
        p = r / "summary.json"
        if not p.exists():
            continue
        s = json.loads(p.read_text())
        if s.get("validity", {}).get("valid") is False and not include_invalid:
            continue
        # The same run may appear in several extracted bundles; count it once.
        if s.get("run_id") in seen:
            continue
        seen.add(s.get("run_id"))
        s["_dir"] = r
        s["_cond"] = condition(s)
        runs.append(s)
    return runs


def events(run: Path, name: str, wanted: set[str]) -> list[dict]:
    p = run / name
    if not p.exists():
        return []
    out = []
    with p.open() as fh:
        for line in fh:
            if not any(f'"{w}"' in line for w in wanted):
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("event") in wanted:
                out.append(e)
    return out


def presented_switch(sw: dict) -> bool:
    """A switch with its own first frame. Summaries from before 2026-10-04 carry only the
    (wrong) `superseded` flag; those are accepted when the flag is false."""
    term = sw.get("terminal")
    if term is not None:
        return term == "first_frame"
    return not sw.get("superseded")


def trajectory(run: dict, field: str) -> tuple[list[float], list[float], list[float]]:
    """(t_s, value, net_change_t_s) for one run; t = 0 at the first presented frame of the
    last client session. Rung index is resolved from the RUN_META ladder."""
    ev = events(run["_dir"], "client-events.jsonl", {"SAMPLE", "STARTUP", "RUN_META"})
    sessions = {e.get("session") for e in ev if e.get("event") == "SAMPLE"}
    if not sessions:
        return [], [], []
    session = max(s for s in sessions if s is not None)
    ev = [e for e in ev if e.get("session") == session]
    startup = next((e for e in ev if e["event"] == "STARTUP"), None)
    samples = [e for e in ev if e["event"] == "SAMPLE"]
    t0 = startup["ts"] if startup else samples[0]["ts"]
    meta = next((e for e in ev if e["event"] == "RUN_META"), None) or {}
    ladder = sorted(meta.get("ladder", []), key=lambda t: t.get("bitrate") or 0)
    rung = {t["track"]: i for i, t in enumerate(ladder)}
    ts, vs = [], []
    for e in samples:
        if field == "rung":
            v = rung.get(e.get("track"))
        else:
            v = e.get(field)
        if v is None:
            continue
        ts.append((e["ts"] - t0) / 1000)
        vs.append(v)
    net = [
        (e.get("at_s"), (e["ts"] - t0) / 1000)
        for e in events(run["_dir"], "runner-events.jsonl", {"NET_CHANGE"})
        if e.get("applied") and (e.get("at_s") or 0) > 0
    ]
    return ts, vs, net


def resample(ts: list[float], vs: list[float], grid: list[float]) -> list[float | None]:
    """Step-hold resample onto `grid` (None before the first / after the last sample)."""
    out: list[float | None] = []
    j = 0
    for g in grid:
        while j + 1 < len(ts) and ts[j + 1] <= g:
            j += 1
        out.append(vs[j] if ts and ts[0] <= g <= ts[-1] else None)
    return out


def median_traj(series: list[tuple[list[float], list[float]]], step: float = 1.0):
    end = max((ts[-1] for ts, _ in series if ts), default=0)
    grid = [i * step for i in range(int(end / step) + 1)]
    cols = [resample(ts, vs, grid) for ts, vs in series]
    med = []
    for i in range(len(grid)):
        vals = [c[i] for c in cols if c[i] is not None]
        med.append(statistics.median(vals) if len(vals) >= max(1, len(series) // 2) else None)
    return grid, med


def facet_groups(runs: list[dict], facet: list[str]) -> dict[tuple, list[dict]]:
    groups: dict[tuple, list[dict]] = {}
    for r in runs:
        key = tuple(r["_cond"][f] for f in facet)
        groups.setdefault(key, []).append(r)
    return dict(sorted(groups.items()))


def facet_title(facet: list[str], key: tuple) -> str:
    return "  ·  ".join(k for k in key if k)


def style():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update(
        {
            "font.size": 8,
            "axes.titlesize": 8,
            "axes.labelsize": 8,
            "legend.fontsize": 7,
            "xtick.labelsize": 7,
            "ytick.labelsize": 7,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "figure.dpi": 150,
            "savefig.bbox": "tight",
            "lines.linewidth": 1.0,
        }
    )
    return plt


def save(fig, out: Path, name: str, formats: list[str], index: list[str], note: str) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for f in formats:
        fig.savefig(out / f"{name}.{f}")
    index.append(f"- `{name}.{formats[0]}` — {note}")


def bar_panel(ax, runs: list[dict], metric: str, x: str, hue: str, colors: dict[str, str]) -> bool:
    fn = ROW_BY_NAME[metric]
    xs = sorted({r["_cond"][x] for r in runs})
    hues = sorted({r["_cond"][hue] for r in runs}) if hue != "none" else [""]
    width = 0.8 / len(hues)
    drew = False
    for hi, h in enumerate(hues):
        for xi, xv in enumerate(xs):
            sel = [r for r in runs if r["_cond"][x] == xv and (hue == "none" or r["_cond"][hue] == h)]
            vals = [v for v in (fn(r) for r in sel) if v is not None]
            if not vals:
                continue
            drew = True
            pos = xi - 0.4 + width * (hi + 0.5)
            med = statistics.median(vals)
            q1, q3 = (compare_pct(vals, 25), compare_pct(vals, 75)) if len(vals) > 1 else (med, med)
            ax.bar(pos, med, width * 0.9, color=colors.get(h, "C0"), alpha=0.75,
                   yerr=[[med - q1], [q3 - med]], capsize=2, error_kw={"lw": 0.8})
            ax.scatter([pos] * len(vals), vals, s=6, color="black", zorder=3, alpha=0.7)
            ax.text(pos, max(q3, med), f"n={len(vals)}", va="bottom", ha="center", fontsize=5)
    ax.set_xticks(range(len(xs)))
    ax.set_xticklabels([xv.replace("/", "/\n") for xv in xs])
    ax.set_ylabel(metric)
    return drew


def compare_pct(values: list[float], q: float) -> float:
    vs = sorted(values)
    k = (len(vs) - 1) * q / 100
    lo, hi = int(k), min(int(k) + 1, len(vs) - 1)
    return vs[lo] + (vs[hi] - vs[lo]) * (k - lo)


def legend_handles(plt, hues: list[str], colors: dict[str, str]):
    from matplotlib.patches import Patch

    return [Patch(color=colors[h], alpha=0.75, label=h) for h in hues]


def make_bars(plt, runs, metrics, x, hue, facet, out, formats, index, name=None, note=None):
    groups = facet_groups(runs, facet)
    hues = sorted({r["_cond"][hue] for r in runs}) if hue != "none" else [""]
    colors = {h: f"C{i}" for i, h in enumerate(hues)}
    ncols = len(groups)
    nrows = len(metrics)
    fig, axes = plt.subplots(nrows, ncols, figsize=(3.2 * ncols, 2.2 * nrows), squeeze=False)
    any_drawn = False
    for ci, (key, sel) in enumerate(groups.items()):
        for ri, metric in enumerate(metrics):
            ax = axes[ri][ci]
            drawn = bar_panel(ax, sel, metric, x, hue, colors)
            any_drawn |= drawn
            if not drawn:
                ax.text(0.5, 0.5, "no data", ha="center", va="center", transform=ax.transAxes, color="gray")
            if ri == 0:
                ax.set_title(facet_title(facet, key))
    if hue != "none":
        fig.legend(handles=legend_handles(plt, hues, colors), loc="upper center", ncol=min(4, len(hues)),
                   bbox_to_anchor=(0.5, 1.0 + 0.3 / nrows), frameon=False)
    fig.tight_layout()
    if any_drawn:
        save(fig, out, name or f"bars_{slug(metrics[0])}", formats, index,
             note or f"{metrics[0]}: median over repetitions, IQR error bar, one dot per repetition")
    plt.close(fig)


def make_trajectories(plt, runs, field, ylabel, prefix, x, facet, out, formats, index, client_filter=None):
    sel_runs = [r for r in runs if client_filter is None or client_filter(r["_cond"]["client"])]
    for key, sel in facet_groups(sel_runs, facet).items():
        conds = sorted({r["_cond"][x] for r in sel})
        colors = {c: f"C{i}" for i, c in enumerate(conds)}
        fig, ax = plt.subplots(figsize=(4.8, 2.6))
        nets: dict[float, list[float]] = {}
        drew = False
        for c in conds:
            series = []
            for r in (r for r in sel if r["_cond"][x] == c):
                ts, vs, net = trajectory(r, field)
                if not ts:
                    continue
                series.append((ts, vs))
                for at_s, t in net:
                    nets.setdefault(at_s, []).append(t)
                ax.plot(ts, vs, color=colors[c], alpha=0.25, lw=0.6)
            if not series:
                continue
            drew = True
            grid, med = median_traj(series)
            ax.plot(grid, med, color=colors[c], lw=1.6, label=f"{c} (n={len(series)})")
        for ts_ in nets.values():
            ax.axvline(statistics.median(ts_), color="gray", ls="--", lw=0.7)
        if not drew:
            plt.close(fig)
            continue
        ax.set_xlabel("time since first frame (s)")
        ax.set_ylabel(ylabel)
        if field == "rung":
            ax.set_yticks(range(0, int(max(ax.get_ylim()[1], 1)) + 1))
        ax.set_title(facet_title(facet, key))
        ax.legend(frameon=False)
        fig.tight_layout()
        save(fig, out, f"{prefix}_{slug(facet_title(facet, key))}", formats, index,
             f"{ylabel} vs time, thin = repetitions, thick = median trajectory, dashed = network change")
        plt.close(fig)


def make_seams(plt, runs, x, hue, facet, out, formats, index):
    for key, sel in facet_groups(runs, facet).items():
        conds = sorted({(r["_cond"][x], r["_cond"][hue] if hue != "none" else "") for r in sel})
        fig, axes = plt.subplots(1, len(SEAM_METRICS), figsize=(3.0 * len(SEAM_METRICS), 2.4), squeeze=False)
        drew = False
        for ai, (field, label) in enumerate(SEAM_METRICS):
            ax = axes[0][ai]
            for ci, cond in enumerate(conds):
                vals = []
                for r in sel:
                    if (r["_cond"][x], r["_cond"][hue] if hue != "none" else "") != cond:
                        continue
                    for sw in r["switches"].get("list", []):
                        v = sw.get(field)
                        if v is not None and presented_switch(sw):
                            vals.append(v)
                if not vals:
                    continue
                drew = True
                vs = sorted(vals)
                ys = [(i + 1) / len(vs) for i in range(len(vs))]
                name = " ".join(c for c in cond if c)
                ax.step(vs, ys, where="post", color=f"C{ci}", label=f"{name} (n={len(vs)})")
            ax.set_xlabel(label)
            ax.set_ylim(0, 1.02)
            if ai == 0:
                ax.set_ylabel("fraction of switches")
            if ax.get_xlim()[1] > 2000:
                ax.set_xscale("symlog", linthresh=100)
            ax.set_xlim(left=0)
        if not drew:
            plt.close(fig)
            continue
        handles, labels = axes[0][0].get_legend_handles_labels()
        fig.legend(handles, labels, frameon=False, loc="upper center", ncol=2, bbox_to_anchor=(0.5, 0.0))
        fig.suptitle(facet_title(facet, key))
        fig.tight_layout()
        save(fig, out, f"seam_{slug(facet_title(facet, key))}", formats, index,
             "ECDF of per-switch seam costs over switches with their own first frame, pooled over repetitions")
        plt.close(fig)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=Path("figures"))
    ap.add_argument("--format", default="pdf,png", help="comma-separated: pdf, png, svg")
    ap.add_argument("--all", action="store_true", help="include runs whose validation failed")
    ap.add_argument("--x", default="mechanism", choices=FIELDS, help="bar groups / trajectory colours")
    ap.add_argument("--hue", default="client", choices=FIELDS + ("none",), help="bars within a group")
    ap.add_argument("--facet", default="profile,ctl", help="comma-separated fields that become panels, or none")
    ap.add_argument("--metrics", default=None, help="comma-separated compare.py row names for bars_*")
    ap.add_argument("--filter", action="append", default=[], metavar="FIELD=VALUE",
                    help="keep only runs whose condition field equals VALUE (repeatable; e.g. ctl=grid)")
    ap.add_argument("--list", action="store_true", help="print conditions and repetition counts, no figures")
    args = ap.parse_args()

    runs = load_runs(args.runs, args.all)
    for f in args.filter:
        field, _, value = f.partition("=")
        if field not in FIELDS:
            ap.error(f"unknown filter field {field!r}; choose from {FIELDS}")
        runs = [r for r in runs if r["_cond"][field] == value]
    if not runs:
        print("no analyzed runs (run analyze.py first, check --filter)")
        return 1
    facet = [] if args.facet == "none" else [f for f in args.facet.split(",") if f]
    for f in facet:
        if f not in FIELDS:
            ap.error(f"unknown facet field {f!r}; choose from {FIELDS}")
    counts: dict[str, int] = {}
    for r in runs:
        counts[compare.cond_key(r).replace("\n", " | ")] = counts.get(compare.cond_key(r).replace("\n", " | "), 0) + 1
    for c, n in sorted(counts.items()):
        print(f"{n:>3}  {c}")
    if args.list:
        return 0

    plt = style()
    formats = [f for f in args.format.split(",") if f]
    index: list[str] = []
    metrics = [m.strip() for m in args.metrics.split(",")] if args.metrics else BAR_METRICS
    for m in metrics:
        if m not in ROW_BY_NAME:
            ap.error(f"unknown metric {m!r}; use a row name from compare.py")
        make_bars(plt, runs, [m], args.x, args.hue, facet, args.out, formats, index)
    make_bars(plt, runs, SUMMARY_METRICS, args.x, args.hue, facet, args.out, formats, index,
              name="summary", note="headline metrics, one row per metric")
    make_trajectories(plt, runs, "live_edge_distance_ms", "live-edge distance (ms)", "traj_live_edge",
                      args.x, facet + ["client"], args.out, formats, index)
    make_trajectories(plt, runs, "rung", "played rung index", "traj_rung",
                      args.x, facet + ["client"], args.out, formats, index)
    make_trajectories(plt, runs, "buffer_s", "buffer (s)", "traj_buffer",
                      args.x, facet + ["client"], args.out, formats, index)
    make_seams(plt, runs, args.x, args.hue, facet, args.out, formats, index)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "index.md").write_text(
        "# Figures\n\nConditions (valid repetitions):\n\n"
        + "\n".join(f"- {n} × {c}" for c, n in sorted(counts.items()))
        + "\n\nFiles:\n\n" + "\n".join(index) + "\n"
    )
    print(f"{len(index)} figures -> {args.out}/ (see index.md)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
