"""Each entry point imports on its own, in a fresh interpreter.

An import cycle can hide in the full suite, or in `switch_core.main`, when
something else happens to load first. Each module here is imported alone, so
a cycle that bites whoever imports it first fails here (the merge of main
`807a1f94d` brought one: `gateway.app` → `rooms` → `agent_templates` →
`template_runs` → `bridges.agent.operations` → back to `agent_templates`).
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

_CORE = Path(__file__).resolve().parents[2]

ENTRY_POINTS = (
    "switch_core.gateway.app",
    "switch_core.template_runs",
    "switch_core.bridges.agent.app",
    "switch_core.main",
)


@pytest.mark.parametrize("module", ENTRY_POINTS)
def test_the_module_imports_on_its_own(module: str) -> None:
    done = subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        cwd=_CORE,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr[-2000:]
