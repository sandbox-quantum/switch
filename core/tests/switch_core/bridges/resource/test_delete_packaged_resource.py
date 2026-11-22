"""A reference or document that sits in a package can still be deleted.

Package membership has no cascade on the member's side, so deleting a
packaged reference or document used to fail with a foreign key violation
(a 500 from the gateway). Deleting now takes it out of its packages too,
and the package lives on without it.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import User
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore


def _svc(session_factory: async_sessionmaker[AsyncSession]) -> ResourceService:
    return ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )


async def _owner(session: AsyncSession) -> User:
    user = User(name="owner", email="owner@example.com", role="user")
    session.add(user)
    await session.flush()
    return user


async def test_a_packaged_reference_is_deleted_and_leaves_its_package(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        owner = await _owner(session)
        ref = await svc.create_reference(
            session,
            created_by_kind="user",
            owner_id=owner.id,
            is_admin=False,
            read_visibility="public",
            write_visibility="private",
            type="github",
            name="repo",
            description="",
            instructions="",
            value={"urls": ["https://github.com/example/repo"]},
        )
        pkg = await svc.create_package(
            session,
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="private",
            name="kit",
            description="",
            instructions="",
        )
        await svc.add_reference_to_package(
            session, pkg.id, ref.id, user_id=owner.id, is_admin=False
        )
        await session.commit()

        assert await svc.list_packages_for_reference(session, ref.id) == [pkg.id]
        await svc.delete_reference(session, ref.id, user_id=owner.id, is_admin=False)
        await session.commit()

        assert await svc.list_package_references(session, pkg.id) == []
        assert await svc.get_package_for_user(session, pkg.id, owner.id, is_admin=False)


async def test_a_packaged_document_is_deleted_and_leaves_its_package(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        owner = await _owner(session)
        doc = await svc.create_document(
            session,
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="private",
            name="guide",
            description="",
            instructions="",
            content="# Guide",
        )
        pkg = await svc.create_package(
            session,
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="private",
            name="kit",
            description="",
            instructions="",
        )
        await svc.add_document_to_package(
            session, pkg.id, doc.id, user_id=owner.id, is_admin=False
        )
        await session.commit()

        await svc.delete_document(session, doc.id, user_id=owner.id, is_admin=False)
        await session.commit()

        assert await svc.list_package_documents(session, pkg.id) == []
