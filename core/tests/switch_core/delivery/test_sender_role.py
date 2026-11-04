"""A delivered message says the sending person's role in the workspace, read
as the message arrives, so an agent need not trust what it was told earlier,
and whether that person owns the agent, which lets them steer a turn someone
else started."""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.message_events import message_event
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.delivery.addressing import SenderPrincipal
from switch_core.delivery.recipient import AgentRecipient, SenderFacts
from switch_core.transport.types import InboundMessage


class _Addressing:
    def __init__(self, principal: SenderPrincipal | None) -> None:
        self._principal = principal

    async def resolve_sender(
        self, _session: AsyncSession, _sender: str, _content: object
    ) -> SenderPrincipal | None:
        return self._principal


def _recipient(
    principal: SenderPrincipal | None, owner_id: str | None = None
) -> SimpleNamespace:
    return SimpleNamespace(
        _addressing=_Addressing(principal),
        tenant_id=TENANT_ZERO_ID,
        agent=SimpleNamespace(owner_id=owner_id),
    )


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
        olivia = await _member(session, "olivia", "admin")
        person = SenderPrincipal("user", "client-1", [olivia.id], None)

        assert (
            await AgentRecipient._sender_role(
                _recipient(person),  # type: ignore[arg-type]
                session,
                "@olivia:test",
                {},
            )
            == "admin"
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


async def test_an_organization_admin_without_a_membership_is_an_admin(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """They administer the workspace through its organization, and agents
    are told so rather than that they hold no role."""
    async with session_factory() as session:
        organization = Organization(
            id="org-sender-role", slug="org-sender-role", name="O"
        )
        session.add(organization)
        await session.flush()
        tenant = await session.get(Tenant, TENANT_ZERO_ID)
        assert tenant is not None
        tenant.organization_id = organization.id
        oscar = User(name="oscar", email="oscar@example.test", role="user")
        session.add(oscar)
        await session.flush()
        session.add(
            OrganizationMember(
                organization_id=organization.id, user_id=oscar.id, role="org_admin"
            )
        )
        await session.flush()
        person = SenderPrincipal("user", "client-2", [oscar.id], None)

        assert (
            await AgentRecipient._sender_role(
                _recipient(person),  # type: ignore[arg-type]
                session,
                "@oscar:test",
                {},
            )
            == "admin"
        )
        await session.rollback()


async def test_the_agents_owner_is_told_apart_from_everyone_else(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _member(session, "olivia", "member")
        person = SenderPrincipal("user", "client-1", [olivia.id], None)

        owner = await AgentRecipient._sender(
            _recipient(person, owner_id=olivia.id),  # type: ignore[arg-type]
            session,
            "@olivia:test",
            {},
        )
        someone = await AgentRecipient._sender(
            _recipient(person, owner_id="another-user"),  # type: ignore[arg-type]
            session,
            "@olivia:test",
            {},
        )

        assert owner == SenderFacts(role="member", is_owner=True)
        assert someone == SenderFacts(role="member", is_owner=False)


async def test_an_agent_the_platform_or_an_unclaimed_person_is_never_the_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Not even an agent the owner owns, or a platform message carrying the
    owner's authority: steering a turn is the owner's own say."""
    async with session_factory() as session:
        for principal in (
            None,
            SenderPrincipal("agent", "agent-1", [], "owner-1"),
            SenderPrincipal("platform", "platform", [], None, "owner-1"),
            SenderPrincipal("user", "client-2", [], None),
        ):
            facts = await AgentRecipient._sender(
                _recipient(principal, owner_id="owner-1"),  # type: ignore[arg-type]
                session,
                "@someone:test",
                {},
            )
            assert facts.is_owner is False


async def test_an_agent_without_an_owner_has_none_to_recognise(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        olivia = await _member(session, "olivia", "member")
        person = SenderPrincipal("user", "client-1", [olivia.id], None)
        facts = await AgentRecipient._sender(
            _recipient(person, owner_id=None),  # type: ignore[arg-type]
            session,
            "@olivia:test",
            {},
        )
        assert facts.is_owner is False


def test_ownership_rides_on_the_message_and_is_off_unless_said() -> None:
    inbound = InboundMessage(
        room_id="room-1",
        event_id="$1",
        sender="@olivia:test",
        timestamp=1,
        body="use the staging data",
        sender_name="olivia",
    )

    def built(**extra: bool) -> object:
        return message_event(
            room_id="room-1",
            bridge_id=None,
            channel_type="direct",
            event=inbound,
            addressed=True,
            sender_name="olivia",
            body="use the staging data",
            thread_id=None,
            **extra,
        ).payload

    assert built(sender_is_owner=True).sender_is_owner is True  # type: ignore[attr-defined]
    assert built().sender_is_owner is False  # type: ignore[attr-defined]
