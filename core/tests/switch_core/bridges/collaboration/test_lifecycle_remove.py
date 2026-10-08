from __future__ import annotations

import re
import uuid
from unittest.mock import MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
    _workspace_consumer_localpart,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    Room,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore


class _ClientLifecycle:
    """Deletes the row in the caller's transaction, as the real service does,
    and remembers what it was asked for. The real one also stops a live
    client; none of these are running, and a MagicMock here would let a
    missing deletion pass.

    `delete_record` deliberately does not commit: the client rows have to join
    the bridge teardown's transaction, and a fake that committed on its own
    would pass a removal that commits them separately.
    """

    def __init__(self) -> None:
        self.removed: list[str] = []
        self.stopped: list[str] = []

    async def stop(self, client_id: str) -> None:
        self.stopped.append(client_id)

    async def delete_record(self, session: AsyncSession, client_id: str) -> None:
        self.removed.append(client_id)
        await ClientStore().delete(session, client_id)


class _FailingClientLifecycle(_ClientLifecycle):
    """Deletes clients until the nth, which raises.

    Stands in for anything that can go wrong partway through the teardown — a
    foreign key, a dropped connection — so the transaction boundary can be
    asserted rather than assumed.
    """

    def __init__(self, *, fail_on_nth: int) -> None:
        super().__init__()
        self._fail_on_nth = fail_on_nth

    async def delete_record(self, session: AsyncSession, client_id: str) -> None:
        if len(self.removed) + 1 == self._fail_on_nth:
            raise RuntimeError(f"deleting client {client_id} failed")
        await super().delete_record(session, client_id)


def _service(
    session_factory: async_sessionmaker[AsyncSession],
    client_lifecycle: _ClientLifecycle,
) -> CollaborationBridgeLifecycleService:
    """Build the service with real stores; mock the deps remove() never touches."""
    return CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        bridge_message_map_store=MagicMock(),
        room_store=RoomStore(),
        agent_store=MagicMock(),
        client_store=MagicMock(),
        client_lifecycle=client_lifecycle,
        room_service=MagicMock(),
        provisioning=MagicMock(),
        session_factory=session_factory,
        config=MagicMock(),
        client_factory=MagicMock(),
        session_activity_listener=MagicMock(),
        session_activity_service=MagicMock(),
        connections=MagicMock(),
    )


async def _make_client(session: AsyncSession, *, client_type: str) -> str:
    client = Client(
        transport_user_id=f"@{client_type}-{uuid.uuid4().hex[:8]}:test",
        display_name=f"{client_type} client",
        type=client_type,
    )
    session.add(client)
    await session.flush()
    return client.id


async def _make_bridge(session: AsyncSession) -> tuple[str, str]:
    client_id = await _make_client(session, client_type="bridge")
    bridge = CollaborationBridge(
        type="mattermost",
        display_name="MM",
        client_id=client_id,
        status="active",
    )
    session.add(bridge)
    await session.flush()
    return bridge.id, client_id


async def _make_bridged_room(session: AsyncSession, *, bridge_id: str) -> str:
    room = Room(
        transport_room_id=f"!{uuid.uuid4().hex[:8]}:test",
        name="bridged room",
        description="mirror of an external channel",
        bridge_id=bridge_id,
        channel_type="channel_public",
        external_channel_id="C123",
    )
    session.add(room)
    await session.flush()
    return room.id


async def _make_external_user(
    session: AsyncSession, *, bridge_id: str
) -> tuple[str, str]:
    client_id = await _make_client(session, client_type="external_user")
    user = ExternalUser(
        bridge_id=bridge_id,
        external_user_id=f"U{uuid.uuid4().hex[:8]}",
        external_username="alice",
        client_id=client_id,
    )
    session.add(user)
    await session.flush()
    return user.id, client_id


@pytest.mark.asyncio
async def test_remove_detaches_dependent_rooms(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Removing a bridge that still has dependent rooms must not FK-violate.

    Regression for the DELETE /gateway/collaborations 500: rooms.bridge_id references
    collaboration_bridges.id with no ON DELETE rule, so deleting the bridge
    while rooms point at it raised a raw FK error. remove() now detaches the
    rooms (non-destructive) before deleting the bridge.
    """
    service = _service(session_factory, _ClientLifecycle())
    async with session_factory() as session:
        bridge_id, _ = await _make_bridge(session)
        room_id = await _make_bridged_room(session, bridge_id=bridge_id)
        external_user_id, _ = await _make_external_user(session, bridge_id=bridge_id)
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await CollaborationBridgeStore().get(session, bridge_id) is None

        # Room survives, just detached from the (now-gone) bridge.
        room = await RoomStore().get(session, room_id)
        assert room is not None
        assert room.bridge_id is None
        assert room.channel_type is None
        assert room.external_channel_id is None

        # External users for the bridge are cleaned up (pre-existing behavior).
        assert await ExternalUserStore().get(session, external_user_id) is None


@pytest.mark.asyncio
async def test_remove_without_dependent_rooms_still_deletes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service = _service(session_factory, _ClientLifecycle())
    async with session_factory() as session:
        bridge_id, _ = await _make_bridge(session)
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await CollaborationBridgeStore().get(session, bridge_id) is None


@pytest.mark.asyncio
async def test_disconnecting_takes_every_identity_switch_made_for_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The bridge's own Matrix client and the human actor behind each person it saw.

    These were left behind, and the bridge one is not merely untidy: its Matrix
    name is derived from the app's type and display name, so disconnecting an
    app and reconnecting one named the same hit the leftover row —
    `duplicate key value violates unique constraint "clients_matrix_user_id_key"`.
    """
    service = _service(session_factory, _ClientLifecycle())
    async with session_factory() as session:
        bridge_id, workspace_consumer_id = await _make_bridge(session)
        _external_user_id, human_actor_client_id = await _make_external_user(
            session, bridge_id=bridge_id
        )
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await ClientStore().get(session, workspace_consumer_id) is None
        assert await ClientStore().get(session, human_actor_client_id) is None


@pytest.mark.asyncio
async def test_identities_that_were_in_rooms_go_too(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The case that actually happens: identities with room memberships.

    Both of these clients have been in a room — the bridge because it carries
    the channel, the human actor because the person it stands for spoke there — and
    `client_rooms` references `clients` with no `ON DELETE` rule, so the
    memberships have to go before the client rows can.
    """
    service = _service(session_factory, _ClientLifecycle())
    async with session_factory() as session:
        bridge_id, workspace_consumer_id = await _make_bridge(session)
        room_id = await _make_bridged_room(session, bridge_id=bridge_id)
        _external_user_id, human_actor_client_id = await _make_external_user(
            session, bridge_id=bridge_id
        )
        await RoomStore().add_client(session, workspace_consumer_id, room_id)
        await RoomStore().add_client(session, human_actor_client_id, room_id)
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await ClientStore().get(session, workspace_consumer_id) is None
        assert await ClientStore().get(session, human_actor_client_id) is None
        # The room outlives the connection as an internal-only room, with
        # nobody left claiming to be a member on the platform's behalf.
        assert await RoomStore().get(session, room_id) is not None
        assert await RoomStore().get_client_ids(session, room_id) == []


@pytest.mark.asyncio
async def test_a_failed_client_delete_leaves_the_bridge_intact(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The teardown is one transaction, so a failure part-way undoes all of it.

    If the bridge committed separately from its clients, a raise part-way
    would leave clients that nothing points at and nothing retries. Rolled
    back instead, the operator can try again with everything still in place.
    """
    lifecycle = _FailingClientLifecycle(fail_on_nth=2)
    service = _service(session_factory, lifecycle)
    async with session_factory() as session:
        bridge_id, workspace_consumer_id = await _make_bridge(session)
        room_id = await _make_bridged_room(session, bridge_id=bridge_id)
        _first_id, first_human_actor = await _make_external_user(
            session, bridge_id=bridge_id
        )
        _second_id, second_human_actor = await _make_external_user(
            session, bridge_id=bridge_id
        )
        await RoomStore().add_client(session, workspace_consumer_id, room_id)
        await RoomStore().add_client(session, first_human_actor, room_id)
        await session.commit()

    with pytest.raises(RuntimeError):
        await service.remove(bridge_id)

    async with session_factory() as session:
        # Nothing committed: the bridge, its rooms, its external users and
        # every one of its clients are as they were.
        assert await CollaborationBridgeStore().get(session, bridge_id) is not None
        room = await RoomStore().get(session, room_id)
        assert room is not None
        assert room.bridge_id == bridge_id
        assert await ExternalUserStore().get_by_bridge(session, bridge_id) != []
        for client_id in (workspace_consumer_id, first_human_actor, second_human_actor):
            assert await ClientStore().get(session, client_id) is not None
        assert sorted(await RoomStore().get_client_ids(session, room_id)) == sorted(
            [workspace_consumer_id, first_human_actor]
        )


@pytest.mark.asyncio
async def test_an_app_with_nobody_on_it_still_loses_its_own_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Louis's case exactly: a Telegram connection nobody had messaged yet.
    service = _service(session_factory, _ClientLifecycle())
    async with session_factory() as session:
        bridge_id, workspace_consumer_id = await _make_bridge(session)
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await ClientStore().get(session, workspace_consumer_id) is None


class TestTheWorkspaceConsumerName:
    """Why deleting the row is necessary but not sufficient.

    The homeserver has no API for removing an account, so the Matrix user
    outlives the row. Reusing the name would then adopt an account whose
    password Switch no longer holds — and shared-secret registration reports an
    existing user as success without applying the new one, which reads as a
    working connection that can never log in. A quiet failure in place of a
    loud one is the wrong trade, so each registration takes a fresh name.
    """

    def test_two_connections_of_the_same_name_do_not_collide(self) -> None:
        first = _workspace_consumer_localpart("telegram", "Telegram louiss")
        second = _workspace_consumer_localpart("telegram", "Telegram louiss")

        assert first != second

    def test_the_name_still_says_which_app_it_is(self) -> None:
        # It shows up as a Matrix user in rooms; a pure uuid would be unreadable.
        localpart = _workspace_consumer_localpart("telegram", "Telegram louiss")

        assert localpart.startswith("switch-bridge-telegram-telegram-louiss")

    def test_it_stays_a_legal_localpart(self) -> None:
        localpart = _workspace_consumer_localpart("slack", "Ops & Eng (US)")

        assert re.fullmatch(r"[a-z0-9._=/-]+", localpart)


@pytest.mark.asyncio
async def test_a_starting_bridge_is_recorded_in_the_rooms_it_carries(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Membership is a row now, and nothing had ever written the bridge's.

    Its rooms were expressed by inviting it and letting the homeserver
    remember; once a client reads its rooms from `client_rooms`, a bridge with
    no rows is in none of them and relays nothing outward — while still
    receiving, because inbound posts into a room by id.
    """
    service = _service(session_factory, _ClientLifecycle())
    async with session_factory() as session:
        bridge_id, client_id = await _make_bridge(session)
        room_id = await _make_bridged_room(session, bridge_id=bridge_id)
        other_bridge_id, _ = await _make_bridge(session)
        elsewhere_id = await _make_bridged_room(session, bridge_id=other_bridge_id)
        await session.commit()

    await service._record_bridge_memberships(bridge_id, TENANT_ZERO_ID, client_id)
    # Again, because a bridge starts more than once.
    await service._record_bridge_memberships(bridge_id, TENANT_ZERO_ID, client_id)

    async with session_factory() as session:
        assert await RoomStore().get_client_ids(session, room_id) == [client_id]
        assert await RoomStore().get_client_ids(session, elsewhere_id) == []


@pytest.mark.asyncio
async def test_removing_a_bridge_forgets_that_it_was_preconfigured(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Bridge ids are never reused, so an entry left behind is one nothing
    will ever remove."""
    service = _service(session_factory, _ClientLifecycle())
    async with session_factory() as session:
        bridge_id, _ = await _make_bridge(session)
        await session.commit()
    service._preconfigured.add(bridge_id)

    await service.remove(bridge_id)

    assert bridge_id not in service._preconfigured


class _WithdrawingAdapter:
    def __init__(self, events: list[str], *, fail: bool = False) -> None:
        self._events = events
        self._fail = fail

    async def withdraw(self) -> None:
        self._events.append("withdraw")
        if self._fail:
            raise RuntimeError("the platform would not let go")


class _RunningBridge:
    def __init__(self, adapter: _WithdrawingAdapter, events: list[str]) -> None:
        self.adapter = adapter
        self._events = events

    async def stop(self) -> None:
        self._events.append("stop")


@pytest.mark.asyncio
async def test_a_removed_bridge_withdraws_from_its_platform_before_it_stops(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Withdrawing needs the bridge still running — its clients and its
    platform credential — and only a removal does it, never a restart."""
    service = _service(session_factory, _ClientLifecycle())
    async with session_factory() as session:
        bridge_id, _ = await _make_bridge(session)
        await session.commit()
    events: list[str] = []
    service._bridges[bridge_id] = _RunningBridge(  # type: ignore[assignment]
        _WithdrawingAdapter(events), events
    )

    await service.remove(bridge_id)

    assert events == ["withdraw", "stop"]


@pytest.mark.asyncio
async def test_a_bridge_that_cannot_withdraw_is_still_removed(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The removal is what someone asked for; what was left behind is logged."""
    service = _service(session_factory, _ClientLifecycle())
    async with session_factory() as session:
        bridge_id, _ = await _make_bridge(session)
        await session.commit()
    events: list[str] = []
    service._bridges[bridge_id] = _RunningBridge(  # type: ignore[assignment]
        _WithdrawingAdapter(events, fail=True), events
    )

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await CollaborationBridgeStore().get(session, bridge_id) is None
    assert "could not let go" in caplog.text


class _RegisteringClientLifecycle(_ClientLifecycle):
    """Also creates the bridge's client row, as registration needs."""

    def __init__(self, factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__()
        self._factory = factory

    async def create_client(
        self, *, client_type: str, display_name: str, localpart: str
    ) -> Client:
        async with self._factory() as session:
            client = Client(
                transport_user_id=f"@{localpart}-{uuid.uuid4().hex[:8]}:test",
                display_name=display_name,
                type=client_type,
                tenant_id=TENANT_ZERO_ID,
            )
            session.add(client)
            await session.commit()
            return client


@pytest.mark.asyncio
async def test_a_bridge_that_cannot_start_is_not_left_registered(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stored and not startable would be a row that fails every boot — and,
    for an install, a second bridge on the customer's next attempt."""
    service = _service(session_factory, _RegisteringClientLifecycle(session_factory))
    service.register_adapter(
        "mattermost", MattermostAdapter, MattermostConnectionConfig
    )

    async def refuse(bridge_id: str) -> None:
        raise RuntimeError("the bridge could not start")

    async def accept(connection_config: dict[str, object]) -> None:
        return None

    async def reachable(bridge_type: str, connection_config: object) -> None:
        return None

    monkeypatch.setattr(service, "check_outbound_urls", reachable)
    monkeypatch.setattr(service, "start", refuse)
    monkeypatch.setattr(
        MattermostAdapter, "verify_credentials", classmethod(lambda cls, c: accept(c))
    )

    with pytest.raises(RuntimeError, match="could not start"):
        await service.register(
            bridge_type="mattermost",
            display_name="MM",
            connection_config={
                "url": "https://mm.example",
                "admin_user": "admin",
                "admin_password": "pw",
                "team_name": "team",
            },
            channel_creation_enabled=False,
            preconfigured=False,
        )

    async with session_factory() as session:
        assert await CollaborationBridgeStore().get_all(session) == []


@pytest.mark.asyncio
async def test_a_failed_cleanup_does_not_hide_why_the_bridge_could_not_start(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    service = _service(session_factory, _RegisteringClientLifecycle(session_factory))
    service.register_adapter(
        "mattermost", MattermostAdapter, MattermostConnectionConfig
    )

    async def refuse(bridge_id: str) -> None:
        raise RuntimeError("the bridge could not start")

    async def remove_fails(bridge_id: str) -> None:
        raise RuntimeError("the database went away")

    async def accept(connection_config: dict[str, object]) -> None:
        return None

    async def reachable(bridge_type: str, connection_config: object) -> None:
        return None

    monkeypatch.setattr(service, "check_outbound_urls", reachable)
    monkeypatch.setattr(service, "start", refuse)
    monkeypatch.setattr(service, "remove", remove_fails)
    monkeypatch.setattr(
        MattermostAdapter, "verify_credentials", classmethod(lambda cls, c: accept(c))
    )

    with pytest.raises(RuntimeError, match="could not start"):
        await service.register(
            bridge_type="mattermost",
            display_name="MM",
            connection_config={
                "url": "https://mm.example",
                "admin_user": "admin",
                "admin_password": "pw",
                "team_name": "team",
            },
            channel_creation_enabled=False,
            preconfigured=False,
        )

    assert "could not be removed after failing to start" in caplog.text
