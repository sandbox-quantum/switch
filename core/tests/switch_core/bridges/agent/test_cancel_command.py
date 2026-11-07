"""Tests for !cancel command: cancelling a queued message/turn before the agent picks it up."""

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
from switch_core.db.stores.session_activity_store import AgentSessionActivityStore
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


async def test_a_typed_cancel_meets_authorization_and_state_rules(
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
                body="@helper please build this",
                content={"body": "@helper please build this"},
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
                status="queued",
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

    async def refusal(asker: Client, message_id: str | None = "$m1") -> str | None:
        event = SimpleNamespace(user_id=asker.transport_user_id)
        ref, _ = await commands._cancel_refusal(client, room.id, event, agent, message_id)  # type: ignore[arg-type]
        return ref

    # Sender can cancel their own queued message
    assert await refusal(sender) is None
    # Room owner can cancel any queued message
    assert await refusal(owner_client) is None
    # Stranger is rejected
    assert "only whoever sent" in (await refusal(stranger) or "")
    # Missing message is rejected
    assert "not in this room" in (await refusal(sender, "$unknown") or "")

    # Cancel without specifying message id finds the newest queued turn
    assert await refusal(sender, None) is None

    # When the turn transitions to running, cancel is refused with guidance to use !interrupt
    async with session_factory() as session:
        row = await session.get(
            AgentSessionActivityItem, (TENANT, agent.id, "s1", "t1", "turn")
        )
        assert row is not None
        row.status = "running"
        await session.commit()

    running_refusal = await refusal(sender) or ""
    assert "already started working" in running_refusal
    assert "!interrupt" in running_refusal


def test_cancel_room_control_frame() -> None:
    frame = commands.room_control_frame(
        agent_id="agent-1",
        session_id="s-1",
        room_id="room-1",
        action="cancel",
        actor_id="@user:test",
        message_id="$cmd-1",
        thread_id=None,
        surface="slack",
        requester_name="Alice",
        target_message_id="$m-target",
    )
    assert frame["body"] == {
        "type": "turn.cancel",
        "turnId": "current",
        "messageId": "$m-target",
    }
    assert frame["requesterName"] == "Alice"
