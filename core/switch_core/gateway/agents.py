from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.agent_display_name import InvalidDisplayName, normalise_display_name
from switch_core.agent_icon import (
    InvalidIconUrl,
    generated_icon_choices,
    normalise_icon_url,
)
from switch_core.authz import Principal, require_manage
from switch_core.bridges.agent.protocol.agent_core import AgentCore, AgentExistsError
from switch_core.bridges.agent.protocol.agent_detail import (
    AgentOptionsNotEditable,
    apply_agent_options,
    assemble_agent_detail,
    build_agent_summary,
    list_agent_summaries,
)
from switch_core.bridges.agent.protocol.hosted_workers import hosted_launch_of
from switch_core.db.models import Agent, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import (
    get_agent_store,
    get_protocol,
    get_room_store,
    get_session,
    get_user_store,
)
from switch_core.gateway.known_agents import KNOWN_AGENTS
from switch_core.gateway.schemas import (
    AgentDetail,
    AgentSummary,
    KnownAgentType,
    RegisterAgentResponse,
    RegisterKnownAgentRequest,
    UpdateAddressingPolicyRequest,
    UpdateAgentCanManageAgentsRequest,
    UpdateAgentDescriptionRequest,
    UpdateAgentDisplayNameRequest,
    UpdateAgentIconRequest,
    UpdateAgentOptionsRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()

CLOUD_AGENT_DELETE_REFUSED = (
    "This is a cloud agent. Remove it from Switch Console's cloud agents instead."
)


async def _sync_hosted_spec(session: AsyncSession, agent: Agent, changes: dict) -> None:
    """Keep a cloud agent's launch spec, which registers it again, on the agent's values."""
    launch_id = hosted_launch_of(agent.metadata_)
    if launch_id is not None:
        await HostedLaunchStore().merge_spec(session, launch_id, changes)


@router.get("")
async def list_agents(
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[AgentSummary]:
    return await list_agent_summaries(session, agent_store, user_store)


@router.delete("/by-name/{agent_name}")
async def delete_agent_by_name(
    agent_name: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> dict[str, bool]:
    agent = await agent_store.get_by_name(session, agent_name)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_name}")
    try:
        require_manage(
            Principal(user.id, is_admin),
            agent.owner_id,
        )
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can delete it.",
        )
    if hosted_launch_of(agent.metadata_) is not None:
        raise HTTPException(status_code=409, detail=CLOUD_AGENT_DELETE_REFUSED)
    try:
        await protocol.delete_agent(agent_name=agent_name)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    logger.info("Deleted agent via gateway by name: %s", agent_name)
    return {"ok": True}


@router.delete("/{agent_id}")
async def delete_agent(
    agent_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> dict[str, bool]:
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")
    try:
        require_manage(
            Principal(user.id, is_admin),
            agent.owner_id,
        )
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can delete it.",
        )
    if hosted_launch_of(agent.metadata_) is not None:
        raise HTTPException(status_code=409, detail=CLOUD_AGENT_DELETE_REFUSED)
    try:
        await protocol.delete_agent(agent_id=agent_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    logger.info("Deleted agent via gateway: %s", agent_id)
    return {"ok": True}


@router.get("/known-types")
async def list_known_agent_types() -> list[KnownAgentType]:
    return [
        KnownAgentType(
            key=key,
            connector_type=spec.connector_type,
            tool_count=len(spec.tools),
            options_schema=spec.options_schema.model_json_schema(),
        )
        for key, spec in KNOWN_AGENTS.items()
    ]


@router.get("/icon-choices")
async def list_icon_choices(
    _user: Annotated[User, Depends(get_current_user)],
    name: Annotated[str, Query(min_length=1, max_length=128)],
    page: Annotated[int, Query(ge=0, le=1000)] = 0,
) -> dict[str, list[str]]:
    """One page of generated icons for an agent called `name`: page 0 leads
    with the one an agent of that name gets when nobody picks an icon."""
    return {"choices": generated_icon_choices(name, page)}


@router.post("/register")
async def register_known_agent(
    req: RegisterKnownAgentRequest,
    user: Annotated[User, Depends(get_current_user)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> RegisterAgentResponse:
    spec = KNOWN_AGENTS.get(req.agent_type)
    if spec is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown agent type: {req.agent_type}",
        )

    try:
        options = spec.parse_options(req.options)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc

    integration_profile = spec.build_profile(options)
    metadata = {
        "known_agent_type": req.agent_type,
        "known_agent_options": options.model_dump(),
    }

    try:
        result = await protocol.register_agent(
            registration_path="gateway",
            name=req.name,
            description=req.description,
            icon_url=req.icon_url,
            display_name=req.display_name,
            connector_type=spec.connector_type,
            integration_profile=integration_profile,
            tools=spec.tools,
            models=spec.models,
            metadata=metadata,
            owner_id=user.id,
            overwrite=req.overwrite,
        )
    except AgentExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        # Covers InvalidIconUrl, which subclasses ValueError.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return RegisterAgentResponse(
        id=result.agent_id,
        api_key=result.api_key,
    )


@router.patch("/{agent_id}/options")
async def update_agent_options(
    agent_id: str,
    req: UpdateAgentOptionsRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> AgentSummary:
    """Replace a known-agent's options.

    Body must contain the full options payload (no partial merge). The new
    options are validated against the spec's `options_schema`, then the
    agent's `integration_profile` is rebuilt from them via
    `KnownAgent.build_profile` and persisted alongside the options — keeping
    the two in sync the same way `/agents/register` does.

    Only the agent's owner (or an admin) can update its options. Agents that
    were not registered via a known-agent type have no editable options and
    return 400.
    """
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")

    try:
        require_manage(
            Principal(user.id, is_admin),
            agent.owner_id,
        )
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can update its options.",
        )

    try:
        await apply_agent_options(session, agent_store, agent, req.options)
    except AgentOptionsNotEditable as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc
    await session.commit()

    md = agent.metadata_ if isinstance(agent.metadata_, dict) else {}
    logger.info(
        "Updated options for agent %s (type=%s) by user %s",
        agent.name,
        md.get("known_agent_type"),
        user.name,
    )

    owner_name = user.name if agent.owner_id == user.id else None
    return await build_agent_summary(session, agent_store, agent, owner_name)


@router.put("/{agent_id}/icon")
async def update_agent_icon(
    agent_id: str,
    req: UpdateAgentIconRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> AgentSummary:
    """Set, change, or clear an agent's icon (CHOO-2171).

    ``icon_url: null`` clears it, leaving the agent with no icon so the caller
    renders its own fallback. Only the agent's owner (or an admin) may change
    it. Unlike options, this applies to every agent regardless of how it was
    registered.

    The URL must be an absolute https address that is not the local machine or
    a private network — Switch dereferences it when a bridge needs the image
    as bytes, so an unconstrained URL would be a request made on the caller's
    behalf from inside our network. A rejected URL returns 400 rather than
    being stored and failing later at render time.
    """
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")

    try:
        require_manage(
            Principal(user.id, is_admin),
            agent.owner_id,
        )
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can change its icon.",
        )

    try:
        icon_url = normalise_icon_url(req.icon_url)
    except InvalidIconUrl as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await agent_store.update(session, agent_id, icon_url=icon_url)
    await _sync_hosted_spec(session, agent, {"icon_url": icon_url})
    await session.commit()
    await session.refresh(agent)

    logger.info(
        "%s agent %s icon by user %s",
        "Cleared" if icon_url is None else "Set",
        agent.name,
        user.name,
    )

    owner_name = user.name if agent.owner_id == user.id else None
    return await build_agent_summary(session, agent_store, agent, owner_name)


@router.put("/{agent_id}/display-name")
async def update_agent_display_name(
    agent_id: str,
    req: UpdateAgentDisplayNameRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> AgentSummary:
    """Set, change, or clear an agent's human display name.

    ``display_name: null`` (or a blank string) clears it, leaving the agent
    with only its identifier. Only the agent's owner (or an admin) may change
    it. Like the icon, this applies to every agent regardless of how it was
    registered.

    A name that is over-long or carries a line break is refused with 400 rather
    than stored to break a message header later.
    """
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")

    try:
        require_manage(
            Principal(user.id, is_admin),
            agent.owner_id,
        )
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can change its display name.",
        )

    try:
        display_name = normalise_display_name(req.display_name)
    except InvalidDisplayName as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await agent_store.update(session, agent_id, display_name=display_name)
    await _sync_hosted_spec(session, agent, {"display_name": display_name})
    await session.commit()
    await session.refresh(agent)

    logger.info(
        "%s agent %s display name by user %s",
        "Cleared" if display_name is None else "Set",
        agent.name,
        user.name,
    )

    owner_name = user.name if agent.owner_id == user.id else None
    return await build_agent_summary(session, agent_store, agent, owner_name)


@router.put("/{agent_id}/description")
async def update_agent_description(
    agent_id: str,
    req: UpdateAgentDescriptionRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> AgentSummary:
    """Change an agent's description. Only its owner (or an admin) may; a
    blank description is refused with 400."""
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")

    try:
        require_manage(Principal(user.id, is_admin), agent.owner_id)
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can change its description.",
        )

    description = req.description.strip()
    if not description:
        raise HTTPException(status_code=400, detail="description must not be blank")

    await agent_store.update(session, agent_id, description=description)
    await _sync_hosted_spec(session, agent, {"description": description})
    await session.commit()
    await session.refresh(agent)

    logger.info("Set agent %s description by user %s", agent.name, user.name)

    owner_name = user.name if agent.owner_id == user.id else None
    return await build_agent_summary(session, agent_store, agent, owner_name)


@router.put("/{agent_id}/addressing-policy")
async def update_addressing_policy(
    agent_id: str,
    req: UpdateAddressingPolicyRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> AgentDetail:
    """Set or clear an agent's scoped addressing policy (CHOO-1585).

    ``policy: null`` clears it (the agent becomes open to anyone). Only the
    agent's owner (or an admin) may change it.
    """
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")

    try:
        require_manage(
            Principal(user.id, is_admin),
            agent.owner_id,
        )
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can change its addressing policy.",
        )

    stored = req.policy.model_dump() if req.policy is not None else None
    await agent_store.update(session, agent_id, addressing_policy=stored)
    await _sync_hosted_spec(session, agent, {"addressing_policy": stored})
    await session.commit()

    logger.info(
        "Updated addressing policy for agent %s (%d rules) by user %s",
        agent.name,
        len(req.policy.rules) if req.policy is not None else 0,
        user.name,
    )

    return await assemble_agent_detail(
        session,
        agent=agent,
        agent_store=agent_store,
        room_store=room_store,
        user_store=user_store,
        agent_session_store=protocol.agent_session_store,
        room_role_store=protocol.room_role_store,
        connections=protocol.connections,
    )


@router.put("/{agent_id}/can-manage-agents")
async def update_can_manage_agents(
    agent_id: str,
    req: UpdateAgentCanManageAgentsRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> AgentDetail:
    """Turn the agent's "can manage agents" capability on or off.

    With it on, the agent may list its owner's machines and managed agents
    and create managed agents on those machines, acting for its owner. Only
    the agent's owner may change it — not an admin, since the agent then acts
    on the owner's own machines. It has an effect only on a server running
    agent management, where those operations exist.
    """
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")
    if agent.owner_id is None or agent.owner_id != user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner can change whether it can manage agents.",
        )

    await agent_store.update(session, agent_id, can_manage_agents=req.enabled)
    await session.commit()
    await session.refresh(agent)

    logger.info(
        "%s 'can manage agents' for agent %s by its owner %s",
        "Enabled" if req.enabled else "Disabled",
        agent.name,
        user.name,
    )

    return await assemble_agent_detail(
        session,
        agent=agent,
        agent_store=agent_store,
        room_store=room_store,
        user_store=user_store,
        agent_session_store=protocol.agent_session_store,
        room_role_store=protocol.room_role_store,
        connections=protocol.connections,
    )


# Declared after the literal GET routes (e.g. /known-types) so those are matched
# first; otherwise this path-parameter route would capture them.
@router.get("/{agent_id}")
async def get_agent_detail(
    agent_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    _user: Annotated[User, Depends(get_current_user)],
) -> AgentDetail:
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")

    return await assemble_agent_detail(
        session,
        agent=agent,
        agent_store=agent_store,
        room_store=room_store,
        user_store=user_store,
        agent_session_store=protocol.agent_session_store,
        room_role_store=protocol.room_role_store,
        connections=protocol.connections,
    )
