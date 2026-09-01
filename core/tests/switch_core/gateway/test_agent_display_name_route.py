"""The gateway route that sets, changes, and clears an agent's display name.

Exercised against real Postgres with real stores, like the other gateway route
tests: ownership is enforced, a name that would break a message header is
refused at write time, and clearing is expressible and lands as NULL.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.agent_display_name import MAX_DISPLAY_NAME_LENGTH
from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.agents import update_agent_display_name
from switch_core.gateway.schemas import UpdateAgentDisplayNameRequest
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user

_AGENT_STORE = AgentStore()

_NAME = "Switch Dev"
_OTHER_NAME = "Switch Reviewer"


class TestUpdateAgentDisplayName:
    async def test_owner_can_set_a_display_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            summary = await update_agent_display_name(
                agent.id,
                UpdateAgentDisplayNameRequest(display_name=_NAME),
                session,
                _AGENT_STORE,
                owner,
            )

            assert summary.display_name == _NAME
            # The identifier is untouched: it is what the agent is addressed by.
            assert summary.name == "switchdev"
            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.display_name == _NAME

    async def test_surrounding_whitespace_is_trimmed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            summary = await update_agent_display_name(
                agent.id,
                UpdateAgentDisplayNameRequest(display_name="  Switch Dev  "),
                session,
                _AGENT_STORE,
                owner,
            )

            assert summary.display_name == _NAME

    async def test_owner_can_change_an_existing_display_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(
                session, name="switchdev", owner_id=owner.id, display_name=_NAME
            )

            summary = await update_agent_display_name(
                agent.id,
                UpdateAgentDisplayNameRequest(display_name=_OTHER_NAME),
                session,
                _AGENT_STORE,
                owner,
            )

            assert summary.display_name == _OTHER_NAME

    @pytest.mark.parametrize("cleared", [None, "   "])
    async def test_null_or_blank_clears_it(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        cleared: str | None,
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(
                session, name="switchdev", owner_id=owner.id, display_name=_NAME
            )

            summary = await update_agent_display_name(
                agent.id,
                UpdateAgentDisplayNameRequest(display_name=cleared),
                session,
                _AGENT_STORE,
                owner,
            )

            assert summary.display_name is None
            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.display_name is None

    async def test_non_owner_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            other = await add_user(session, name="other")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            with pytest.raises(HTTPException) as exc:
                await update_agent_display_name(
                    agent.id,
                    UpdateAgentDisplayNameRequest(display_name=_NAME),
                    session,
                    _AGENT_STORE,
                    other,
                )

            assert exc.value.status_code == 403
            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.display_name is None

    async def test_admin_can_set_one_on_an_agent_they_do_not_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            admin = await add_user(session, name="admin", role="admin")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            summary = await update_agent_display_name(
                agent.id,
                UpdateAgentDisplayNameRequest(display_name=_NAME),
                session,
                _AGENT_STORE,
                admin,
            )

            assert summary.display_name == _NAME

    async def test_unknown_agent_is_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")

            with pytest.raises(HTTPException) as exc:
                await update_agent_display_name(
                    "no-such-agent",
                    UpdateAgentDisplayNameRequest(display_name=_NAME),
                    session,
                    _AGENT_STORE,
                    owner,
                )

            assert exc.value.status_code == 404

    @pytest.mark.parametrize(
        "bad_name",
        [
            "Switch\nDev",
            "Switch\rDev",
            "Switch\x00Dev",
            "S" * (MAX_DISPLAY_NAME_LENGTH + 1),
        ],
    )
    async def test_unsafe_names_are_400_not_stored(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        bad_name: str,
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            with pytest.raises(HTTPException) as exc:
                await update_agent_display_name(
                    agent.id,
                    UpdateAgentDisplayNameRequest(display_name=bad_name),
                    session,
                    _AGENT_STORE,
                    owner,
                )

            assert exc.value.status_code == 400
            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.display_name is None
