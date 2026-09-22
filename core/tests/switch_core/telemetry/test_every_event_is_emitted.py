"""Every declared event is actually emitted somewhere.

A catalogue entry with no call site is a metric the product believes it has and
does not. That is worse than an absent entry, because the absence is visible in
the code and the silence is only visible in an empty chart six weeks later —
and the reader's first assumption will be that usage is zero, not that nothing
is reporting.

Five entries were in exactly that state when a coverage review looked:
`agent_registered`, `agent_session_started`, `agent_session_ended`,
`first_agent_registered` and `first_session_started` — between them the whole
agent half of the funnel, and two of the metrics the business asked for.
"""

from __future__ import annotations

import ast
from pathlib import Path

import switch_core
from switch_core.telemetry.catalogue import CATALOGUE

_PACKAGE_ROOT = Path(switch_core.__file__).resolve().parent
_CATALOGUE = _PACKAGE_ROOT / "telemetry" / "catalogue.py"


def _emitted_names() -> set[str]:
    """Every string literal passed as the first argument to an emit call.

    Matched on the call rather than on the bare string, so a name that appears
    only in a comment, a docstring or a reason map does not count as an
    emitter. The three shapes in the tree are `telemetry.emit("x", ...)`,
    `await telemetry.emit_milestone("x", ...)` and
    `emit_safely(target, "x", {...})`.
    """
    emitters = {"emit", "emit_milestone", "emit_safely"}
    found: set[str] = set()
    for path in _PACKAGE_ROOT.rglob("*.py"):
        if path == _CATALOGUE:
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            func = node.func
            name = (
                func.attr
                if isinstance(func, ast.Attribute)
                else func.id
                if isinstance(func, ast.Name)
                else None
            )
            if name not in emitters:
                continue
            # `emit_safely` takes the service first, so scan the leading
            # arguments rather than assuming a position.
            for arg in node.args[:2]:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    found.add(arg.value)
    return found


def test_no_declared_event_is_left_unemitted() -> None:
    declared = set(CATALOGUE)
    unemitted = sorted(declared - _emitted_names())
    assert not unemitted, (
        f"{unemitted} are declared in the telemetry catalogue and emitted "
        "nowhere. An event nobody sends is a metric the product believes it "
        "has: the chart is empty and reads as 'no usage' rather than 'not "
        "instrumented'. Either wire it up, or delete the entry and the row it "
        "claims in docs/old/telemetry-events.md."
    )


def test_no_event_is_emitted_without_being_declared() -> None:
    """The other direction. `validate()` already raises at runtime on an
    undeclared name, but that only fires if the branch is taken — this catches
    a typo in a rarely-reached call site at import time instead."""
    declared = set(CATALOGUE)
    # Names passed to an emit call that are not events: `emit_safely`'s first
    # argument is a service, never a literal, so anything found here should be
    # an event name.
    undeclared = sorted(name for name in _emitted_names() if name not in declared)
    assert not undeclared, (
        f"{undeclared} are emitted but not declared in the catalogue. "
        "`validate()` would reject them at runtime; declare them, or fix the "
        "name."
    )


def test_the_detector_would_notice_a_new_unemitted_entry() -> None:
    """The test above only proves today's tree is clean; this proves it can
    fail. Without it, a broken detector reads as a clean catalogue."""
    pretend = set(CATALOGUE) | {"room_abandoned"}
    assert sorted(pretend - _emitted_names()) == ["room_abandoned"]
