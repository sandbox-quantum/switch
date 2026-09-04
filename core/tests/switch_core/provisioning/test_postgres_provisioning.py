"""Provisioning against the database, where every operation is a row.

Against a real PostgreSQL, because what is being tested is what the tables end
up holding — a membership, an arrival, and the absence of either.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, ClientRoom, Room
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.provisioning.postgres import (
    MEMBERSHIP_EVENT_TYPE,
    PostgresProvisioning,
    ProvisioningError,
    new_room_id,
)
from switch_core.transport.invites import InviteBus


async def _client(session: AsyncSession, name: str = "someone") -> Client:
    client = Client(
        matrix_user_id=f"@{name}-{uuid.uuid4().hex[:8]}:test",
        display_name=name,
        type="agent",
        password=str(uuid.uuid4()),
    )
    session.add(client)
    await session.flush()
    return client


async def _room(session: AsyncSession) -> Room:
    room = Room(matrix_room_id=new_room_id(), name="a room", description="")
    session.add(room)
    await session.flush()
    return room


def _provisioning(
    session_factory: async_sessionmaker[AsyncSession],
    invites: InviteBus | None = None,
) -> PostgresProvisioning:
    return PostgresProvisioning(
        session_factory=session_factory,
        room_store=RoomStore(),
        client_store=ClientStore(),
        message_store=MessageStore(),
        invites=invites or InviteBus(),
    )


class TestAccounts:
    async def test_registering_writes_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The caller's `clients` row is the account; there is no second
        system to create one in."""
        await _provisioning(session_factory).register_user("@a:test", "secret")

        async with session_factory() as session:
            assert await ClientStore().get_by_matrix_user_id(session, "@a:test") is None

    async def test_a_password_is_checked_against_the_client_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            client = await _client(session)
            await session.commit()
            user_id, password = client.matrix_user_id, client.password

        provisioning = _provisioning(session_factory)
        assert await provisioning.verify_login(user_id, password) is True
        assert await provisioning.verify_login(user_id, "wrong") is False
        assert await provisioning.verify_login("@nobody:test", password) is False


class TestRooms:
    async def test_creating_a_room_mints_an_id_and_writes_no_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The room is the caller's to create. A second record of it here
        would be a second thing to keep in step."""
        provisioning = _provisioning(session_factory)

        first = await provisioning.create_room("a", "b")
        second = await provisioning.create_room("a", "b")

        assert first != second
        async with session_factory() as session:
            assert await RoomStore().get_by_matrix_room_id(session, first) is None


class TestMembership:
    async def test_a_member_who_is_not_running_is_written_in_directly(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            client = await _client(session, "nova")
            await session.commit()
            room_id, transport_room_id = room.id, room.matrix_room_id
            client_id, user_id = client.id, client.matrix_user_id

        await _provisioning(session_factory).invite_to_room(transport_room_id, user_id)

        async with session_factory() as session:
            membership = await session.get(
                ClientRoom, {"client_id": client_id, "room_id": room_id}
            )
            rows = await MessageStore().list_for_room(
                session, room_id, after_seq=0, limit=10
            )

        assert membership is not None
        # The arrival explains the membership, and carries no rendered
        # sentence: how it reads is the reader's to phrase.
        assert [row.event_type for row in rows] == [MEMBERSHIP_EVENT_TYPE]
        assert rows[0].sender_matrix_id == user_id
        assert rows[0].sender_name == "nova"
        assert rows[0].body is None

    async def test_a_running_member_is_woken_and_joins_itself(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Waking the client is what leaves its transport watching the room.
        Writing the membership underneath it would put it in a room it never
        reads."""
        async with session_factory() as session:
            room = await _room(session)
            client = await _client(session)
            await session.commit()
            room_id, transport_room_id = room.id, room.matrix_room_id
            client_id, user_id = client.id, client.matrix_user_id

        woken: list[str] = []

        async def _handler(invited_to: str) -> None:
            woken.append(invited_to)

        invites = InviteBus()
        invites.register(user_id, _handler)
        await _provisioning(session_factory, invites).invite_to_room(
            transport_room_id, user_id
        )

        assert woken == [transport_room_id]
        async with session_factory() as session:
            membership = await session.get(
                ClientRoom, {"client_id": client_id, "room_id": room_id}
            )
        # Left to the client, which joins itself in response.
        assert membership is None

    async def test_inviting_a_member_who_is_already_in_does_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            client = await _client(session)
            await session.commit()
            transport_room_id, user_id = room.matrix_room_id, client.matrix_user_id
            room_id, client_id = room.id, client.id

        provisioning = _provisioning(session_factory)
        await provisioning.invite_to_room(transport_room_id, user_id)
        await provisioning.invite_to_room(transport_room_id, user_id)

        async with session_factory() as session:
            rows = await MessageStore().list_for_room(
                session, room_id, after_seq=0, limit=10
            )
            membership = await session.get(
                ClientRoom, {"client_id": client_id, "room_id": room_id}
            )

        assert membership is not None
        assert len(rows) == 1

    async def test_removing_a_member_takes_the_membership_away(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            client = await _client(session)
            await session.commit()
            transport_room_id, user_id = room.matrix_room_id, client.matrix_user_id
            room_id, client_id = room.id, client.id

        provisioning = _provisioning(session_factory)
        await provisioning.invite_to_room(transport_room_id, user_id)
        await provisioning.kick_user(transport_room_id, user_id)

        async with session_factory() as session:
            membership = await session.get(
                ClientRoom, {"client_id": client_id, "room_id": room_id}
            )
        assert membership is None

    async def test_removing_a_member_who_is_already_out_is_success(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            client = await _client(session)
            await session.commit()
            transport_room_id, user_id = room.matrix_room_id, client.matrix_user_id

        await _provisioning(session_factory).kick_user(transport_room_id, user_id)

    async def test_a_room_or_member_switch_does_not_know_is_an_error(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            await session.commit()
            transport_room_id = room.matrix_room_id

        provisioning = _provisioning(session_factory)
        with pytest.raises(ProvisioningError):
            await provisioning.invite_to_room("sw_room_nowhere", "@a:test")
        with pytest.raises(ProvisioningError):
            await provisioning.invite_to_room(transport_room_id, "@nobody:test")

    async def test_a_recorded_member_is_still_woken(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A row is not proof that a running client is watching the room.

        Something else may have written it, and there is a window at startup
        where a client is running but not yet on the bus. Returning early on
        the row would make a deaf membership permanent: every later
        invitation would find the same row and stop.
        """
        async with session_factory() as session:
            room = await _room(session)
            client = await _client(session)
            await session.commit()
            transport_room_id, user_id = room.matrix_room_id, client.matrix_user_id

        woken: list[str] = []

        async def _handler(invited_to: str) -> None:
            woken.append(invited_to)

        provisioning = _provisioning(session_factory)
        await provisioning.invite_to_room(transport_room_id, user_id)

        invites = InviteBus()
        invites.register(user_id, _handler)
        await _provisioning(session_factory, invites).invite_to_room(
            transport_room_id, user_id
        )

        assert woken == [transport_room_id]
