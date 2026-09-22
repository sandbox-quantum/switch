"""Provisioning against the database, where every operation is a row.

Against a real PostgreSQL, because what is being tested is what the tables end
up holding — a membership, an arrival, and the absence of either.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, ClientRoom, Room, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.provisioning.postgres import (
    MEMBERSHIP_EVENT_TYPE,
    PostgresProvisioning,
    ProvisioningError,
    new_room_id,
)
from switch_core.tenant_context import tenant_scope
from switch_core.transport.invites import InviteBus
from tests.conftest import RLSHarness


async def _client(session: AsyncSession, name: str = "someone") -> Client:
    client = Client(
        matrix_user_id=f"@{name}-{uuid.uuid4().hex[:8]}:test",
        display_name=name,
        type="agent",
    )
    session.add(client)
    await session.flush()
    return client


async def _room(session: AsyncSession) -> Room:
    room = Room(matrix_room_id=new_room_id(), name="a room", description="")
    session.add(room)
    await session.flush()
    return room


async def _never(_room_id: str) -> None:
    """The arm of a registration a test is not exercising.

    `register` takes both arms together, so the one not under test has to be
    something — and something that fails the test if it is rung.
    """
    raise AssertionError("the other half of the registration was rung")


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
        assert rows[0].sender_id == user_id
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

        # By client id: the bus is keyed on `clients.id`, not on the handle,
        # because `matrix_user_id` is unique per tenant and every tenant's
        # admin client carries the same one.
        invites = InviteBus()
        invites.register(client_id, _handler, _never)
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

    async def test_removing_a_running_member_tells_it_to_stop_reading(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Deleting the row is only half of a removal.

        A running client holds its own subscription to the room, so the row
        going away leaves it reading a room it is no longer in. The homeserver
        used to end the delivery itself; here it has to be rung.

        The handler reads the membership rather than only recording that it was
        called, because the ordering is the other half of the promise: a client
        that responds to the wake-up by re-reading its rooms must not still see
        the one it was removed from. Asserting on the row after `kick_user` has
        returned would pass whichever side of the commit the ring happened on.
        """
        async with session_factory() as session:
            room = await _room(session)
            client = await _client(session)
            await session.commit()
            transport_room_id, user_id = room.matrix_room_id, client.matrix_user_id
            room_id, client_id = room.id, client.id

        told: list[str] = []
        seen_when_told: list[object] = []

        async def _handler(removed_from: str) -> None:
            told.append(removed_from)
            async with session_factory() as session:
                seen_when_told.append(
                    await session.get(
                        ClientRoom, {"client_id": client_id, "room_id": room_id}
                    )
                )

        invites = InviteBus()
        provisioning = _provisioning(session_factory, invites)
        await provisioning.invite_to_room(transport_room_id, user_id)
        invites.register(client_id, _never, _handler)
        await provisioning.kick_user(transport_room_id, user_id)

        assert told == [transport_room_id]
        # Rung after the row is gone, as seen from inside the handler itself.
        assert seen_when_told == [None]

    async def test_a_removal_names_the_client_row_not_the_handle(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`clients.matrix_user_id` is unique per tenant, not globally.

        Every tenant's admin client carries the same handle, so a bus keyed on
        it would tell whichever tenant's transport last claimed the slot to
        stop reading a room it is still in — and leave the one actually removed
        reading on. `invite_to_room` learned this; a removal is the same fact
        in reverse, and getting it wrong here is the worse half because there
        is no membership row for the caller to fall back to.
        """
        async with session_factory() as session:
            room = await _room(session)
            client = await _client(session)
            await session.commit()
            transport_room_id, user_id = room.matrix_room_id, client.matrix_user_id
            client_id = client.id

        told: list[str] = []

        async def _handler(removed_from: str) -> None:
            told.append(removed_from)

        invites = InviteBus()
        provisioning = _provisioning(session_factory, invites)

        # Registered under the handle, which is what the bus is *not* keyed on.
        invites.register(user_id, _never, _handler)
        await provisioning.kick_user(transport_room_id, user_id)
        assert told == []

        invites.register(client_id, _never, _handler)
        await provisioning.kick_user(transport_room_id, user_id)
        assert told == [transport_room_id]

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
        invites.register(client.id, _handler, _never)
        await _provisioning(session_factory, invites).invite_to_room(
            transport_room_id, user_id
        )

        assert woken == [transport_room_id]


class TestTwoTenantsSharingAHandle:
    """Two admin clients, one handle, and the invitation that used to go to
    the wrong one.

    `clients.matrix_user_id` is unique *per tenant*, and
    `ClientLifecycleService.ensure_system_client` deliberately gives every
    tenant's admin client the same `@switch-admin:<server>` — one row per
    tenant, one handle. The invite bus used to key its handler slot on that
    handle, process-wide, so the second admin client to start displaced the
    first and every invitation for either woke whichever had won.

    What made it silent is the return value. `invite` answered True because
    *a* handler existed, so `invite_to_room` took that as "a live client has
    joined itself" and returned without writing the membership row — while the
    woken transport, scoped to its own tenant, could not resolve a room in the
    other one and logged an error nobody was looking for. A tenant's rooms
    simply had no admin participant. The bus is keyed on `clients.id` now,
    which is a uuid primary key, so there is nothing left to disambiguate.

    Asked of `rls_harness.restricted` rather than the plain fixture, and it
    has to be: `ClientStore.get_by_matrix_user_id` calls `scalar_one_or_none`
    on a column that is unique per tenant, so on the owner connection — where
    no policy narrows the read — resolving the shared handle raises
    `MultipleResultsFound` before the bus is ever consulted. That is a known
    open item of this phase, and it is the policies that close it.
    """

    async def test_each_tenants_client_is_woken_for_its_own_room(
        self, rls_harness: RLSHarness
    ) -> None:
        handle = f"@switch-admin-{uuid.uuid4().hex[:8]}:test"
        tenants = [f"tenant-{uuid.uuid4().hex[:8]}" for _ in range(2)]
        rooms: dict[str, str] = {}
        clients: dict[str, str] = {}
        for tenant_id in tenants:
            # Each tenant's rows on a session opened *inside* that tenant's
            # binding: the `set_config` rides `after_begin`, so a scope entered
            # around an already-open transaction stamps nothing.
            async with tenant_session(rls_harness.owner, tenant_id) as session:
                session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
                await session.flush()
                client = Client(
                    tenant_id=tenant_id,
                    matrix_user_id=handle,
                    display_name="admin",
                    type="admin",
                )
                room = Room(
                    tenant_id=tenant_id,
                    matrix_room_id=new_room_id(),
                    name="a room",
                    description="",
                )
                session.add_all([client, room])
                await session.commit()
                clients[tenant_id] = client.id
                rooms[tenant_id] = room.matrix_room_id

        woken: dict[str, list[str]] = {tenant_id: [] for tenant_id in tenants}

        def _handler_for(tenant_id: str) -> Any:
            async def _handler(invited_to: str) -> None:
                woken[tenant_id].append(invited_to)

            return _handler

        invites = InviteBus()
        for tenant_id in tenants:
            invites.register(clients[tenant_id], _handler_for(tenant_id), _never)

        provisioning = _provisioning(rls_harness.restricted, invites)
        for tenant_id in tenants:
            with tenant_scope(tenant_id):
                await provisioning.invite_to_room(rooms[tenant_id], handle)

        for tenant_id in tenants:
            assert woken[tenant_id] == [rooms[tenant_id]], (
                f"tenant {tenant_id}'s admin client was not the one woken for "
                "its own room; the invite bus routed by the shared handle"
            )
