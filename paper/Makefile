# Build all paper figures from raw experiment results.
#
# Usage:
#   make all         # build every figure
#   make figures/fig2_e2_e3_playhead_gap.pdf
#   make clean       # delete generated PDFs/PNGs

# Make matplotlib + pdflatex output deterministic so re-runs don't
# create spurious git-modified status on regenerated PDFs.
export SOURCE_DATE_EPOCH := 0

NOTEBOOKS := \
  notebooks/fig2_e2_e3_playhead_gap.ipynb \
  notebooks/fig3_trace_naive_vs_aligned.ipynb \
  notebooks/fig4_e4_cache_boundary.ipynb \
  notebooks/fig5_e6_composability.ipynb \
  notebooks/fig5b_e6_goodput.ipynb \
  notebooks/fig6_e5_unfiltered_naive.ipynb \
  notebooks/fig6b_e5_goodput.ipynb \
  notebooks/fig7_e7_aligned.ipynb \
  notebooks/fig7b_e7_goodput.ipynb \
  notebooks/fig5c_e6_throughput.ipynb \
  notebooks/fig6c_e5_throughput.ipynb \
  notebooks/fig7c_e7_throughput.ipynb

PDFS := \
  figures/fig1_architecture.pdf \
  figures/fig2_e2_e3_playhead_gap.pdf \
  figures/fig3a_trace_naive.pdf \
  figures/fig3b_trace_aligned.pdf \
  figures/fig4_e4_cache_boundary.pdf \
  figures/fig5_e6_composability.pdf \
  figures/fig5b_e6_goodput.pdf \
  figures/fig6_e5_unfiltered_naive.pdf \
  figures/fig6b_e5_goodput.pdf \
  figures/fig7_e7_aligned.pdf \
  figures/fig7b_e7_goodput.pdf \
  figures/fig5c_e6_throughput.pdf \
  figures/fig6c_e5_throughput.pdf \
  figures/fig7c_e7_throughput.pdf

.PHONY: all clean test
all: $(PDFS)

# Notebook-driven figures.
figures/fig2_e2_e3_playhead_gap.pdf: notebooks/fig2_e2_e3_playhead_gap.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

# Both PDFs are emitted by the same notebook execution; declare each as a
# target with the same recipe so make can request either by name.
figures/fig3a_trace_naive.pdf figures/fig3b_trace_aligned.pdf: notebooks/fig3_trace_naive_vs_aligned.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

figures/fig4_e4_cache_boundary.pdf: notebooks/fig4_e4_cache_boundary.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

figures/fig5_e6_composability.pdf: notebooks/fig5_e6_composability.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

figures/fig5b_e6_goodput.pdf: notebooks/fig5b_e6_goodput.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

figures/fig6_e5_unfiltered_naive.pdf: notebooks/fig6_e5_unfiltered_naive.ipynb
	uv run jupyter nbconvert --to notebook --execute --inplace $<

figures/fig6b_e5_goodput.pdf: notebooks/fig6b_e5_goodput.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

figures/fig7_e7_aligned.pdf: notebooks/fig7_e7_aligned.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

figures/fig7b_e7_goodput.pdf: notebooks/fig7b_e7_goodput.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

figures/fig5c_e6_throughput.pdf: notebooks/fig5c_e6_throughput.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

figures/fig6c_e5_throughput.pdf: notebooks/fig6c_e5_throughput.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

figures/fig7c_e7_throughput.pdf: notebooks/fig7c_e7_throughput.ipynb
	.venv/bin/jupyter nbconvert --to notebook --execute --inplace $<

# TikZ figure.
figures/fig1_architecture.pdf: figures/fig1_architecture.tex
	cd figures && pdflatex -interaction=nonstopmode fig1_architecture.tex \
	  && rm -f fig1_architecture.aux fig1_architecture.log fig1_architecture.fls fig1_architecture.fdb_latexmk fig1_architecture.synctex.gz fig1_architecture.out

test:
	.venv/bin/pytest tests/ -v

clean:
	rm -f figures/fig2*.pdf figures/fig2*.png \
	      figures/fig3*.pdf figures/fig3*.png \
	      figures/fig4*.pdf figures/fig4*.png \
	      figures/fig5*.pdf figures/fig5*.png \
	      figures/fig6*.pdf figures/fig6*.png \
	      figures/fig7*.pdf figures/fig7*.png \
	      figures/fig1_architecture.pdf \
	      figures/fig1_architecture.aux figures/fig1_architecture.log \
	      figures/fig1_architecture.fls figures/fig1_architecture.fdb_latexmk \
	      figures/fig1_architecture.synctex.gz figures/fig1_architecture.out
