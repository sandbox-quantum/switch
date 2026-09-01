from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.resource.registry import REFERENCE_TYPES
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Reference, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, require_room_access
from switch_core.gateway.dependencies import (
    get_resource_service,
    get_room_store,
    get_session,
    get_user_store,
)
from switch_core.gateway.schemas import (
    ReferenceCreateRequest,
    ReferenceDeleteResponse,
    ReferenceDetail,
    ReferenceTypeInfo,
    ReferenceUpdateRequest,
    ResourceRoom,
)

router = APIRouter()


def _to_detail(
    ref: Reference,
    *,
    owner_name: str | None = None,
    attached_rooms_count: int = 0,
    packages: list[str] | None = None,
) -> ReferenceDetail:
    return ReferenceDetail(
        id=ref.id,
        owner_id=ref.owner_id,
        owner_name=owner_name,
        read_visibility=ref.read_visibility,
        write_visibility=ref.write_visibility,
        type=ref.type,
        name=ref.name,
        description=ref.description,
        instructions=ref.instructions,
        value=ref.value,
        attached_rooms_count=attached_rooms_count,
        packages=packages or [],
        created_at=str(ref.created_at),
    )


async def _enrich(
    session: AsyncSession,
    refs: list[Reference],
    resource_service: ResourceService,
    user_store: UserStore,
) -> list[ReferenceDetail]:
    if not refs:
        return []
    counts = await resource_service.get_reference_attached_counts(
        session, [r.id for r in refs]
    )
    pkg_map = await resource_service.get_packages_for_references(
        session, [r.id for r in refs]
    )
    owner_ids = list({r.owner_id for r in refs})
    owners: dict[str, str] = {}
    for oid in owner_ids:
        u = await user_store.get(session, oid)
        if u is not None:
            owners[oid] = u.name
    return [
        _to_detail(
            r,
            owner_name=owners.get(r.owner_id),
            attached_rooms_count=counts.get(r.id, 0),
            packages=pkg_map.get(r.id, []),
        )
        for r in refs
    ]


async def _enrich_one(
    session: AsyncSession,
    ref: Reference,
    resource_service: ResourceService,
    user_store: UserStore,
) -> ReferenceDetail:
    results = await _enrich(session, [ref], resource_service, user_store)
    return results[0]


@router.get("/references/reference-types")
async def list_reference_types() -> list[ReferenceTypeInfo]:
    return [
        ReferenceTypeInfo(
            type=spec.type,
            display_name=spec.display_name,
            instructions=spec.instructions,
            value_schema=spec.value_json_schema(),
        )
        for spec in REFERENCE_TYPES.values()
    ]


@router.get("/references")
async def list_references(
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[ReferenceDetail]:
    refs = await resource_service.list_references_for_user(session, user.id)
    return await _enrich(session, refs, resource_service, user_store)


@router.post("/references", status_code=201)
async def create_reference(
    req: ReferenceCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReferenceDetail:
    try:
        ref = await resource_service.create_reference(
            session,
            owner_id=user.id,
            is_admin=user.role == "admin",
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
            type=req.type,
            name=req.name,
            description=req.description,
            instructions=req.instructions,
            value=req.value,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await session.commit()
    return await _enrich_one(session, ref, resource_service, user_store)


@router.get("/references/{reference_id}")
async def get_reference(
    reference_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReferenceDetail:
    try:
        ref = await resource_service.get_reference_for_user(
            session, reference_id, user.id, is_admin=user.role == "admin"
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    return await _enrich_one(session, ref, resource_service, user_store)


@router.patch("/references/{reference_id}")
async def patch_reference(
    reference_id: str,
    req: ReferenceUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReferenceDetail:
    try:
        ref = await resource_service.update_reference(
            session,
            reference_id,
            user_id=user.id,
            is_admin=user.role == "admin",
            name=req.name,
            description=req.description,
            instructions=req.instructions,
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
            value=req.value,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    return await _enrich_one(session, ref, resource_service, user_store)


@router.delete("/references/{reference_id}")
async def delete_reference(
    reference_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReferenceDeleteResponse:
    affected_packages = await resource_service.list_packages_for_reference(
        session, reference_id
    )
    try:
        detached = await resource_service.delete_reference(
            session,
            reference_id,
            user_id=user.id,
            is_admin=user.role == "admin",
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    return ReferenceDeleteResponse(
        deleted_id=reference_id,
        detached_room_ids=detached,
        affected_package_ids=affected_packages,
    )


@router.get("/references/{reference_id}/rooms")
async def list_rooms_for_reference(
    reference_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[ResourceRoom]:
    try:
        await resource_service.get_reference_for_user(
            session, reference_id, user.id, is_admin=user.role == "admin"
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    rows = await resource_service.list_rooms_for_reference(session, reference_id)
    return [ResourceRoom(room_id=rid, room_name=name) for rid, name in rows]


@router.get("/rooms/{room_id}/references")
async def list_room_references(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[ReferenceDetail]:
    refs = await resource_service.list_room_references(session, room_id)
    return await _enrich(session, refs, resource_service, user_store)


@router.post("/rooms/{room_id}/references/{reference_id}", status_code=201)
async def attach_reference_to_room(
    room_id: str,
    reference_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReferenceDetail:
    await require_room_access(session, room_store, room_id, user, "write")
    try:
        await resource_service.attach_reference_to_room(
            session,
            room_id,
            reference_id,
            user_id=user.id,
            is_admin=user.role == "admin",
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    ref = await resource_service.get_reference_for_user(
        session, reference_id, user.id, is_admin=user.role == "admin"
    )
    return await _enrich_one(session, ref, resource_service, user_store)


@router.delete("/rooms/{room_id}/references/{reference_id}", status_code=204)
async def detach_reference_from_room(
    room_id: str,
    reference_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    _user: Annotated[User, Depends(get_current_user)],
) -> None:
    await resource_service.detach_reference_from_room(session, room_id, reference_id)
    await session.commit()
