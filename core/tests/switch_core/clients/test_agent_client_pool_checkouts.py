"""How many pool checkouts one inbound room message costs an agent client.

A room fans every Matrix message out to *all* of its agent clients at once, in
a single event-loop tick. So this number is multiplied by the size of the room
before it ever reaches the pool: at two checkouts per client, a ten-agent room
turned one Slack message into twenty concurrent checkouts out of forty, and the
addressed client alone took up to nine more. That is the burst that pushed the
pool to its ceiling and started failing heartbeats.

The contract is one checkout per client per message, and none at all for a
message that needs no lookup — plus, as with the room service, no session held
open while the client posts to Matrix.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.clients.agent_client import AgentClient
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver
from switch_core.transport import InboundMessage, RoomRef

MATRIX_ROOM_ID = "!r:test"


class _CountingSessionFactory:
    """The real factory, counting sessions opened and tracking how many are
    open right now. One session is one pool checkout."""

    def __init__(self, inner: async_sessionmaker[AsyncSession]) -> None:
        self._inner = inner
        self.opened = 0
        self.live = 0

    def __call__(self) -> Any:
        self.opened += 1
        return _Tracked(self, self._inner())


class _Tracked:
    def __init__(self, tracker: _CountingSessionFactory, inner: Any) -> None:
        self._tracker = tracker
        self._inner = inner

    async def __aenter__(self) -> AsyncSession:
        self._tracker.live += 1
        return await self._inner.__aenter__()  # type: ignore[no-any-return]

    async def __aexit__(self, *exc: object) -> bool:
        self._tracker.live -= 1
        return await self._inner.__aexit__(*exc)  # type: ignore[no-any-return]


async def _seed(
    session_factory: async_sessionmaker[AsyncSession], *, names: list[str]
) -> tuple[str, dict[str, Agent]]:
    async with session_factory() as session:
        user = User(name="o", email="o@test", role="user", password_hash="x")
        session.add(user)
        await session.flush()
        agents: dict[str, Agent] = {}
        for name in names:
            key = ApiKey(
                user_id=user.id,
                key_hash=f"hash-{name}",
                encrypted_key="enc",
                label=name,
                type="agent",
            )
            client = Client(
                matrix_user_id=f"@{name}:test",
                display_name=name,
                type="agent",
                password="x",
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=name,
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={"connection_model": "session_addressable"},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=user.id,
            )
            session.add(agent)
            await session.flush()
            agents[name] = agent
        room = Room(matrix_room_id=MATRIX_ROOM_ID, name="room", description="d")
        session.add(room)
        await session.flush()
        await RoomStore().add_agents(session, room.id, [a.id for a in agents.values()])
        await session.commit()
        return room.id, agents


def _client(
    counting: _CountingSessionFactory, agent: Agent, room_id: str
) -> AgentClient:
    """An AgentClient wired to the real stores, with its room-meta cache warm.

    The cache is warm because that is the steady state: a client resolves a
    room once and then answers every later message in it from memory.
    """
    client = object.__new__(AgentClient)
    client.session_factory = counting  # type: ignore[assignment]
    client.client_store = ClientStore()
    client.matrix_user_id = f"@{agent.name}:test"
    client.client_id = agent.client_id
    client._agent = agent
    client._agent_store = AgentStore()
    client._room_store = RoomStore()
    client._room_role_store = RoomRoleStore()
    client._agent_session_store = AgentSessionStore()
    client._external_user_store = ExternalUserStore()
    client._connections = ConnectionRegistry()
    client._addressing = AddressingResolver(
        room_store=client._room_store,
        room_role_store=client._room_role_store,
        client_store=client.client_store,
        agent_store=client._agent_store,
        external_user_store=client._external_user_store,
        live_agent_ids=client._connections.live_agent_ids,
    )
    client._frontend_base_url = None
    client._room_meta = {
        MATRIX_ROOM_ID: RoomMeta(
            room_id=room_id,
            name="room",
            bridge_id=None,
            channel_type="channel_public",
        )
    }
    client._attachment_groups = {}
    client._attachment_group_timers = {}
    client.sent = []  # type: ignore[attr-defined]

    async def _send_message(matrix_room_id: str, body: str, **kwargs: Any) -> str:
        client.sent.append((body, counting.live))  # type: ignore[attr-defined]
        return "$sent"

    client.send_message = _send_message  # type: ignore[assignment, method-assign]
    client._event_buffer = SimpleNamespace(  # type: ignore[assignment]
        enqueue=lambda *_a, **_k: None
    )
    return client


def _message(body: str, sender: str = "@switch-slack-louisa:test") -> InboundMessage:
    return InboundMessage(
        room_id=MATRIX_ROOM_ID,
        event_id="$trigger",
        sender=sender,
        timestamp=0,
        content={"body": body, "sender_name": "louisa"},
        body=body,
        sender_name="louisa",
    )


def _room() -> RoomRef:
    return RoomRef(room_id=MATRIX_ROOM_ID)


class TestInboundMessageCheckouts:
    async def test_chatter_with_no_at_costs_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The common case in a busy room, and the one multiplied by every agent
        # in it: no `@`, so there is nothing an alias or a role lease could
        # match and no reason to touch the database at all.
        room_id, agents = await _seed(session_factory, names=["member"])
        counting = _CountingSessionFactory(session_factory)
        client = _client(counting, agents["member"], room_id)

        await client.on_message(_room(), _message("just talking amongst ourselves"))

        assert counting.opened == 0

    async def test_an_at_message_for_somebody_else_costs_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Was two: the room alias and the role lease each took a session.
        room_id, agents = await _seed(session_factory, names=["member", "other"])
        counting = _CountingSessionFactory(session_factory)
        client = _client(counting, agents["member"], room_id)

        await client.on_message(_room(), _message("@other can you look at this"))

        assert counting.opened == 1

    async def test_being_addressed_and_offline_still_costs_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The expensive path: addressing policy, liveness, and the whole
        # offline-reply derivation. Was up to nine checkouts.
        room_id, agents = await _seed(session_factory, names=["member"])
        counting = _CountingSessionFactory(session_factory)
        client = _client(counting, agents["member"], room_id)

        await client.on_message(_room(), _message("@member can you look at this"))

        assert counting.opened == 1
        assert len(client.sent) == 1  # type: ignore[attr-defined]

    async def test_no_session_is_open_while_the_auto_reply_is_posted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Posting to Matrix is an unbounded wait as far as the pool is
        # concerned; doing it inside the transaction is how a slot ends up
        # idle-in-transaction for seconds.
        room_id, agents = await _seed(session_factory, names=["member"])
        counting = _CountingSessionFactory(session_factory)
        client = _client(counting, agents["member"], room_id)

        await client.on_message(_room(), _message("@member you there?"))

        assert [live for _body, live in client.sent] == [0]  # type: ignore[attr-defined]

    async def test_a_restricted_agent_refusing_a_sender_costs_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, agents = await _seed(session_factory, names=["member"])
        async with session_factory() as session:
            await AgentStore().update(
                session,
                agents["member"].id,
                addressing_policy={"rules": [{"agents": ["nobody"], "users": []}]},
            )
            await session.commit()
        counting = _CountingSessionFactory(session_factory)
        client = _client(counting, agents["member"], room_id)

        await client.on_message(_room(), _message("@member you there?"))

        assert counting.opened == 1
        assert [live for _body, live in client.sent] == [0]  # type: ignore[attr-defined]

    async def test_an_alias_tag_costs_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Reached only after the alias lookup misses on name, so this is the
        # path where alias and role used to be two separate checkouts.
        room_id, agents = await _seed(session_factory, names=["member"])
        async with session_factory() as session:
            await RoomStore().set_alias(session, room_id, agents["member"].id, "fixer")
            await session.commit()
        counting = _CountingSessionFactory(session_factory)
        client = _client(counting, agents["member"], room_id)

        await client.on_message(_room(), _message("@fixer please look"))

        assert counting.opened == 1
        assert len(client.sent) == 1  # type: ignore[attr-defined]

    async def test_a_ten_agent_room_costs_ten(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The burst, end to end. One message, every client in the room handling
        # it at once: ten slots out of forty, where it used to be twenty plus
        # the addressed client's own handful.
        names = [f"a{i}" for i in range(10)]
        room_id, agents = await _seed(session_factory, names=names)
        counting = _CountingSessionFactory(session_factory)
        clients = [_client(counting, agents[name], room_id) for name in names]

        for client in clients:
            await client.on_message(_room(), _message("@a3 can you take this"))

        assert counting.opened == 10
