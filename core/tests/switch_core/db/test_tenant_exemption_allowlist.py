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
`_resolve_tenant_id` and `list_tenant_memberships` live in `gateway/auth.py`
as functions rather than on a `TenantMemberStore`: whatever calls them —
`gateway/tenants.py` included — reaches the exemption through this one
module, never directly through a store any endpoint could declare for itself.

**A raw factory call** (`session_factory()`, or a factory handed in as
`factory`) is the other surface. It inherits whatever
is ambient, which in background code is nothing at all, since the long-lived
tasks deliberately unbind (see `tenant_context.no_tenant`). Such a session can
now only read the tables that carry no policy — `users`, `oidc_identities`
and the installation's telemetry records — so it is no longer a way to cross a tenant boundary, but it
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
    # Session-activity upkeep expires overdue approval requests and prunes
    # old activity lines in every tenant: enumerate, then bind each tenant and
    # work under its own policy, the same shape as the runtime-state sweep.
    "switch_core.session_activity.maintenance",
    # Service-token upkeep revokes tokens whose grant or owner is gone and
    # prunes issuance records past retention, in every tenant: enumerate,
    # then bind each tenant and work under its own policy, the same shape as
    # session-activity upkeep above.
    "switch_core.connections.maintenance",
    # The operator's Connectors page counts who is connected through each
    # app, and who would have to reconnect if it were replaced, across every
    # workspace: enumerate, then read each one's connections under its own
    # policy, the same shape as service-token upkeep above.
    "switch_core.gateway.connector_apps",
    # Data retention deletes what each workspace no longer keeps, hourly:
    # enumerate, then bind each tenant and work under its own policy, the same
    # shape as session-activity upkeep.
    "switch_core.retention.service",
    # The erasure loop works every tenant's queue of person erasures:
    # enumerate, then bind each tenant and work under its own policy, the
    # same shape as session-activity upkeep.
    "switch_core.retention.erasure",
    # The runtime-state sweep reads every tenant's stale rows, one tenant at a
    # time.
    "switch_core.bridges.agent.protocol.agent_core",
    # Each process keeps a copy of every other process's agent connections, so
    # its periodic pass over the recorded rows reads every tenant's: enumerate
    # the tenants, then read each one's rows under its own policy, the same
    # shape as the runtime-state sweep.
    "switch_core.bridges.agent.protocol.connection_rows",
    # Bearer and OIDC authentication: the credential's tenant, before its row.
    "switch_core.bridges.agent.auth",
    # Agent-controller enrollment and token exchange carry their secret (a
    # one-time code, a controller credential) in the body rather than as a
    # bearer token, and both are `api_keys` rows: the same credential-
    # resolution shape as the line above, through the same `tenant_of_api_key`,
    # with the row then read scoped to the tenant it produced.
    "switch_core.management.auth",
    # The boot-time re-encryption sweep visits every organization, including
    # one with no workspace to reach it through, binding each in turn
    # (`organization_session`) to rewrite its connector apps' secrets.
    "switch_core.db.key_rotation",
    # Core keeps which controller runs each agent in memory, so at startup
    # every tenant's placed definitions are read back into it: enumerate the
    # tenants, then read each one's definitions under its own policy, the same
    # boot-style fan-out `main` does.
    "switch_core.management.bindings",
    # Each process keeps its own copy of which process holds each
    # controller's socket, and reads every tenant's controllers again at
    # startup, on resync and on each re-check in case a signal was lost: the
    # same fan-out as the bindings.
    "switch_core.management.signals",
    # The gateway's JWT subject resolves to its membership, and
    # `tenant_members` is scoped, so nothing else can answer it. In the
    # authentication module itself rather than on an injected store: a store
    # is reachable by any endpoint that declares it, which would make this
    # list name one module while the exemption was open to every route.
    "switch_core.gateway.auth",
    # A user's cloud machine is global and the cloud controller acts for no
    # tenant: which workspaces a machine serves comes from
    # `tenants_of_cloud_machine`, and each one's row on the machine is then
    # read with that workspace bound.
    "switch_core.db.stores.hosted_machine_store",
    # Deleting an account also clears the workspaces the person was removed
    # from, where nothing binds them any more: enumerate the tenants, then
    # look for their rows in each under its own policy, the same fan-out as
    # the boot work.
    "switch_core.accounts.deletion",
    # Enumerating tenants at boot, and starting one bridge by id from a
    # context bound to somebody else's tenant.
    "switch_core.clients.client_lifecycle_service",
    "switch_core.bridges.collaboration.lifecycle_service",
    # `_room_tenant`'s fallback: which tenant is this room in, asked when the
    # answer is not already cached alongside the channel mapping.
    "switch_core.bridges.collaboration.collaboration_core",
    # An inbound webhook from an installed workspace: the platform's signature
    # proves the sender and the payload names a workspace, and nothing in
    # either names a tenant. It is the one read that must happen before a
    # tenant can be bound at all, and the install row is then re-read scoped to
    # the tenant it produced, so a wrong answer here is a miss rather than a
    # cross-tenant read.
    "switch_core.bridges.collaboration.install_service",
    # A sign-in's browser steps (leaving for the vendor, coming back,
    # continuing to Switch Console) carry no Switch session, only the flow's
    # state, and may reach any process. The state is the one thing that names
    # the flow's tenant, and the flow is then read scoped to it, so a wrong
    # answer is a missing flow rather than a cross-tenant read.
    "switch_core.connections.sign_in_flows",
    # A WorkOS sign-in names the WorkOS organizations the person belongs to;
    # which Switch organizations follow them has to be read before any is
    # bound, and the membership is then written with that organization bound,
    # so a wrong answer is a missing row rather than a write into another
    # organization.
    "switch_core.organization_mirror",
    # The WorkOS mirror acts for no tenant and no person: which organizations
    # are linked is read before any is bound, and each is then read and
    # written with it bound.
    "switch_core.workos_mirror",
    # `switch_core.transport.postgres` and `switch_core.clients.agent_consumer`
    # came off this list with `tenant_of_client`: both were built from a
    # `clients` row that already named the tenant, so they carry it instead of
    # asking for it.
    #
    # The usage snapshot counts every tenant's rooms, messages and agents and
    # reports one deployment-wide total. That is the same boot-style fan-out
    # `main` does: enumerate the tenants, then bind each one in turn and read
    # its rows under its own policy. It has to ask, because a session with
    # nothing bound reads nothing — a snapshot written without this would
    # report a page of zeroes on a correctly configured deployment and look
    # perfectly healthy doing it.
    "switch_core.telemetry.snapshot",
    #
    # ── The operator's hosted visibility. Switch operators act
    # for no tenant; each module below asks which workspaces are involved and
    # then reads or writes each one's rows with that workspace bound
    # (`tenant_session`). No row is read across tenants.
    #
    # An operator names a workspace only by its keyed id. `all_tenant_ids`
    # turns that into a tenant by keying each id, and the workspace's copy of
    # the audit entry is then read or written with that tenant bound.
    "switch_core.visibility.audit_log",
    # An operator's pause acts for no tenant. `tenants_of_user` names every
    # workspace the paused person is in, for each one's admin copy of the entry
    # and its controller revokes; `tenants_of_cloud_machine` names the workspaces
    # a box serves. Each workspace's rows are then read and written with that
    # workspace bound, the same shape as hosted_machine_store.
    "switch_core.visibility.hosted_access",
    # The operator's overview and Show name are server-wide, so no tenant
    # is bound. `tenants_of_cloud_machine` names the workspaces a box serves.
    # Each workspace's controller report is then read with that workspace
    # bound (`tenant_session`), and only keyed ids leave.
    "switch_core.visibility.read_views",
    # An operator's restart acts for no tenant. `tenants_of_cloud_machine`
    # names the workspaces a box serves, only so each workspace gets its admin
    # copy of the restart, written with that workspace bound (`tenant_session`,
    # in audit_log). Reached only from `require_operator` routes and the
    # operator worker's bearer.
    "switch_core.visibility.operator_actions",
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
    "switch_core.bridges.agent.operations.agent_management",
    "switch_core.bridges.agent.mediation",
    # Reached only from the gateway's rooms endpoints, so the same holds.
    "switch_core.rooms_yaml",
    # Runs: reached from the gateway's run endpoints and from an agent's room
    # creation, both of which have bound the caller's tenant.
    "switch_core.agent_runs",
    # ── Reached only from inside a unit of work that has already bound the
    # tenant of the row it is acting on — an inbound bridge event, a delivery,
    # a sweep row, an authenticated agent operation.
    "switch_core.bridges.agent.protocol.agent_core",
    "switch_core.bridges.agent.commands",
    "switch_core.bridges.collaboration.collaboration_core",
    "switch_core.bridges.collaboration.lifecycle_service",
    "switch_core.delivery.recipient",
    "switch_core.clients.client_lifecycle_service",
    "switch_core.provisioning.postgres",
    "switch_core.room_service",
    # ── The exemption's own plumbing. It opens a session with nothing bound
    # on purpose and touches only the seven functions above, which are the one
    # thing a session with nothing bound may read.
    "switch_core.db.tenant_lookup",
    # ── The readiness check, which issues `SELECT 1` and reads no table at
    # all. Unbound on purpose: binding a tenant would make the health of the
    # database a question about one customer's rows, and reading a scoped
    # table here would be the one check that passes in development and raises
    # under the restricted runtime role in production.
    "switch_core.observability.health",
    # ── The announcer, which sends this process's signals and its router's
    # announcements with `pg_notify` and reads no table. They are for every
    # process regardless of tenant, so there is no tenant to bind.
    "switch_core.announcer",
    # `switch_core.transport.postgres` and `switch_core.bridges.agent.auth`
    # came off this list with the runtime role: the transport learned its own
    # tenant from its client row and the middleware learned a credential's
    # from the exemption, so neither has a session left that says nothing.
    # `switch_core.main` came off it earlier, when the tenant-zero fallback
    # went.
    #
    # ── Telemetry bookkeeping: three tables that carry no tenant and no
    # policy, named in `rls_ddl.GLOBAL_TABLES`. Each records a fact about the
    # *installation* — which deployment this is, when it was installed, which
    # once-ever milestones it has reported, when the last snapshot went out —
    # so there is no tenant for a policy to narrow on and binding one would be
    # theatre. Same shape, and same reasoning, as reading `users`.
    "switch_core.telemetry.deployment",
    "switch_core.telemetry.reporter",
    # Its own reads are the per-tenant fan-out above; this is the one global
    # read beside them, the deployment's user count.
    "switch_core.telemetry.snapshot",
    # This process's lease in `switch_core_processes`, a table with no tenant
    # and no policy (`rls_ddl.GLOBAL_TABLES`): a process serves every tenant,
    # so its lease belongs to none. It touches only that table.
    "switch_core.process_lease",
    # Which process runs each piece of work that must run once: it reads
    # `switch_core_processes` and claims and releases `ownership_leases`, both
    # tables with no tenant and no policy (`rls_ddl.GLOBAL_TABLES`). One
    # process holds work for every tenant at once.
    "switch_core.ownership",
    # The boot-time re-encryption sweep's per-tenant pass binds a tenant
    # (`tenant_session`); this raw call is its separate pass over
    # the global tables' encrypted values (`trust_settings`'s key,
    # `service_oauth_clients`' secrets), tables with no tenant and no policy
    # (`rls_ddl.GLOBAL_TABLES`) that a per-tenant loop would otherwise sweep
    # once per tenant for no reason.
    "switch_core.db.key_rotation",
    # `DynamicTrustClient` reads `trust_settings` on every check, including
    # from agent- and bridge-originated sends that have no request to inherit
    # a tenant from. A table with no tenant and no policy
    # (`rls_ddl.GLOBAL_TABLES`): one guardrails policy covers the whole
    # deployment, so there is no tenant for a policy to narrow on.
    "switch_core.trust.client",
    # The operator's account linking reads `users` and writes
    # `oidc_identities`, both global (`rls_ddl.GLOBAL_TABLES`): a person and
    # their sign-in identities belong to no tenant. Its organization linking
    # binds the organization (`organization_session`).
    "switch_core.workos_linking",
    # The WorkOS mirror reads and moves its cursor (`directory_event_cursors`)
    # and reads `oidc_identities` to match people, both global
    # (`rls_ddl.GLOBAL_TABLES`); every organization it changes is bound.
    "switch_core.workos_mirror",
    #
    # ── The OAuth client Core registers for itself at a vendor that offers
    # no other (`service_oauth_clients`, in `rls_ddl.GLOBAL_TABLES`). The
    # vendor sees one Switch, so the client is the deployment's, not a
    # tenant's: read and written in a session bound to none, and re-encrypted
    # once at boot by the global pass above.
    "switch_core.connections.oauth_clients",
    # The apps the operator registered at connectors' vendors
    # (`service_app_credentials`, in `rls_ddl.GLOBAL_TABLES`): one per
    # deployment and service, shared by every tenant's sign-ins, so read at
    # boot and after the operator changes one, in a session bound to none.
    "switch_core.connections.app_credentials",
    #
    # ── The hosted alerts: raised and cleared as `server_audit_events` rows, decided
    # from `cloud_machines` heartbeats, both tables with no tenant and no
    # policy (`rls_ddl.GLOBAL_TABLES`). An alert is about a node, a box or a
    # shared service, seen by Switch operators across the deployment, so there
    # is no tenant to bind; each call is wrapped in `no_tenant()` to say so.
    "switch_core.visibility.alerts",
    # The operators' audit log: its unbound sessions touch only `server_audit_events`, a
    # table with no tenant and no policy. Workspace copies use `tenant_session`.
    "switch_core.visibility.audit_log",
    # The operator list: reads only `users` (which listed operators also hold
    # the admin role), a table with no tenant and no policy.
    "switch_core.visibility.operators",
    # Its unbound sessions touch only tables with no tenant and no policy:
    # `users` (the pause mark, and the keyed-id resolve), `cloud_machines`
    # (stopping and labelling the person's box) and `server_audit_events` (the
    # expiry sweep). Anything in a workspace goes through `tenant_session`.
    "switch_core.visibility.hosted_access",
    # Box provisioning: its unbound sessions touch only `server_audit_events`
    # (the provision requests, claims and results) and `cloud_machines` (the
    # machine a box is made for), both tables with no tenant and no policy. A
    # box belongs to a person, not a workspace; the gates' per-workspace reads
    # go through the store's lookup and `tenant_session`.
    "switch_core.visibility.box_provision",
    #
    # ── Factories handed in as `factory`. The check below only
    # saw calls named `session_factory` until it was widened to bare
    # `factory()`; these four were opening sessions that way all along.
    #
    # The hosted-machine store: `workspaces_on` opens one session per
    # workspace a box serves, each with that workspace bound (`tenant_scope`),
    # since the box belongs to none of them. It opens no unbound session.
    "switch_core.db.stores.hosted_machine_store",
    # The operator controller's routes: its credential's session is opened
    # under `no_tenant()` and touches only `cloud_machines` and
    # `server_audit_events` (the provision requests and the hosted alerts), tables
    # with no tenant and no policy. Each workspace a box serves is read on a
    # session with that workspace bound (`tenant_scope`).
    "switch_core.gateway.hosted_controller",
    # The provisioner routes: its credential's session is opened under
    # `no_tenant()` and touches only `cloud_machines` and `server_audit_events`
    # (the claim and the result, through box_provision). The pause and
    # turn-off checks open their own sessions in hosted_access.
    "switch_core.gateway.hosted_provisioner",
    # The operator overview and Show name: its unbound sessions, each under
    # `no_tenant()`, touch only `users` (the pause mark, and the person behind
    # a raw id), `cloud_machines` (live boxes) and `server_audit_events` (the
    # alerts, and the reveal count until the operator rate limits take it
    # over). A workspace is read with that workspace bound (`tenant_session`).
    "switch_core.visibility.read_views",
    # The operator rate limits (RL): its unbound sessions, each under
    # `no_tenant()`, touch only `server_audit_events`, a table with no tenant
    # and no policy. They count operators' requested actions and reveals there,
    # and raise and clear A11 there. They're opened only from operator routes
    # and Core's A11 sweep. No workspace row is read or written.
    "switch_core.visibility.operator_limits",
    # The operator actions (restart): its unbound sessions, each under
    # `no_tenant()`, touch only `cloud_machines` (the box's state) and
    # `server_audit_events` (the action's request, steps and result, and the
    # open provisions), tables with no tenant and no policy. Workspace copies
    # go through `tenant_session` in audit_log.
    "switch_core.visibility.operator_actions",
}

# Calls that end in `session_factory` but hand one back rather than open a
# session with it.
_FACTORY_ACCESSORS = {"create_session_factory", "get_session_factory"}

# The other name a session factory goes by: modules handed one by dependency
# injection call it `factory`. Matched exactly, so the engine, client and
# transport factories (`_engine_factory()` and the like) are not mistaken for
# sessions.
_BARE_FACTORY_NAMES = {"factory", "_factory"}

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

    Matches any call whose name ends in `session_factory` —
    `session_factory()`, `self._session_factory()`, `self.session_factory()` —
    or is exactly `factory` or `_factory`, the name a factory has when a route
    or helper is handed one (`factory()`, `self._factory()`). Those are the
    two ways a session factory is spelled in this tree.

    A name match rather than a resolved reference: there is no single
    definition to alias, since every service is handed its own factory. That
    makes it over-eager rather than under-eager, which is the safe direction
    for an audit — except for the two accessors that hand a factory back
    instead of opening a session with it, which are named.
    """
    tree = ast.parse(path.read_text(), filename=str(path))
    return any(
        (name.endswith("session_factory") or name in _BARE_FACTORY_NAMES)
        and name not in _FACTORY_ACCESSORS
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

    def test_a_factory_handed_in_as_factory_is_detected(self, tmp_path: Path) -> None:
        """How the hosted routes and helpers are handed theirs. Missed until
        the detector was widened, so it gets its own case."""
        new_caller = tmp_path / "a_new_route_helper.py"
        new_caller.write_text(
            "async def read(factory):\n"
            "    async with factory() as session:\n"
            "        ...\n"
        )
        assert _calls_session_factory(new_caller)

    def test_a_factory_held_on_self_as_factory_is_detected(
        self, tmp_path: Path
    ) -> None:
        new_caller = tmp_path / "a_new_store.py"
        new_caller.write_text(
            "class Store:\n"
            "    async def run(self):\n"
            "        async with self._factory() as session:\n"
            "            ...\n"
        )
        assert _calls_session_factory(new_caller)

    def test_other_kinds_of_factory_are_not_sessions(self, tmp_path: Path) -> None:
        """The engine, client and transport factories make no session, so the
        widened match must not flag them."""
        clean = tmp_path / "a_listener.py"
        clean.write_text(
            "class Listener:\n"
            "    def start(self):\n"
            "        engine = self._engine_factory()\n"
            "        client = self._client_factory()\n"
            "        return engine, client, transport_factory()\n"
        )
        assert not _calls_session_factory(clean)

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
