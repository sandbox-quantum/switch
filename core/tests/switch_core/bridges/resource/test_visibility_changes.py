"""Changing a reference's, reference type's, package's or library document's
visibility is its owner's or a workspace admin's; editing anything else needs only write access.

Through `ResourceService`, which both the gateway routes and the agent
operations call, against a real database.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Document, Package, Reference, ReferenceType
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from tests.switch_core.bridges.resource.test_reference_types_service import (
    _make_user,
)


@pytest.fixture
def service(session_factory: async_sessionmaker[AsyncSession]) -> ResourceService:
    return ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )


OPEN = {"read_visibility": "public", "write_visibility": "public"}


async def _open_resources(
    session: AsyncSession, owner_id: str
) -> tuple[str, str, str, str]:
    reference = Reference(
        owner_id=owner_id,
        type="url",
        name="docs",
        description="",
        instructions="",
        value={"url": "https://example.test"},
        **OPEN,
    )
    package = Package(
        owner_id=owner_id, name="kit", description="", instructions="", **OPEN
    )
    reference_type = ReferenceType(
        type="ticket",
        owner_id=owner_id,
        display_name="Ticket",
        instructions="",
        value_hint="",
        **OPEN,
    )
    document = Document(
        owner_id=owner_id,
        room_id=None,
        name="notes",
        description="",
        instructions="",
        content="",
        **OPEN,
    )
    session.add_all([reference, package, reference_type, document])
    await session.flush()
    return reference.id, package.id, reference_type.type, document.id


async def test_a_writer_edits_the_description_but_not_the_visibility(
    session_factory: async_sessionmaker[AsyncSession], service: ResourceService
) -> None:
    async with session_factory() as session:
        owner = await _make_user(session, "owner")
        writer = await _make_user(session, "writer")
        reference_id, package_id, slug, document_id = await _open_resources(
            session, owner.id
        )
        await session.commit()

        await service.update_reference(
            session, reference_id, user_id=writer.id, is_admin=False, description="x"
        )
        await service.update_package(
            session, package_id, user_id=writer.id, is_admin=False, description="x"
        )
        await service.update_reference_type(
            session, slug, user_id=writer.id, is_admin=False, instructions="x"
        )
        await service.update_document(
            session, document_id, user_id=writer.id, is_admin=False, content="x"
        )
        with pytest.raises(PermissionError, match="reference's owner"):
            await service.update_reference(
                session,
                reference_id,
                user_id=writer.id,
                is_admin=False,
                read_visibility="private",
                write_visibility="private",
            )
        with pytest.raises(PermissionError, match="package's owner"):
            await service.update_package(
                session,
                package_id,
                user_id=writer.id,
                is_admin=False,
                write_visibility="private",
            )
        with pytest.raises(PermissionError, match="reference type's owner"):
            await service.update_reference_type(
                session,
                slug,
                user_id=writer.id,
                is_admin=False,
                write_visibility="private",
            )
        with pytest.raises(PermissionError, match="document's owner"):
            await service.update_document(
                session,
                document_id,
                user_id=writer.id,
                is_admin=False,
                read_visibility="private",
            )


@pytest.mark.parametrize("as_admin", [False, True])
async def test_the_owner_and_an_admin_change_the_visibility(
    session_factory: async_sessionmaker[AsyncSession],
    service: ResourceService,
    as_admin: bool,
) -> None:
    async with session_factory() as session:
        owner = await _make_user(session, "owner")
        admin = await _make_user(session, "admin")
        reference_id, package_id, slug, document_id = await _open_resources(
            session, owner.id
        )
        await session.commit()
        actor = admin.id if as_admin else owner.id
        private = {"read_visibility": "private", "write_visibility": "private"}

        reference = await service.update_reference(
            session, reference_id, user_id=actor, is_admin=as_admin, **private
        )
        package = await service.update_package(
            session, package_id, user_id=actor, is_admin=as_admin, **private
        )
        reference_type = await service.update_reference_type(
            session, slug, user_id=actor, is_admin=as_admin, **private
        )
        document = await service.update_document(
            session, document_id, user_id=actor, is_admin=as_admin, **private
        )
    for row in (reference, package, reference_type, document):
        assert (row.read_visibility, row.write_visibility) == ("private", "private")


async def test_a_writer_racing_the_owner_is_checked_against_the_committed_row(
    session_factory: async_sessionmaker[AsyncSession], service: ResourceService
) -> None:
    """The owner makes everything private while a writer, who read it public,
    sends an edit with the visibility it saw. The writer waits for the owner's
    commit and is then refused, rather than passing a check made on the row as
    it was before."""
    async with session_factory() as session:
        owner = await _make_user(session, "owner")
        writer = await _make_user(session, "writer")
        reference_id, package_id, slug, document_id = await _open_resources(
            session, owner.id
        )
        await session.commit()
    private = {"read_visibility": "private", "write_visibility": "private"}
    updates = {
        "reference": (service.update_reference, reference_id, {"description": "x"}),
        "package": (service.update_package, package_id, {"description": "x"}),
        "reference type": (service.update_reference_type, slug, {"instructions": "x"}),
        "document": (service.update_document, document_id, {"instructions": "x"}),
    }

    for label, (update, key, edit) in updates.items():
        async with (
            session_factory() as owner_session,
            session_factory() as writer_session,
        ):
            await update(
                owner_session, key, user_id=owner.id, is_admin=False, **private
            )
            writer_edit = asyncio.create_task(
                update(
                    writer_session,
                    key,
                    user_id=writer.id,
                    is_admin=False,
                    **OPEN,
                    **edit,
                )
            )
            await asyncio.sleep(0.2)
            assert not writer_edit.done(), f"the {label} was not locked"
            await owner_session.commit()
            with pytest.raises(PermissionError):
                await writer_edit
            await writer_session.rollback()

    async with session_factory() as session:
        rows = [
            await ReferenceStore().get(session, reference_id),
            await PackageStore().get(session, package_id),
            await ReferenceTypeStore().get(session, slug),
            await DocumentStore().get(session, document_id),
        ]
    for row in rows:
        assert row is not None
        assert (row.read_visibility, row.write_visibility) == ("private", "private")
        assert "x" not in (getattr(row, "description", ""), row.instructions)
