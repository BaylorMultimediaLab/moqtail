"""Smoke test: every notebook executes end-to-end and produces a PDF.

Doesn't compare visual output (matplotlib's image-comparison tooling is
flaky across versions) — just asserts the notebook ran without error
and the expected PDF exists with non-trivial size.
"""
import subprocess
from pathlib import Path

import pytest

PAPER_ROOT = Path(__file__).resolve().parents[1]
NOTEBOOKS_DIR = PAPER_ROOT / "notebooks"
FIGURES_DIR = PAPER_ROOT / "figures"

NOTEBOOK_TO_PDF = {
    "fig2_e2_e3_playhead_gap.ipynb": ("fig2_e2_e3_playhead_gap.pdf",),
    "fig3_trace_naive_vs_aligned.ipynb": ("fig3a_trace_naive.pdf", "fig3b_trace_aligned.pdf"),
    "fig4_e4_cache_boundary.ipynb": ("fig4_e4_cache_boundary.pdf",),
    "fig5_e6_composability.ipynb": ("fig5_e6_composability.pdf",),
}


@pytest.mark.parametrize("notebook,pdfs", NOTEBOOK_TO_PDF.items())
def test_notebook_executes_and_emits_pdf(notebook, pdfs, tmp_path):
    nb_path = NOTEBOOKS_DIR / notebook
    out_nb = tmp_path / notebook
    jupyter = PAPER_ROOT / ".venv/bin/jupyter"
    result = subprocess.run(
        [str(jupyter), "nbconvert", "--to", "notebook", "--execute",
         "--output", str(out_nb), str(nb_path)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    for pdf in pdfs:
        pdf_path = FIGURES_DIR / pdf
        assert pdf_path.exists(), f"{pdf_path} was not produced"
        assert pdf_path.stat().st_size > 1024, f"{pdf_path} is suspiciously small"
