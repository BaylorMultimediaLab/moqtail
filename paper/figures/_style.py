"""Shared style and layout helpers for the MMSys paper figures.

Keeps every notebook visually consistent: column widths, font sizes,
and the categorical palette used by Figs 2, 4, 5. Importing this
module does NOT mutate rcParams; call apply_acm_style() explicitly so
tests can assert on the side effect.
"""
from __future__ import annotations

import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.figure import Figure

# ACM sigconf two-column geometry. Measured from the template's
# \showthe\columnwidth / \showthe\textwidth output.
COLUMN_WIDTH_IN = 3.33
TEXT_WIDTH_IN = 7.0

# Publisher emits 1-second GOPs; this is the aligned-mode envelope referenced
# by Figs 2 and 5 (horizontal dashed line).
GOP_DURATION_MS = 1000

# Categorical palette. Pinned to Tableau-10 hex so the figure renders the
# same on every machine regardless of matplotlib version.
COL_NAIVE = "#E15759"     # red
COL_ALIGNED = "#4E79A7"   # blue
COL_READY = "#59A14F"     # green
COL_CLAMPED = "#F28E2B"   # orange


def apply_acm_style() -> None:
    """Apply ACM sigconf-friendly rcParams (sans-serif, 8pt, embedded fonts).

    Idempotent. Safe to call from every notebook's first cell.
    """
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["DejaVu Sans", "Arial", "Helvetica"],
        "font.size": 8.0,
        "axes.titlesize": 8.0,
        "axes.labelsize": 8.0,
        "xtick.labelsize": 7.0,
        "ytick.labelsize": 7.0,
        "legend.fontsize": 7.0,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "grid.alpha": 0.3,
        "pdf.fonttype": 42,   # TrueType, embedded — required by ACM
        "ps.fonttype": 42,
    })


def fig_one_col(height_in: float) -> tuple[Figure, Axes]:
    """Return a (fig, ax) sized for a single ACM column."""
    fig, ax = plt.subplots(figsize=(COLUMN_WIDTH_IN, height_in), constrained_layout=True)
    return fig, ax


def fig_two_col(height_in: float) -> tuple[Figure, Axes]:
    """Return a (fig, ax) sized for the full ACM textwidth (figure*)."""
    fig, ax = plt.subplots(figsize=(TEXT_WIDTH_IN, height_in), constrained_layout=True)
    return fig, ax
