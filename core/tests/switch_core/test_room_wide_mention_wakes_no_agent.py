"""A room-wide mention pages the room's people and wakes no agent.

This is the promise the feature exists to keep, so it is tested end to end
against a real database rather than stubbed stores: the message is produced by
`ProtocolService.send_targeted_message`, carried in the content the transport
would store, and judged by `AddressingResolver.addresses` — the one decision
the agent client turns into `MessagePayload.addressed`, which is what the event
buffer's `is_notifiable` delivers on. Every way an agent can be addressed is
live in the room: a plain name, a room alias and a live-held role.

The control case matters as much as the claim. It sends through the same
harness to the same agents by name, alias and role and watches them wake, so a
harness that could never see a wake cannot pass the claim by accident.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import (
    AgentStatus,
    RoomWideMentionStatus,
)
from switch_core.db.models import Agent, ApiKey, Client, Room, RoomRole, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver, IncomingMessage
from switch_core.room_wide_mention import ROOM_WIDE_MENTION_MARKER
from switch_core.transport.content import message_content


async def _make_agent(session: AsyncSession, name: str) -> Agent:
    user = User(
        name=f"owner-{name}", email=f"{name}@test", role="user", password_hash="x"
    )
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(matrix_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


@dataclass
class _Room:
    """A room holding one agent reachable each way addressing allows."""

    id: str
    sender: Agent
    # Addressed by its name.
    scout: Agent
    # Addressed by its room alias, `bob`.
    builder: Agent
    # Addressed by the role it live-holds, `lead`.
    reviewer: Agent

    @property
    def listeners(self) -> list[Agent]:
        return [self.scout, self.builder, self.reviewer]


@pytest.fixture
async def room(session_factory: async_sessionmaker[AsyncSession]) -> _Room:
    room_store, role_store = RoomStore(), RoomRoleStore()
    async with session_factory() as session:
        row = Room(matrix_room_id="!wide:test", name="wide", description="wide")
        session.add(row)
        await session.flush()
        agents = [
            await _make_agent(session, name)
            for name in ("sender", "scout", "builder", "reviewer")
        ]
        await room_store.add_agents(session, row.id, [a.id for a in agents])
        sender, scout, builder, reviewer = agents
        await room_store.set_alias(session, row.id, builder.id, "bob")
        lead = await role_store.define_role(session, row.id, "lead", "lead", True)
        await role_store.acquire_lease(session, lead, reviewer.id, None)
        await session.commit()
        return _Room(row.id, sender, scout, builder, reviewer)


@dataclass
class _Sent:
    body: str
    extra_content: dict[str, object] | None


def _service(
    session_factory: async_sessionmaker[AsyncSession], room: _Room
) -> tuple[ProtocolService, list[_Sent]]:
    """The real `send_targeted_message`, over real stores.

    Only the two edges that leave the process are replaced: the participant
    roster (a projection of the same rows) and the send itself, which records
    what would have gone onto the bus.
    """
    sent: list[_Sent] = []
    svc = object.__new__(ProtocolService)
    svc.connections = ConnectionRegistry()
    svc.session_factory = session_factory
    svc.room_store = RoomStore()
    svc.room_role_store = RoomRoleStore()
    svc.agent_store = AgentStore()
    svc.collab_lifecycle = SimpleNamespace(get=lambda _bridge_id: None)  # type: ignore[assignment]

    async def _participants(_room_id: str) -> list[Any]:
        return [
            SimpleNamespace(id=a.id, name=a.name, type="agent", status=AgentStatus.LIVE)
            for a in [room.sender, *room.listeners]
        ]

    async def _send_message(
        _agent_id: str,
        _room_id: str,
        body: str,
        thread_id: str | None = None,
        *,
        extra_content: dict[str, object] | None = None,
    ) -> str:
        sent.append(_Sent(body, extra_content))
        return f"evt-{len(sent)}"

    svc.list_participants = _participants  # type: ignore[assignment]
    svc.send_message = _send_message  # type: ignore[assignment]
    return svc, sent


def _as_received(sent: _Sent, sender: Agent) -> IncomingMessage:
    """The message as an agent client reads it off the bus."""
    content = message_content(
        sent.body, sender_name=sender.name, extra_content=sent.extra_content
    )
    return IncomingMessage(
        sender=f"@{sender.name}:test", body=sent.body, content=content
    )


async def _woken(
    session_factory: async_sessionmaker[AsyncSession],
    room: _Room,
    message: IncomingMessage,
) -> set[str]:
    resolver = AddressingResolver(
        room_store=RoomStore(),
        room_role_store=RoomRoleStore(),
        client_store=ClientStore(),
        agent_store=AgentStore(),
        external_user_store=ExternalUserStore(),
        live_agent_ids=set,
    )
    woken: set[str] = set()
    async with session_factory() as session:
        for agent in room.listeners:
            if await resolver.addresses(
                session,
                agent=agent,
                agent_matrix_id=f"@{agent.name}:test",
                room_id=room.id,
                channel_type="channel_public",
                message=message,
            ):
                woken.add(agent.name)
    return woken


async def test_a_room_wide_mention_wakes_no_agent(
    session_factory: async_sessionmaker[AsyncSession], room: _Room
) -> None:
    svc, sent = _service(session_factory, room)

    result = await svc.send_targeted_message(
        room.sender.id, room.id, ["everyone"], "the deploy is at five"
    )

    assert [s.body for s in sent] == ["@everyone the deploy is at five"]
    assert sent[0].extra_content == {ROOM_WIDE_MENTION_MARKER: {}}
    assert (
        await _woken(session_factory, room, _as_received(sent[0], room.sender)) == set()
    )
    # An unbridged room has nobody on a platform to page, and says so.
    assert result.target_statuses == {"everyone": RoomWideMentionStatus.NO_BRIDGE}


async def test_the_same_harness_sees_agents_it_addresses_wake(
    session_factory: async_sessionmaker[AsyncSession], room: _Room
) -> None:
    svc, sent = _service(session_factory, room)

    await svc.send_targeted_message(
        room.sender.id, room.id, ["scout", "bob"], "over to you", target_roles=["lead"]
    )

    assert await _woken(session_factory, room, _as_received(sent[0], room.sender)) == {
        "scout",
        "builder",
        "reviewer",
    }


async def test_a_room_wide_mention_still_addresses_who_it_names(
    session_factory: async_sessionmaker[AsyncSession], room: _Room
) -> None:
    svc, sent = _service(session_factory, room)

    await svc.send_targeted_message(
        room.sender.id, room.id, ["scout", "everyone"], "scout, take this"
    )

    assert sent[0].body == "@everyone @scout scout, take this"
    assert await _woken(session_factory, room, _as_received(sent[0], room.sender)) == {
        "scout"
    }


class TestSomethingAlreadyAnswersToEveryone:
    """A row made before the name was reserved would be woken, so the send is
    refused and nothing reaches the room."""

    async def test_an_alias(
        self, session_factory: async_sessionmaker[AsyncSession], room: _Room
    ) -> None:
        async with session_factory() as session:
            # Straight to the store, the way a row from before the
            # reservation got there: `validate_alias_format` now refuses it.
            await RoomStore().set_alias(session, room.id, room.scout.id, "Everyone")
            await session.commit()
        svc, sent = _service(session_factory, room)

        with pytest.raises(ValueError, match="alias 'Everyone'"):
            await svc.send_targeted_message(room.sender.id, room.id, ["everyone"], "hi")
        assert sent == []

    async def test_a_role(
        self, session_factory: async_sessionmaker[AsyncSession], room: _Room
    ) -> None:
        async with session_factory() as session:
            session.add(
                RoomRole(
                    room_id=room.id, name="everyone", instructions="x", exclusive=False
                )
            )
            await session.commit()
        svc, sent = _service(session_factory, room)

        with pytest.raises(ValueError, match="role 'everyone'"):
            await svc.send_targeted_message(room.sender.id, room.id, ["everyone"], "hi")
        assert sent == []

    async def test_an_agent(
        self, session_factory: async_sessionmaker[AsyncSession], room: _Room
    ) -> None:
        async with session_factory() as session:
            legacy = await _make_agent(session, "everyone")
            await RoomStore().add_agents(session, room.id, [legacy.id])
            await session.commit()
        room.scout = legacy
        svc, sent = _service(session_factory, room)

        with pytest.raises(ValueError, match="agent 'everyone'"):
            await svc.send_targeted_message(room.sender.id, room.id, ["everyone"], "hi")
        assert sent == []
