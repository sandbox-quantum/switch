from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import StoredTemplate
from switch_core.db.stores.stored_template_store import StoredTemplateStore


class TestStoredTemplateStore:
    async def test_list_empty(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = StoredTemplateStore()
        async with session_factory() as session:
            result = await store.list_all(session)
            assert result == []

    async def test_create_and_get(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = StoredTemplateStore()
        async with session_factory() as session:
            t = StoredTemplate(
                name="Test Agent",
                description="A test template",
                kind="agent",
                definition="# Test persona",
                creator="tester",
            )
            created = await store.create(session, t)
            await session.commit()

            fetched = await store.get(session, created.id)
            assert fetched is not None
            assert fetched.name == "Test Agent"
            assert fetched.definition == "# Test persona"
            assert fetched.creator == "tester"
            assert fetched.is_bundled is False

    async def test_list_all_ordered_by_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = StoredTemplateStore()
        async with session_factory() as session:
            for name in ["Zebra", "Alpha", "Middle"]:
                await store.create(
                    session,
                    StoredTemplate(
                        name=name,
                        description=f"{name} desc",
                        kind="agent",
                        definition=f"# {name}",
                        creator="tester",
                    ),
                )
            await session.commit()

            result = await store.list_all(session)
            assert [t.name for t in result] == ["Alpha", "Middle", "Zebra"]

    async def test_list_filtered_by_kind(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = StoredTemplateStore()
        async with session_factory() as session:
            await store.create(
                session,
                StoredTemplate(
                    name="Agent One",
                    description="agent",
                    kind="agent",
                    definition="# agent",
                    creator="tester",
                ),
            )
            await store.create(
                session,
                StoredTemplate(
                    name="Room One",
                    description="room",
                    kind="room",
                    definition="room: ...",
                    creator="tester",
                ),
            )
            await session.commit()

            agents = await store.list_all(session, kind="agent")
            assert len(agents) == 1
            assert agents[0].name == "Agent One"

            rooms = await store.list_all(session, kind="room")
            assert len(rooms) == 1
            assert rooms[0].name == "Room One"

    async def test_get_nonexistent_returns_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = StoredTemplateStore()
        async with session_factory() as session:
            assert await store.get(session, "no-such-id") is None
