"""A small room for the follow-the-conversation tests, shared by the rule tests
and the journey tests: two agents (helper, reviewer), two people (alice, bob),
and a way to write history with chosen timestamps."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Message,
    Room,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import (
    RoomStore,
    follow_ups_enabled_in,
    main_agent_in,
)
from switch_core.delivery.addressing import AddressingResolver
from switch_core.delivery.conversation import (
    ConversationDecision,
    ConversationMessage,
    ConversationRoute,
    ConversationRules,
    ConversationSettings,
    may_follow,
)

T0 = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)

THREAD = ConversationRoute.THREAD_FOLLOW_UP
CHANNEL = ConversationRoute.CHANNEL_FOLLOW_UP
MAIN = ConversationRoute.MAIN_AGENT


def _settings() -> ConversationSettings:
    return ConversationSettings(enabled=True, window_seconds=300)


@dataclass
class World:
    """A room with two agents (helper, reviewer) and two people (alice, bob)."""

    session_factory: async_sessionmaker[AsyncSession]
    room_id: str
    owner_id: str
    agents: dict[str, Agent]
    people: dict[str, str] = field(default_factory=dict)
    store: MessageStore = field(default_factory=MessageStore)
    _n: int = 0

    def mxid(self, name: str) -> str:
        return self.people.get(name) or f"@{name}-{self.room_id[:8]}:test"

    async def post(
        self,
        sender: str,
        body: str,
        *,
        at: float,
        thread: str | None = None,
        **content: object,
    ) -> str:
        """Write one message, `at` seconds after T0, and return its event id."""
        self._n += 1
        event_id = f"$e{self._n}-{uuid.uuid4().hex[:6]}"
        async with self.session_factory() as session:
            await self.store.create(
                session,
                Message(
                    room_id=self.room_id,
                    transport_event_id=event_id,
                    sender_id=self.mxid(sender),
                    event_type="m.room.message",
                    msgtype="m.text",
                    body=body,
                    thread_root_event_id=thread,
                    content={"msgtype": "m.text", "body": body, **content},
                    sent_at=T0 + timedelta(seconds=at),
                ),
                [],
            )
            await session.commit()
        return event_id

    async def assign(self, agent: str | None) -> None:
        """Make `agent` the room's main agent, or clear it with None."""
        async with self.session_factory() as session:
            await RoomStore().set_main_agent(
                session, self.room_id, self.agents[agent].id if agent else None
            )
            await session.commit()

    def rules(self, settings: ConversationSettings) -> ConversationRules:
        return ConversationRules(
            settings=settings,
            message_store=self.store,
            room_store=RoomStore(),
            agent_store=AgentStore(),
            room_role_store=RoomRoleStore(),
        )

    async def decide(
        self,
        agent: str,
        event_id: str,
        *,
        settings: ConversationSettings | None = None,
        channel_type: str = "channel_public",
    ) -> ConversationDecision:
        settings = settings or _settings()
        async with self.session_factory() as session:
            row = await self.store.get_by_transport_event_id(session, event_id)
            assert row is not None
            room = await RoomStore().get(session, self.room_id)
            assert room is not None
            message = ConversationMessage(
                event_id=event_id,
                sender=row.sender_id,
                body=row.body or "",
                content=row.content,
                thread_root_id=row.thread_root_event_id,
                sent_at=row.sent_at,  # type: ignore[arg-type]
            )
            assert may_follow(
                settings,
                channel_type=channel_type,
                message=message,
            )
            conversation = self.rules(settings).for_message(
                addressing=_resolver(),
                room_id=self.room_id,
                channel_type=channel_type,
                follow_ups_enabled=follow_ups_enabled_in(room.metadata_),
                main_agent_id=main_agent_in(room.metadata_),
                message=message,
            )
            return await conversation.decide(
                session, agent=self.agents[agent], agent_user_id=self.mxid(agent)
            )

    async def route(self, agent: str, event_id: str, **kwargs: Any) -> str | None:
        return (await self.decide(agent, event_id, **kwargs)).route


def _resolver() -> AddressingResolver:
    return AddressingResolver(
        room_store=RoomStore(),
        room_role_store=RoomRoleStore(),
        client_store=ClientStore(),
        agent_store=AgentStore(),
        external_user_store=ExternalUserStore(),
        live_connection_ids=lambda: set(),
    )


async def make_world(session_factory: async_sessionmaker[AsyncSession]) -> World:
    tag = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        owner = User(name="o", email=f"o-{tag}@test", role="user", password_hash="x")
        session.add(owner)
        await session.flush()
        room = Room(
            transport_room_id=f"!room-{tag}:test",
            name="room",
            description="d",
            channel_type="channel_public",
        )
        session.add(room)
        await session.flush()
        world = World(
            session_factory=session_factory,
            room_id=room.id,
            owner_id=owner.id,
            agents={},
        )
        for name in ("helper", "reviewer"):
            key = ApiKey(
                user_id=owner.id,
                key_hash=f"hash-{name}-{tag}",
                encrypted_key="enc",
                label=name,
                type="agent",
            )
            client = Client(
                transport_user_id=world.mxid(name), display_name=name, type="agent"
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=f"{name}",
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={"connection_model": "session_addressable"},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=owner.id,
            )
            session.add(agent)
            await session.flush()
            world.agents[name] = agent
        await RoomStore().add_agents(
            session, room.id, [a.id for a in world.agents.values()]
        )

        bridge_client = Client(
            transport_user_id=f"@bridge-{tag}:test", display_name="b", type="bridge"
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="mattermost",
            display_name="MM",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        # The Switch app's own client, which sends room-settings notices.
        admin_mxid = f"@switch-admin-{tag}:test"
        session.add(
            Client(transport_user_id=admin_mxid, display_name="Switch", type="admin")
        )
        await session.flush()
        world.people["admin"] = admin_mxid
        for name in ("alice", "bob"):
            mxid = f"@{name}-{tag}:test"
            client = Client(
                transport_user_id=mxid, display_name=name, type="external_user"
            )
            session.add(client)
            await session.flush()
            person = ExternalUser(
                bridge_id=bridge.id,
                external_user_id=f"U{name}{tag}",
                external_username=name,
                client_id=client.id,
            )
            session.add(person)
            await session.flush()
            if name == "alice":
                session.add(
                    ExternalUserClaim(external_user_id=person.id, user_id=owner.id)
                )
            world.people[name] = mxid
        await session.commit()
    return world
