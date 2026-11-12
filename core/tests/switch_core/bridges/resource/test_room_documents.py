"""Who among a room's agents may change or delete a room-scoped document.

An agent's own document is its alone to change. One a room template's
`docs:` created belongs to the room, and any agent in it may maintain it; that
the agent is in the room is checked by the caller before the service is asked.
A document whose writer was deleted has no author either, and stays locked.
"""

from __future__ import annotations

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Agent, ApiKey, Client, Document, Room
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


async def _make_agent(session: AsyncSession, name: str, owner_id: str) -> Agent:
    api_key = ApiKey(
        user_id=owner_id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        transport_user_id=f"@{name}:test.local", display_name=name, type="agent"
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description="",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner_id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _room(session: AsyncSession, owner_id: str) -> Room:
    room = Room(
        transport_room_id="!room-docs:test",
        name="room docs",
        description="",
        owner_id=owner_id,
    )
    session.add(room)
    await session.flush()
    return room


async def test_any_agent_maintains_a_document_the_template_created(
    session_factory: async_sessionmaker[AsyncSession], service: ResourceService
) -> None:
    async with session_factory() as session:
        owner = await _make_user(session, "owner")
        agent = await _make_agent(session, "maintainer", owner.id)
        room = await _room(session, owner.id)
        doc = await service.create_template_room_document(
            session,
            room_id=room.id,
            owner_id=owner.id,
            name="plan",
            description="the plan",
            instructions="",
            content="v1",
        )
        await session.commit()

        updated = await service.update_room_document(
            session,
            room_id=room.id,
            agent_id=agent.id,
            document_id=doc.id,
            content="v2",
        )
        await session.commit()
        assert updated.content == "v2"

        await service.delete_room_document(
            session, room_id=room.id, agent_id=agent.id, document_id=doc.id
        )
        await session.commit()
        assert await DocumentStore().get_room_scoped(session, room.id, doc.id) is None


async def test_only_the_creating_agent_changes_an_agents_document(
    session_factory: async_sessionmaker[AsyncSession], service: ResourceService
) -> None:
    async with session_factory() as session:
        owner = await _make_user(session, "owner")
        author = await _make_agent(session, "author", owner.id)
        other = await _make_agent(session, "other", owner.id)
        room = await _room(session, owner.id)
        doc = await service.create_room_document(
            session,
            room_id=room.id,
            agent_id=author.id,
            owner_id=owner.id,
            name="notes",
            description="",
            instructions="",
            content="v1",
        )
        await session.commit()

        with pytest.raises(PermissionError, match="only its creating agent"):
            await service.update_room_document(
                session,
                room_id=room.id,
                agent_id=other.id,
                document_id=doc.id,
                content="v2",
            )
        with pytest.raises(PermissionError, match="only its creating agent"):
            await service.delete_room_document(
                session, room_id=room.id, agent_id=other.id, document_id=doc.id
            )

        updated = await service.update_room_document(
            session,
            room_id=room.id,
            agent_id=author.id,
            document_id=doc.id,
            content="v2",
        )
        assert updated.content == "v2"


async def test_a_document_whose_writer_is_gone_stays_locked(
    session_factory: async_sessionmaker[AsyncSession], service: ResourceService
) -> None:
    async with session_factory() as session:
        owner = await _make_user(session, "owner")
        author = await _make_agent(session, "author", owner.id)
        other = await _make_agent(session, "other", owner.id)
        room = await _room(session, owner.id)
        doc = await service.create_room_document(
            session,
            room_id=room.id,
            agent_id=author.id,
            owner_id=owner.id,
            name="private notes",
            description="",
            instructions="",
            content="v1",
        )
        room_id, other_id, doc_id = room.id, other.id, doc.id
        # What the foreign key's ON DELETE SET NULL leaves behind.
        await session.execute(
            update(Document)
            .where(Document.id == doc_id)
            .values(created_by_agent_id=None)
        )
        await session.commit()
        session.expire_all()

        with pytest.raises(PermissionError, match="only its creating agent"):
            await service.update_room_document(
                session,
                room_id=room_id,
                agent_id=other_id,
                document_id=doc_id,
                content="v2",
            )
        with pytest.raises(PermissionError, match="only its creating agent"):
            await service.delete_room_document(
                session, room_id=room_id, agent_id=other_id, document_id=doc_id
            )
