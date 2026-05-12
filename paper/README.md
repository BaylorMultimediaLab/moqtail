# Paper figures

Figures for the MMSys 2026 Special Session paper. See
[docs/superpowers/specs/2026-05-03-paper-figures-design.md](../docs/superpowers/specs/2026-05-03-paper-figures-design.md)
for the figure spec.

## Build all figures

    cd paper
    uv sync
    make all

Outputs land in `paper/figures/`. Sources read from
`../tests/experiments/results/`.

## Notebook hygiene

Notebooks are committed without cell outputs to keep diffs small. Strip
outputs before staging:

    .venv/bin/nbstripout notebooks/<name>.ipynb

Or install the git filter once per clone so it happens automatically:

    .venv/bin/nbstripout --install

## Build a single figure

    make figures/fig2_e2_e3_playhead_gap.pdf
