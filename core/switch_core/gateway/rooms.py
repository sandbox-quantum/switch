from __future__ import annotations

import json
import logging
from datetime import UTC
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.agent_templates import plan_template
from switch_core.authz import Action, Principal, can, require, require_manage
from switch_core.bridges.agent.operations.agent_management import management_port
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelRetirement,
    ChannelType,
    RetireOutcome,
)
from switch_core.config import SwitchConfig
from switch_core.db.models import Room, RoomGroup, User, require_tenant_id
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import LINKED_CHANNEL_NAME_KEY, RoomStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore
from switch_core.feature_flags import AGENT_MANAGEMENT, SWITCH_BUDDY
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_bridge_store,
    get_collab_lifecycle,
    get_config,
    get_external_user_store,
    get_protocol,
    get_room_group_store,
    get_room_schedule_store,
    get_room_service,
    get_room_store,
    get_room_yaml_service,
    get_session,
    get_template_store,
    get_user_store,
)
from switch_core.gateway.schemas import (
    BulkArchiveRequest,
    BulkArchiveResponse,
    BulkDeleteRequest,
    BulkDeleteResponse,
    RoomAgentsRequest,
    RoomAgentUpdateRequest,
    RoomCreateRequest,
    RoomDeleteResponse,
    RoomDetail,
    RoomObserveRequest,
    RoomProtectionRequest,
    RoomRoleCreateRequest,
    RoomRoleDetail,
    RoomRoleUpdateRequest,
    RoomScheduleCreateRequest,
    RoomScheduleResponse,
    RoomScheduleUpdateRequest,
    RoomSetGroupRequest,
    RoomSummary,
    RoomUpdateRequest,
    RoomUsersRequest,
)
from switch_core.gateway.templates import readable_template
from switch_core.room_service import RoleSpec, RoomCreateConfig, RoomService
from switch_core.rooms_yaml import (
    GroupProvisionResult,
    GroupSpec,
    ProvisionResult,
    RoomReader,
    RoomYamlService,
    template_json_schema,
)
from switch_core.scheduler.cron_util import (
    compute_next_run,
    validate_cron_expression,
    validate_timezone,
)
from switch_core.telemetry import emit_safely
from switch_core.template_installs import record_install, vouched_source
from switch_core.template_runs import (
    LISTEN_TIMEOUT_SECONDS,
    AgentsNotCreated,
    ConnectionPlan,
    NewAgentPlan,
    RunUndone,
    TemplateAgents,
    room_ids_of,
)
from switch_core.template_v2 import is_v2_text

logger = logging.getLogger(__name__)

router = APIRouter()


async def _require_room(
    session: AsyncSession,
    room_store: RoomStore,
    room_id: str,
    user: User,
    action: Action,
    is_admin: bool,
) -> Room:
    """Load a room (404 if missing) and authorize `action` for `user`,
    raising HTTP 403 if denied."""
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    try:
        require(
            Principal(user.id, is_admin),
            action,
            room,
        )
    except PermissionError as e:
        # Whoever takes part in a room may read it, as its listing shows them.
        if action != "read" or not await room_store.involved_room_ids(
            session, user.id, [room.id]
        ):
            raise HTTPException(status_code=403, detail=str(e)) from e
    return room


async def _require_room_released(
    session: AsyncSession,
    room_store: RoomStore,
    room_id: str,
    user: User,
    action: Action,
    is_admin: bool,
) -> Room:
    """`_require_room`, then end the read's transaction.

    For a route that goes on to call `RoomService` or `RoomYamlService`, which
    open sessions of their own and may call Matrix or a messaging platform.
    Holding this read's connection while waiting for another from the same
    pool is how the pool runs dry under load: every connection held by a
    request that is waiting for one more. The room stays readable after the
    commit (`expire_on_commit=False`).
    """
    room = await _require_room(session, room_store, room_id, user, action, is_admin)
    await session.commit()
    return room


async def _external_channel_url(room: Room) -> str | None:
    """Native deeplink to open the room's external channel in the messaging
    app, built by the live collaboration adapter. None when not bridged, the
    bridge isn't running, or the platform has no such scheme."""
    if not room.bridge_id or not room.external_channel_id:
        return None
    adapter = get_collab_lifecycle().get_adapter(room.bridge_id)
    if adapter is None:
        return None
    try:
        return await adapter.channel_deeplink(room.external_channel_id)
    except Exception:
        logger.warning(
            "Failed to build channel deeplink for room %s", room.id, exc_info=True
        )
        return None


def _channel_on_delete(room: Room, bridge_type: str | None) -> ChannelRetirement | None:
    """What deleting the room will do to its platform channel, as the
    platform's adapter declares it. None when the room has no channel, or its
    platform is not one this build ships."""
    if not room.external_channel_id or bridge_type is None:
        return None
    if room.channel_type == "direct":
        return "kept"
    adapter_cls = get_collab_lifecycle().adapter_class(bridge_type)
    if adapter_cls is None:
        return None
    return adapter_cls.channel_on_delete


async def _build_room_detail(
    session: AsyncSession,
    room: Room,
    room_store: RoomStore,
    bridge_store: CollaborationBridgeStore,
    external_user_store: ExternalUserStore,
    protocol: AgentCore,
) -> RoomDetail:
    agent_ids = await room_store.get_agent_ids(session, room.id)
    client_ids = await room_store.get_client_ids(session, room.id)
    statuses = await protocol.get_agent_statuses_by_ids_in_session(
        session, room.id, agent_ids
    )

    bridge_display_name: str | None = None
    bridge_type: str | None = None
    connected_names: list[str] = []
    if room.bridge_id:
        bridge = await bridge_store.get(session, room.bridge_id)
        if bridge:
            bridge_display_name = bridge.display_name
            bridge_type = bridge.type
        ext_users = await external_user_store.get_by_bridge(session, room.bridge_id)
        ext_client_to_name = {eu.client_id: eu.external_username for eu in ext_users}
        connected_names = sorted(
            ext_client_to_name[cid] for cid in client_ids if cid in ext_client_to_name
        )

    name = room.name
    if bridge_display_name and name.startswith(f"{bridge_display_name}: "):
        name = name[len(bridge_display_name) + 2 :]

    group_name: str | None = None
    if room.group_id:
        group = await session.get(RoomGroup, room.group_id)
        if group:
            group_name = group.name

    roles = await _list_room_role_details(session, room.id, protocol)
    join_event_listeners = await room_store.get_join_event_listeners(session, room.id)
    # Not held across the deeplink, which can ask the platform on a cache miss.
    await session.commit()
    external_channel_url = await _external_channel_url(room)

    return RoomDetail(
        id=room.id,
        name=name,
        description=room.description,
        channel_type=room.channel_type,
        admin_mode=room.admin_mode,
        agent_count=len(agent_ids),
        connected_user_count=len(connected_names),
        connected_user_names=connected_names,
        bridge_id=room.bridge_id,
        bridge_display_name=bridge_display_name,
        bridge_type=bridge_type,
        external_channel_url=external_channel_url,
        group_id=room.group_id,
        group_name=group_name,
        read_visibility=room.read_visibility,
        write_visibility=room.write_visibility,
        created_at=str(room.created_at),
        archived=room.archived_at is not None,
        transport_room_id=room.transport_room_id,
        matrix_room_id=room.transport_room_id,
        external_channel_id=room.external_channel_id,
        instructions=room.instructions,
        protection_config=room.protection_config,
        observe_config=room.observe_config,
        agent_ids=agent_ids,
        agent_statuses={
            aid: statuses[aid].value for aid in agent_ids if aid in statuses
        },
        roles=roles,
        join_event_listeners=join_event_listeners,
        archived_at=str(room.archived_at) if room.archived_at else None,
        channel_on_delete=_channel_on_delete(room, bridge_type),
        linked_channel_name=(
            (room.metadata_ or {}).get(LINKED_CHANNEL_NAME_KEY)
            if room.external_channel_id
            else None
        ),
    )


async def _list_room_role_details(
    session: AsyncSession, room_id: str, protocol: AgentCore
) -> list[RoomRoleDetail]:
    """List a room's roles with their live holder agent names (empty if free).

    A shared (non-exclusive) role may have several concurrent holders.
    """
    store = protocol.room_role_store
    roles = await store.list_roles(session, room_id)
    holders = await store.live_holders_for_room(
        session, room_id, protocol.connections.live_connection_ids()
    )
    holder_names: dict[str, str] = {}
    for holder_id in {h for ids in holders.values() for h in ids}:
        holder = await protocol.agent_store.get(session, holder_id)
        if holder is not None:
            holder_names[holder_id] = holder.name
    details: list[RoomRoleDetail] = []
    for r in roles:
        details.append(
            RoomRoleDetail(
                name=r.name,
                instructions=r.instructions,
                exclusive=r.exclusive,
                held_by=[
                    holder_names[h] for h in holders.get(r.id, []) if h in holder_names
                ],
            )
        )
    return details


def _validate_create(req: RoomCreateRequest) -> None:
    valid_internal = ("channel_public", "channel_private")
    valid_bridge_create = ("channel_public", "channel_private", "direct")

    if not req.bridge_id:
        if req.channel_type and req.channel_type not in valid_internal:
            raise HTTPException(
                status_code=400,
                detail=f"Internal rooms must be one of {valid_internal}",
            )
        n = len(req.agent_ids or req.agent_names or [])
        if n < 1:
            raise HTTPException(
                status_code=400,
                detail="Internal rooms require at least one agent",
            )
    else:
        if not req.external_channel_id:
            if not req.channel_type or req.channel_type not in valid_bridge_create:
                raise HTTPException(
                    status_code=400,
                    detail=f"Creating a new bridge channel requires channel_type {valid_bridge_create}",
                )


@router.get("")
async def list_rooms(
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    room_group_store: Annotated[RoomGroupStore, Depends(get_room_group_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    search: Annotated[str | None, Query()] = None,
    include_archived: Annotated[bool, Query()] = False,
) -> list[RoomSummary]:
    rooms = await room_store.list_readable(
        session,
        user.id,
        is_admin=is_admin,
        include_archived=include_archived,
    )

    group_names = {g.id: g.name for g in await room_group_store.get_all(session)}

    bridge_ids = {r.bridge_id for r in rooms if r.bridge_id}
    bridges = {b.id: b for b in await bridge_store.get_many(session, bridge_ids)}
    ext_client_to_name = {
        eu.client_id: eu.external_username
        for eu in await external_user_store.get_by_bridges(session, bridge_ids)
    }

    if search:
        term = search.lower()
        rooms = [
            r for r in rooms if term in r.name.lower() or term in r.description.lower()
        ]

    owner_names = await user_store.names_by_id(
        session, {r.owner_id for r in rooms if r.owner_id}
    )
    room_ids = [room.id for room in rooms]
    agent_ids_by_room = await room_store.agent_ids_by_room(session, room_ids)
    client_ids_by_room = await room_store.client_ids_by_room(session, room_ids)
    involved = await room_store.involved_room_ids(session, user.id, room_ids)
    # Not held across the deeplinks, which can ask the platform on a cache miss.
    await session.commit()

    summaries = []
    for room in rooms:
        connected_names = sorted(
            ext_client_to_name[cid]
            for cid in client_ids_by_room.get(room.id, [])
            if cid in ext_client_to_name
        )
        bridge = bridges.get(room.bridge_id) if room.bridge_id else None
        bridge_display_name = bridge.display_name if bridge else None
        name = room.name
        if bridge_display_name and name.startswith(f"{bridge_display_name}: "):
            name = name[len(bridge_display_name) + 2 :]
        summaries.append(
            RoomSummary(
                id=room.id,
                name=name,
                description=room.description,
                channel_type=room.channel_type,
                admin_mode=room.admin_mode,
                agent_count=len(agent_ids_by_room.get(room.id, [])),
                connected_user_count=len(connected_names),
                connected_user_names=connected_names,
                bridge_id=room.bridge_id,
                bridge_display_name=bridge_display_name,
                bridge_type=bridge.type if bridge else None,
                external_channel_url=await _external_channel_url(room),
                group_id=room.group_id,
                group_name=group_names.get(room.group_id) if room.group_id else None,
                owner_id=room.owner_id,
                owner_name=owner_names.get(room.owner_id) if room.owner_id else None,
                read_visibility=room.read_visibility,
                write_visibility=room.write_visibility,
                created_at=str(room.created_at),
                archived=room.archived_at is not None,
                viewer_is_member=room.id in involved,
                is_console_chat="chat_operation_id" in (room.metadata_ or {}),
            )
        )

    return summaries


@router.post("", status_code=201)
async def create_room(
    req: RoomCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    _validate_create(req)
    config = RoomCreateConfig(
        name=req.name,
        description=req.description,
        instructions=req.instructions,
        channel_type=cast(ChannelType, req.channel_type) if req.channel_type else None,
        agent_ids=req.agent_ids,
        agent_names=req.agent_names,
        include_subagents_for=req.include_subagents_for,
        join_event_listeners=req.join_event_listeners,
        user_names=req.user_names,
        bridge_id=req.bridge_id,
        internal_only=req.internal_only,
        external_channel_id=req.external_channel_id,
        group_id=req.group_id,
        created_by=user.id,
        owner_id=user.id,
        read_visibility=req.read_visibility,
        write_visibility=req.write_visibility,
        roles=([RoleSpec(**r.model_dump()) for r in req.roles] if req.roles else None),
    )
    try:
        result = await room_service.create_room(config)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except BridgeOperationError as e:
        # The platform refused to provision the channel and said why. Its
        # wording names the permission to grant or the value to change, and
        # the operator who clicked the button is the only one who can act on
        # it — so it goes back to them rather than into the log alone.
        raise HTTPException(status_code=502, detail=str(e)) from e
    fresh = await room_store.get(session, result.room.id)
    if fresh is None:
        raise HTTPException(status_code=500, detail="Room missing after create")
    return await _build_room_detail(
        session, fresh, room_store, bridge_store, external_user_store, protocol
    )


@router.post("/from-yaml", status_code=201)
async def create_room_from_yaml(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    rooms_yaml: Annotated[RoomYamlService, Depends(get_room_yaml_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> ProvisionResult | GroupProvisionResult:
    """Provision a room, or a group of rooms, from a YAML spec.

    The document shape picks the result: a ``room:`` document makes one room
    (``ProvisionResult``); a ``group:`` + ``rooms:`` document makes a room
    group with its rooms and links (``GroupProvisionResult``).

    Two content types are accepted:

    * **Raw YAML** (``text/yaml``, ``text/plain``, or any non-JSON type): the
      body is the template text.  Only defaults-only templates work here
      (no way to pass inputs).
    * **JSON** (``application/json``): ``{"yaml": "<template text>",
      "inputs": {...}, "template_name": "..."}`` where ``inputs`` supplies
      values for declared ``params:`` and ``template_name`` is what the run is
      listed under in Recently used (the document's own name when absent).
    """
    content_type = request.headers.get("content-type", "")
    try:
        if "application/json" in content_type:
            payload = json.loads(await request.body())
            if not isinstance(payload, dict) or "yaml" not in payload:
                raise ValueError("JSON body must have a 'yaml' key")
            text = payload["yaml"]
            if not isinstance(text, str):
                raise ValueError("'yaml' must be a string")
            inputs = payload.get("inputs")
            template_name = payload.get("template_name")
            if template_name is not None and not isinstance(template_name, str):
                raise ValueError("'template_name' must be a string")
        else:
            text = (await request.body()).decode("utf-8")
            inputs = None
            template_name = None
        reader = RoomReader(Principal(user.id, is_admin))
        inputs = await rooms_yaml.resolve_defaults(text, inputs, reader=reader)
        builtins = await rooms_yaml.builtins_for(
            user_id=user.id, name=user.name, email=user.email, text=text, inputs=inputs
        )
        parsed = rooms_yaml.parse_template(text, inputs=inputs, builtins=builtins)
        await rooms_yaml.check_entity_params(parsed, reader=reader)
        if isinstance(parsed.spec, GroupSpec):
            return await rooms_yaml.provision_group(
                parsed.spec,
                user_id=user.id,
                is_admin=is_admin,
                creator_name=builtins["$creator"],
                template_name=template_name or parsed.spec.group.name,
            )
        return await rooms_yaml.provision(
            parsed.spec,
            kickoff=parsed.kickoff,
            user_id=user.id,
            is_admin=is_admin,
            creator_name=builtins["$creator"],
            template_name=template_name or parsed.spec.name,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except BridgeOperationError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


class TemplateConnectionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    service: str
    access: Literal["read", "write"] | None = None
    repos: list[str] = Field(default_factory=list)


class TemplateAgentBody(BaseModel):
    """One agent a template run creates, resolved by the client."""

    model_config = ConfigDict(extra="forbid")
    slot: str
    name: str
    description: str
    display_name: str | None
    instructions: str
    provider: str
    machine: str
    model: str | None
    advanced_config: dict[str, Any]
    isolation: Literal["shared", "isolated"]
    # Older Consoles do not send it; a new agent runs in auto mode.
    auto_mode: bool = True
    auto_approve: bool
    directory: str | None
    addressing: Literal["owner", "owner-agents", "anyone"]
    # Older Consoles do not send it.
    can_manage_agents: bool = False
    connections: list[TemplateConnectionBody]

    def plan(self) -> NewAgentPlan:
        return NewAgentPlan(
            slot=self.slot,
            name=self.name,
            description=self.description,
            display_name=self.display_name,
            icon_url=None,
            instructions=self.instructions,
            provider=self.provider,
            machine=self.machine,
            model=self.model,
            advanced_config=self.advanced_config,
            isolation=self.isolation,
            auto_mode=self.auto_mode,
            auto_approve=self.auto_approve,
            directory=self.directory,
            addressing=self.addressing,
            can_manage_agents=self.can_manage_agents,
            connections=[
                ConnectionPlan(c.service, c.access, list(c.repos))
                for c in self.connections
            ],
        )


class TemplateRunBody(BaseModel):
    """A template run: the agents it creates, then the room half (``yaml``,
    naming them by name; null for a template with no room)."""

    model_config = ConfigDict(extra="forbid")
    agents: list[TemplateAgentBody]
    yaml: str | None
    inputs: dict[str, Any] | None = None
    template_name: str


def _refused_run(error: AgentsNotCreated | RunUndone) -> JSONResponse:
    content: dict[str, Any] = {"detail": str(error), "code": error.reason}
    if isinstance(error, AgentsNotCreated):
        content["problems"] = [p.as_dict() for p in error.problems]
    else:
        content["left_behind"] = error.left_behind
    return JSONResponse(status_code=409, content=content)


@router.post("/from-template", status_code=201, response_model=None)
async def run_template_with_agents(
    body: TemplateRunBody,
    rooms_yaml: Annotated[RoomYamlService, Depends(get_room_yaml_service)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> dict[str, Any] | JSONResponse:
    """Run a template that creates agents: the agents first, as managed
    agents of the caller on their own machines, then its rooms.

    Everything is checked before anything is created: each machine can take
    its agent now, each name is free, each connection is the caller's to
    grant, and the room half parses. A refusal is 409 with ``code``
    ``agents_not_created`` and ``problems``, each ``{slot, code, message}``.
    When the rooms fail after the agents were created, the agents are deleted
    again: 409 with ``code`` ``run_undone`` and ``left_behind`` naming any
    that could not be. A room half that is wrong is 400, as from-yaml.

    Returns ``{created_agents: [{slot, agent_id, name, machine, listening}],
    room}``, ``room`` being what from-yaml returns, or null with no room
    half. ``listening`` is false for an agent that was not taking events
    before the rooms were made: the kickoff may not have reached it.
    """
    return await _run_as_person(
        rooms_yaml,
        protocol,
        user,
        is_admin,
        plans=[agent.plan() for agent in body.agents],
        document=body.yaml,
        inputs=body.inputs,
        template_name=body.template_name,
        room_addressing={},
    )


class TemplateDocumentRunBody(BaseModel):
    """A whole template run from its document: the server works out the
    agents and rooms from the document and the inputs."""

    model_config = ConfigDict(extra="forbid")
    template: str
    inputs: dict[str, Any] | None = None
    # Existing agents standing in for slots that allow it: {slot: agent name}.
    filled: dict[str, str] = Field(default_factory=dict)
    template_name: str
    # The template the document is, by id, when it is one. The run is
    # recorded as that template's install only when the document is exactly
    # the template's; a Switch Console that does not send it still has a run
    # of an official template recognised by its document.
    template_id: str | None = None


@router.post("/from-template-document", status_code=201, response_model=None)
async def run_template_document(
    body: TemplateDocumentRunBody,
    rooms_yaml: Annotated[RoomYamlService, Depends(get_room_yaml_service)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    session: Annotated[AsyncSession, Depends(get_session)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> dict[str, Any] | JSONResponse:
    """Run a template from its document, the way ``run_template`` does for an
    agent: the server resolves the agents (their machine and provider among
    the caller's machines), checks everything, creates the agents, then the
    rooms. For a ``version: 2`` document, whose conditions and references
    only the server resolves. Answers as ``from-template``.

    The agents a run of a known template creates are recorded as its
    install (``template_installs``), so a later revision can update them.
    """
    loaded = (
        await readable_template(
            body.template_id, session, template_store, user, is_admin, config
        )
        if body.template_id is not None
        else None
    )
    source = vouched_source(
        body.template,
        loaded,
        agent_management=config.feature_flags[AGENT_MANAGEMENT],
        switch_buddy=config.feature_flags[SWITCH_BUDDY],
    )
    inputs = body.inputs or {}
    try:
        if is_v2_text(body.template):
            inputs = (
                await rooms_yaml.resolve_defaults(
                    body.template,
                    inputs,
                    reader=RoomReader(Principal(user.id, is_admin)),
                )
                or {}
            )
        builtins = await rooms_yaml.builtins_for(
            user_id=user.id,
            name=user.name,
            email=user.email,
            text=body.template,
            inputs=inputs,
        )
        port = management_port()
        machines = (
            await port.list_machines(require_tenant_id(), user.id)
            if port is not None
            else None
        )
        plan = plan_template(
            body.template, body.filled, inputs, builtins=builtins, machines=machines
        )
    except AgentsNotCreated as error:
        return _refused_run(error)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    result = await _run_as_person(
        rooms_yaml,
        protocol,
        user,
        is_admin,
        plans=plan.new_agents,
        document=plan.document,
        inputs=plan.inputs or None,
        template_name=body.template_name,
        room_addressing=plan.room_addressing,
    )
    if source is not None and isinstance(result, dict):
        await record_install(
            protocol.session_factory,
            require_tenant_id(),
            owner_id=user.id,
            source=source,
            document=body.template,
            inputs=inputs,
            builtins=builtins,
            plans=plan.new_agents,
            created=result["created_agents"],
        )
    return result


async def _run_as_person(
    rooms_yaml: RoomYamlService,
    protocol: AgentCore,
    user: User,
    is_admin: bool,
    *,
    plans: list[NewAgentPlan],
    document: str | None,
    inputs: dict[str, Any] | None,
    template_name: str,
    room_addressing: dict[str, list[str]],
) -> dict[str, Any] | JSONResponse:
    """Check everything, create the agents, then the rooms, as `user`; undo
    the agents when the rooms fail."""
    tenant_id = require_tenant_id()
    creator = TemplateAgents(
        protocol=protocol,
        management=management_port(),
        broker=protocol.service_broker,
        listen_timeout=LISTEN_TIMEOUT_SECONDS,
    )
    try:
        parsed = None
        builtins: dict[str, str] = {}
        if document is not None:
            reader = RoomReader(Principal(user.id, is_admin))
            inputs = await rooms_yaml.resolve_defaults(document, inputs, reader=reader)
            builtins = await rooms_yaml.builtins_for(
                user_id=user.id,
                name=user.name,
                email=user.email,
                text=document,
                inputs=inputs,
            )
            parsed = rooms_yaml.parse_template(
                document, inputs=inputs, builtins=builtins
            )
            await rooms_yaml.check_entity_params(parsed, reader=reader)
            await rooms_yaml.check_bridges(parsed)
        checked = await creator.check(tenant_id, user.id, plans)
        created = await creator.create(tenant_id, user.id, checked)
        room: ProvisionResult | GroupProvisionResult | None = None
        if parsed is not None:
            try:
                if isinstance(parsed.spec, GroupSpec):
                    room = await rooms_yaml.provision_group(
                        parsed.spec,
                        user_id=user.id,
                        is_admin=is_admin,
                        creator_name=builtins["$creator"],
                        template_name=template_name,
                    )
                else:
                    room = await rooms_yaml.provision(
                        parsed.spec,
                        kickoff=parsed.kickoff,
                        user_id=user.id,
                        is_admin=is_admin,
                        creator_name=builtins["$creator"],
                        template_name=template_name,
                    )
                if room_addressing:
                    await creator.open_to_rooms(
                        tenant_id,
                        created,
                        room_addressing,
                        room_ids_of(room.model_dump()),
                    )
            except Exception as error:
                if not created:
                    raise
                raise await creator.undone(
                    created, f"the rooms could not be created: {error}"
                ) from error
    except (AgentsNotCreated, RunUndone) as error:
        return _refused_run(error)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except BridgeOperationError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "created_agents": [
            {
                "slot": agent.slot,
                "agent_id": agent.agent_id,
                "name": agent.name,
                "machine": agent.machine,
                "listening": agent.listening,
            }
            for agent in created
        ],
        "room": None if room is None else room.model_dump(),
    }


@router.get("/template-schema")
async def get_template_schema(
    _user: Annotated[User, Depends(get_current_user)],
) -> dict:
    """Return the JSON Schema describing a valid template document, either
    the single-room or the group shape."""
    return template_json_schema()


@router.get("/{room_id}/yaml")
async def export_room_yaml(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    rooms_yaml: Annotated[RoomYamlService, Depends(get_room_yaml_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    agents: Annotated[bool, Query()] = True,
    users: Annotated[bool, Query()] = True,
    references: Annotated[bool, Query()] = True,
    packages: Annotated[bool, Query()] = True,
    docs: Annotated[bool, Query()] = True,
    roles: Annotated[bool, Query()] = True,
) -> Response:
    """Export a room to YAML in the same surface ``/rooms/from-yaml`` accepts.
    Each section can be dropped via its boolean toggle (default included)."""
    await _require_room_released(session, room_store, room_id, user, "read", is_admin)
    yaml_text = await rooms_yaml.export(
        room_id,
        agents=agents,
        users=users,
        references=references,
        packages=packages,
        docs=docs,
        roles=roles,
    )
    return Response(content=yaml_text, media_type="application/x-yaml")


@router.get("/{room_id}")
async def get_room(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    room = await _require_room(session, room_store, room_id, user, "read", is_admin)
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.patch("/{room_id}")
async def patch_room(
    room_id: str,
    req: RoomUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    target = await _require_room_released(
        session, room_store, room_id, user, "write", is_admin
    )
    # Changing a room's access permission (read/write visibility) is reserved
    # for the room's owner and tenant admins — plain write access (which a
    # publicly-writable room grants to everyone) is not enough. Otherwise any
    # user could re-permission any room and lock out its owner.
    if req.read_visibility is not None or req.write_visibility is not None:
        try:
            require_manage(Principal(user.id, is_admin), target.owner_id)
        except PermissionError as e:
            raise HTTPException(status_code=403, detail=str(e)) from e
    try:
        await room_service.update_room(
            room_id,
            name=req.name,
            description=req.description,
            instructions=req.instructions,
            admin_mode=req.admin_mode,
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await session.commit()
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    # The update was written on another session; this one still holds the row
    # as it was read for the access check.
    await session.refresh(room)
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.get("/{room_id}/roles")
async def list_room_roles(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[RoomRoleDetail]:
    await _require_room(session, room_store, room_id, user, "read", is_admin)
    return await _list_room_role_details(session, room_id, protocol)


@router.post("/{room_id}/roles", status_code=201)
async def create_room_role(
    room_id: str,
    req: RoomRoleCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[RoomRoleDetail]:
    await _require_room(session, room_store, room_id, user, "write", is_admin)
    try:
        await protocol.room_role_store.define_role(
            session, room_id, req.name, req.instructions, req.exclusive
        )
        # After the write succeeds but before the outer commit — the same
        # convention as room_role_deleted below, chosen so a request that
        # fails validation (e.g. a duplicate name) never reports an event for
        # a role that was never defined.
        emit_safely(
            current_telemetry(), "room_role_defined", {"exclusive": req.exclusive}
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await session.commit()
    return await _list_room_role_details(session, room_id, protocol)


@router.patch("/{room_id}/roles/{name}")
async def patch_room_role(
    room_id: str,
    name: str,
    req: RoomRoleUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[RoomRoleDetail]:
    await _require_room(session, room_store, room_id, user, "write", is_admin)
    try:
        await protocol.room_role_store.edit_role(
            session, room_id, name, req.instructions, req.exclusive
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    await session.commit()
    return await _list_room_role_details(session, room_id, protocol)


@router.delete("/{room_id}/roles/{name}")
async def delete_room_role(
    room_id: str,
    name: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[RoomRoleDetail]:
    await _require_room(session, room_store, room_id, user, "write", is_admin)
    try:
        await protocol.room_role_store.delete_role(session, room_id, name)
        emit_safely(current_telemetry(), "room_role_deleted", {})
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    await session.commit()
    return await _list_room_role_details(session, room_id, protocol)


@router.put("/{room_id}/group")
async def put_room_group(
    room_id: str,
    req: RoomSetGroupRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    """Assign the room to a group, or make it standalone (`group_id=null`)."""
    await _require_room(session, room_store, room_id, user, "write", is_admin)
    try:
        await room_store.set_group(session, room_id, req.group_id)
    except ValueError as e:
        # Missing room → 404; missing group → 400.
        detail = str(e)
        status = 404 if "Room not found" in detail else 400
        raise HTTPException(status_code=status, detail=detail) from e
    await session.commit()
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.put("/{room_id}/protection")
async def put_protection(
    room_id: str,
    req: RoomProtectionRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    await _require_room_released(session, room_store, room_id, user, "write", is_admin)
    try:
        await room_service.update_protection_config(room_id, req.protection_config)
    except ValueError:
        raise HTTPException(status_code=404, detail="Room not found")
    await session.commit()
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.put("/{room_id}/observe")
async def put_observe(
    room_id: str,
    req: RoomObserveRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    await _require_room_released(session, room_store, room_id, user, "write", is_admin)
    try:
        await room_service.update_observe_config(room_id, req.observe_config)
    except ValueError:
        raise HTTPException(status_code=404, detail="Room not found")
    await session.commit()
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.post("/{room_id}/agents")
async def post_room_agents(
    room_id: str,
    req: RoomAgentsRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    await _require_room_released(session, room_store, room_id, user, "write", is_admin)
    try:
        await room_service.add_agents_to_room(
            room_id,
            agent_ids=req.agent_ids,
            include_subagents_for=req.include_subagents_for,
            join_event_listeners=req.join_event_listeners,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await session.commit()
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.patch("/{room_id}/agents/{agent_id}")
async def patch_room_agent(
    room_id: str,
    agent_id: str,
    req: RoomAgentUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    await _require_room_released(session, room_store, room_id, user, "write", is_admin)
    try:
        await room_service.set_join_event_listeners(
            room_id, {agent_id: req.receives_join_events}
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.delete("/{room_id}/agents/{agent_id}")
async def delete_room_agent(
    room_id: str,
    agent_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    await _require_room_released(session, room_store, room_id, user, "write", is_admin)
    try:
        await room_service.remove_agents_from_room(room_id, [agent_id])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await session.commit()
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.post("/{room_id}/users")
async def post_room_users(
    room_id: str,
    req: RoomUsersRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    await _require_room_released(session, room_store, room_id, user, "write", is_admin)
    try:
        await room_service.add_users_to_room(room_id, req.user_names)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await session.commit()
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


async def _set_archived(
    room_id: str,
    archived: bool,
    session: AsyncSession,
    room_service: RoomService,
    room_store: RoomStore,
    bridge_store: CollaborationBridgeStore,
    external_user_store: ExternalUserStore,
    protocol: AgentCore,
    user: User,
    is_admin: bool,
) -> RoomDetail:
    await _require_room_released(session, room_store, room_id, user, "write", is_admin)
    try:
        await room_service.set_room_archived(room_id, archived)
    except ValueError:
        raise HTTPException(status_code=404, detail="Room not found")
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.post("/{room_id}/sync-name")
async def sync_room_name(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    """Name the room after its linked channel (`linked_channel_name`), as the
    bridge names its own rooms, so it follows the channel's renames from now
    on. The room's owner or an admin only."""
    room = await _require_room(session, room_store, room_id, user, "delete", is_admin)
    channel_name = (room.metadata_ or {}).get(LINKED_CHANNEL_NAME_KEY)
    bridge = await bridge_store.get(session, room.bridge_id) if room.bridge_id else None
    if not room.external_channel_id or bridge is None or not channel_name:
        raise HTTPException(
            status_code=409,
            detail="Switch has not seen the name of a channel linked to this room.",
        )
    # `take_platform_name` opens a session of its own (`_require_room_released`).
    await session.commit()
    await room_service.take_platform_name(
        room.id, f"{bridge.display_name}: {channel_name}", channel_name
    )
    await session.refresh(room)
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.post("/{room_id}/archive")
async def archive_room(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    """: hide it from the default active list. Reversible and
    metadata-only: the room, members, and bridge channel are intact."""
    return await _set_archived(
        room_id,
        True,
        session,
        room_service,
        room_store,
        bridge_store,
        external_user_store,
        protocol,
        user,
        is_admin,
    )


@router.post("/{room_id}/unarchive")
async def unarchive_room(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDetail:
    """: restore it to the active list."""
    return await _set_archived(
        room_id,
        False,
        session,
        room_service,
        room_store,
        bridge_store,
        external_user_store,
        protocol,
        user,
        is_admin,
    )


@router.delete("/{room_id}")
async def delete_room(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    # Also archive, delete or leave the room's platform channel. Off unless
    # asked: people often delete a room to take the agents out of a channel
    # they keep using.
    retire_channel: Annotated[bool, Query()] = False,
) -> RoomDeleteResponse:
    await _require_room_released(session, room_store, room_id, user, "delete", is_admin)
    try:
        channel = await room_service.delete_room(room_id, retire_channel=retire_channel)
    except ValueError:
        raise HTTPException(status_code=404, detail="Room not found")
    return RoomDeleteResponse(ok=True, channel=channel)


@router.post("/bulk-delete")
async def bulk_delete_rooms(
    req: BulkDeleteRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> BulkDeleteResponse:
    principal = Principal(user.id, is_admin)
    deleted = 0
    channels: dict[str, RetireOutcome] = {}
    for room_id in req.room_ids:
        room = await room_store.get(session, room_id)
        if room is None:
            logger.warning("Skipping unknown room %s during bulk delete", room_id)
            continue
        if not can(principal, "delete", room):
            logger.warning(
                "Skipping room %s during bulk delete: not authorized", room_id
            )
            continue
        # See `_require_room_released`.
        await session.commit()
        channel = await room_service.delete_room(
            room_id, retire_channel=req.retire_channel
        )
        if channel is not None:
            channels[room_id] = channel
        deleted += 1
    return BulkDeleteResponse(deleted=deleted, channels=channels)


@router.post("/bulk-archive")
async def bulk_archive_rooms(
    req: BulkArchiveRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> BulkArchiveResponse:
    """Archive or unarchive many rooms at once. Each room is authorized
    individually with the same `write` check as the single archive endpoint;
    rooms the caller cannot write (or that no longer exist) are skipped."""
    principal = Principal(user.id, is_admin)
    updated = 0
    for room_id in req.room_ids:
        room = await room_store.get(session, room_id)
        if room is None:
            logger.warning("Skipping unknown room %s during bulk archive", room_id)
            continue
        if not can(principal, "write", room):
            logger.warning(
                "Skipping room %s during bulk archive: not authorized", room_id
            )
            continue
        # See `_require_room_released`.
        await session.commit()
        await room_service.set_room_archived(room_id, req.archived)
        updated += 1
    return BulkArchiveResponse(updated=updated)


# ── Room Schedules ──────────────────────────────────────────────────────────


@router.get("/{room_id}/schedules")
async def list_room_schedules(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[RoomScheduleResponse]:
    """List all scheduled routines for a room. Requires read access to the room."""
    await _require_room(session, room_store, room_id, user, "read", is_admin)
    schedules = await schedule_store.list_for_room(session, room_id)
    return [
        RoomScheduleResponse.model_validate(s, from_attributes=True) for s in schedules
    ]


@router.post("/{room_id}/schedules", status_code=201)
async def create_room_schedule(
    room_id: str,
    req: RoomScheduleCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleResponse:
    """Create a new schedule for a room. Only users allowed to manage the room can create schedules."""
    room = await _require_room(session, room_store, room_id, user, "write", is_admin)
    try:
        require_manage(Principal(user.id, is_admin), room.owner_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    # Verify target agents are currently members of the room
    agent_ids_in_room = set(await room_store.get_agent_ids(session, room_id))
    invalid_agents = [
        aid for aid in req.target_agent_ids if aid not in agent_ids_in_room
    ]
    if invalid_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Target agents not present in room: {', '.join(invalid_agents)}",
        )

    # Validate timing and calculate next run
    if req.schedule_type == "recurring":
        if not req.cron_expression or not validate_cron_expression(req.cron_expression):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid cron expression: '{req.cron_expression}'",
            )
        if not validate_timezone(req.timezone):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid timezone: '{req.timezone}'",
            )
        next_run = compute_next_run(req.cron_expression, req.timezone)
    else:
        if req.one_off_datetime is None:
            raise HTTPException(
                status_code=400,
                detail="one_off_datetime is required for one_off schedules",
            )
        next_run = (
            req.one_off_datetime
            if req.one_off_datetime.tzinfo is not None
            else req.one_off_datetime.replace(tzinfo=UTC)
        )

    created = await schedule_store.create(
        session,
        room_id=room_id,
        created_by_user_id=user.id,
        name=req.name,
        message=req.message,
        target_agent_ids=req.target_agent_ids,
        schedule_type=req.schedule_type,
        cron_expression=req.cron_expression,
        timezone=req.timezone,
        next_run_at=next_run,
        status="active",
        missed_run_policy=req.missed_run_policy,
    )
    await session.commit()
    return RoomScheduleResponse.model_validate(created, from_attributes=True)


@router.get("/{room_id}/schedules/{schedule_id}")
async def get_room_schedule(
    room_id: str,
    schedule_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleResponse:
    """Get a single schedule by ID."""
    await _require_room(session, room_store, room_id, user, "read", is_admin)
    schedule = await schedule_store.get(session, schedule_id)
    if schedule is None or schedule.room_id != room_id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return RoomScheduleResponse.model_validate(schedule, from_attributes=True)


@router.patch("/{room_id}/schedules/{schedule_id}")
async def update_room_schedule(
    room_id: str,
    schedule_id: str,
    req: RoomScheduleUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleResponse:
    """Update a room schedule. Only room managers can update schedules."""
    room = await _require_room(session, room_store, room_id, user, "write", is_admin)
    try:
        require_manage(Principal(user.id, is_admin), room.owner_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    schedule = await schedule_store.get(session, schedule_id)
    if schedule is None or schedule.room_id != room_id:
        raise HTTPException(status_code=404, detail="Schedule not found")

    if req.target_agent_ids is not None:
        agent_ids_in_room = set(await room_store.get_agent_ids(session, room_id))
        invalid_agents = [
            aid for aid in req.target_agent_ids if aid not in agent_ids_in_room
        ]
        if invalid_agents:
            raise HTTPException(
                status_code=400,
                detail=f"Target agents not present in room: {', '.join(invalid_agents)}",
            )

    new_timezone = req.timezone or schedule.timezone
    new_cron = req.cron_expression or schedule.cron_expression
    next_run_at = schedule.next_run_at

    if req.timezone is not None and not validate_timezone(req.timezone):
        raise HTTPException(
            status_code=400, detail=f"Invalid timezone: '{req.timezone}'"
        )

    if req.cron_expression is not None and not validate_cron_expression(
        req.cron_expression
    ):
        raise HTTPException(
            status_code=400, detail=f"Invalid cron expression: '{req.cron_expression}'"
        )

    if schedule.schedule_type == "recurring" and (
        req.cron_expression is not None or req.timezone is not None
    ):
        if (
            new_cron
            and validate_cron_expression(new_cron)
            and validate_timezone(new_timezone)
        ):
            next_run_at = compute_next_run(new_cron, new_timezone)
    elif req.one_off_datetime is not None:
        next_run_at = (
            req.one_off_datetime
            if req.one_off_datetime.tzinfo is not None
            else req.one_off_datetime.replace(tzinfo=UTC)
        )

    updated = await schedule_store.update(
        session,
        schedule_id,
        name=req.name,
        message=req.message,
        target_agent_ids=req.target_agent_ids,
        cron_expression=req.cron_expression,
        timezone=req.timezone,
        next_run_at=next_run_at,
        missed_run_policy=req.missed_run_policy,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    await session.commit()
    return RoomScheduleResponse.model_validate(updated, from_attributes=True)


@router.post("/{room_id}/schedules/{schedule_id}/pause")
async def pause_room_schedule(
    room_id: str,
    schedule_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleResponse:
    """Pause an active room schedule."""
    room = await _require_room(session, room_store, room_id, user, "write", is_admin)
    try:
        require_manage(Principal(user.id, is_admin), room.owner_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    schedule = await schedule_store.get(session, schedule_id)
    if schedule is None or schedule.room_id != room_id:
        raise HTTPException(status_code=404, detail="Schedule not found")

    updated = await schedule_store.set_status(session, schedule_id, "paused")
    if updated is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    await session.commit()
    return RoomScheduleResponse.model_validate(updated, from_attributes=True)


@router.post("/{room_id}/schedules/{schedule_id}/resume")
async def resume_room_schedule(
    room_id: str,
    schedule_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleResponse:
    """Resume a paused room schedule."""
    room = await _require_room(session, room_store, room_id, user, "write", is_admin)
    try:
        require_manage(Principal(user.id, is_admin), room.owner_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    schedule = await schedule_store.get(session, schedule_id)
    if schedule is None or schedule.room_id != room_id:
        raise HTTPException(status_code=404, detail="Schedule not found")

    next_run = None
    if schedule.schedule_type == "recurring" and schedule.cron_expression:
        next_run = compute_next_run(schedule.cron_expression, schedule.timezone)

    updated = await schedule_store.set_status(
        session, schedule_id, "active", next_run_at=next_run
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    await session.commit()
    return RoomScheduleResponse.model_validate(updated, from_attributes=True)


@router.delete("/{room_id}/schedules/{schedule_id}", status_code=204)
async def delete_room_schedule(
    room_id: str,
    schedule_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> Response:
    """Delete a schedule for a room."""
    room = await _require_room(session, room_store, room_id, user, "write", is_admin)
    try:
        require_manage(Principal(user.id, is_admin), room.owner_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    schedule = await schedule_store.get(session, schedule_id)
    if schedule is None or schedule.room_id != room_id:
        raise HTTPException(status_code=404, detail="Schedule not found")

    await schedule_store.delete(session, schedule_id)
    await session.commit()
    return Response(status_code=204)
