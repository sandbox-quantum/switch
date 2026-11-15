"""A typed `!retry @agent <message>` is held to the rules Switch Console's
Retry is: the message is in the room, whoever asks sent it or manages the
room, and the agent's turn for it failed or was interrupted."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import commands
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    AgentSessionActivityItem,
    Client,
    Message,
    Room,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver
from tests.switch_core.gateway.agent_route_harness import add_agent

TENANT = "00000000-0000-0000-0000-000000000000"


async def _member(session: AsyncSession, name: str) -> tuple[User, Client]:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    client = Client(
        transport_user_id=f"@member-{name}:test",
        display_name=name,
        type=MEMBER_CLIENT_TYPE,
        user_id=user.id,
    )
    session.add(client)
    await session.flush()
    return user, client


async def test_a_typed_retry_meets_the_consoles_rules(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, owner_client = await _member(session, "owner")
        _, sender = await _member(session, "sender")
        _, stranger = await _member(session, "stranger")
        agent = await add_agent(session, name="helper", owner_id=owner.id)
        room = Room(
            transport_room_id="!r:test", name="r", description="", owner_id=owner.id
        )
        session.add(room)
        await session.flush()
        session.add(
            Message(
                room_id=room.id,
                seq=1,
                transport_event_id="$m1",
                sender_id=sender.transport_user_id,
                sender_client_id=sender.id,
                event_type="m.room.message",
                body="@helper plan",
                content={"body": "@helper plan"},
            )
        )
        session.add(
            AgentSessionActivityItem(
                agent_id=agent.id,
                session_id="s1",
                turn_id="t1",
                item_id="turn",
                kind="turn",
                revision=1,
                status="error",
                title="Turn",
                text="",
                room_id=room.id,
                message_id="$m1",
                occurred_at=datetime.now(UTC),
            )
        )
        await session.commit()

    client = SimpleNamespace(
        session_factory=session_factory,
        tenant_id=TENANT,
        _addressing=AddressingResolver(
            room_store=RoomStore(),
            room_role_store=RoomRoleStore(),
            client_store=ClientStore(),
            agent_store=AgentStore(),
            external_user_store=ExternalUserStore(),
            live_connection_ids=set,
        ),
    )

    async def refusal(asker: Client, message_id: str = "$m1") -> str | None:
        event = SimpleNamespace(user_id=asker.transport_user_id)
        return await commands._retry_refusal(client, room.id, event, agent, message_id)  # type: ignore[arg-type]

    assert await refusal(sender) is None
    assert await refusal(owner_client) is None
    assert "only whoever sent" in (await refusal(stranger) or "")
    assert "not in this room" in (await refusal(sender, "$nowhere") or "")

    async with session_factory() as session:
        row = await session.get(
            AgentSessionActivityItem, (TENANT, agent.id, "s1", "t1", "turn")
        )
        assert row is not None
        row.status = "completed"
        await session.commit()
    assert "no failed or interrupted turn" in (await refusal(sender) or "")
