"""Pytest fixtures for paper experiments.

Re-exports tests/network/conftest.py fixtures (`net`, `relay_proc`,
`publisher_proc`, `browser_page`, `collector`, `results_dir`, `config`,
`project_root`, `results_base`) so experiment tests share the regression
suite's Mininet/relay/publisher/Playwright lifecycle.

Per-experiment overrides (relay --cache-size, publisher --ladder-spec) live
in Task 7's follow-up; this file only sets up the import scaffolding.
"""
import sys
from pathlib import Path

# Make tests/network importable as a sibling. tests/experiments/pyproject.toml
# already lists "../network" in pythonpath, but doing this here too makes
# `pytest tests/experiments/...` invocations from arbitrary cwd robust.
_NETWORK_DIR = Path(__file__).resolve().parent.parent / "network"
if str(_NETWORK_DIR) not in sys.path:
    sys.path.insert(0, str(_NETWORK_DIR))

# Pull in every fixture and helper the regression suite defines.
from conftest import *  # noqa: F401,F403
from conftest import pytest_addoption  # noqa: F401  (pytest needs to find this hook)
