"""Who may reach the exemption from row-level security, and who may open a
session without saying which tenant it is for.

Two audit surfaces, and neither is the enforcement — the database is. That is
the difference between this file and the one it replaces
(`test_unscoped_session_allowlist.py`). `unscoped_session` genuinely read
across every tenant, so the list of its callers *was* the isolation boundary
and a missing entry was a leak. It only did that because every environment
connected as the tables' owner; under the restricted runtime role an unbound
session reads nothing. So these lists are now what they always should have
been: an inventory a reviewer can read, backed by a database that refuses
regardless.

**`db/tenant_lookup.py`** is the whole exemption: seven `SECURITY DEFINER`
functions that answer *which tenant* and never return a row. Every module that
imports one is named below. Keep the list short — it is the complete set of
places in the process that ask a question no tenant can be scoped to.

Short in both directions. A module reaches the exemption if it *can* call a
lookup, not if it happens to; a helper on an injected store, reachable by
anything that declares the store, put one module on this list and the
exemption within reach of every endpoint behind it. That is why
`get_sole_tenant_id` lives in `gateway/auth.py` as a function rather than on a
`TenantMemberStore`: the one caller it ever had is the one module named here.

**A raw `session_factory()` call** is the other surface. It inherits whatever
is ambient, which in background code is nothing at all, since the long-lived
tasks deliberately unbind (see `tenant_context.no_tenant`). Such a session can
now only read the tables that carry no policy — `users`, `oidc_identities`,
`feature_flags` — so it is no longer a way to cross a tenant boundary, but it
is still a session whose call site did not say what it was for.

A module failing either check is not a bug in the test. It means someone
reached for the exemption, or opened a session with nothing bound, without
saying why — and either that is deliberate and reviewable, in which case add
the module below and argue for it in the commit, or it is not, in which case
use `tenant_session` and bind the tenant of the row the work is acting on.
"""

from __future__ import annotations

import ast
from pathlib import Path

import switch_core
from switch_core.db.tenant_lookup import TENANT_LOOKUPS

# Every module allowed to call one of the tenant lookups. This is the whole
# audit surface of the exemption: each entry is a place that has to answer
# "which tenant" before it can scope anything.
_ALLOWED_MODULES = {
    # Startup: which tenants exist, to fan the boot work out over them, and
    # which tenant holds the deployment-wide bootstrap key.
    "switch_core.main",
    # Reconciling every room's client membership at startup fans out over
    # every tenant's rooms before binding each room's own tenant.
    "switch_core.room_service",
    # The runtime-state sweep reads every tenant's stale rows, one tenant at a
    # time; `register_agent_with_token` resolves a registration credential by
    # its globally unique hash, which is the read that produces a tenant.
    "switch_core.bridges.agent.protocol.service",
    # Bearer and OIDC authentication: the credential's tenant, before its row.
    "switch_core.bridges.agent.auth",
    # The gateway's JWT subject resolves to its membership, and
    # `tenant_members` is scoped, so nothing else can answer it. In the
    # authentication module itself rather than on an injected store: a store
    # is reachable by any endpoint that declares it, which would make this
    # list name one module while the exemption was open to every route.
    "switch_core.gateway.auth",
    # Enumerating tenants at boot, and starting one bridge or one connector by
    # id from a context bound to somebody else's tenant.
    "switch_core.clients.client_lifecycle_service",
    "switch_core.bridges.collaboration.lifecycle_service",
    "switch_core.bridges.agent.server_connectors.lifecycle",
    # `_room_tenant`'s fallback: which tenant is this room in, asked when the
    # answer is not already cached alongside the channel mapping.
    "switch_core.bridges.collaboration.bridge_core",
    # An inbound webhook from an installed workspace: the platform's signature
    # proves the sender and the payload names a workspace, and nothing in
    # either names a tenant. It is the one read that must happen before a
    # tenant can be bound at all, and the install row is then re-read scoped to
    # the tenant it produced, so a wrong answer here is a miss rather than a
    # cross-tenant read.
    "switch_core.bridges.collaboration.install_service",
    # `switch_core.transport.postgres` and `switch_core.clients.agent_client`
    # came off this list with `tenant_of_client`: both were built from a
    # `clients` row that already named the tenant, so they carry it instead of
    # asking for it.
}

# Every module allowed to open a session straight from the factory. Not short,
# and not meant to be permanent: an inventory of what has not been converted
# yet, plus the request-path modules where inheriting the authenticated
# request's tenant is the correct answer.
_RAW_SESSION_FACTORY_MODULES = {
    # ── Request path: the session inherits the authenticated caller's tenant,
    # bound by the auth dependency before the endpoint body runs. Correct as
    # it stands; these are not to-dos.
    "switch_core.gateway.auth",
    "switch_core.gateway.dependencies",
    "switch_core.bridges.agent.dependencies",
    "switch_core.bridges.agent.operations.context",
    "switch_core.bridges.agent.operations.definitions",
    "switch_core.bridges.agent.mediation",
    # Reached only from the gateway's rooms endpoints, so the same holds.
    "switch_core.rooms_yaml",
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
    # ── The exemption's own plumbing. It opens a session with nothing bound
    # on purpose and touches only the seven functions above, which are the one
    # thing a session with nothing bound may read.
    "switch_core.db.tenant_lookup",
    # `switch_core.transport.postgres` and `switch_core.bridges.agent.auth`
    # came off this list with the runtime role: the transport learned its own
    # tenant from its client row and the middleware learned a credential's
    # from the exemption, so neither has a session left that says nothing.
    # `switch_core.main` came off it earlier, when the tenant-zero fallback
    # went.
}

# Calls that end in `session_factory` but hand one back rather than open a
# session with it.
_FACTORY_ACCESSORS = {"create_session_factory", "get_session_factory"}

_LOOKUP_NAMES = {lookup.name for lookup in TENANT_LOOKUPS}

_LOOKUP_MODULE = "switch_core.db.tenant_lookup"
_LOOKUP_PACKAGE, _, _LOOKUP_MODULE_LEAF = _LOOKUP_MODULE.rpartition(".")

_PACKAGE_ROOT = Path(switch_core.__file__).resolve().parent

# The modules that define the two things, rather than reaching for them.
_LOOKUP_DEFINITION = _PACKAGE_ROOT / "db" / "tenant_lookup.py"
_SESSION_SCOPE = _PACKAGE_ROOT / "db" / "session_scope.py"


def _module_name(path: Path) -> str:
    relative = path.relative_to(_PACKAGE_ROOT.parent)
    parts = list(relative.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _imports_a_lookup(path: Path) -> bool:
    """Whether `path` reaches for one of the exempt lookups.

    Matched on the import rather than on the call, unlike the raw-factory
    detector below, because there is a single module to import from and
    Python has only three ways to name it. All three are checked, because
    checking one and describing it as "the import" is how an audit surface
    comes to be narrower than the thing it claims to cover:

    - `from switch_core.db.tenant_lookup import tenants_of_user` — the shape
      every current caller uses. An `as` alias renames the local binding but
      not the name inside the `from` clause, so aliasing cannot walk past it.
    - `import switch_core.db.tenant_lookup [as x]` — binds the module, and
      every function on it, under a name of the writer's choosing.
    - `from switch_core.db import tenant_lookup [as x]` — the same thing
      spelled so that the module name never appears in a `from` clause at all.

    The last two are flagged on reaching the *module*, without asking which
    attribute is used, because there is no attribute on it worth having except
    a lookup and the DDL helpers, and a module holding the module object can
    reach any of them at any point later.

    Importing the DDL helpers *by name* is not reaching for the exemption:
    `TENANT_LOOKUPS` and `attach_tenant_lookups` describe it rather than using
    it, which is why the first shape asks which names are imported and the
    other two cannot. Importing without calling is flagged too, which is the
    safe direction — a module that reaches for the exemption at all is one
    this list wants to name.
    """
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name == _LOOKUP_MODULE for alias in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            if node.module == _LOOKUP_MODULE:
                if any(alias.name in _LOOKUP_NAMES for alias in node.names):
                    return True
            elif node.module == _LOOKUP_PACKAGE:
                if any(alias.name == _LOOKUP_MODULE_LEAF for alias in node.names):
                    return True
    return False


def _called_names(tree: ast.AST) -> set[str]:
    """The name of every function called anywhere, attribute access included.

    `foo()` yields "foo"; `self._session_factory()` yields "_session_factory";
    `_state["session_factory"]()` yields "session_factory". Chains collapse to
    their last element, which is what the detector keys on — a session factory
    is reached through something far more often than as a bare name, and the
    gateway reaches it through a module-level dict, which a name-and-attribute
    -only walk misses entirely.
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


def _calls_session_factory(path: Path) -> bool:
    """Whether `path` opens a session straight from a factory.

    Matches any call whose name ends in `session_factory`, which is how every
    such call in this tree is spelled — `session_factory()`,
    `self._session_factory()`, `self.session_factory()`.

    A name match rather than a resolved reference: there is no single
    definition to alias, since every service is handed its own factory. That
    makes it over-eager rather than under-eager, which is the safe direction
    for an audit — except for the two accessors that hand a factory back
    instead of opening a session with it, which are named.
    """
    tree = ast.parse(path.read_text(), filename=str(path))
    return any(
        name.endswith("session_factory") and name not in _FACTORY_ACCESSORS
        for name in _called_names(tree)
    )


def _modules_where(predicate: object, *, skip: Path | None = None) -> set[str]:
    found = set()
    for path in _PACKAGE_ROOT.rglob("*.py"):
        if skip is not None and path == skip:
            continue
        if predicate(path):  # type: ignore[operator]
            found.add(_module_name(path))
    return found


def test_only_the_allowed_modules_reach_the_exemption() -> None:
    found = _modules_where(_imports_a_lookup, skip=_LOOKUP_DEFINITION)
    unexpected = found - _ALLOWED_MODULES
    assert not unexpected, (
        f"{sorted(unexpected)} import a tenant lookup but are not in "
        "_ALLOWED_MODULES in this test. Those functions are the whole "
        "exemption from row-level security (db/tenant_lookup.py) — if this "
        "new call site genuinely has to answer 'which tenant' before it can "
        "scope anything (a credential, a boot enumeration, an id reached with "
        "nothing bound), add its module below and say why in the commit; "
        "otherwise use tenant_session and bind the tenant the work is for."
    )


def test_the_allowlist_names_no_stale_module() -> None:
    """The other direction: every allowed module still actually reaches it, so
    the list stays the audit surface it claims to be rather than growing
    entries nobody needs."""
    found = _modules_where(_imports_a_lookup, skip=_LOOKUP_DEFINITION)
    stale = _ALLOWED_MODULES - found
    assert not stale, f"{sorted(stale)} no longer reach the exemption; remove them"


def test_no_module_still_reaches_for_an_unscoped_session() -> None:
    """`unscoped_session` is gone, and nothing may bring it back by name.

    A helper called that again would look like the fail-open hatch this design
    used to have and would not be one: under the runtime role an unbound
    session reads nothing rather than everything, so the name would promise
    the opposite of what it delivered. Cheap to assert, and it catches a
    revert.
    """
    import switch_core.db.session_scope as session_scope

    assert not hasattr(session_scope, "unscoped_session")
    offenders = sorted(
        _module_name(path)
        for path in _PACKAGE_ROOT.rglob("*.py")
        if "unscoped_session(" in path.read_text()
    )
    assert not offenders, f"{offenders} still call unscoped_session"


def test_only_the_approved_modules_open_a_raw_session() -> None:
    """A raw factory call takes whatever tenant is ambient — which in
    background code, now that the long-lived tasks unbind, is none."""
    found = _modules_where(_calls_session_factory, skip=_SESSION_SCOPE)
    unexpected = found - _RAW_SESSION_FACTORY_MODULES
    assert not unexpected, (
        f"{sorted(unexpected)} open a session straight from the factory but "
        "are not in _RAW_SESSION_FACTORY_MODULES in this test. Such a session "
        "inherits whatever tenant is bound, which in background code is "
        "nothing at all — and a session with nothing bound can only read the "
        "tables that carry no policy. Say which you mean: tenant_session("
        "factory, <the row's tenant>) for work that acts on one tenant's "
        "rows, or one of the lookups in db/tenant_lookup.py for the question "
        "that produces a tenant. If the call really is reached only from an "
        "authenticated request, add the module below and say so in the commit."
    )


def test_the_raw_session_list_names_no_stale_module() -> None:
    found = _modules_where(_calls_session_factory, skip=_SESSION_SCOPE)
    stale = _RAW_SESSION_FACTORY_MODULES - found
    assert not stale, (
        f"{sorted(stale)} no longer open a raw session — remove them from "
        "_RAW_SESSION_FACTORY_MODULES. Shrinking this list is the point; "
        "leaving converted modules in it hides the progress."
    )


class TestTheDetectorsCatchANewCaller:
    """The tests above only prove today's tree is clean. These exercise the
    detectors against files that are not in the real source tree at all, so
    they stand on their own even if every real call site is later removed."""

    def test_a_lookup_import_is_detected(self, tmp_path: Path) -> None:
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "from switch_core.db.tenant_lookup import all_tenant_ids\n"
            "async def sweep(session_factory):\n"
            "    return await all_tenant_ids(session_factory)\n"
        )
        assert _imports_a_lookup(new_caller)

    def test_an_aliased_lookup_import_is_detected(self, tmp_path: Path) -> None:
        """`import ... as` must not walk past the check. The detector matches
        the imported name inside the `from` clause, which an alias leaves
        alone."""
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "from switch_core.db.tenant_lookup import all_tenant_ids as every\n"
            "async def sweep(session_factory):\n"
            "    return await every(session_factory)\n"
        )
        assert _imports_a_lookup(new_caller)

    def test_importing_the_module_itself_is_detected(self, tmp_path: Path) -> None:
        """`import switch_core.db.tenant_lookup` names no function in the
        statement, so a detector that only reads `from ... import` clauses
        reports the module clean while it calls whatever it likes off the
        module object."""
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "import switch_core.db.tenant_lookup\n"
            "async def sweep(session_factory):\n"
            "    return await switch_core.db.tenant_lookup.all_tenant_ids(\n"
            "        session_factory\n"
            "    )\n"
        )
        assert _imports_a_lookup(new_caller)

    def test_an_aliased_module_import_is_detected(self, tmp_path: Path) -> None:
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "import switch_core.db.tenant_lookup as lookups\n"
            "async def sweep(session_factory):\n"
            "    return await lookups.all_tenant_ids(session_factory)\n"
        )
        assert _imports_a_lookup(new_caller)

    def test_importing_the_module_from_its_package_is_detected(
        self, tmp_path: Path
    ) -> None:
        """`from switch_core.db import tenant_lookup` reaches the same module
        without its dotted name ever appearing in a `from` clause."""
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "from switch_core.db import tenant_lookup\n"
            "async def sweep(session_factory):\n"
            "    return await tenant_lookup.all_tenant_ids(session_factory)\n"
        )
        assert _imports_a_lookup(new_caller)

    def test_an_aliased_package_relative_module_import_is_detected(
        self, tmp_path: Path
    ) -> None:
        new_caller = tmp_path / "a_new_background_job.py"
        new_caller.write_text(
            "from switch_core.db import tenant_lookup as lookups\n"
            "async def sweep(session_factory):\n"
            "    return await lookups.all_tenant_ids(session_factory)\n"
        )
        assert _imports_a_lookup(new_caller)

    def test_a_neighbouring_module_from_the_same_package_is_not_flagged(
        self, tmp_path: Path
    ) -> None:
        """The package-relative shape must key on the module, not the package.
        `from switch_core.db import ...` is how half the tree reaches a
        session helper, and flagging all of it would make the list meaningless
        by being unreadable."""
        clean = tmp_path / "an_ordinary_service.py"
        clean.write_text(
            "from switch_core.db import session_scope\n"
            "async def work(session_factory, tenant_id):\n"
            "    async with session_scope.tenant_session(\n"
            "        session_factory, tenant_id\n"
            "    ) as session:\n"
            "        ...\n"
        )
        assert not _imports_a_lookup(clean)

    def test_importing_the_ddl_helpers_is_not_reaching_for_it(
        self, tmp_path: Path
    ) -> None:
        """`db/models.py` and the migration test import from this module
        without using the exemption; flagging them would make the list mean
        something other than what it says."""
        schema_code = tmp_path / "schema.py"
        schema_code.write_text(
            "from switch_core.db.tenant_lookup import attach_tenant_lookups\n"
        )
        assert not _imports_a_lookup(schema_code)

    def test_a_module_with_no_call_is_not_flagged(self, tmp_path: Path) -> None:
        clean = tmp_path / "an_unrelated_module.py"
        clean.write_text("async def do_work(session):\n    ...\n")
        assert not _imports_a_lookup(clean)
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

    def test_handing_a_factory_back_is_not_opening_a_session(
        self, tmp_path: Path
    ) -> None:
        clean = tmp_path / "wiring.py"
        clean.write_text(
            "def wire(engine):\n"
            "    return create_session_factory(engine)\n"
            "def fetch():\n"
            "    return get_session_factory()\n"
        )
        assert not _calls_session_factory(clean)

    def test_the_allowlist_check_would_fail_for_a_hypothetical_new_caller(self) -> None:
        """Simulates what `test_only_the_allowed_modules_reach_the_exemption`
        does, against a found-set that includes a module nobody added to
        `_ALLOWED_MODULES` — pinning that the check actually fails rather
        than, say, silently ignoring an unknown module."""
        found = _modules_where(_imports_a_lookup, skip=_LOOKUP_DEFINITION) | {
            "switch_core.a_new_sweep"
        }
        unexpected = found - _ALLOWED_MODULES
        assert unexpected == {"switch_core.a_new_sweep"}
