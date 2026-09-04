from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Document, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, require_room_access
from switch_core.gateway.dependencies import (
    get_agent_store,
    get_resource_service,
    get_room_store,
    get_session,
    get_user_store,
)
from switch_core.gateway.schemas import (
    DocumentCreateRequest,
    DocumentDeleteResponse,
    DocumentDetail,
    DocumentSummary,
    DocumentUpdateRequest,
    ResourceRoom,
)

router = APIRouter()


def _to_detail(
    doc: Document,
    *,
    owner_name: str | None = None,
    attached_rooms_count: int = 0,
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
        packages=packages or [],
        scope="room" if doc.room_id is not None else "global",
        room_id=doc.room_id,
        created_by_agent_id=doc.created_by_agent_id,
        created_by_agent_name=created_by_agent_name,
        created_at=str(doc.created_at),
    )


async def _enrich_summaries(
    session: AsyncSession,
    docs: list[Document],
    resource_service: ResourceService,
    user_store: UserStore,
    agent_store: AgentStore,
) -> list[DocumentSummary]:
    if not docs:
        return []
    counts = await resource_service.get_document_attached_counts(
        session, [d.id for d in docs]
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
            attached_rooms_count=counts.get(d.id, 0),
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
) -> DocumentDetail:
    counts = await resource_service.get_document_attached_counts(session, [doc.id])
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
        attached_rooms_count=counts.get(doc.id, 0),
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
) -> list[DocumentSummary]:
    docs = await resource_service.list_documents_for_user(session, user.id)
    return await _enrich_summaries(
        session, docs, resource_service, user_store, agent_store
    )


@router.post("/documents", status_code=201)
async def create_document(
    req: DocumentCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
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
    return await _enrich_detail(session, doc, resource_service, user_store, agent_store)


@router.get("/documents/{document_id}")
async def get_document(
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> DocumentDetail:
    try:
        doc = await resource_service.get_document_for_user(
            session, document_id, user.id, is_admin=user.role == "admin"
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    return await _enrich_detail(session, doc, resource_service, user_store, agent_store)


@router.patch("/documents/{document_id}")
async def patch_document(
    document_id: str,
    req: DocumentUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> DocumentDetail:
    try:
        doc = await resource_service.update_document(
            session,
            document_id,
            user_id=user.id,
            is_admin=user.role == "admin",
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
    return await _enrich_detail(session, doc, resource_service, user_store, agent_store)


@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user: Annotated[User, Depends(get_current_user)],
) -> DocumentDeleteResponse:
    affected_packages = await resource_service.list_packages_for_document(
        session, document_id
    )
    try:
        detached = await resource_service.delete_document(
            session,
            document_id,
            user_id=user.id,
            is_admin=user.role == "admin",
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
    user: Annotated[User, Depends(get_current_user)],
) -> list[ResourceRoom]:
    try:
        await resource_service.get_document_for_user(
            session, document_id, user.id, is_admin=user.role == "admin"
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    rows = await resource_service.list_rooms_for_document(session, document_id)
    return [ResourceRoom(room_id=rid, room_name=name) for rid, name in rows]


@router.get("/rooms/{room_id}/documents")
async def list_room_documents(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[DocumentSummary]:
    await require_room_access(session, room_store, room_id, user, "read")
    docs = await resource_service.list_room_documents(session, room_id)
    return await _enrich_summaries(
        session, docs, resource_service, user_store, agent_store
    )


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
) -> DocumentDetail:
    await require_room_access(session, room_store, room_id, user, "write")
    try:
        await resource_service.attach_document_to_room(
            session,
            room_id,
            document_id,
            user_id=user.id,
            is_admin=user.role == "admin",
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await session.commit()
    doc = await resource_service.get_document_for_user(
        session, document_id, user.id, is_admin=user.role == "admin"
    )
    return await _enrich_detail(session, doc, resource_service, user_store, agent_store)


@router.delete("/rooms/{room_id}/documents/{document_id}", status_code=204)
async def detach_document_from_room(
    room_id: str,
    document_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> None:
    """For globally-owned docs: detach from the room. For room-scoped docs:
    hard-delete them entirely (since they live only in this room)."""
    await require_room_access(session, room_store, room_id, user, "write")
    doc = await resource_service.get_room_scoped_document_or_none(
        session, room_id, document_id
    )
    if doc is not None:
        await resource_service.delete_room_document_by_user(
            session, room_id=room_id, document_id=document_id
        )
    else:
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
) -> DocumentDetail:
    """Fetch a document by id within the context of a room. Accepts both
    room-scoped documents (read-only) and globally-attached documents. Room
    read access is required and, once granted, implies access to its docs."""
    await require_room_access(session, room_store, room_id, user, "read")
    docs = await resource_service.list_room_documents(session, room_id)
    doc = next((d for d in docs if d.id == document_id), None)
    if doc is None:
        raise HTTPException(
            status_code=404, detail=f"Document {document_id} not in room {room_id}"
        )
    return await _enrich_detail(session, doc, resource_service, user_store, agent_store)
