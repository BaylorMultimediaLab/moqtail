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

## Build a single figure

    make figures/fig2_e2_e3_playhead_gap.pdf
