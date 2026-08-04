from __future__ import annotations

import logging
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Action, Principal, can, require
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.collaboration.models import ChannelType
from switch_core.db.models import Room, RoomGroup, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_bridge_store,
    get_collab_lifecycle,
    get_external_user_store,
    get_protocol,
    get_room_group_store,
    get_room_service,
    get_room_store,
    get_room_yaml_service,
    get_session,
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
    RoomDetail,
    RoomObserveRequest,
    RoomProtectionRequest,
    RoomRoleCreateRequest,
    RoomRoleDetail,
    RoomRoleUpdateRequest,
    RoomSetGroupRequest,
    RoomSummary,
    RoomUpdateRequest,
    RoomUsersRequest,
)
from switch_core.room_service import RoleSpec, RoomCreateConfig, RoomService
from switch_core.rooms_yaml import ProvisionResult, RoomYamlService

logger = logging.getLogger(__name__)

router = APIRouter()


async def _require_room(
    session: AsyncSession,
    room_store: RoomStore,
    room_id: str,
    user: User,
    action: Action,
) -> Room:
    """Load a room (404 if missing) and authorize `action` for `user`,
    raising HTTP 403 if denied."""
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    try:
        require(Principal(user.id, user.role == "admin"), action, room)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
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


async def _build_room_detail(
    session: AsyncSession,
    room: Room,
    room_store: RoomStore,
    bridge_store: CollaborationBridgeStore,
    external_user_store: ExternalUserStore,
    protocol: ProtocolService,
) -> RoomDetail:
    agent_ids = await room_store.get_agent_ids(session, room.id)
    client_ids = await room_store.get_client_ids(session, room.id)
    statuses = await protocol.get_agent_statuses_by_ids(room.id, agent_ids)

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
        external_channel_url=await _external_channel_url(room),
        group_id=room.group_id,
        group_name=group_name,
        read_visibility=room.read_visibility,
        write_visibility=room.write_visibility,
        created_at=str(room.created_at),
        archived=room.archived_at is not None,
        matrix_room_id=room.matrix_room_id,
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
    )


async def _list_room_role_details(
    session: AsyncSession, room_id: str, protocol: ProtocolService
) -> list[RoomRoleDetail]:
    """List a room's roles with their live holder agent names (empty if free).

    A shared (non-exclusive) role may have several concurrent holders.
    """
    store = protocol.room_role_store
    roles = await store.list_roles(session, room_id)
    holders = await store.live_holders_for_room(
        session, room_id, protocol.connections.live_agent_ids()
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
    search: Annotated[str | None, Query()] = None,
    include_archived: Annotated[bool, Query()] = False,
) -> list[RoomSummary]:
    rooms = await room_store.list_readable(
        session,
        user.id,
        is_admin=user.role == "admin",
        include_archived=include_archived,
    )

    group_names = {g.id: g.name for g in await room_group_store.get_all(session)}

    bridge_ids = {r.bridge_id for r in rooms if r.bridge_id}
    bridge_names: dict[str, str] = {}
    bridge_types: dict[str, str] = {}
    ext_client_to_name: dict[str, str] = {}
    for bid in bridge_ids:
        bridge = await bridge_store.get(session, bid)
        if bridge:
            bridge_names[bid] = bridge.display_name
            bridge_types[bid] = bridge.type
        ext_users = await external_user_store.get_by_bridge(session, bid)
        for eu in ext_users:
            ext_client_to_name[eu.client_id] = eu.external_username

    owner_names: dict[str, str] = {}
    for oid in {r.owner_id for r in rooms if r.owner_id}:
        owner = await user_store.get(session, oid)
        if owner:
            owner_names[oid] = owner.name

    if search:
        term = search.lower()
        rooms = [
            r for r in rooms if term in r.name.lower() or term in r.description.lower()
        ]

    summaries = []
    for room in rooms:
        agent_ids = await room_store.get_agent_ids(session, room.id)
        client_ids = await room_store.get_client_ids(session, room.id)
        connected_names = sorted(
            ext_client_to_name[cid] for cid in client_ids if cid in ext_client_to_name
        )
        bridge_display_name = (
            bridge_names.get(room.bridge_id) if room.bridge_id else None
        )
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
                agent_count=len(agent_ids),
                connected_user_count=len(connected_names),
                connected_user_names=connected_names,
                bridge_id=room.bridge_id,
                bridge_display_name=bridge_display_name,
                bridge_type=(
                    bridge_types.get(room.bridge_id) if room.bridge_id else None
                ),
                external_channel_url=await _external_channel_url(room),
                group_id=room.group_id,
                group_name=group_names.get(room.group_id) if room.group_id else None,
                owner_id=room.owner_id,
                owner_name=owner_names.get(room.owner_id) if room.owner_id else None,
                read_visibility=room.read_visibility,
                write_visibility=room.write_visibility,
                created_at=str(room.created_at),
                archived=room.archived_at is not None,
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
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
    fresh = await room_store.get(session, result.room.id)
    if fresh is None:
        raise HTTPException(status_code=500, detail="Room missing after create")
    return await _build_room_detail(
        session, fresh, room_store, bridge_store, external_user_store, protocol
    )


@router.post("/from-yaml", status_code=201)
async def create_room_from_yaml(
    request: Request,
    rooms_yaml: Annotated[RoomYamlService, Depends(get_room_yaml_service)],
    user: Annotated[User, Depends(get_current_user)],
) -> ProvisionResult:
    """Provision a single room and its attachments from a YAML spec. The body
    is the raw YAML text. Best-effort: the room is created first (fail-loud on
    bad config), then inline references/docs are attached, with post-creation
    failures surfaced in ``failed_attachments`` rather than dropped."""
    text = (await request.body()).decode("utf-8")
    try:
        spec = rooms_yaml.parse(text)
        return await rooms_yaml.provision(
            spec, user_id=user.id, is_admin=user.role == "admin"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e


@router.get("/{room_id}/yaml")
async def export_room_yaml(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    rooms_yaml: Annotated[RoomYamlService, Depends(get_room_yaml_service)],
    user: Annotated[User, Depends(get_current_user)],
    agents: Annotated[bool, Query()] = True,
    users: Annotated[bool, Query()] = True,
    references: Annotated[bool, Query()] = True,
    docs: Annotated[bool, Query()] = True,
    roles: Annotated[bool, Query()] = True,
) -> Response:
    """Export a room to YAML in the same surface ``/rooms/from-yaml`` accepts.
    Each section can be dropped via its boolean toggle (default included)."""
    await _require_room(session, room_store, room_id, user, "read")
    yaml_text = await rooms_yaml.export(
        room_id,
        agents=agents,
        users=users,
        references=references,
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    room = await _require_room(session, room_store, room_id, user, "read")
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    await _require_room(session, room_store, room_id, user, "write")
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
    return await _build_room_detail(
        session, room, room_store, bridge_store, external_user_store, protocol
    )


@router.get("/{room_id}/roles")
async def list_room_roles(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[RoomRoleDetail]:
    await _require_room(session, room_store, room_id, user, "read")
    return await _list_room_role_details(session, room_id, protocol)


@router.post("/{room_id}/roles", status_code=201)
async def create_room_role(
    room_id: str,
    req: RoomRoleCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[RoomRoleDetail]:
    await _require_room(session, room_store, room_id, user, "write")
    try:
        await protocol.room_role_store.define_role(
            session, room_id, req.name, req.instructions, req.exclusive
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[RoomRoleDetail]:
    await _require_room(session, room_store, room_id, user, "write")
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[RoomRoleDetail]:
    await _require_room(session, room_store, room_id, user, "write")
    try:
        await protocol.room_role_store.delete_role(session, room_id, name)
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    """Assign the room to a group, or make it standalone (`group_id=null`)."""
    await _require_room(session, room_store, room_id, user, "write")
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    await _require_room(session, room_store, room_id, user, "write")
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    await _require_room(session, room_store, room_id, user, "write")
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    await _require_room(session, room_store, room_id, user, "write")
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    await _require_room(session, room_store, room_id, user, "write")
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    await _require_room(session, room_store, room_id, user, "write")
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
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    await _require_room(session, room_store, room_id, user, "write")
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
    protocol: ProtocolService,
    user: User,
) -> RoomDetail:
    await _require_room(session, room_store, room_id, user, "write")
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


@router.post("/{room_id}/archive")
async def archive_room(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    """Archive a room: hide it from the default active list. Reversible and
    metadata-only — the Matrix room, members, and bridge channel are intact."""
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
    )


@router.post("/{room_id}/unarchive")
async def unarchive_room(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomDetail:
    """Unarchive a room: restore it to the active list."""
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
    )


@router.delete("/{room_id}")
async def delete_room(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, bool]:
    await _require_room(session, room_store, room_id, user, "delete")
    try:
        await room_service.delete_room(room_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Room not found")
    return {"ok": True}


@router.post("/bulk-delete")
async def bulk_delete_rooms(
    req: BulkDeleteRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> BulkDeleteResponse:
    principal = Principal(user.id, user.role == "admin")
    deleted = 0
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
        await room_service.delete_room(room_id)
        deleted += 1
    return BulkDeleteResponse(deleted=deleted)


@router.post("/bulk-archive")
async def bulk_archive_rooms(
    req: BulkArchiveRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> BulkArchiveResponse:
    """Archive or unarchive many rooms at once. Each room is authorized
    individually with the same `write` check as the single archive endpoint;
    rooms the caller cannot write (or that no longer exist) are skipped."""
    principal = Principal(user.id, user.role == "admin")
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
        await room_service.set_room_archived(room_id, req.archived)
        updated += 1
    return BulkArchiveResponse(updated=updated)
