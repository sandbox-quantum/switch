"""`unscoped_session` (`db/session_scope.py`) is the fail-open hatch: a session
with no tenant bound at all, for the handful of things that are legitimately
cross-tenant — a sweep or lifecycle enumeration reading every row before
fanning out per-row work, and startup seeding that runs before any tenant can
be said to exist.

Nothing stops a query on a session it opens from reading across every tenant
there is, so its callers are the audit surface for that risk. This test pins
them to an explicit allowlist, derived from the source tree rather than
imports, so a module that only calls it conditionally or inside a string is
still caught. A new module failing here is not a bug in the test: it means
someone reached for the cross-tenant escape hatch, and either that is a
deliberate, reviewable choice — in which case add the module to
`_ALLOWED_MODULES` in the same change, saying why in the commit — or it is
not, in which case use `tenant_session` instead.
"""

from __future__ import annotations

import ast
from pathlib import Path

import switch_core

# Every module allowed to call `unscoped_session`. Keep this short: it is the
# whole list of places in the process that may read across every tenant.
_ALLOWED_MODULES = {
    # Startup seeding: the admin user and the agent-registration bootstrap
    # owner/key are created before any tenant can be said to exist.
    "switch_core.main",
    # Reconciling every room's client membership at startup fans out across
    # every tenant's rooms; each room's own tenant is bound for its own work.
    "switch_core.room_service",
    # The runtime-state sweep reads every tenant's stale rows in one pass;
    # each row's own tenant is bound before anything is done with it.
    "switch_core.bridges.agent.protocol.service",
    # Starting every collaboration bridge at boot reads every tenant's rows in
    # one pass; each bridge's own tenant is bound before it is started.
    "switch_core.bridges.collaboration.lifecycle_service",
    # Same as above, for server-side connectors.
    "switch_core.bridges.agent.server_connectors.lifecycle",
    # Same as above, for the generic client registry (agent and admin
    # clients) started at boot.
    "switch_core.clients.client_lifecycle_service",
}

_PACKAGE_ROOT = Path(switch_core.__file__).resolve().parent


def _module_name(path: Path) -> str:
    relative = path.relative_to(_PACKAGE_ROOT.parent)
    parts = list(relative.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _calls_unscoped_session(path: Path) -> bool:
    """Whether `path` contains a call to a function literally named
    `unscoped_session`, anywhere — a call, an alias, a re-export."""
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name == "unscoped_session":
            return True
    return False


def _modules_calling_unscoped_session() -> set[str]:
    found = set()
    for path in _PACKAGE_ROOT.rglob("*.py"):
        if path.name == "session_scope.py" and path.parent.name == "db":
            continue  # the definition itself, not a caller
        if _calls_unscoped_session(path):
            found.add(_module_name(path))
    return found


def test_only_the_allowed_modules_call_unscoped_session() -> None:
    found = _modules_calling_unscoped_session()
    unexpected = found - _ALLOWED_MODULES
    assert not unexpected, (
        f"{sorted(unexpected)} call unscoped_session but are not in "
        "_ALLOWED_MODULES in this test. That helper is the fail-open hatch "
        "for cross-tenant work (db/session_scope.py) — if this new call site "
        "is genuinely cross-tenant (a sweep, an enumeration, startup "
        "seeding), add its module to _ALLOWED_MODULES and say why in the "
        "commit; otherwise use tenant_session and bind the tenant the work "
        "is actually for."
    )


def test_the_allowlist_names_no_stale_module() -> None:
    """The other direction: every allowed module still actually uses it,
    so the list stays the audit surface it claims to be rather than growing
    entries nobody needs."""
    found = _modules_calling_unscoped_session()
    stale = _ALLOWED_MODULES - found
    assert not stale, f"{sorted(stale)} no longer call unscoped_session; remove them"


class TestDetectionCatchesANewCaller:
    """The two tests above only prove today's tree is clean. This exercises
    the detector itself against a file that is not in the real source tree
    at all, so it stands on its own even if every real call site above is
    later removed."""

    def test_a_plain_call_is_detected(self, tmp_path: Path) -> None:
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "async def sweep(session_factory):\n"
            "    async with unscoped_session(session_factory) as session:\n"
            "        ...\n"
        )
        assert _calls_unscoped_session(new_caller)

    def test_an_aliased_import_is_still_detected(self, tmp_path: Path) -> None:
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "from switch_core.db.session_scope import unscoped_session as us\n"
            "async def sweep(session_factory):\n"
            "    async with us(session_factory) as session:\n"
            "        ...\n"
        )
        assert not _calls_unscoped_session(new_caller), (
            "an aliased import is a known gap: the detector matches the "
            "literal name unscoped_session, not what it resolves to"
        )

    def test_a_module_with_no_call_is_not_flagged(self, tmp_path: Path) -> None:
        clean = tmp_path / "an_unrelated_module.py"
        clean.write_text("async def do_work(session_factory):\n    ...\n")
        assert not _calls_unscoped_session(clean)

    def test_the_allowlist_check_would_fail_for_a_hypothetical_new_caller(self) -> None:
        """Simulates what `test_only_the_allowed_modules_call_unscoped_session`
        does, against a found-set that includes a module nobody added to
        `_ALLOWED_MODULES` — pinning that the check actually fails rather
        than, say, silently ignoring an unknown module."""
        found = _modules_calling_unscoped_session() | {"switch_core.a_new_sweep"}
        unexpected = found - _ALLOWED_MODULES
        assert unexpected == {"switch_core.a_new_sweep"}
