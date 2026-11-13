"""Resource events report what really changed, once it is committed.

Against real Postgres: whether a row was there to detach, and whether the
transaction that changed it committed, are what is being tested.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Room, User
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from tests.telemetry_records import RecordingSink, recording_telemetry


def _svc(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[ResourceService, RecordingSink]:
    telemetry, sink = recording_telemetry()
    service = ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
        telemetry=telemetry,
    )
    return service, sink


async def _owner_and_rooms(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str]:
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        owner = User(name="owner", email=f"owner-{suffix}@example.com", role="user")
        rooms = [
            Room(transport_room_id=f"!{n}-{suffix}:test", name=n, description="")
            for n in ("one", "two")
        ]
        session.add_all([owner, *rooms])
        await session.commit()
        return owner.id, rooms[0].id, rooms[1].id


async def _reference(
    service: ResourceService,
    session: AsyncSession,
    owner_id: str,
    created_by_kind: str = "user",
) -> str:
    ref = await service.create_reference(
        session,
        owner_id=owner_id,
        is_admin=False,
        read_visibility="public",
        write_visibility="private",
        type="github",
        name="repo",
        description="",
        instructions="",
        value={"urls": ["https://github.com/example/repo"]},
        created_by_kind=created_by_kind,  # type: ignore[arg-type]
    )
    return ref.id


async def test_a_creation_that_rolls_back_is_never_reported(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, sink = _svc(session_factory)
    owner_id, _, _ = await _owner_and_rooms(session_factory)

    async with session_factory() as session:
        await _reference(service, session, owner_id)
        await session.rollback()
    async with session_factory() as session:
        await _reference(service, session, owner_id, created_by_kind="agent")
        await session.commit()

    assert sink.events("reference_created") == [
        {
            "reference_type": "github",
            "read_visibility": "public",
            "created_by_kind": "agent",
        }
    ]


async def test_detaching_what_was_never_attached_reports_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, sink = _svc(session_factory)
    owner_id, room_id, other_room_id = await _owner_and_rooms(session_factory)
    async with session_factory() as session:
        reference_id = await _reference(service, session, owner_id)
        document = await service.create_document(
            session,
            owner_id=owner_id,
            read_visibility="public",
            write_visibility="private",
            name="doc",
            description="",
            instructions="",
            content="text",
        )
        package = await service.create_package(
            session,
            owner_id=owner_id,
            read_visibility="public",
            write_visibility="private",
            name="kit",
            description="",
            instructions="",
        )
        await session.commit()

    async with session_factory() as session:
        await service.detach_reference_from_room(session, room_id, reference_id)
        await service.detach_document_from_room(session, room_id, document.id)
        await service.detach_package_from_room(session, room_id, package.id)
        assert not await service.detach_linked_room(
            session, source_room_id=room_id, target_room_id=other_room_id
        )
        await session.commit()

    for event in (
        "reference_detached_from_room",
        "document_detached_from_room",
        "package_detached_from_room",
        "room_link_removed",
    ):
        assert sink.events(event) == [], event

    async with session_factory() as session:
        await service.attach_reference_to_room(
            session, room_id, reference_id, user_id=owner_id
        )
        await service.attach_document_to_room(
            session, room_id, document.id, user_id=owner_id
        )
        await service.attach_package_to_room(
            session, room_id, package.id, user_id=owner_id
        )
        await service.attach_linked_room(
            session, source_room_id=room_id, target_room_id=other_room_id, label="l"
        )
        await session.commit()
    async with session_factory() as session:
        await service.detach_reference_from_room(session, room_id, reference_id)
        await service.detach_document_from_room(session, room_id, document.id)
        await service.detach_package_from_room(session, room_id, package.id)
        await service.detach_linked_room(
            session, source_room_id=room_id, target_room_id=other_room_id
        )
        await session.commit()

    assert sink.events("reference_detached_from_room") == [{"reference_type": "github"}]
    assert sink.events("document_detached_from_room") == [{}]
    assert sink.events("package_detached_from_room") == [{}]
    assert sink.events("room_link_removed") == [{}]


async def test_a_package_does_not_say_who_made_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Only a person can make one, so the property said nothing."""
    service, sink = _svc(session_factory)
    owner_id, _, _ = await _owner_and_rooms(session_factory)
    async with session_factory() as session:
        await service.create_package(
            session,
            owner_id=owner_id,
            read_visibility="public",
            write_visibility="private",
            name="kit",
            description="",
            instructions="",
        )
        await session.commit()

    assert sink.events("package_created") == [{}]
