from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import User
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user, require_room_access
from switch_core.gateway.dependencies import (
    get_resource_service,
    get_room_store,
    get_session,
)
from switch_core.gateway.schemas import (
    InboundLinkedRoomDetail,
    LinkedRoomCreateRequest,
    LinkedRoomDetail,
    RoomGraphResponse,
)

router = APIRouter()


@router.get("/linked-rooms/graph")
async def get_room_link_graph(
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    _user: Annotated[User, Depends(get_current_user)],
) -> RoomGraphResponse:
    payload = await resource_service.get_room_link_graph(session)
    return RoomGraphResponse(**payload)


@router.get("/rooms/{room_id}/linked-rooms")
async def list_linked_rooms(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[LinkedRoomDetail]:
    await require_room_access(session, room_store, room_id, user, "read")
    rows = await resource_service.list_linked_rooms_for_room(session, room_id)
    return [LinkedRoomDetail(**row) for row in rows]


@router.get("/rooms/{room_id}/linked-rooms/inbound")
async def list_inbound_linked_rooms(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[InboundLinkedRoomDetail]:
    await require_room_access(session, room_store, room_id, user, "read")
    rows = await resource_service.list_inbound_linked_rooms(session, room_id)
    return [InboundLinkedRoomDetail(**row) for row in rows]


@router.post("/rooms/{room_id}/linked-rooms", status_code=201)
async def create_linked_room(
    room_id: str,
    req: LinkedRoomCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> LinkedRoomDetail:
    await require_room_access(session, room_store, room_id, user, "write")
    try:
        row = await resource_service.attach_linked_room(
            session,
            source_room_id=room_id,
            target_room_id=req.target_room_id,
            label=req.label,
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await session.commit()
    return LinkedRoomDetail(**row)


@router.delete("/rooms/{room_id}/linked-rooms/{target_room_id}", status_code=204)
async def delete_linked_room(
    room_id: str,
    target_room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> Response:
    await require_room_access(session, room_store, room_id, user, "write")
    removed = await resource_service.detach_linked_room(
        session, source_room_id=room_id, target_room_id=target_room_id
    )
    if not removed:
        raise HTTPException(
            status_code=404,
            detail=f"No link from {room_id} to {target_room_id}",
        )
    await session.commit()
    return Response(status_code=204)
