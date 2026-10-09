"""A gateway user's member client is that user in person, to every rule that
asks who a sender is: addressing an agent, commanding it (`!reset`,
`!compact`, `!interrupt` are gated on the same decision, asked with no event
content), and answering its requests from a platform.

Real Postgres, real stores: the resolution is a chain of lookups, and a fake
for each link would test the fakes.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import (
    ADDRESSING_DENIED_MESSAGE,
    AddressingResolver,
    SenderPrincipal,
)
from tests.switch_core.gateway.agent_route_harness import add_agent


def _resolver() -> AddressingResolver:
    return AddressingResolver(
        room_store=RoomStore(),
        room_role_store=RoomRoleStore(),
        client_store=ClientStore(),
        agent_store=AgentStore(),
        external_user_store=ExternalUserStore(),
        live_connection_ids=set,
    )


async def _member(session: AsyncSession, name: str) -> tuple[User, Client]:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    client = Client(
        transport_user_id=f"@switch-member-{user.id}:test",
        display_name=name,
        type=MEMBER_CLIENT_TYPE,
        user_id=user.id,
    )
    session.add(client)
    await session.flush()
    return user, client


async def test_a_member_client_resolves_to_its_user_with_no_claims(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user, client = await _member(session, "alice")
        principal = await _resolver().resolve_sender(session, client.transport_user_id)
    assert principal == SenderPrincipal("user", client.id, [user.id], None)


async def test_a_member_client_whose_user_is_gone_resolves_to_nobody(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        _, client = await _member(session, "alice")
        client.user_id = None
        await session.flush()
        assert (
            await _resolver().resolve_sender(session, client.transport_user_id) is None
        )


async def test_an_owner_only_agent_admits_its_owner_and_refuses_another_member(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, owner_client = await _member(session, "alice")
        _, other_client = await _member(session, "bob")
        agent = await add_agent(session, name="private", owner_id=owner.id)
        agent.addressing_policy = owner_only_policy([]).model_dump()
        room = Room(transport_room_id="!r:test", name="r", description="")
        session.add(room)
        await session.flush()
        resolver = _resolver()

        for content in ({"body": "@private hi"}, None):
            # With content: a message. Without: a room command, which the
            # agent gates on exactly this decision.
            allowed = await resolver.permitted(
                session,
                agent=agent,
                room_id=room.id,
                sender=owner_client.transport_user_id,
                content=content,
            )
            assert allowed.allowed is True
            refused = await resolver.permitted(
                session,
                agent=agent,
                room_id=room.id,
                sender=other_client.transport_user_id,
                content=content,
            )
            assert refused.allowed is False
            assert refused.refusal == ADDRESSING_DENIED_MESSAGE
