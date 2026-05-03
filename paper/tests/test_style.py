"""Tests for shared figure-style helpers."""
import matplotlib

# Force non-interactive backend before importing pyplot anywhere downstream.
matplotlib.use("Agg")

import matplotlib.pyplot as plt
import pytest

from _style import (
    COL_ALIGNED,
    COL_CLAMPED,
    COL_NAIVE,
    COL_READY,
    COLUMN_WIDTH_IN,
    GOP_DURATION_MS,
    TEXT_WIDTH_IN,
    apply_acm_style,
    fig_one_col,
    fig_two_col,
)


def test_column_widths_match_acm_sigconf():
    # ACM sigconf: \columnwidth ≈ 3.33 in, \textwidth ≈ 7.0 in.
    assert COLUMN_WIDTH_IN == pytest.approx(3.33, rel=0.01)
    assert TEXT_WIDTH_IN == pytest.approx(7.0, rel=0.02)


def test_gop_duration_constant():
    # Publisher emits 1-second GOPs; the dashed reference line in Figs 2 & 5.
    assert GOP_DURATION_MS == 1000


def test_palette_is_colorblind_safe_categorical():
    # Tableau-10-derived; pinned hex strings so reviewers see consistent color.
    assert COL_NAIVE == "#E15759"      # Tableau red
    assert COL_ALIGNED == "#4E79A7"    # Tableau blue
    assert COL_READY == "#59A14F"      # Tableau green
    assert COL_CLAMPED == "#F28E2B"    # Tableau orange


def test_apply_acm_style_sets_rcparams():
    apply_acm_style()
    assert plt.rcParams["font.size"] == 8.0
    assert plt.rcParams["axes.titlesize"] == 8.0
    assert plt.rcParams["axes.labelsize"] == 8.0
    assert plt.rcParams["legend.fontsize"] == 7.0
    assert plt.rcParams["pdf.fonttype"] == 42  # TrueType, embedded
    assert plt.rcParams["ps.fonttype"] == 42


def test_fig_one_col_returns_correctly_sized_figure():
    fig, ax = fig_one_col(height_in=2.0)
    width_in, height_in = fig.get_size_inches()
    assert width_in == pytest.approx(COLUMN_WIDTH_IN)
    assert height_in == pytest.approx(2.0)
    plt.close(fig)


def test_fig_two_col_returns_correctly_sized_figure():
    fig, ax = fig_two_col(height_in=2.5)
    width_in, height_in = fig.get_size_inches()
    assert width_in == pytest.approx(TEXT_WIDTH_IN)
    assert height_in == pytest.approx(2.5)
    plt.close(fig)
