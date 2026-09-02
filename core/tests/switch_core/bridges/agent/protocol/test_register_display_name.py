"""Registration and the agent's human display name.

Two things are load-bearing here. First, that the Matrix client keeps the
*identifier* as its display name: the bridges recognise an agent's own echo
coming back from a platform by matching `sender_name`, so a human name on the
client would make an agent re-import its own messages as a stranger and appear
in the room twice. Second, that a re-registration which says nothing about the
icon or the display name keeps both — server-side connectors re-register with
`overwrite=True` on every startup.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.agent_display_name import InvalidDisplayName
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Agent, Client
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    FakeClientLifecycle,
    make_owner,
    make_service,
    register,
)

_ICON = "https://cdn.example.com/9.x/bottts/png?seed=switchdev"


async def _agent(
    svc: ProtocolService,
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
) -> Agent:
    async with session_factory() as session:
        agent = await svc.agent_store.get(session, agent_id)
    assert agent is not None
    return agent


class TestMatrixIdentityStaysTheIdentifier:
    async def test_a_display_name_does_not_reach_the_matrix_client(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(svc, "switchdev", owner_id, display_name="Switch Dev")

        agent = await _agent(svc, session_factory, agent_id)
        assert agent.display_name == "Switch Dev"
        assert agent.name == "switchdev"

        # What the bridges match on is the identifier, not the human name.
        lifecycle = svc.client_lifecycle
        assert isinstance(lifecycle, FakeClientLifecycle)
        assert lifecycle.requested_display_names == ["switchdev"]

        async with session_factory() as session:
            client = await session.get(Client, agent.client_id)
        assert client is not None
        assert client.display_name == "switchdev"

    async def test_registering_without_one_stores_null(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(svc, "plain", owner_id)

        agent = await _agent(svc, session_factory, agent_id)
        assert agent.display_name is None


class TestDisplayNameValidationAtRegistration:
    async def test_blank_collapses_to_null(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(svc, "blank", owner_id, display_name="   ")

        agent = await _agent(svc, session_factory, agent_id)
        assert agent.display_name is None

    async def test_a_newline_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        with pytest.raises(InvalidDisplayName):
            await register(svc, "forged", owner_id, display_name="Switch\nDev")


class TestReregistrationKeepsWhatItWasNotTold:
    async def test_omitting_both_preserves_icon_and_display_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A server-side connector re-registers with overwrite=True on every
        # startup and knows nothing about either field.
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(
            svc, "connected", owner_id, icon_url=_ICON, display_name="Switch Dev"
        )

        again = await register(svc, "connected", owner_id, overwrite=True)
        assert again == agent_id

        agent = await _agent(svc, session_factory, agent_id)
        assert agent.icon_url == _ICON
        assert agent.display_name == "Switch Dev"

    async def test_supplying_them_replaces_them(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(
            svc, "renamed", owner_id, icon_url=_ICON, display_name="Switch Dev"
        )

        other_icon = "https://cdn.example.com/9.x/shapes/png?seed=switchdev"
        await register(
            svc,
            "renamed",
            owner_id,
            overwrite=True,
            icon_url=other_icon,
            display_name="Switch Reviewer",
        )

        agent = await _agent(svc, session_factory, agent_id)
        assert agent.icon_url == other_icon
        assert agent.display_name == "Switch Reviewer"
