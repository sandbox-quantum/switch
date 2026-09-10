"""What may open a database session without a tenant, and who is allowed to.

Two audit surfaces, and the second is the bigger one.

**`unscoped_session`** (`db/session_scope.py`) is the declared fail-open hatch:
it unbinds for the duration of the block, so a query on it reads across every
tenant whether or not the caller had one bound. Its callers are named here.

**A raw `session_factory()` call** is the undeclared one. It inherits whatever
is ambient — the request's tenant on the request path, and *nothing at all* in
background code, since the long-lived tasks deliberately unbind (see
`tenant_context.no_tenant`). So a raw call in background code is unscoped in
fact while saying nothing about it, which is strictly worse than the hatch
that announces itself. There are ~197 of them across the modules below; that
is the number this design has to work down, and pinning the module list is how
a new one becomes a decision rather than a default.

A module failing either check is not a bug in the test. It means someone
opened a session without saying which tenant it is for, and either that is
deliberate and reviewable — add the module below, saying why in the commit —
or it is not, in which case use `tenant_session` and bind the tenant of the
row the work is acting on.
"""

from __future__ import annotations

import ast
from pathlib import Path

import switch_core

# Every module allowed to call `unscoped_session`. Keep this short: it is the
# whole list of places in the process that read across every tenant on purpose.
_ALLOWED_MODULES = {
    # Startup seeding: the admin user and the agent-registration bootstrap
    # owner/key are created before any tenant can be said to exist.
    "switch_core.main",
    # Reconciling every room's client membership at startup fans out across
    # every tenant's rooms; and `_load_room` is the bootstrap read that says
    # which tenant a room is in before that tenant is bound.
    "switch_core.room_service",
    # The runtime-state sweep reads every tenant's stale rows in one pass, and
    # `register_agent_with_token` resolves a credential by its globally unique
    # hash — the read that produces a tenant rather than one that uses it.
    "switch_core.bridges.agent.protocol.service",
    # Starting a bridge reads its own row to learn its tenant, from boot (with
    # nothing bound) and from a request (with the wrong one bound); and
    # `_reject_resource_conflict` must span tenants by definition, since two
    # tenants claiming one Slack workspace is the collision it exists to catch.
    "switch_core.bridges.collaboration.lifecycle_service",
    # `_room_tenant`'s fallback: which tenant is this room in, asked when the
    # answer is not already cached alongside the channel mapping.
    "switch_core.bridges.collaboration.bridge_core",
    # Same as the bridge lifecycle, for server-side connectors.
    "switch_core.bridges.agent.server_connectors.lifecycle",
    # Enumerating every tenant's clients at boot.
    "switch_core.clients.client_lifecycle_service",
    # A client's own task binds nothing, so resolving which agent it is — by
    # globally unique client id — cannot be scoped to a guess.
    "switch_core.clients.agent_client",
    # `joined_rooms` (which rooms is this client in) and `_resolve_room_and_
    # tenant` (which room, and so which tenant, is this transport id) are both
    # lookups that produce a tenant rather than consume one.
    "switch_core.transport.postgres",
}

# Every module allowed to open a session straight from the factory. Unlike the
# list above this one is not short, and is not meant to be permanent: it is an
# inventory of what has not been converted yet, plus the request-path modules
# where inheriting the authenticated request's tenant is the correct answer.
_RAW_SESSION_FACTORY_MODULES = {
    # ── Request path: the session inherits the authenticated caller's tenant,
    # bound by the auth dependency before the endpoint body runs. Correct as
    # it stands; these are not to-dos.
    "switch_core.gateway.auth",
    "switch_core.gateway.dependencies",
    "switch_core.bridges.agent.auth",
    "switch_core.bridges.agent.dependencies",
    "switch_core.bridges.agent.operations.context",
    "switch_core.bridges.agent.operations.definitions",
    "switch_core.bridges.agent.mediation",
    # ── Reached only from inside a unit of work that has already bound the
    # tenant of the row it is acting on — an inbound bridge event, a delivery,
    # a sweep row, an authenticated agent operation.
    "switch_core.bridges.agent.protocol.service",
    "switch_core.bridges.agent.commands",
    "switch_core.bridges.collaboration.bridge_core",
    "switch_core.bridges.collaboration.lifecycle_service",
    "switch_core.bridges.agent.server_connectors.lifecycle",
    "switch_core.clients.agent_client",
    "switch_core.clients.admin_client",
    "switch_core.clients.client_lifecycle_service",
    "switch_core.provisioning.postgres",
    "switch_core.room_service",
    "switch_core.transport.postgres",
    # ── Deployment-level startup, with no tenant to inherit and none bound.
    # Rows these write land in tenant zero via the model default. Correct
    # while one tenant exists; both need revisiting before a second.
    "switch_core.main",
    "switch_core.rooms_yaml",
}

_PACKAGE_ROOT = Path(switch_core.__file__).resolve().parent

# The module that defines the helpers, not a caller of them.
_DEFINITION = _PACKAGE_ROOT / "db" / "session_scope.py"


def _module_name(path: Path) -> str:
    relative = path.relative_to(_PACKAGE_ROOT.parent)
    parts = list(relative.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _local_names_for(tree: ast.AST, imported: str) -> set[str]:
    """Every local name `imported` is reachable under in this module.

    Its own name, plus any alias it was imported as. Without this the
    detectors match a spelling rather than a function, and one `import … as`
    walks straight past them.
    """
    names = {imported}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == imported and alias.asname:
                    names.add(alias.asname)
    return names


def _called_names(tree: ast.AST) -> set[str]:
    """The name of every function called anywhere, attribute access included.

    `foo()` yields "foo"; `self._session_factory()` yields "_session_factory";
    `_state["session_factory"]()` yields "session_factory". Chains collapse to
    their last element, which is what both detectors key on — a session
    factory is reached through something far more often than as a bare name,
    and the gateway reaches it through a module-level dict, which a
    name-and-attribute-only walk misses entirely.
    """
    called = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name):
            called.add(func.id)
        elif isinstance(func, ast.Attribute):
            called.add(func.attr)
        elif isinstance(func, ast.Subscript) and isinstance(func.slice, ast.Constant):
            if isinstance(func.slice.value, str):
                called.add(func.slice.value)
    return called


def _calls_unscoped_session(path: Path) -> bool:
    """Whether `path` calls `unscoped_session`, under any local name."""
    tree = ast.parse(path.read_text(), filename=str(path))
    return bool(_called_names(tree) & _local_names_for(tree, "unscoped_session"))


def _calls_session_factory(path: Path) -> bool:
    """Whether `path` opens a session straight from a factory.

    Matches any call whose name ends in `session_factory`, which is how every
    such call in this tree is spelled — `session_factory()`,
    `self._session_factory()`, `self.session_factory()`. `create_session_
    factory` is excluded: it builds a factory rather than opening a session.
    """
    tree = ast.parse(path.read_text(), filename=str(path))
    return any(
        name.endswith("session_factory") and name != "create_session_factory"
        for name in _called_names(tree)
    )


def _modules_where(predicate: object) -> set[str]:
    found = set()
    for path in _PACKAGE_ROOT.rglob("*.py"):
        if path == _DEFINITION:
            continue
        if predicate(path):  # type: ignore[operator]
            found.add(_module_name(path))
    return found


def test_only_the_allowed_modules_call_unscoped_session() -> None:
    found = _modules_where(_calls_unscoped_session)
    unexpected = found - _ALLOWED_MODULES
    assert not unexpected, (
        f"{sorted(unexpected)} call unscoped_session but are not in "
        "_ALLOWED_MODULES in this test. That helper unbinds the tenant for "
        "the whole block (db/session_scope.py) — if this new call site is "
        "genuinely cross-tenant (a sweep, an enumeration, a lookup that "
        "answers *which* tenant something is in, startup seeding), add its "
        "module to _ALLOWED_MODULES and say why in the commit; otherwise use "
        "tenant_session and bind the tenant the work is actually for."
    )


def test_the_allowlist_names_no_stale_module() -> None:
    """The other direction: every allowed module still actually uses it,
    so the list stays the audit surface it claims to be rather than growing
    entries nobody needs."""
    found = _modules_where(_calls_unscoped_session)
    stale = _ALLOWED_MODULES - found
    assert not stale, f"{sorted(stale)} no longer call unscoped_session; remove them"


def test_only_the_approved_modules_open_a_raw_session() -> None:
    """The surface that actually matters, and the one this design is working
    down. A raw factory call takes whatever tenant is ambient — which in
    background code, now that the long-lived tasks unbind, is none."""
    found = _modules_where(_calls_session_factory)
    unexpected = found - _RAW_SESSION_FACTORY_MODULES
    assert not unexpected, (
        f"{sorted(unexpected)} open a session straight from the factory but "
        "are not in _RAW_SESSION_FACTORY_MODULES in this test. Such a session "
        "inherits whatever tenant is bound, which in background code is "
        "nothing at all. Say which you mean: tenant_session(factory, "
        "<the row's tenant>) for work that acts on one tenant's rows, "
        "unscoped_session(factory) for work that genuinely spans them. If "
        "the call really is reached only from an authenticated request, add "
        "the module below and say so in the commit."
    )


def test_the_raw_session_list_names_no_stale_module() -> None:
    found = _modules_where(_calls_session_factory)
    stale = _RAW_SESSION_FACTORY_MODULES - found
    assert not stale, (
        f"{sorted(stale)} no longer open a raw session — remove them from "
        "_RAW_SESSION_FACTORY_MODULES. Shrinking this list is the point; "
        "leaving converted modules in it hides the progress."
    )


class TestTheDetectorsCatchANewCaller:
    """The four tests above only prove today's tree is clean. These exercise
    the detectors against files that are not in the real source tree at all,
    so they stand on their own even if every real call site is later
    removed."""

    def test_a_plain_unscoped_call_is_detected(self, tmp_path: Path) -> None:
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "async def sweep(session_factory):\n"
            "    async with unscoped_session(session_factory) as session:\n"
            "        ...\n"
        )
        assert _calls_unscoped_session(new_caller)

    def test_an_aliased_import_is_detected(self, tmp_path: Path) -> None:
        """`import … as` must not walk past the check. The detector resolves
        the local name the helper was bound to rather than matching the
        spelling `unscoped_session`."""
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "from switch_core.db.session_scope import unscoped_session as us\n"
            "async def sweep(session_factory):\n"
            "    async with us(session_factory) as session:\n"
            "        ...\n"
        )
        assert _calls_unscoped_session(new_caller)

    def test_a_module_with_no_call_is_not_flagged(self, tmp_path: Path) -> None:
        clean = tmp_path / "an_unrelated_module.py"
        clean.write_text("async def do_work(session):\n    ...\n")
        assert not _calls_unscoped_session(clean)
        assert not _calls_session_factory(clean)

    def test_a_bare_factory_call_is_detected(self, tmp_path: Path) -> None:
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "async def sweep(session_factory):\n"
            "    async with session_factory() as session:\n"
            "        ...\n"
        )
        assert _calls_session_factory(new_caller)

    def test_a_factory_reached_through_self_is_detected(self, tmp_path: Path) -> None:
        new_caller = tmp_path / "a_new_service.py"
        new_caller.write_text(
            "class Service:\n"
            "    async def run(self):\n"
            "        async with self._session_factory() as session:\n"
            "            ...\n"
        )
        assert _calls_session_factory(new_caller)

    def test_a_factory_reached_through_a_dict_is_detected(self, tmp_path: Path) -> None:
        """How the gateway holds its factory. Worth its own case: a walk over
        names and attributes alone reports this module as clean."""
        new_caller = tmp_path / "a_new_dependency.py"
        new_caller.write_text(
            "_state = {}\n"
            "async def get_session():\n"
            '    async with _state["session_factory"]() as session:\n'
            "        yield session\n"
        )
        assert _calls_session_factory(new_caller)

    def test_building_a_factory_is_not_opening_a_session(self, tmp_path: Path) -> None:
        clean = tmp_path / "wiring.py"
        clean.write_text(
            "def wire(engine):\n    return create_session_factory(engine)\n"
        )
        assert not _calls_session_factory(clean)

    def test_the_allowlist_check_would_fail_for_a_hypothetical_new_caller(self) -> None:
        """Simulates what `test_only_the_allowed_modules_call_unscoped_session`
        does, against a found-set that includes a module nobody added to
        `_ALLOWED_MODULES` — pinning that the check actually fails rather
        than, say, silently ignoring an unknown module."""
        found = _modules_where(_calls_unscoped_session) | {"switch_core.a_new_sweep"}
        unexpected = found - _ALLOWED_MODULES
        assert unexpected == {"switch_core.a_new_sweep"}
