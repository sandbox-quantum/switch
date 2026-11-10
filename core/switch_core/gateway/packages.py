from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Principal, can, can_manage
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Package, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore, readable_by
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    get_current_user,
    get_tenant_is_admin,
    require_room_access,
    require_room_unlink,
)
from switch_core.gateway.dependencies import (
    get_agent_store,
    get_resource_service,
    get_room_store,
    get_session,
    get_user_store,
)
from switch_core.gateway.documents import _enrich_summaries as enrich_doc_summaries
from switch_core.gateway.references import _enrich as enrich_refs
from switch_core.gateway.resource_rooms import resource_rooms, room_counts
from switch_core.gateway.schemas import (
    DocumentSummary,
    PackageCreateRequest,
    PackageDeleteResponse,
    PackageDetail,
    PackageMemberRemoveResponse,
    PackageUpdateRequest,
    ReferenceDetail,
    ResourceRoom,
)

router = APIRouter()


def _to_detail(
    pkg: Package,
    reader: Principal,
    *,
    owner_name: str | None = None,
    references_count: int = 0,
    documents_count: int = 0,
    attached_rooms_count: int = 0,
    hidden_rooms_count: int,
) -> PackageDetail:
    return PackageDetail(
        id=pkg.id,
        owner_id=pkg.owner_id,
        owner_name=owner_name,
        read_visibility=pkg.read_visibility,
        write_visibility=pkg.write_visibility,
        name=pkg.name,
        description=pkg.description,
        instructions=pkg.instructions,
        references_count=references_count,
        documents_count=documents_count,
        attached_rooms_count=attached_rooms_count,
        hidden_rooms_count=hidden_rooms_count,
        created_at=str(pkg.created_at),
        can_read=can(reader, "read", pkg),
        can_edit=can(reader, "write", pkg),
        can_manage=can_manage(reader, pkg.owner_id),
    )


async def _enrich(
    session: AsyncSession,
    pkgs: list[Package],
    resource_service: ResourceService,
    user_store: UserStore,
    reader: Principal,
) -> list[PackageDetail]:
    if not pkgs:
        return []
    ids = [p.id for p in pkgs]
    rooms = await room_counts(
        session, pkgs, reader, resource_service.get_package_attached_counts
    )
    ref_counts = await resource_service.get_package_reference_counts(session, ids)
    doc_counts = await resource_service.get_package_document_counts(session, ids)
    owner_ids = list({p.owner_id for p in pkgs})
    owners: dict[str, str] = {}
    for oid in owner_ids:
        u = await user_store.get(session, oid)
        if u is not None:
            owners[oid] = u.name
    return [
        _to_detail(
            p,
            reader,
            owner_name=owners.get(p.owner_id),
            references_count=ref_counts.get(p.id, 0),
            documents_count=doc_counts.get(p.id, 0),
            attached_rooms_count=rooms[p.id].attached,
            hidden_rooms_count=rooms[p.id].hidden,
        )
        for p in pkgs
    ]


async def _enrich_one(
    session: AsyncSession,
    pkg: Package,
    resource_service: ResourceService,
    user_store: UserStore,
    reader: Principal,
) -> PackageDetail:
    results = await _enrich(session, [pkg], resource_service, user_store, reader)
    return results[0]


@router.get("/packages")
async def list_packages(
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[PackageDetail]:
    pkgs = await resource_service.list_packages_for_user(session, user.id)
    return await _enrich(
        session, pkgs, resource_service, user_store, Principal(user.id, is_admin)
    )


@router.post("/packages", status_code=201)
async def create_package(
    req: PackageCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> PackageDetail:
    try:
        pkg = await resource_service.create_package(
            session,
            owner_id=user.id,
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
            name=req.name,
            description=req.description,
            instructions=req.instructions,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await session.commit()
    return await _enrich_one(
        session, pkg, resource_service, user_store, Principal(user.id, is_admin)
    )


@router.get("/packages/{package_id}")
async def get_package(
    package_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> PackageDetail:
    try:
        pkg = await resource_service.get_package_for_user(
            session,
            package_id,
            user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    return await _enrich_one(
        session, pkg, resource_service, user_store, Principal(user.id, is_admin)
    )


@router.patch("/packages/{package_id}")
async def patch_package(
    package_id: str,
    req: PackageUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> PackageDetail:
    try:
        pkg = await resource_service.update_package(
            session,
            package_id,
            user_id=user.id,
            is_admin=is_admin,
            name=req.name,
            description=req.description,
            instructions=req.instructions,
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    return await _enrich_one(
        session, pkg, resource_service, user_store, Principal(user.id, is_admin)
    )


@router.delete("/packages/{package_id}")
async def delete_package(
    package_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> PackageDeleteResponse:
    try:
        detached = await resource_service.delete_package(
            session,
            package_id,
            user_id=user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    return PackageDeleteResponse(deleted_id=package_id, detached_room_ids=detached)


@router.get("/packages/{package_id}/rooms")
async def list_rooms_for_package(
    package_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[ResourceRoom]:
    try:
        await resource_service.get_package_for_user(
            session,
            package_id,
            user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    rooms = await resource_service.list_rooms_for_package(
        session, package_id, reader_id=user.id, reader_is_admin=is_admin
    )
    return await resource_rooms(
        session, room_store, rooms, Principal(user.id, is_admin)
    )


# ── Membership ────────────────────────────────────────────────────────────


@router.get("/packages/{package_id}/references")
async def list_package_references(
    package_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[ReferenceDetail]:
    try:
        await resource_service.get_package_for_user(
            session,
            package_id,
            user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    refs = await resource_service.list_package_references(session, package_id)
    return await enrich_refs(
        session, refs, resource_service, user_store, Principal(user.id, is_admin)
    )


@router.post("/packages/{package_id}/references/{reference_id}", status_code=201)
async def add_reference_to_package(
    package_id: str,
    reference_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> None:
    try:
        await resource_service.add_reference_to_package(
            session,
            package_id,
            reference_id,
            user_id=user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()


@router.delete("/packages/{package_id}/references/{reference_id}")
async def remove_reference_from_package(
    package_id: str,
    reference_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> PackageMemberRemoveResponse:
    try:
        affected = await resource_service.remove_reference_from_package(
            session,
            package_id,
            reference_id,
            user_id=user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    return await _member_removed(
        session, room_store, package_id, reference_id, affected, user, is_admin
    )


@router.get("/packages/{package_id}/documents")
async def list_package_documents(
    package_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[DocumentSummary]:
    try:
        await resource_service.get_package_for_user(
            session,
            package_id,
            user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    docs = await resource_service.list_package_documents(session, package_id)
    return await enrich_doc_summaries(
        session,
        docs,
        resource_service,
        user_store,
        agent_store,
        Principal(user.id, is_admin),
    )


@router.post("/packages/{package_id}/documents/{document_id}", status_code=201)
async def add_document_to_package(
    package_id: str,
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> None:
    try:
        await resource_service.add_document_to_package(
            session,
            package_id,
            document_id,
            user_id=user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()


@router.delete("/packages/{package_id}/documents/{document_id}")
async def remove_document_from_package(
    package_id: str,
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> PackageMemberRemoveResponse:
    try:
        affected = await resource_service.remove_document_from_package(
            session,
            package_id,
            document_id,
            user_id=user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    return await _member_removed(
        session, room_store, package_id, document_id, affected, user, is_admin
    )


# ── Room attachment ────────────────────────────────────────────────────────


@router.get("/rooms/{room_id}/packages")
async def list_room_packages(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[PackageDetail]:
    await require_room_access(session, room_store, room_id, user, "read", is_admin)
    pkgs = await resource_service.list_room_packages(session, room_id)
    return await _enrich(
        session, pkgs, resource_service, user_store, Principal(user.id, is_admin)
    )


@router.post("/rooms/{room_id}/packages/{package_id}", status_code=201)
async def attach_package_to_room(
    room_id: str,
    package_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> PackageDetail:
    await require_room_access(session, room_store, room_id, user, "write", is_admin)
    try:
        await resource_service.attach_package_to_room(
            session,
            room_id,
            package_id,
            user_id=user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    pkg = await resource_service.get_package_for_user(
        session,
        package_id,
        user.id,
        is_admin=is_admin,
    )
    return await _enrich_one(
        session, pkg, resource_service, user_store, Principal(user.id, is_admin)
    )


@router.delete("/rooms/{room_id}/packages/{package_id}", status_code=204)
async def detach_package_from_room(
    room_id: str,
    package_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> None:
    await require_room_unlink(session, room_store, room_id, user, is_admin)
    await resource_service.detach_package_from_room(session, room_id, package_id)
    await session.commit()


async def _member_removed(
    session: AsyncSession,
    room_store: RoomStore,
    package_id: str,
    member_id: str,
    affected: list[tuple[str, str]],
    user: User,
    is_admin: bool,
) -> PackageMemberRemoveResponse:
    """Name the affected rooms the caller may read, and count the rest."""
    readable = await room_store.visible_room_ids(
        session,
        [rid for rid, _ in affected],
        readable_by(user.id, is_admin=is_admin),
    )
    shown = [(rid, name) for rid, name in affected if rid in readable]
    return PackageMemberRemoveResponse(
        package_id=package_id,
        member_id=member_id,
        affected_room_ids=[rid for rid, _ in shown],
        affected_room_names=[name for _, name in shown],
        hidden_affected_rooms_count=len(affected) - len(shown),
    )
