"""Only the pause, resume and per-person switch write
the two marks. No other route or store can set `users.hosted_paused_at` or
`tenant_members.hosted_enabled`, so a user can't clear their own pause and an
admin can only change the switch through the guarded route."""

from __future__ import annotations

import re
from pathlib import Path

_CORE = Path(__file__).resolve().parents[3] / "switch_core"
_WRITES = re.compile(
    r"(\.hosted_paused_at\s*=[^=]|hosted_paused_at\s*=\s*[^=]|"
    r"\.hosted_enabled\s*=[^=]|hosted_enabled\s*=\s*[^=]|"
    r"setattr\([^)]*[\"']hosted_(paused_at|enabled)[\"'])"
)
# Where a mark is declared, or the one module that writes them.
_ALLOWED = {
    Path("db/models.py"),
    Path("visibility/hosted_access.py"),
}


def test_only_hosted_access_writes_the_pause_and_the_switch() -> None:
    writers = set()
    for path in _CORE.rglob("*.py"):
        relative = path.relative_to(_CORE)
        if relative.parts[0] == "migrations":
            continue
        for line in path.read_text().splitlines():
            code = line.split("#", 1)[0]
            if _WRITES.search(code):
                writers.add(relative)
    assert writers <= _ALLOWED, sorted(str(p) for p in writers - _ALLOWED)
    assert Path("visibility/hosted_access.py") in writers  # the scan does see writes


def test_the_only_routes_that_reach_the_writer_are_guarded() -> None:
    routes = _CORE / "visibility" / "hosted_access_routes.py"
    callers = {
        path.relative_to(_CORE)
        for path in _CORE.rglob("*.py")
        if re.search(r"\.(pause|resume|set_member)\(", path.read_text())
        and "HostedAccess" in path.read_text()
        and path.name != "hosted_access.py"
    }
    assert callers == {routes.relative_to(_CORE)}
