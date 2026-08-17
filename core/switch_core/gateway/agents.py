from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.agent_icon import InvalidIconUrl, normalise_icon_url
from switch_core.authz import Principal, require_manage
from switch_core.bridges.agent.protocol.agent_detail import (
    AgentOptionsNotEditable,
    apply_agent_options,
    assemble_agent_detail,
    build_agent_summary,
    list_agent_summaries,
)
from switch_core.bridges.agent.protocol.service import AgentExistsError, ProtocolService
from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    TaskProtocolConfig,
)
from switch_core.db.models import User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
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
    BulkRegisterResult,
    KnownAgentType,
    RegisterAgentResponse,
    RegisterKnownAgentRequest,
    RegisterKnownSubagentsRequest,
    RegisterKnownSubagentsResponse,
    RegisterOtherAgentRequest,
    UpdateAddressingPolicyRequest,
    UpdateAgentIconRequest,
    UpdateAgentOptionsRequest,
)
from switch_core.gateway.subagent_registration import derive_subagent_registrations

logger = logging.getLogger(__name__)

router = APIRouter()


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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, bool]:
    agent = await agent_store.get_by_name(session, agent_name)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_name}")
    try:
        require_manage(Principal(user.id, user.role == "admin"), agent.owner_id)
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can delete it.",
        )
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, bool]:
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")
    try:
        require_manage(Principal(user.id, user.role == "admin"), agent.owner_id)
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can delete it.",
        )
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


@router.post("/register")
async def register_known_agent(
    req: RegisterKnownAgentRequest,
    user: Annotated[User, Depends(get_current_user)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
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
            name=req.name,
            description=req.description,
            icon_url=req.icon_url,
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
        oauth_client_id=result.oauth_client_id,
    )


@router.post("/register-known-bulk")
async def register_known_subagents(
    req: RegisterKnownSubagentsRequest,
    user: Annotated[User, Depends(get_current_user)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
) -> RegisterKnownSubagentsResponse:
    """Register many Claude Code subagents under one parent agent (session-authed).

    The owner-scoped counterpart of the agent-bridge `register-known-bulk`
    endpoint: the signed-in user must own the parent. Each child's Switch name
    is derived as ``<parent-name>.<subagent_name>``; a name clash fails the whole
    batch up front rather than leaving a partial set registered. Subagents
    inherit the parent's `channels_enabled` / `repo_dir` unless overridden in
    `options`.
    """
    spec = KNOWN_AGENTS.get(req.agent_type)
    if spec is None:
        raise HTTPException(
            status_code=400, detail=f"Unknown agent type: {req.agent_type}"
        )
    if not req.subagents:
        raise HTTPException(status_code=400, detail="No subagents provided")

    parent = await agent_store.get(session, req.parent_agent_id)
    if parent is None:
        raise HTTPException(
            status_code=404, detail=f"Parent agent not found: {req.parent_agent_id}"
        )
    try:
        require_manage(Principal(user.id, user.role == "admin"), parent.owner_id)
    except PermissionError as exc:
        raise HTTPException(
            status_code=403,
            detail="Only the parent agent's owner or an admin can register its subagents.",
        ) from exc

    # Derive names + per-subagent options (inheriting parent settings); reject
    # in-batch duplicates before touching the DB.
    try:
        derived = derive_subagent_registrations(
            parent_name=parent.name,
            parent_metadata=parent.metadata_,
            base_options=req.options,
            subagents=[(s.subagent_name, s.description) for s in req.subagents],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Pre-check existence so a clash fails the batch before any registration.
    if not req.overwrite:
        clashes = [
            d.name
            for d in derived
            if await agent_store.get_by_name(session, d.name) is not None
        ]
        if clashes:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Subagents already exist: "
                    + ", ".join(clashes)
                    + ". Pass overwrite=true to re-register."
                ),
            )

    results: list[BulkRegisterResult] = []
    for d in derived:
        try:
            options = spec.parse_options(d.options)
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail=exc.errors()) from exc
        integration_profile = spec.build_profile(options)
        metadata = {
            "known_agent_type": req.agent_type,
            "known_agent_options": options.model_dump(),
        }
        try:
            result = await protocol.register_agent(
                name=d.name,
                description=d.description,
                connector_type=spec.connector_type,
                integration_profile=integration_profile,
                tools=spec.tools,
                models=spec.models,
                metadata=metadata,
                owner_id=user.id,
                parent_agent_id=parent.id,
                overwrite=req.overwrite,
            )
        except AgentExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        results.append(
            BulkRegisterResult(
                subagent_name=d.subagent_name,
                name=d.name,
                id=result.agent_id,
                api_key=result.api_key,
            )
        )

    return RegisterKnownSubagentsResponse(results=results)


@router.patch("/{agent_id}/options")
async def update_agent_options(
    agent_id: str,
    req: UpdateAgentOptionsRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> AgentSummary:
    """Replace a known-agent's options.

    Body must contain the full options payload (no partial merge). The new
    options are validated against the spec's `options_schema`, then the
    agent's `integration_profile` is rebuilt from them via
    `KnownAgent.build_profile` and persisted alongside the options — keeping
    the two in sync the same way `/agents/register` does.

    Only the agent's owner (or an admin) can update its options. Agents that
    were not registered via a known-agent type (e.g. `register-other`) have
    no editable options and return 400.
    """
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")

    try:
        require_manage(Principal(user.id, user.role == "admin"), agent.owner_id)
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can update its options.",
        )

    try:
        await apply_agent_options(session, agent_store, agent, req.options, merge=False)
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
        require_manage(Principal(user.id, user.role == "admin"), agent.owner_id)
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


@router.post("/register-other")
async def register_other_agent(
    req: RegisterOtherAgentRequest,
    user: Annotated[User, Depends(get_current_user)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> RegisterAgentResponse:
    # External agent registered without a known profile — give it a conservative
    # default profile (session_passive, no task capabilities).
    default_profile = IntegrationProfile(
        connection_model="session_passive",
        message_exchange=True,
        pre_invocation_mediation=[],
        post_invocation_mediation=[],
        event_reporting=[],
        task_protocol=TaskProtocolConfig(can_delegate=False, can_accept=False),
    )

    try:
        result = await protocol.register_agent(
            name=req.name,
            description=req.description,
            icon_url=req.icon_url,
            connector_type="external",
            integration_profile=default_profile,
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
        oauth_client_id=result.oauth_client_id,
    )


@router.put("/{agent_id}/addressing-policy")
async def update_addressing_policy(
    agent_id: str,
    req: UpdateAddressingPolicyRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> AgentDetail:
    """Set or clear an agent's scoped addressing policy (CHOO-1585).

    ``policy: null`` clears it (the agent becomes open to anyone). Only the
    agent's owner (or an admin) may change it.
    """
    agent = await agent_store.get(session, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")

    try:
        require_manage(Principal(user.id, user.role == "admin"), agent.owner_id)
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner or an admin can change its addressing policy.",
        )

    stored = req.policy.model_dump() if req.policy is not None else None
    await agent_store.update(session, agent_id, addressing_policy=stored)
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


# Declared after the literal GET routes (e.g. /known-types) so those are matched
# first; otherwise this path-parameter route would capture them.
@router.get("/{agent_id}")
async def get_agent_detail(
    agent_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
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
