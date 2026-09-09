from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Principal, require
from switch_core.db.models import RoomGroup, User
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_room_group_store,
    get_room_store,
    get_room_yaml_service,
    get_session,
)
from switch_core.gateway.schemas import (
    RoomGroupAssignRequest,
    RoomGroupAssignResponse,
    RoomGroupCreateRequest,
    RoomGroupDetail,
    RoomGroupUpdateRequest,
)
from switch_core.rooms_yaml import RoomYamlService

router = APIRouter()


def _to_detail(group: RoomGroup, room_count: int) -> RoomGroupDetail:
    return RoomGroupDetail(
        id=group.id,
        name=group.name,
        description=group.description,
        color=group.color,
        parent_group_id=group.parent_group_id,
        room_count=room_count,
        created_at=str(group.created_at),
    )


@router.get("")
async def list_room_groups(
    session: Annotated[AsyncSession, Depends(get_session)],
    room_group_store: Annotated[RoomGroupStore, Depends(get_room_group_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[RoomGroupDetail]:
    groups = await room_group_store.get_all(session)
    counts = await room_group_store.get_room_counts(session)
    return [_to_detail(g, counts.get(g.id, 0)) for g in groups]


@router.post("", status_code=201)
async def create_room_group(
    req: RoomGroupCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_group_store: Annotated[RoomGroupStore, Depends(get_room_group_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> RoomGroupDetail:
    try:
        group = await room_group_store.create(
            session,
            name=req.name,
            description=req.description,
            color=req.color,
            parent_group_id=req.parent_group_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await session.commit()
    return _to_detail(group, 0)


@router.patch("/{group_id}")
async def patch_room_group(
    group_id: str,
    req: RoomGroupUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_group_store: Annotated[RoomGroupStore, Depends(get_room_group_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> RoomGroupDetail:
    # Only reparent when the client actually sent `parent_group_id` (so we can
    # tell "make top-level" (null) apart from "leave the parent alone" (absent)).
    reparent = "parent_group_id" in req.model_fields_set
    try:
        group = await room_group_store.update_fields(
            session,
            group_id,
            name=req.name,
            description=req.description,
            color=req.color,
            parent_group_id=req.parent_group_id,
            reparent=reparent,
        )
    except ValueError as e:
        # "not found" → 404; cycle/validation → 400.
        if "not found" in str(e).lower():
            raise HTTPException(status_code=404, detail=str(e)) from e
        raise HTTPException(status_code=400, detail=str(e)) from e
    await session.commit()
    counts = await room_group_store.get_room_counts(session)
    return _to_detail(group, counts.get(group.id, 0))


@router.put("/{group_id}/rooms")
async def assign_rooms_to_group(
    group_id: str,
    req: RoomGroupAssignRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_group_store: Annotated[RoomGroupStore, Depends(get_room_group_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> RoomGroupAssignResponse:
    """Bulk-assign rooms into a group. Requires write access to each room;
    unknown room ids are skipped."""
    if await room_group_store.get(session, group_id) is None:
        raise HTTPException(status_code=404, detail="Room group not found")

    principal = Principal(user.id, user.role == "admin")
    forbidden: list[str] = []
    allowed: list[str] = []
    for room_id in req.room_ids:
        room = await room_store.get(session, room_id)
        if room is None:
            continue  # skip unknown ids rather than failing the whole batch
        try:
            require(principal, "write", room)
        except PermissionError:
            forbidden.append(room_id)
            continue
        allowed.append(room_id)

    if forbidden:
        raise HTTPException(
            status_code=403,
            detail=f"No write access to rooms: {', '.join(forbidden)}",
        )

    assigned = await room_store.set_group_bulk(session, allowed, group_id)
    await session.commit()
    return RoomGroupAssignResponse(assigned=assigned)


@router.get("/{group_id}/yaml")
async def export_group_yaml(
    group_id: str,
    rooms_yaml: Annotated[RoomYamlService, Depends(get_room_yaml_service)],
    _user: Annotated[User, Depends(get_current_user)],
) -> Response:
    """Export all rooms in a group to YAML in the group document shape
    (``group:`` + ``rooms:`` + ``links:``)."""
    try:
        yaml_text = await rooms_yaml.export_group(group_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return Response(content=yaml_text, media_type="application/x-yaml")


@router.delete("/{group_id}", status_code=204)
async def delete_room_group(
    group_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_group_store: Annotated[RoomGroupStore, Depends(get_room_group_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> Response:
    removed = await room_group_store.delete(session, group_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Room group not found")
    await session.commit()
    return Response(status_code=204)
