"""Attaching to a room is idempotent, and is reported once.

Attaching what a room already has is a no-op the routes answer as a success,
so asking twice must neither fail nor count as a second attachment.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Room
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from tests.switch_core.bridges.resource.test_reference_types_service import (
    _make_user,
)
from tests.switch_core.bridges.resource.test_visibility_changes import (
    _open_resources,
)
from tests.telemetry_records import recording_telemetry


async def test_attaching_twice_attaches_and_reports_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
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
    async with session_factory() as session:
        owner = await _make_user(session, "owner")
        reference_id, package_id, _slug, document_id = await _open_resources(
            session, owner.id
        )
        room = Room(
            transport_room_id="!attach-twice:test",
            name="attach twice",
            description="",
            owner_id=owner.id,
        )
        session.add(room)
        await session.commit()

        for _ in range(2):
            await service.attach_reference_to_room(
                session, room.id, reference_id, user_id=owner.id
            )
            await service.attach_document_to_room(
                session, room.id, document_id, user_id=owner.id
            )
            await service.attach_package_to_room(
                session, room.id, package_id, user_id=owner.id
            )
        await session.commit()

        assert [r.id for r in await service.list_room_references(session, room.id)] == [
            reference_id
        ]
    assert len(sink.events("reference_attached_to_room")) == 1
    assert len(sink.events("document_attached_to_room")) == 1
    assert len(sink.events("package_attached_to_room")) == 1
