"""The gateway route that sets, changes, and clears an agent's icon (CHOO-2171).

Exercised against real Postgres with real stores, like the other gateway route
tests. What matters here is that ownership is enforced, that an unsafe URL is
refused at write time rather than stored to fail later, and that clearing is
expressible and lands as NULL.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.agents import update_agent_icon
from switch_core.gateway.schemas import UpdateAgentIconRequest
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user

_AGENT_STORE = AgentStore()

_ICON = "https://cdn.example.com/9.x/bottts/png?seed=switch-worker"
_OTHER_ICON = "https://cdn.example.com/9.x/shapes/png?seed=switch-worker"


class TestUpdateAgentIcon:
    async def test_owner_can_set_an_icon(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="a1", owner_id=owner.id)

            summary = await update_agent_icon(
                agent.id,
                UpdateAgentIconRequest(icon_url=_ICON),
                session,
                _AGENT_STORE,
                owner,
            )

            assert summary.icon_url == _ICON
            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.icon_url == _ICON

    async def test_owner_can_change_an_existing_icon(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(
                session, name="a1", owner_id=owner.id, icon_url=_ICON
            )

            summary = await update_agent_icon(
                agent.id,
                UpdateAgentIconRequest(icon_url=_OTHER_ICON),
                session,
                _AGENT_STORE,
                owner,
            )

            assert summary.icon_url == _OTHER_ICON

    async def test_null_clears_the_icon(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Clearing has to be expressible — the whole reason this is a separate
        route rather than another optional field on the agent update."""
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(
                session, name="a1", owner_id=owner.id, icon_url=_ICON
            )

            summary = await update_agent_icon(
                agent.id,
                UpdateAgentIconRequest(icon_url=None),
                session,
                _AGENT_STORE,
                owner,
            )

            assert summary.icon_url is None
            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.icon_url is None

    async def test_blank_string_clears_rather_than_storing_empty(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(
                session, name="a1", owner_id=owner.id, icon_url=_ICON
            )

            summary = await update_agent_icon(
                agent.id,
                UpdateAgentIconRequest(icon_url="   "),
                session,
                _AGENT_STORE,
                owner,
            )

            assert summary.icon_url is None

    async def test_non_owner_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            other = await add_user(session, name="other")
            agent = await add_agent(session, name="a1", owner_id=owner.id)

            with pytest.raises(HTTPException) as exc:
                await update_agent_icon(
                    agent.id,
                    UpdateAgentIconRequest(icon_url=_ICON),
                    session,
                    _AGENT_STORE,
                    other,
                )

            assert exc.value.status_code == 403
            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.icon_url is None

    async def test_admin_can_set_an_icon_on_an_agent_they_do_not_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            admin = await add_user(session, name="admin", role="admin")
            agent = await add_agent(session, name="a1", owner_id=owner.id)

            summary = await update_agent_icon(
                agent.id,
                UpdateAgentIconRequest(icon_url=_ICON),
                session,
                _AGENT_STORE,
                admin,
            )

            assert summary.icon_url == _ICON

    async def test_unknown_agent_is_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")

            with pytest.raises(HTTPException) as exc:
                await update_agent_icon(
                    "no-such-agent",
                    UpdateAgentIconRequest(icon_url=_ICON),
                    session,
                    _AGENT_STORE,
                    owner,
                )

            assert exc.value.status_code == 404

    @pytest.mark.parametrize(
        "bad_url",
        [
            "http://cdn.example.com/i.png",
            "javascript:alert(1)",
            "https://127.0.0.1/i.png",
            "https://169.254.169.254/latest/meta-data/",
            "https://localhost/i.png",
        ],
    )
    async def test_unsafe_url_is_rejected_and_nothing_is_stored(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        bad_url: str,
    ) -> None:
        """Refused at write time, not stored to break later at render time —
        and never stored at all, since Switch itself dereferences the URL when
        a bridge needs the image as bytes."""
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="a1", owner_id=owner.id)

            with pytest.raises(HTTPException) as exc:
                await update_agent_icon(
                    agent.id,
                    UpdateAgentIconRequest(icon_url=bad_url),
                    session,
                    _AGENT_STORE,
                    owner,
                )

            assert exc.value.status_code == 400
            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.icon_url is None

    async def test_a_rejected_change_leaves_the_previous_icon_intact(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(
                session, name="a1", owner_id=owner.id, icon_url=_ICON
            )

            with pytest.raises(HTTPException):
                await update_agent_icon(
                    agent.id,
                    UpdateAgentIconRequest(icon_url="https://192.168.0.9/i.png"),
                    session,
                    _AGENT_STORE,
                    owner,
                )

            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.icon_url == _ICON
