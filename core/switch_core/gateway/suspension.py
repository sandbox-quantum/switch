"""Suspending an agent or a person, and lifting it (`accounts/suspension.py`).

An agent: its owner, an admin of the workspace and the server's operator. A
person: the operator, or an admin of every workspace they belong to. What
each may lift follows who made the suspension, and the refusal says so.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.suspension import (
    PersonSuspension,
    SuspensionChanges,
    SuspensionEffects,
    SuspensionRefused,
    agent_suspender,
    person_suspender,
    suspend_agent,
    suspend_user,
    unsuspend_agent,
    unsuspend_user,
)
from switch_core.bridges.agent.protocol.agent_detail import agent_suspension
from switch_core.db.models import Agent, User, require_tenant_id
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import (
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.schemas import (
    AgentSuspensionResponse,
    PersonSuspensionResponse,
    SuspendRequest,
)
from switch_core.tenant_context import no_tenant

logger = logging.getLogger(__name__)

router = APIRouter()


def _effects(request: Request) -> SuspensionEffects:
    """Set by the wiring (`switch_core.main`)."""
    effects = getattr(request.app.state, "suspension_effects", None)
    if not isinstance(effects, SuspensionEffects):
        raise RuntimeError("No suspension effects are installed on this app.")
    return effects


def _refused(refused: SuspensionRefused) -> HTTPException:
    return HTTPException(status_code=refused.status, detail=str(refused))


async def _agent_for_change(
    session: AsyncSession, agent_id: str
) -> tuple[str, str | None]:
    """The agent's tenant and owner, 404 when it is not in this workspace."""
    tenant_id = require_tenant_id()
    owner = await session.execute(
        select(Agent.owner_id).where(Agent.tenant_id == tenant_id, Agent.id == agent_id)
    )
    row = owner.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")
    return tenant_id, row[0]


async def _agent_response(
    session: AsyncSession, tenant_id: str, agent_id: str
) -> AgentSuspensionResponse:
    agent = await session.scalar(
        select(Agent)
        .where(Agent.tenant_id == tenant_id, Agent.id == agent_id)
        .execution_options(populate_existing=True)
    )
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")
    return AgentSuspensionResponse(
        agent_id=agent.id, suspension=agent_suspension(agent)
    )


async def _settle_agent(
    request: Request,
    session: AsyncSession,
    tenant_id: str,
    agent_id: str,
    changes: SuspensionChanges,
) -> AgentSuspensionResponse:
    await session.commit()
    await _effects(request).committed(changes)
    return await _agent_response(session, tenant_id, agent_id)


@router.post("/agents/{agent_id}/suspend")
async def suspend_agent_route(
    agent_id: str,
    req: SuspendRequest,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> AgentSuspensionResponse:
    """Suspend an agent: its connections close, its device stops it, its
    service tokens are revoked, and it can't connect, post or call tools
    until the suspension is lifted. It stays a member of its rooms. Its
    owner, a workspace admin or the server's operator."""
    tenant_id, owner_id = await _agent_for_change(session, agent_id)
    try:
        by = agent_suspender(
            caller_id=user.id,
            is_operator=user.role == "admin",
            is_admin=is_admin,
            owner_id=owner_id,
        )
        changes = await suspend_agent(
            session, tenant_id=tenant_id, agent_id=agent_id, by=by, reason=req.reason
        )
    except SuspensionRefused as refused:
        await session.rollback()
        raise _refused(refused) from None
    logger.warning("%s (%s) suspended agent %s", user.id, by.role, agent_id)
    return await _settle_agent(request, session, tenant_id, agent_id, changes)


@router.post("/agents/{agent_id}/unsuspend")
async def unsuspend_agent_route(
    agent_id: str,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> AgentSuspensionResponse:
    """Lift an agent's suspension: its device starts it again if its owner
    had it running, and it may connect again. Refused when the suspension
    was made by someone of higher standing than the caller (an admin's, by
    its owner; the operator's, by anyone else), and for an agent suspended
    because its owner is."""
    tenant_id, owner_id = await _agent_for_change(session, agent_id)
    try:
        by = agent_suspender(
            caller_id=user.id,
            is_operator=user.role == "admin",
            is_admin=is_admin,
            owner_id=owner_id,
        )
        changes = await unsuspend_agent(
            session, tenant_id=tenant_id, agent_id=agent_id, by=by
        )
    except SuspensionRefused as refused:
        await session.rollback()
        raise _refused(refused) from None
    logger.warning(
        "%s (%s) lifted the suspension of agent %s", user.id, by.role, agent_id
    )
    return await _settle_agent(request, session, tenant_id, agent_id, changes)


async def _person_response(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    done: PersonSuspension,
) -> PersonSuspensionResponse:
    with no_tenant():
        async with session_factory() as session:
            person = await session.get(User, user_id)
    if person is None:
        raise HTTPException(status_code=404, detail="User not found.")
    return PersonSuspensionResponse(
        user_id=person.id,
        suspended=person.suspended_at is not None,
        suspended_at=person.suspended_at,
        reason=person.suspended_reason,
        by_role=person.suspended_by_role,
        agents=done.changes.agents,
    )


@router.post("/users/{user_id}/suspend")
async def suspend_person_route(
    user_id: str,
    req: SuspendRequest,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> PersonSuspensionResponse:
    """Suspend a person: every session they hold ends and none can start,
    their keys are refused, and every agent they own, in every workspace, is
    suspended with them. The server's operator, or an admin of every
    workspace the person belongs to. Suspending someone already suspended
    suspends any agent of theirs that is not."""
    try:
        by = await person_suspender(
            session_factory, user_store, caller=user, target_id=user_id
        )
        done = await suspend_user(
            session_factory, user_id=user_id, by=by, reason=req.reason
        )
    except SuspensionRefused as refused:
        raise _refused(refused) from None
    logger.warning("%s (%s) suspended user %s", user.id, by.role, user_id)
    await _effects(request).committed(done.changes)
    return await _person_response(session_factory, user_id, done)


@router.post("/users/{user_id}/unsuspend")
async def unsuspend_person_route(
    user_id: str,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> PersonSuspensionResponse:
    """Lift a person's suspension, and that of every agent suspended with
    them; an agent suspended on its own stays so. Refused when the operator
    suspended them and the caller is not the operator."""
    try:
        by = await person_suspender(
            session_factory, user_store, caller=user, target_id=user_id
        )
        done = await unsuspend_user(session_factory, user_id=user_id, by=by)
    except SuspensionRefused as refused:
        raise _refused(refused) from None
    logger.warning(
        "%s (%s) lifted the suspension of user %s", user.id, by.role, user_id
    )
    await _effects(request).committed(done.changes)
    return await _person_response(session_factory, user_id, done)
