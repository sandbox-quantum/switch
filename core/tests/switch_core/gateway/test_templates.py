from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import StoredTemplate, User
from switch_core.db.stores.stored_template_store import StoredTemplateStore
from switch_core.gateway.templates import get_template, list_templates


async def _make_user(session: AsyncSession) -> User:
    user = User(name="alice", email="alice@example.invalid", role="user")
    session.add(user)
    await session.flush()
    return user


class TestTemplatesGateway:
    async def test_list_returns_empty(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user = await _make_user(session)
            result = await list_templates(session=session, _user=user)
            assert result == []

    async def test_list_returns_seeded_template(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = StoredTemplateStore()
        async with session_factory() as session:
            await store.create(
                session,
                StoredTemplate(
                    name="Switch Expert",
                    description="Helps with Switch",
                    kind="agent",
                    definition="# Expert persona",
                    creator="Switch",
                    is_bundled=True,
                ),
            )
            await session.commit()

            user = await _make_user(session)
            result = await list_templates(session=session, _user=user)
            assert len(result) == 1
            assert result[0].name == "Switch Expert"
            assert result[0].creator == "Switch"
            assert result[0].is_bundled is True

    async def test_list_filters_by_kind(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = StoredTemplateStore()
        async with session_factory() as session:
            await store.create(
                session,
                StoredTemplate(
                    name="Agent T",
                    description="agent",
                    kind="agent",
                    definition="# agent",
                    creator="x",
                ),
            )
            await store.create(
                session,
                StoredTemplate(
                    name="Room T",
                    description="room",
                    kind="room",
                    definition="room: ...",
                    creator="x",
                ),
            )
            await session.commit()

            user = await _make_user(session)
            agents = await list_templates(session=session, _user=user, kind="agent")
            assert len(agents) == 1
            assert agents[0].name == "Agent T"

    async def test_get_returns_full_definition(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = StoredTemplateStore()
        async with session_factory() as session:
            t = await store.create(
                session,
                StoredTemplate(
                    name="Expert",
                    description="desc",
                    kind="agent",
                    definition="# Full persona content",
                    creator="Switch",
                ),
            )
            await session.commit()

            user = await _make_user(session)
            detail = await get_template(template_id=t.id, session=session, _user=user)
            assert detail.definition == "# Full persona content"
            assert detail.name == "Expert"

    async def test_get_nonexistent_raises_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        from fastapi import HTTPException

        async with session_factory() as session:
            user = await _make_user(session)
            with pytest.raises(HTTPException) as exc_info:
                await get_template(
                    template_id="nonexistent", session=session, _user=user
                )
            assert exc_info.value.status_code == 404
