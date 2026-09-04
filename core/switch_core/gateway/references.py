from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.resource.registry import ReferenceValue, is_builtin_type
from switch_core.bridges.resource.service import (
    ReferenceTypeInUseError,
    ReferenceTypeRow,
    ReferenceTypeView,
    ResourceService,
)
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
    ReferenceTypeCreateRequest,
    ReferenceTypeDeleteResponse,
    ReferenceTypeDetail,
    ReferenceTypeInfo,
    ReferenceTypeUpdateRequest,
    ReferenceUpdateRequest,
    ResourceRoom,
)

router = APIRouter()


def _to_detail(
    ref: Reference,
    *,
    owner_name: str | None = None,
    type_display_name: str | None = None,
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
        type_display_name=type_display_name,
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
    owner_ids = {r.owner_id for r in refs if r.owner_id is not None}
    owners: dict[str, str] = {}
    for oid in owner_ids:
        u = await user_store.get(session, oid)
        if u is not None:
            owners[oid] = u.name
    type_names = await resource_service.resolve_display_names(
        session, {r.type for r in refs}
    )
    return [
        _to_detail(
            r,
            owner_name=owners.get(r.owner_id),
            type_display_name=type_names.get(r.type),
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


async def _owner_names(
    session: AsyncSession, user_store: UserStore, owner_ids: set[str]
) -> dict[str, str]:
    names: dict[str, str] = {}
    for oid in owner_ids:
        u = await user_store.get(session, oid)
        if u is not None:
            names[oid] = u.name
    return names


def _type_to_info(view: ReferenceTypeView, owner_name: str | None) -> ReferenceTypeInfo:
    return ReferenceTypeInfo(
        type=view.spec.type,
        display_name=view.spec.display_name,
        instructions=view.spec.instructions,
        value_schema=view.spec.value_json_schema(),
        value_hint=view.spec.value_hint,
        is_builtin=view.is_builtin,
        owner_id=view.owner_id,
        owner_name=owner_name,
    )


def _type_to_detail(
    entry: ReferenceTypeRow, owner_name: str | None
) -> ReferenceTypeDetail:
    row = entry.row
    return ReferenceTypeDetail(
        type=row.type,
        display_name=row.display_name,
        instructions=row.instructions,
        value_schema=ReferenceValue.model_json_schema(),
        value_hint=row.value_hint,
        is_builtin=False,
        owner_id=row.owner_id,
        owner_name=owner_name,
        read_visibility=row.read_visibility,
        write_visibility=row.write_visibility,
        shadowed_by_builtin=entry.shadowed_by_builtin,
        created_at=str(row.created_at),
    )


# The five /references/reference-types routes are declared above
# /references/{reference_id}: FastAPI matches in declaration order, so a
# greedy sibling declared first would swallow every one of them. For the same
# reason /reference-types/owned precedes /reference-types/{type}.


@router.get("/references/reference-types")
async def list_reference_types(
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[ReferenceTypeInfo]:
    views = await resource_service.list_reference_types_for_principal(
        session, user_id=user.id, is_admin=user.role == "admin"
    )
    owners = await _owner_names(
        session, user_store, {v.owner_id for v in views if v.owner_id is not None}
    )
    return [
        _type_to_info(v, owners.get(v.owner_id) if v.owner_id is not None else None)
        for v in views
    ]


@router.get("/references/reference-types/owned")
async def list_owned_reference_types(
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[ReferenceTypeDetail]:
    rows = await resource_service.list_owned_reference_types(
        session, user_id=user.id, is_admin=user.role == "admin"
    )
    owners = await _owner_names(session, user_store, {e.row.owner_id for e in rows})
    return [_type_to_detail(e, owners.get(e.row.owner_id)) for e in rows]


@router.post("/references/reference-types", status_code=201)
async def create_reference_type(
    req: ReferenceTypeCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReferenceTypeDetail:
    try:
        row = await resource_service.create_reference_type(
            session,
            owner_id=user.id,
            type=req.type,
            display_name=req.display_name,
            instructions=req.instructions,
            value_hint=req.value_hint,
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await session.commit()
    owners = await _owner_names(session, user_store, {row.owner_id})
    return _type_to_detail(
        ReferenceTypeRow(row=row, shadowed_by_builtin=False),
        owners.get(row.owner_id),
    )


@router.patch("/references/reference-types/{type}")
async def patch_reference_type(
    type: str,
    req: ReferenceTypeUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReferenceTypeDetail:
    try:
        row = await resource_service.update_reference_type(
            session,
            type,
            user_id=user.id,
            is_admin=user.role == "admin",
            display_name=req.display_name,
            instructions=req.instructions,
            value_hint=req.value_hint,
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    owners = await _owner_names(session, user_store, {row.owner_id})
    return _type_to_detail(
        ReferenceTypeRow(row=row, shadowed_by_builtin=is_builtin_type(row.type)),
        owners.get(row.owner_id),
    )


@router.delete("/references/reference-types/{type}")
async def delete_reference_type(
    type: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReferenceTypeDeleteResponse:
    try:
        await resource_service.delete_reference_type(
            session, type, user_id=user.id, is_admin=user.role == "admin"
        )
    except ReferenceTypeInUseError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    return ReferenceTypeDeleteResponse(deleted_type=type)


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
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[ReferenceDetail]:
    await require_room_access(session, room_store, room_id, user, "read")
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
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> None:
    await require_room_access(session, room_store, room_id, user, "write")
    await resource_service.detach_reference_from_room(session, room_id, reference_id)
    await session.commit()
