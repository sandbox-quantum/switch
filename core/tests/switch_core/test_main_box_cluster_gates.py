"""Without a box cluster, Core starts none of the boxes' background work.

Agent management is always installed (upstream retired its flag), so what
keeps the boxes' sweeps off on a server with no box cluster is `box_cluster`
alone, never whether management exists. The hosted sweep is gated inside
`start_hosted_sweep`; the two started inline in `main.py` are checked here, on
the source, since they run only inside the server's lifespan."""

from __future__ import annotations

import ast
from pathlib import Path

import switch_core.main

MAIN = Path(switch_core.main.__file__)
# Started by `main.py` itself, and the boxes' alone.
GATE = "box_cluster"
BOX_ONLY_CALLS = {"own_restart_sweep", "_sweep_hosted_actions"}


def _names(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _gated_calls() -> dict[str, list[bool]]:
    """For each box-only call in main.py, whether each call site sits under a
    condition (an `if` or a conditional expression) that reads `box_cluster`."""
    tree = ast.parse(MAIN.read_text())
    found: dict[str, list[bool]] = {name: [] for name in BOX_ONLY_CALLS}

    def visit(node: ast.AST, gated: bool) -> None:
        if isinstance(node, ast.If):
            inner = gated or GATE in _names(node.test)
            visit(node.test, gated)
            for child in node.body:
                visit(child, inner)
            for child in node.orelse:
                visit(child, gated)
            return
        if isinstance(node, ast.IfExp):
            visit(node.test, gated)
            visit(node.body, gated or GATE in _names(node.test))
            visit(node.orelse, gated)
            return
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in BOX_ONLY_CALLS
        ):
            found[node.func.id].append(gated)
        for child in ast.iter_child_nodes(node):
            visit(child, gated)

    visit(tree, False)
    return found


def test_every_box_only_sweep_main_starts_is_behind_the_box_cluster() -> None:
    found = _gated_calls()
    for name, sites in found.items():
        assert sites, f"{name} is no longer started in main.py: update this test"
        assert all(sites), f"{name} is started in main.py without a box cluster"
