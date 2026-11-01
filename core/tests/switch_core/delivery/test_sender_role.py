"""A delivered message says the sending person's role in the workspace, read
as the message arrives, so an agent need not trust what it was told earlier."""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.message_events import message_event
from switch_core.db.models import TENANT_ZERO_ID, TenantMember, User
from switch_core.delivery.addressing import SenderPrincipal
from switch_core.delivery.recipient import AgentRecipient
from switch_core.transport.types import InboundMessage


class _Addressing:
    def __init__(self, principal: SenderPrincipal | None) -> None:
        self._principal = principal

    async def resolve_sender(
        self, _session: AsyncSession, _sender: str, _content: object
    ) -> SenderPrincipal | None:
        return self._principal


def _recipient(principal: SenderPrincipal | None) -> SimpleNamespace:
    return SimpleNamespace(_addressing=_Addressing(principal))


async def _member(session: AsyncSession, name: str, role: str) -> User:
    user = User(name=name, email=f"{name}@example.test", role="user")
    session.add(user)
    await session.flush()
    session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role=role))
    await session.flush()
    return user


async def test_a_person_is_named_by_their_role_now(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _member(session, "olivia", "owner")
        person = SenderPrincipal("user", "client-1", [olivia.id], None)

        assert (
            await AgentRecipient._sender_role(
                _recipient(person),  # type: ignore[arg-type]
                session,
                "@olivia:test",
                {},
            )
            == "owner"
        )

        membership = await session.get(TenantMember, (TENANT_ZERO_ID, olivia.id))
        assert membership is not None
        membership.role = "member"
        await session.flush()

        assert (
            await AgentRecipient._sender_role(
                _recipient(person),  # type: ignore[arg-type]
                session,
                "@olivia:test",
                {},
            )
            == "member"
        )


async def test_an_agent_or_an_unclaimed_person_has_no_role(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        for principal in (
            None,
            SenderPrincipal("agent", "agent-1", [], "owner-1"),
            SenderPrincipal("user", "client-2", [], None),
        ):
            assert (
                await AgentRecipient._sender_role(
                    _recipient(principal),  # type: ignore[arg-type]
                    session,
                    "@someone:test",
                    {},
                )
                is None
            )


def test_the_role_rides_on_the_message() -> None:
    event = message_event(
        room_id="room-1",
        bridge_id=None,
        channel_type="direct",
        event=InboundMessage(
            room_id="room-1",
            event_id="$1",
            sender="@olivia:test",
            timestamp=1,
            body="help me connect Discord",
            sender_name="olivia",
        ),
        addressed=True,
        sender_name="olivia",
        body="help me connect Discord",
        thread_id=None,
        sender_role="member",
    )

    assert event.payload.sender_role == "member"  # type: ignore[union-attr]
    assert event.payload.sender_owns_agent is False  # type: ignore[union-attr]


async def test_sender_owns_agent_detected_accurately() -> None:
    person = SenderPrincipal("user", "client-1", ["user-olivia"], None)
    recipient = SimpleNamespace(
        _addressing=_Addressing(person),
        agent=SimpleNamespace(owner_id="user-olivia"),
    )
    assert (
        await AgentRecipient._sender_owns_agent(
            recipient,  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            "@olivia:test",
            {},
        )
        is True
    )

    non_owner_recipient = SimpleNamespace(
        _addressing=_Addressing(person),
        agent=SimpleNamespace(owner_id="different-owner-id"),
    )
    assert (
        await AgentRecipient._sender_owns_agent(
            non_owner_recipient,  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            "@olivia:test",
            {},
        )
        is False
    )

    unowned_recipient = SimpleNamespace(
        _addressing=_Addressing(person),
        agent=SimpleNamespace(owner_id=None),
    )
    assert (
        await AgentRecipient._sender_owns_agent(
            unowned_recipient,  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            "@olivia:test",
            {},
        )
        is False
    )


def test_sender_owns_agent_rides_on_the_message() -> None:
    event = message_event(
        room_id="room-1",
        bridge_id=None,
        channel_type="direct",
        event=InboundMessage(
            room_id="room-1",
            event_id="$1",
            sender="@olivia:test",
            timestamp=1,
            body="help me connect Discord",
            sender_name="olivia",
        ),
        addressed=True,
        sender_name="olivia",
        body="help me connect Discord",
        thread_id=None,
        sender_role="member",
        sender_owns_agent=True,
    )

    assert event.payload.sender_owns_agent is True  # type: ignore[union-attr]
