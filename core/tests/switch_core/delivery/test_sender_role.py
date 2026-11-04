"""A delivered message says the sending person's role in the workspace, read
as the message arrives, so an agent need not trust what it was told earlier."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.message_events import message_event
from switch_core.clients.admin_messages import PLATFORM_MARKER
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver, SenderPrincipal
from switch_core.delivery.recipient import AgentRecipient
from switch_core.transport.types import InboundMessage
from tests.switch_core.gateway.agent_route_harness import add_agent


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
        olivia = await _member(session, "olivia", "owner")
        person = SenderPrincipal("user", "client-1", [olivia.id], None)

        assert await AgentRecipient._sender_details(
            _recipient(person, olivia.id),  # type: ignore[arg-type]
            session,
            "@olivia:test",
            {},
        ) == ("owner", True, olivia.id)

        membership = await session.get(TenantMember, (TENANT_ZERO_ID, olivia.id))
        assert membership is not None
        membership.role = "member"
        await session.flush()

        assert await AgentRecipient._sender_details(
            _recipient(person, olivia.id),  # type: ignore[arg-type]
            session,
            "@olivia:test",
            {},
        ) == ("member", True, olivia.id)


@pytest.mark.parametrize(
    "sender_kind",
    ["owner", "member", "unclaimed", "agent", "platform_on_behalf_of_owner", "unknown"],
)
async def test_sender_details_ride_on_the_message(
    session_factory: async_sessionmaker[AsyncSession], sender_kind: str
) -> None:
    async with session_factory() as session:
        owner = await _member(session, "owner", "owner")
        member = await _member(session, "member", "member")
        sender = "@sender:example.test"
        content: dict[str, object] = {}
        expected = {
            "owner": ("owner", True, owner.id),
            "member": ("member", False, member.id),
            "unclaimed": (None, False, sender),
            "agent": (None, False, None),
            "platform_on_behalf_of_owner": (None, True, owner.id),
            "unknown": (None, False, None),
        }[sender_kind]
        if sender_kind == "agent":
            agent = await add_agent(session, name="other-agent", owner_id=owner.id)
            client = await session.get(Client, agent.client_id)
            assert client is not None
            sender = client.transport_user_id
        elif sender_kind == "platform_on_behalf_of_owner":
            session.add(
                Client(transport_user_id=sender, display_name="Platform", type="admin")
            )
            content[PLATFORM_MARKER] = {
                "on_behalf_of": {"user_id": owner.id, "name": owner.name}
            }
        elif sender_kind != "unknown":
            client = Client(
                transport_user_id=sender, display_name="Sender", type="user"
            )
            bridge_client = Client(
                transport_user_id="@bridge:example.test",
                display_name="Bridge",
                type="bridge",
            )
            session.add_all([client, bridge_client])
            await session.flush()
            bridge = CollaborationBridge(
                type="discord",
                display_name="Discord",
                client_id=bridge_client.id,
                status="active",
            )
            session.add(bridge)
            await session.flush()
            account = ExternalUser(
                bridge_id=bridge.id,
                external_user_id="sender",
                external_username="sender",
                client_id=client.id,
            )
            session.add(account)
            await session.flush()
            claimant = {"owner": owner, "member": member}.get(sender_kind)
            if claimant is not None:
                session.add(
                    ExternalUserClaim(external_user_id=account.id, user_id=claimant.id)
                )
        await session.flush()
        resolver = AddressingResolver(
            room_store=RoomStore(),
            room_role_store=RoomRoleStore(),
            client_store=ClientStore(),
            agent_store=AgentStore(),
            external_user_store=ExternalUserStore(),
            live_connection_ids=set,
        )
        recipient = SimpleNamespace(
            _addressing=resolver,
            tenant_id=TENANT_ZERO_ID,
            agent=SimpleNamespace(owner_id=owner.id),
        )
        role, owns_agent, actor_id = await AgentRecipient._sender_details(
            recipient,  # type: ignore[arg-type]
            session,
            sender,
            content,
        )
        event = message_event(
            room_id="room-1",
            bridge_id=None,
            channel_type="direct",
            event=InboundMessage(
                room_id="room-1",
                event_id="$1",
                sender=sender,
                timestamp=1,
                body="hello",
                sender_name="Sender",
            ),
            addressed=True,
            sender_name="Sender",
            body="hello",
            thread_id=None,
            sender_role=role,
            sender_owns_agent=owns_agent,
            steering_actor_id=actor_id,
        )
        payload = event.model_dump(mode="json")["payload"]
        assert payload["sender"] == sender
        assert (
            payload["sender_role"],
            payload["sender_owns_agent"],
            payload["steering_actor_id"],
        ) == expected


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

        assert await AgentRecipient._sender_details(
            _recipient(person),  # type: ignore[arg-type]
            session,
            "@oscar:test",
            {},
        ) == ("admin", False, oscar.id)
        await session.rollback()
