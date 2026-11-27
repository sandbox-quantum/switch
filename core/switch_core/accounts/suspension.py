"""Suspending a person or an agent: shutting them out at once, with nothing
deleted, and letting them back in.

While an agent is suspended (`Agent.suspended_at`):

- its key, its OAuth client and its controller are refused for it, on every
  agent route, MCP included, and on its controller's socket
  (`bridges/agent/auth.py`, `management/socket_calls.py`), and a service
  token is not issued to it (`connections/broker.py`);
- the connections it holds are ended, in every process, and one opened on a
  key a process still remembered is ended by the next pass over the recorded
  rows (`connection_rows.py`);
- the device that runs it assigns it stopped, without its definition or the
  state its owner set being touched (`management/schemas.py`), so lifting the
  suspension starts it again if it was running;
- the service tokens issued to it are revoked;
- its room memberships stay as they are: it is still a member, and can do
  nothing there.

Suspending a person (`User.suspended_at`) ends every session they hold and
refuses any new one (`gateway/auth.py`), refuses their registration keys, and
suspends every agent they own, in every workspace, marked
`suspended_with_owner` so that lifting theirs lifts those and leaves any
agent suspended on its own as it was. Their devices are disconnected: each
controller's stream ends, in every process, once its agents' assignments say
stopped, and it is refused a token and every route but its assignment while
the suspension lasts (`management/auth.py`). Its credential is kept, so it
connects again by itself once the suspension is lifted.

Who may do it, and who may undo it. An agent: its owner, an admin of its
workspace (or of its organization) and the server's operator. A person: the
operator, or an admin of every workspace the person belongs to; an admin of
only some of them would be shutting the person out of workspaces they have no
say over. A suspension records whether its owner, an admin or the operator
made it (`suspended_by_role`), and only someone of that standing or above
lifts it, so a workspace's admins cannot undo the operator's.

The database work is here, on the caller's session or on sessions of its own,
and returns what committed (`SuspensionChanges`). Setting that going is the
caller's: the server does it at once (`SuspensionEffects`), and the operator's
command line, which holds none of the server's state, tells the server's
processes over the signal bus (`suspension_admin.py`).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, Protocol, cast

from sqlalchemy import select

from switch_core.db.audit import (
    PLATFORM_OPERATOR_COMMAND,
    AuditAction,
    ServerAuditAction,
    record_audit_event,
    record_server_audit_event,
)
from switch_core.db.models import (
    Agent,
    AgentController,
    AgentDefinition,
    ServiceTokenIssuance,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.hosted_machine_store import (
    lift_box_suspension,
    suspend_box,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.tenant_lookup import all_tenant_ids, tenants_of_user
from switch_core.tenant_context import no_tenant, tenant_scope

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.agent.api_key_cache import ApiKeyCache
    from switch_core.bridges.agent.protocol.agent_connections import (
        AgentConnectionRegistry,
    )
    from switch_core.connections.broker import ServiceBroker
    from switch_core.db.stores.user_store import UserStore

logger = logging.getLogger(__name__)

SuspenderRole = Literal["owner", "admin", "operator"]

_RANK: dict[str, int] = {"owner": 0, "admin": 1, "operator": 2}

_ROLE_WORDS: dict[str, str] = {
    "owner": "its owner",
    "admin": "an admin",
    "operator": "the server's operator",
}

# Who may lift a suspension made with each standing.
_LIFTED_BY: dict[str, str] = {
    "owner": "its owner, an admin or the server's operator",
    "admin": "an admin or the server's operator",
    "operator": "the server's operator",
}

#: What an agent is told when it is refused for being suspended.
AGENT_SUSPENDED_CODE = "agent_suspended"
#: What a person's key is refused with while their account is suspended.
ACCOUNT_SUSPENDED_CODE = "account_suspended"


def agent_suspended_message(agent_id: str) -> str:
    return (
        f"Agent {agent_id} is suspended. Its owner or a workspace admin can "
        "lift the suspension; until then it can't connect, post or call tools."
    )


ACCOUNT_SUSPENDED_MESSAGE = (
    "This account is suspended. Contact your workspace admin or the server's operator."
)


async def owner_is_suspended(session: AsyncSession, user_id: str) -> bool:
    return (
        await session.scalar(select(User.suspended_at).where(User.id == user_id))
        is not None
    )


@dataclass(frozen=True)
class Suspender:
    """Who suspends or lifts a suspension, and with what standing. `user_id`
    is None for the operator's command line, which acts as no account."""

    user_id: str | None
    role: SuspenderRole


def _by_command(by: Suspender) -> dict[str, bool]:
    """Marks an audit event of a suspension the operator's command line made,
    which names no actor."""
    return {PLATFORM_OPERATOR_COMMAND: True} if by.user_id is None else {}


class SuspensionRefused(Exception):
    """The suspension, or lifting it, is refused; `status` is the HTTP status
    and the message says why, in words for the person."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class SuspensionChanges:
    """What committed, for the caller to set going.

    `agents` names, by tenant, the agents suspended (`suspended`) or let back
    in; `revisions`, by tenant, the controllers that run any of them, with
    the assignment revision each was moved to; `controllers`, by tenant, the
    controllers of a person just suspended, which are disconnected. Lifting a
    person's suspension names none: nothing is kept of the refusal, so their
    controllers are let in the next time they try."""

    suspended: bool
    agents: dict[str, list[str]]
    revisions: dict[str, dict[str, int]]
    controllers: dict[str, list[str]]

    def merge(self, other: SuspensionChanges) -> SuspensionChanges:
        if other.suspended != self.suspended:
            raise ValueError("Cannot merge a suspension with lifting one")
        agents = {k: list(v) for k, v in self.agents.items()}
        for tenant_id, ids in other.agents.items():
            agents.setdefault(tenant_id, []).extend(ids)
        revisions = {k: dict(v) for k, v in self.revisions.items()}
        for tenant_id, by_controller in other.revisions.items():
            revisions.setdefault(tenant_id, {}).update(by_controller)
        controllers = {k: list(v) for k, v in self.controllers.items()}
        for tenant_id, ids in other.controllers.items():
            controllers.setdefault(tenant_id, []).extend(ids)
        return SuspensionChanges(
            suspended=self.suspended,
            agents=agents,
            revisions=revisions,
            controllers=controllers,
        )


def _nothing(suspended: bool) -> SuspensionChanges:
    return SuspensionChanges(
        suspended=suspended, agents={}, revisions={}, controllers={}
    )


# ── Who may ───────────────────────────────────────────────────────────────────


def agent_suspender(
    *, caller_id: str, is_operator: bool, is_admin: bool, owner_id: str | None
) -> Suspender:
    """The standing `caller_id` suspends or lifts an agent's suspension with:
    the operator's, a workspace admin's, or its owner's. Refused for anyone
    else."""
    if is_operator:
        return Suspender(user_id=caller_id, role="operator")
    if is_admin:
        return Suspender(user_id=caller_id, role="admin")
    if owner_id is not None and owner_id == caller_id:
        return Suspender(user_id=caller_id, role="owner")
    raise SuspensionRefused(
        403,
        "Only the agent's owner, a workspace admin or the server's operator "
        "can suspend it or lift its suspension.",
    )


async def person_suspender(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    *,
    caller: User,
    target_id: str,
) -> Suspender:
    """The standing `caller` suspends or lifts `target_id`'s suspension with:
    the operator's, or an admin's when they administer every workspace the
    person belongs to. Refused otherwise, and for their own account."""
    if caller.id == target_id:
        raise SuspensionRefused(400, "You can't suspend your own account.")
    with no_tenant():
        async with session_factory() as session:
            target = await session.get(User, target_id)
    if target is None:
        raise SuspensionRefused(404, "User not found.")
    if caller.role == "admin":
        return Suspender(user_id=caller.id, role="operator")
    if target.role == "admin":
        raise SuspensionRefused(
            403, "Only the server's operator can suspend the operator's account."
        )
    workspaces = await tenants_of_user(session_factory, target_id)
    for tenant_id in workspaces:
        async with tenant_session(session_factory, tenant_id) as session:
            if not await user_store.administers_by_role(session, tenant_id, caller.id):
                workspaces = []
                break
    if not workspaces:
        raise SuspensionRefused(
            403,
            "You can suspend someone only if you administer every workspace "
            "they belong to. Ask the server's operator.",
        )
    return Suspender(user_id=caller.id, role="admin")


def _require_standing(by: Suspender, role: str | None, what: str) -> None:
    if role is not None and _RANK[by.role] < _RANK[role]:
        raise SuspensionRefused(
            403,
            f"{what} was suspended by {_ROLE_WORDS[role]}, so only "
            f"{_LIFTED_BY[role]} can lift it.",
        )


def _required_reason(reason: str) -> str:
    reason = reason.strip()
    if not reason:
        raise SuspensionRefused(400, "Say why: a reason is required.")
    return reason


# ── Agents ────────────────────────────────────────────────────────────────────


async def _locked_agent(session: AsyncSession, tenant_id: str, agent_id: str) -> Agent:
    agent = await session.scalar(
        select(Agent)
        .where(Agent.tenant_id == tenant_id, Agent.id == agent_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if agent is None:
        raise SuspensionRefused(404, f"Agent not found: {agent_id}")
    return agent


def _mark(
    target: Agent | User,
    by: Suspender,
    reason: str,
    now: datetime,
) -> None:
    target.suspended_at = now
    target.suspended_by = by.user_id
    target.suspended_reason = reason
    target.suspended_by_role = by.role


def _clear(target: Agent | User) -> None:
    target.suspended_at = None
    target.suspended_by = None
    target.suspended_reason = None
    target.suspended_by_role = None


async def _reassign(
    session: AsyncSession, tenant_id: str, agent_id: str, changes: SuspensionChanges
) -> None:
    """Move on the assignment of the controller that runs the agent, if one
    does, so it pulls the agent's new desired state."""
    controller_id = await session.scalar(
        select(AgentDefinition.controller_id).where(
            AgentDefinition.tenant_id == tenant_id,
            AgentDefinition.agent_id == agent_id,
        )
    )
    if controller_id is not None:
        changes.revisions.setdefault(tenant_id, {})[
            controller_id
        ] = await AgentControllerStore().bump_assignment_revision(
            session, tenant_id, controller_id
        )


async def _shut_out(
    session: AsyncSession,
    tenant_id: str,
    agent: Agent,
    by: Suspender,
    reason: str,
    *,
    with_owner: bool,
    changes: SuspensionChanges,
) -> None:
    """Suspend `agent` on `session`: its connections' rows go, so every
    process ends them when it reads them, its live service tokens are queued
    for revocation, and its controller is moved on."""
    _mark(agent, by, reason, datetime.now(UTC))
    agent.suspended_with_owner = with_owner
    await AgentConnectionStore().delete_agent(
        session, tenant_id=tenant_id, agent_id=agent.id
    )
    with tenant_scope(tenant_id):
        await ServiceConnectionStore().queue_revocation(
            session,
            ServiceTokenIssuance.agent_id == agent.id,
            ServiceTokenIssuance.revoke_requested.is_(False),
        )
    await _reassign(session, tenant_id, agent.id, changes)
    changes.agents.setdefault(tenant_id, []).append(agent.id)


async def suspend_agent(
    session: AsyncSession,
    *,
    tenant_id: str,
    agent_id: str,
    by: Suspender,
    reason: str,
) -> SuspensionChanges:
    """Suspend the agent, with its audit event, on `session`; the caller
    commits, then sets the result going. An agent already suspended with its
    owner is suspended on its own as well, so it stays suspended when its
    owner's is lifted."""
    reason = _required_reason(reason)
    agent = await _locked_agent(session, tenant_id, agent_id)
    changes = _nothing(True)
    if agent.suspended_at is not None:
        if not agent.suspended_with_owner:
            raise SuspensionRefused(409, f"Agent {agent.name} is already suspended.")
        _mark(agent, by, reason, agent.suspended_at)
        agent.suspended_with_owner = False
    else:
        await _shut_out(
            session, tenant_id, agent, by, reason, with_owner=False, changes=changes
        )
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=by.user_id,
        action=AuditAction.AGENT_SUSPENDED,
        target_type="agent",
        target_id=agent.id,
        details={"reason": reason, "by_role": by.role, **_by_command(by)},
    )
    return changes


async def unsuspend_agent(
    session: AsyncSession, *, tenant_id: str, agent_id: str, by: Suspender
) -> SuspensionChanges:
    """Lift the agent's own suspension, with its audit event, on `session`;
    the caller commits, then sets the result going. Refused for one
    suspended with its owner, which is lifted with the owner's. If its owner
    has been suspended since, it stays suspended with them."""
    agent = await _locked_agent(session, tenant_id, agent_id)
    if agent.suspended_at is None:
        raise SuspensionRefused(409, f"Agent {agent.name} is not suspended.")
    if agent.suspended_with_owner:
        raise SuspensionRefused(
            409,
            f"Agent {agent.name} is suspended because its owner is. Lift the "
            "owner's suspension instead.",
        )
    _require_standing(by, agent.suspended_by_role, f"Agent {agent.name}")
    previous = {"reason": agent.suspended_reason, "by_role": agent.suspended_by_role}
    owner = None if agent.owner_id is None else await session.get(User, agent.owner_id)
    changes = _nothing(False)
    if owner is not None and owner.suspended_at is not None:
        agent.suspended_by = owner.suspended_by
        agent.suspended_reason = owner.suspended_reason
        agent.suspended_by_role = owner.suspended_by_role
        agent.suspended_with_owner = True
    else:
        _clear(agent)
        await _reassign(session, tenant_id, agent.id, changes)
        changes.agents.setdefault(tenant_id, []).append(agent.id)
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=by.user_id,
        action=AuditAction.AGENT_UNSUSPENDED,
        target_type="agent",
        target_id=agent.id,
        details={
            **previous,
            "still_suspended_with_owner": agent.suspended_at is not None,
            **_by_command(by),
        },
    )
    return changes


# ── People ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PersonSuspension:
    """What suspending or lifting a person's suspension did: whether their own
    row changed (False when re-sweeping someone already suspended), and what
    committed for the caller to set going."""

    changed: bool
    changes: SuspensionChanges


async def suspend_user(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: str,
    by: Suspender,
    reason: str,
) -> PersonSuspension:
    """Suspend the account and every agent it owns, committing as it goes.

    The account first, which ends its sessions, then each workspace's agents
    in a transaction of their own. Suspending someone already suspended
    changes nothing about their suspension unless `by` outranks whoever made
    it, and suspends any agent of theirs that is not: so a run that failed
    part-way is finished by running it again."""
    if by.role == "owner":
        raise ValueError("A person is suspended by an admin or the operator")
    reason = _required_reason(reason)
    with no_tenant():
        async with session_factory() as session:
            user = await session.get(
                User, user_id, with_for_update=True, populate_existing=True
            )
            if user is None:
                raise SuspensionRefused(404, "User not found.")
            changed = user.suspended_at is None or (
                _RANK[by.role] > _RANK[cast(str, user.suspended_by_role)]
            )
            if user.suspended_at is None:
                _mark(user, by, reason, datetime.now(UTC))
                # Every session it holds ends: a cookie carries the version
                # it was minted with (`gateway/auth.py`).
                user.session_version = user.session_version + 1
            elif changed:
                _mark(user, by, reason, user.suspended_at)
            # Their hosted box stops now, not at its next wake, and nothing
            # starts it while the suspension lasts (re-run safely).
            stopped_box = await suspend_box(session, user_id, datetime.now(UTC))
            if changed:
                await record_server_audit_event(
                    session,
                    actor_user_id=by.user_id,
                    action=ServerAuditAction.USER_SUSPENDED,
                    target_type="user",
                    target_id=user_id,
                    details={
                        "reason": reason,
                        "by_role": by.role,
                        **_by_command(by),
                        **({"box_stopped": True} if stopped_box else {}),
                    },
                )
            # Its agents are suspended as the account now is, by whoever made
            # its suspension, which a re-run did not change.
            cascade = Suspender(
                user_id=user.suspended_by,
                role=cast(SuspenderRole, user.suspended_by_role),
            )
            cascade_reason = cast(str, user.suspended_reason)
            await session.commit()

    member_of = set(await tenants_of_user(session_factory, user_id))
    changes = _nothing(True)
    for tenant_id in sorted(await all_tenant_ids(session_factory)):
        async with tenant_session(session_factory, tenant_id) as session:
            agents = list(
                await session.scalars(
                    select(Agent)
                    .where(Agent.tenant_id == tenant_id, Agent.owner_id == user_id)
                    .order_by(Agent.id)
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            )
            controllers = list(
                await session.scalars(
                    select(AgentController.id)
                    .where(
                        AgentController.tenant_id == tenant_id,
                        AgentController.owner_id == user_id,
                        AgentController.revoked_at.is_(None),
                    )
                    .order_by(AgentController.id)
                )
            )
            if not agents and not controllers and tenant_id not in member_of:
                continue
            here = _nothing(True)
            if controllers:
                here.controllers[tenant_id] = controllers
            for agent in agents:
                if agent.suspended_at is None:
                    await _shut_out(
                        session,
                        tenant_id,
                        agent,
                        cascade,
                        cascade_reason,
                        with_owner=True,
                        changes=here,
                    )
            if changed or here.agents:
                await record_audit_event(
                    session,
                    tenant_id=tenant_id,
                    actor_user_id=by.user_id,
                    action=AuditAction.USER_SUSPENDED,
                    target_type="user",
                    target_id=user_id,
                    details={
                        "reason": cascade_reason,
                        "by_role": cascade.role,
                        "agents_suspended": here.agents.get(tenant_id, []),
                        **_by_command(by),
                    },
                )
            await session.commit()
        changes = changes.merge(here)
    logger.warning(
        "User %s suspended by %s (%s); %d agent(s) suspended with them, "
        "%d controller(s) disconnected",
        user_id,
        by.user_id or "the operator's command line",
        by.role,
        sum(len(ids) for ids in changes.agents.values()),
        sum(len(ids) for ids in changes.controllers.values()),
    )
    return PersonSuspension(changed=changed, changes=changes)


async def unsuspend_user(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: str,
    by: Suspender,
) -> PersonSuspension:
    """Lift the account's suspension and that of every agent suspended with
    it, committing as it goes. An agent suspended on its own stays so."""
    with no_tenant():
        async with session_factory() as session:
            user = await session.get(
                User, user_id, with_for_update=True, populate_existing=True
            )
            if user is None:
                raise SuspensionRefused(404, "User not found.")
            if user.suspended_at is None:
                raise SuspensionRefused(409, "This account is not suspended.")
            _require_standing(by, user.suspended_by_role, "This account")
            previous = {
                "reason": user.suspended_reason,
                "by_role": user.suspended_by_role,
            }
            _clear(user)
            # A box stopped for the suspension stays stopped: held again by a
            # pause, a move or a turn-off that still applies, or else asleep,
            # so the next message wakes it through every gate again.
            await lift_box_suspension(
                session, session_factory, user_id, datetime.now(UTC)
            )
            await record_server_audit_event(
                session,
                actor_user_id=by.user_id,
                action=ServerAuditAction.USER_UNSUSPENDED,
                target_type="user",
                target_id=user_id,
                details={**previous, **_by_command(by)},
            )
            await session.commit()

    member_of = set(await tenants_of_user(session_factory, user_id))
    changes = _nothing(False)
    for tenant_id in sorted(await all_tenant_ids(session_factory)):
        async with tenant_session(session_factory, tenant_id) as session:
            agents = list(
                await session.scalars(
                    select(Agent)
                    .where(
                        Agent.tenant_id == tenant_id,
                        Agent.owner_id == user_id,
                        Agent.suspended_with_owner.is_(True),
                    )
                    .order_by(Agent.id)
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            )
            if not agents and tenant_id not in member_of:
                continue
            here = _nothing(False)
            for agent in agents:
                _clear(agent)
                agent.suspended_with_owner = False
                await _reassign(session, tenant_id, agent.id, here)
                here.agents.setdefault(tenant_id, []).append(agent.id)
            await record_audit_event(
                session,
                tenant_id=tenant_id,
                actor_user_id=by.user_id,
                action=AuditAction.USER_UNSUSPENDED,
                target_type="user",
                target_id=user_id,
                details={
                    **previous,
                    "agents_unsuspended": [a.id for a in agents],
                    **_by_command(by),
                },
            )
            await session.commit()
        changes = changes.merge(here)
    logger.warning(
        "User %s let back in by %s (%s); %d agent(s) let back in with them",
        user_id,
        by.user_id or "the operator's command line",
        by.role,
        sum(len(ids) for ids in changes.agents.values()),
    )
    return PersonSuspension(changed=True, changes=changes)


# ── Setting it going, in the server ───────────────────────────────────────────


class SuspensionAssignments(Protocol):
    """Agent management's part (`ManagementService`), injected so the core
    does not depend on it: Core's bindings follow the agents' new state,
    their controllers are nudged to pull it, and a suspended person's
    controllers are disconnected."""

    async def agents_suspension_changed(
        self,
        session: AsyncSession,
        tenant_id: str,
        agent_ids: list[str],
        revisions: dict[str, int],
    ) -> None: ...

    def owner_suspended(self, controller_ids: list[str]) -> None: ...


class SuspensionEffects:
    """What a suspension, or lifting one, sets going once it has committed:
    here at once, and in every other process through the signals each part
    already sends."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        connections: AgentConnectionRegistry,
        api_key_cache: ApiKeyCache,
        broker: ServiceBroker | None,
        management: SuspensionAssignments | None,
    ) -> None:
        self._session_factory = session_factory
        self._connections = connections
        self._api_key_cache = api_key_cache
        self._broker = broker
        self._management = management

    async def committed(self, changes: SuspensionChanges) -> None:
        for tenant_id, agent_ids in changes.agents.items():
            with tenant_scope(tenant_id):
                for agent_id in agent_ids:
                    self._api_key_cache.invalidate_agent(agent_id)
                    if changes.suspended:
                        # After its keys are dropped, so a client told cannot
                        # open another on one remembered here.
                        await self._connections.agent_suspended(agent_id)
                if changes.suspended and self._broker is not None:
                    async with tenant_session(
                        self._session_factory, tenant_id
                    ) as session:
                        await self._broker.revoke_pending(
                            session, (ServiceTokenIssuance.agent_id.in_(agent_ids),)
                        )
                if self._management is not None:
                    async with tenant_session(
                        self._session_factory, tenant_id
                    ) as session:
                        await self._management.agents_suspension_changed(
                            session,
                            tenant_id,
                            agent_ids,
                            changes.revisions.get(tenant_id, {}),
                        )
        # After their agents' assignments say stopped, so a controller is
        # nudged to pull them before its connection ends.
        if self._management is not None:
            for controller_ids in changes.controllers.values():
                self._management.owner_suspended(controller_ids)
