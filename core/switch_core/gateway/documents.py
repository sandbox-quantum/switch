from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import (
    Principal,
    can_delete_room_document,
    can_unlink_from_room,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Document, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    ensure_may_unlink,
    get_current_user,
    get_tenant_is_admin,
    require_room_access,
    takes_part_in_room,
)
from switch_core.gateway.dependencies import (
    get_agent_store,
    get_resource_service,
    get_room_store,
    get_session,
    get_user_store,
)
from switch_core.gateway.resource_rooms import resource_rooms, room_counts
from switch_core.gateway.schemas import (
    DocumentCreateRequest,
    DocumentDeleteResponse,
    DocumentDetail,
    DocumentSummary,
    DocumentUpdateRequest,
    ResourceRoom,
    RoomDocumentDetail,
    RoomDocumentSummary,
)

router = APIRouter()


def _to_detail(
    doc: Document,
    *,
    owner_name: str | None = None,
    attached_rooms_count: int = 0,
    hidden_rooms_count: int,
    packages: list[str] | None = None,
    created_by_agent_name: str | None = None,
) -> DocumentDetail:
    return DocumentDetail(
        id=doc.id,
        owner_id=doc.owner_id,
        owner_name=owner_name,
        read_visibility=doc.read_visibility,
        write_visibility=doc.write_visibility,
        name=doc.name,
        description=doc.description,
        instructions=doc.instructions,
        content=doc.content,
        attached_rooms_count=attached_rooms_count,
        hidden_rooms_count=hidden_rooms_count,
        packages=packages or [],
        scope="room" if doc.room_id is not None else "global",
        room_id=doc.room_id,
        created_by_agent_id=doc.created_by_agent_id,
        created_by_agent_name=created_by_agent_name,
        created_at=str(doc.created_at),
    )


def _to_summary(
    doc: Document,
    *,
    owner_name: str | None = None,
    attached_rooms_count: int = 0,
    hidden_rooms_count: int,
    packages: list[str] | None = None,
    created_by_agent_name: str | None = None,
) -> DocumentSummary:
    return DocumentSummary(
        id=doc.id,
        owner_id=doc.owner_id,
        owner_name=owner_name,
        read_visibility=doc.read_visibility,
        write_visibility=doc.write_visibility,
        name=doc.name,
        description=doc.description,
        instructions=doc.instructions,
        attached_rooms_count=attached_rooms_count,
        hidden_rooms_count=hidden_rooms_count,
        packages=packages or [],
        scope="room" if doc.room_id is not None else "global",
        room_id=doc.room_id,
        created_by_agent_id=doc.created_by_agent_id,
        created_by_agent_name=created_by_agent_name,
        created_at=str(doc.created_at),
    )


def _can_remove(
    principal: Principal, room: Room, doc: Document, *, takes_part: bool
) -> bool:
    """Whether `principal` may remove `doc` from `room`: delete it if it is
    room-scoped, unlink it if it is attached."""
    if doc.room_id is not None:
        return can_delete_room_document(
            principal, room_owner_id=room.owner_id, document_owner_id=doc.owner_id
        )
    return can_unlink_from_room(principal, takes_part=takes_part)


async def _enrich_summaries(
    session: AsyncSession,
    docs: list[Document],
    resource_service: ResourceService,
    user_store: UserStore,
    agent_store: AgentStore,
    reader: Principal,
) -> list[DocumentSummary]:
    if not docs:
        return []
    counts = await room_counts(
        session, docs, reader, resource_service.get_document_attached_counts
    )
    pkg_map = await resource_service.get_packages_for_documents(
        session, [d.id for d in docs]
    )
    owner_ids = {d.owner_id for d in docs if d.owner_id is not None}
    owners: dict[str, str] = {}
    for oid in owner_ids:
        u = await user_store.get(session, oid)
        if u is not None:
            owners[oid] = u.name
    agent_ids = {d.created_by_agent_id for d in docs if d.created_by_agent_id}
    agent_names: dict[str, str] = {}
    for aid in agent_ids:
        a = await agent_store.get(session, aid)
        if a is not None:
            agent_names[aid] = a.name
    return [
        _to_summary(
            d,
            owner_name=owners.get(d.owner_id) if d.owner_id else None,
            attached_rooms_count=counts[d.id].attached,
            hidden_rooms_count=counts[d.id].hidden,
            packages=pkg_map.get(d.id, []),
            created_by_agent_name=(
                agent_names.get(d.created_by_agent_id)
                if d.created_by_agent_id
                else None
            ),
        )
        for d in docs
    ]


async def _enrich_detail(
    session: AsyncSession,
    doc: Document,
    resource_service: ResourceService,
    user_store: UserStore,
    agent_store: AgentStore,
    reader: Principal,
) -> DocumentDetail:
    counts = await room_counts(
        session, [doc], reader, resource_service.get_document_attached_counts
    )
    pkg_map = await resource_service.get_packages_for_documents(session, [doc.id])
    owner = await user_store.get(session, doc.owner_id) if doc.owner_id else None
    agent = (
        await agent_store.get(session, doc.created_by_agent_id)
        if doc.created_by_agent_id
        else None
    )
    return _to_detail(
        doc,
        owner_name=owner.name if owner else None,
        attached_rooms_count=counts[doc.id].attached,
        hidden_rooms_count=counts[doc.id].hidden,
        packages=pkg_map.get(doc.id, []),
        created_by_agent_name=agent.name if agent else None,
    )


@router.get("/documents")
async def list_documents(
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[DocumentSummary]:
    docs = await resource_service.list_documents_for_user(session, user.id)
    return await _enrich_summaries(
        session,
        docs,
        resource_service,
        user_store,
        agent_store,
        Principal(user.id, is_admin),
    )


@router.post("/documents", status_code=201)
async def create_document(
    req: DocumentCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> DocumentDetail:
    try:
        doc = await resource_service.create_document(
            session,
            owner_id=user.id,
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
            name=req.name,
            description=req.description,
            instructions=req.instructions,
            content=req.content,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await session.commit()
    return await _enrich_detail(
        session,
        doc,
        resource_service,
        user_store,
        agent_store,
        Principal(user.id, is_admin),
    )


@router.get("/documents/{document_id}")
async def get_document(
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> DocumentDetail:
    try:
        doc = await resource_service.get_document_for_user(
            session, document_id, user.id, is_admin=is_admin
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    return await _enrich_detail(
        session,
        doc,
        resource_service,
        user_store,
        agent_store,
        Principal(user.id, is_admin),
    )


@router.patch("/documents/{document_id}")
async def patch_document(
    document_id: str,
    req: DocumentUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> DocumentDetail:
    try:
        doc = await resource_service.update_document(
            session,
            document_id,
            user_id=user.id,
            is_admin=is_admin,
            name=req.name,
            description=req.description,
            instructions=req.instructions,
            read_visibility=req.read_visibility,
            write_visibility=req.write_visibility,
            content=req.content,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    return await _enrich_detail(
        session,
        doc,
        resource_service,
        user_store,
        agent_store,
        Principal(user.id, is_admin),
    )


@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> DocumentDeleteResponse:
    affected_packages = await resource_service.list_packages_for_document(
        session, document_id
    )
    try:
        detached = await resource_service.delete_document(
            session,
            document_id,
            user_id=user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    return DocumentDeleteResponse(
        deleted_id=document_id,
        detached_room_ids=detached,
        affected_package_ids=affected_packages,
    )


@router.get("/documents/{document_id}/rooms")
async def list_rooms_for_document(
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[ResourceRoom]:
    try:
        await resource_service.get_document_for_user(
            session, document_id, user.id, is_admin=is_admin
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    rooms = await resource_service.list_rooms_for_document(
        session, document_id, reader_id=user.id, reader_is_admin=is_admin
    )
    return await resource_rooms(
        session, room_store, rooms, Principal(user.id, is_admin)
    )


@router.get("/rooms/{room_id}/documents")
async def list_room_documents(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[RoomDocumentSummary]:
    room = await require_room_access(
        session, room_store, room_id, user, "read", is_admin
    )
    takes_part = await takes_part_in_room(session, room_store, room.id, user.id)
    principal = Principal(user.id, is_admin)
    docs = await resource_service.list_room_documents(session, room_id)
    summaries = await _enrich_summaries(
        session, docs, resource_service, user_store, agent_store, principal
    )
    return [
        RoomDocumentSummary(
            **summary.model_dump(),
            can_remove=_can_remove(principal, room, doc, takes_part=takes_part),
        )
        for summary, doc in zip(summaries, docs, strict=True)
    ]


@router.post("/rooms/{room_id}/documents/{document_id}", status_code=201)
async def attach_document_to_room(
    room_id: str,
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> DocumentDetail:
    await require_room_access(session, room_store, room_id, user, "write", is_admin)
    try:
        await resource_service.attach_document_to_room(
            session,
            room_id,
            document_id,
            user_id=user.id,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    doc = await resource_service.get_document_for_user(
        session, document_id, user.id, is_admin=is_admin
    )
    return await _enrich_detail(
        session,
        doc,
        resource_service,
        user_store,
        agent_store,
        Principal(user.id, is_admin),
    )


@router.delete("/rooms/{room_id}/documents/{document_id}", status_code=204)
async def detach_document_from_room(
    room_id: str,
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> None:
    """For globally-owned docs: unlink from the room, which those taking part
    in it and admins may do. For room-scoped docs: hard-delete them entirely
    (since they live only in this room), which their creator, the room's owner
    and admins may do."""
    room = await require_room_access(
        session, room_store, room_id, user, "read", is_admin
    )
    principal = Principal(user.id, is_admin)
    doc = await resource_service.get_room_scoped_document_or_none(
        session, room_id, document_id
    )
    if doc is not None:
        if not can_delete_room_document(
            principal, room_owner_id=room.owner_id, document_owner_id=doc.owner_id
        ):
            raise HTTPException(
                status_code=403,
                detail="Only the document's creator, the room's owner and admins can delete it",
            )
        await resource_service.delete_room_document_by_user(
            session, room_id=room_id, document_id=document_id
        )
    else:
        await ensure_may_unlink(session, room_store, room, principal)
        await resource_service.detach_document_from_room(session, room_id, document_id)
    await session.commit()


@router.get("/rooms/{room_id}/documents/{document_id}")
async def get_room_document(
    room_id: str,
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomDocumentDetail:
    """Fetch a document by id within the context of a room. Accepts both
    room-scoped documents (read-only) and globally-attached documents. Room
    read access is required and, once granted, implies access to its docs."""
    room = await require_room_access(
        session, room_store, room_id, user, "read", is_admin
    )
    docs = await resource_service.list_room_documents(session, room_id)
    doc = next((d for d in docs if d.id == document_id), None)
    if doc is None:
        raise HTTPException(
            status_code=404, detail=f"Document {document_id} not in room {room_id}"
        )
    principal = Principal(user.id, is_admin)
    detail = await _enrich_detail(
        session, doc, resource_service, user_store, agent_store, principal
    )
    takes_part = await takes_part_in_room(session, room_store, room.id, user.id)
    return RoomDocumentDetail(
        **detail.model_dump(),
        can_remove=_can_remove(principal, room, doc, takes_part=takes_part),
    )
