"""One process listens for a collaboration bridge; every other runs it quietly.

Against real PostgreSQL, two "processes" on one database, each wired the way
`main` wires one for bridges: its own message listener and signal bus, process
lease, ownership and cursor writer, client lifecycle, room service and bridge
lifecycle. Both run the bridge. The platform here (`Platform`) is the one
messaging service both copies talk to: it knows which copies listen to it and
records what is posted to it, so a test can say that a reply reached the
channel once and that only one process holds the connection.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients import workspace_consumer
from switch_core.db.models import (
    TENANT_ZERO_ID,
    BridgeMessageMap,
    Client,
    CollaborationBridge,
    ExternalUser,
    Message,
)
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomCreateConfig
from switch_core.tenant_context import tenant_scope
from tests.switch_core.bridges.collaboration.bridge_processes import (
    CHANNEL,
    LOUD_CHAT,
    TIMEOUT,
    Bridge,
    Chat,
    Platform,
    Process,
    add_bridge,
    inbound_post,
    process_on,
    say_in_room,
)


class _PublisherThatFailsToStop:
    """A bridge's session-activity publisher whose stop raises. Stands in for
    anything that can go wrong as a bridge stops, before its adapter does.
    It can be swapped in while the bridge is still starting: the adapter
    listens before the bridge starts its publisher, so `start` has to work."""

    def start(self) -> None:
        pass

    async def stop(self) -> None:
        raise RuntimeError("the publisher's task had died")


@pytest.fixture
def platform() -> AsyncIterator[Platform] | Any:
    platform = Platform()
    Chat.platform = platform
    return platform


@pytest.fixture
async def bridge(session_factory: async_sessionmaker[AsyncSession]) -> Bridge:
    """A bridge on the fake platform carrying one room, bridged to `CHANNEL`,
    and someone in the room whose messages the bridge relays out."""
    return await add_bridge(session_factory)


@pytest.fixture
async def processes(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[list[Process]]:
    started: list[Process] = []
    try:
        yield started
    finally:
        for process in started:
            await process.stop()


async def _boot_two(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    processes: list[Process],
) -> tuple[Process, Process]:
    for _ in range(2):
        process = await process_on(postgres_url, session_factory)
        processes.append(process)
        await process.boot()
    # The first balance of each cannot see the other; balance once more now
    # that both leases are there, as the interval would.
    for process in processes:
        await process.ownership.balance()
    for process in processes:
        await process.settled()
    return processes[0], processes[1]


def _holder(two: tuple[Process, Process], bridge_id: str) -> tuple[Process, Process]:
    a, b = two
    holders = [p for p in (a, b) if p.bridges.holds(bridge_id)]
    assert len(holders) == 1
    return (a, b) if holders[0] is a else (b, a)


async def _eventually(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(TIMEOUT):
        while not check():
            await asyncio.sleep(0.02)


async def _posted(platform: Platform, count: int) -> list[str]:
    await _eventually(lambda: len(platform.posts) >= count)
    # Long enough for a second relay, had there been one, to have posted.
    await asyncio.sleep(0.5)
    return platform.posted()


async def _room_bodies(
    session_factory: async_sessionmaker[AsyncSession], room_id: str, sender: str
) -> list[str | None]:
    async with session_factory() as session:
        rows = (
            await session.scalars(
                select(Message.body)
                .where(
                    Message.room_id == room_id,
                    Message.sender_id == sender,
                    Message.event_type == "m.room.message",
                )
                .order_by(Message.seq)
            )
        ).all()
    return list(rows)


class TestOneConnection:
    async def test_one_process_listens_and_the_other_runs_quietly(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )

        # A bridge connects in its own task, after it is started.
        await _eventually(lambda: len(platform.listening) == 1)
        await asyncio.sleep(0.5)
        assert len(platform.listening) == 1
        held = holder.bridges.get(bridge.bridge_id)
        copy = quiet.bridges.get(bridge.bridge_id)
        assert held is not None and held.active
        assert copy is not None and not copy.active
        assert platform.listening == [held.adapter]

    async def test_a_reply_is_posted_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        await _boot_two(postgres_url, session_factory, processes)

        await say_in_room(session_factory, bridge, "hello channel")

        assert await _posted(platform, 1) == ["hello channel"]


class TestHandingOver:
    async def test_the_next_holder_resumes_with_no_repeat_and_no_gap(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        holder, other = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        await say_in_room(session_factory, bridge, "one")
        await _posted(platform, 1)

        await holder.stop()
        # Said while no process listens for the bridge.
        await say_in_room(session_factory, bridge, "two")
        await other.ownership.balance()
        await say_in_room(session_factory, bridge, "three")

        assert await _posted(platform, 3) == ["one", "two", "three"]
        assert other.bridges.holds(bridge.bridge_id)
        assert len(platform.listening) == 1

    async def test_a_post_the_platform_refused_is_tried_again(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            workspace_consumer, "RETRY_RELAY_AFTER_SECONDS", (0.05, 0.05)
        )
        _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        platform.refusing = 2
        await say_in_room(session_factory, bridge, "one")
        await say_in_room(session_factory, bridge, "two")

        assert sorted(await _posted(platform, 2)) == ["one", "two"]

    async def test_a_refused_post_still_being_tried_is_posted_by_the_next_holder(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(workspace_consumer, "RETRY_RELAY_AFTER_SECONDS", (60.0,))
        holder, other = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        platform.refusing = 1
        await say_in_room(session_factory, bridge, "one")
        await say_in_room(session_factory, bridge, "two")
        assert await _posted(platform, 1) == ["two"]

        await holder.stop()
        await other.ownership.balance()

        assert await _posted(platform, 2) == ["two", "one"]

    async def test_a_bridge_that_fails_to_stop_still_closes_its_connection(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        """The hand-over's stop raised before it reached the adapter. The
        lease is let go of all the same, so the connection is closed first:
        the next holder's must not run beside it."""
        holder, other = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        held = holder.bridges.get(bridge.bridge_id)
        assert held is not None
        await _eventually(lambda: platform.listening == [held.adapter])
        held._activity_publisher = _PublisherThatFailsToStop()  # type: ignore[assignment]

        # As `main` shuts a process down: its owned work, then its lease.
        await holder.ownership.stop()
        await holder.lease.stop()
        await other.ownership.balance()

        assert holder.bridges.get(bridge.bridge_id) is None
        taken = other.bridges.get(bridge.bridge_id)
        assert taken is not None and taken.active
        await _eventually(lambda: platform.listening == [taken.adapter])

    async def test_what_the_last_holder_posted_is_not_posted_again(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        """A holder that died after posting a message and before storing how
        far it had got leaves the message for the next holder to read again.
        Its claim on the post is what stops the second one."""
        posted = await say_in_room(session_factory, bridge, "posted before it died")
        async with session_factory() as session:
            session.add(
                BridgeMessageMap(
                    bridge_id=bridge.bridge_id,
                    external_channel_id=CHANNEL,
                    transport_event_id=posted,
                    external_post_id="post-from-the-last-holder",
                )
            )
            await session.commit()

        await _boot_two(postgres_url, session_factory, processes)
        await say_in_room(session_factory, bridge, "said after")

        assert await _posted(platform, 1) == ["said after"]

    async def test_a_post_the_last_holder_claimed_and_never_sent_is_posted(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        """A holder that died between claiming a message and posting it
        leaves a claim with no post. The next holder reaches it once that
        holder's lease has lapsed, by when the claim is long past any post in
        flight, and posts it. A claim as fresh as a post in flight is left."""
        claims = {
            "claimed before it died": func.now() - timedelta(seconds=30),
            "claimed just now": func.now(),
        }
        for body, claimed_at in claims.items():
            event_id = await say_in_room(session_factory, bridge, body)
            async with session_factory() as session:
                session.add(
                    BridgeMessageMap(
                        bridge_id=bridge.bridge_id,
                        external_channel_id=CHANNEL,
                        transport_event_id=event_id,
                        external_post_id=None,
                        created_at=claimed_at,
                    )
                )
                await session.commit()

        await _boot_two(postgres_url, session_factory, processes)
        await say_in_room(session_factory, bridge, "said after")

        assert await _posted(platform, 2) == ["claimed before it died", "said after"]

    async def test_a_post_delivered_again_to_the_next_holder_is_stored_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        """As Slack does with an event whose acknowledgement it did not get:
        the holder stored it and stopped before acknowledging it, and the
        platform delivers it again to whoever listens next."""
        holder, other = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        await platform.say(user_id="U1", text="only once", ref="m1")
        await holder.stop()
        await other.ownership.balance()

        await platform.say(user_id="U1", text="only once", ref="m1")

        async with session_factory() as session:
            people = (
                await session.scalars(
                    select(ExternalUser.client_id).where(
                        ExternalUser.bridge_id == bridge.bridge_id
                    )
                )
            ).all()
            person = await session.get(Client, people[0])
        assert len(people) == 1 and person is not None
        assert await _room_bodies(
            session_factory, bridge.room_id, person.transport_user_id
        ) == ["only once"]


class TestChangesMadeElsewhere:
    async def test_an_edit_through_the_quiet_process_reaches_the_holder(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )

        # What the gateway's edit route does: store the config, then restart.
        async with session_factory() as session:
            await session.execute(
                update(CollaborationBridge)
                .where(CollaborationBridge.id == bridge.bridge_id)
                .values(connection_config={"token": "second"})
            )
            await session.commit()
        await quiet.bridges.restart(bridge.bridge_id)

        await _eventually(
            lambda: [chat.config.token for chat in platform.listening] == ["second"]
        )
        held = holder.bridges.get(bridge.bridge_id)
        assert held is not None and held.active
        assert platform.listening == [held.adapter]

    async def test_what_a_bridge_learned_and_stored_restarts_no_copy(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        """Teams stores the service URL and each channel's team as it learns
        them from traffic, in the bridge's config. That is not an edit: the
        re-check restarts no copy of the bridge for it."""
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        await _eventually(lambda: quiet.bridges.is_connected(bridge.bridge_id))
        running = [p.bridges.get(bridge.bridge_id) for p in (holder, quiet)]

        await holder.bridges._persist_service_url(
            bridge.bridge_id, TENANT_ZERO_ID, "https://smba.example/emea/"
        )
        await holder.bridges._persist_channel_team(
            bridge.bridge_id, TENANT_ZERO_ID, "C9", "team-9"
        )
        for process in (holder, quiet):
            await process.bridges.reconcile_all()

        assert [p.bridges.get(bridge.bridge_id) for p in (holder, quiet)] == running

    async def test_a_bridge_removed_through_the_quiet_process_stops_listening(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )

        await quiet.bridges.remove(bridge.bridge_id)

        await _eventually(lambda: platform.listening == [])
        await _eventually(lambda: holder.bridges.get(bridge.bridge_id) is None)
        assert not holder.bridges.holds(bridge.bridge_id)

    async def test_a_room_bridged_through_the_quiet_process_is_relayed(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )

        with tenant_scope(TENANT_ZERO_ID):
            created = await quiet.bridges._room_service.create_room(
                RoomCreateConfig(
                    name="second",
                    description="",
                    bridge_id=bridge.bridge_id,
                    external_channel_id="C2",
                    channel_type="channel_public",
                    created_by_kind="system",
                )
            )
        async with session_factory() as session:
            await RoomStore().add_client(session, bridge.speaker_id, created.room.id)
            await session.commit()
        await say_in_room(
            session_factory, bridge, "in the new room", room_id=created.room.id
        )

        await _eventually(lambda: len(platform.posts) >= 1)
        assert platform.posts[0][0] == "C2"
        assert platform.posted() == ["in the new room"]


class TestPeopleOnThePlatform:
    async def test_a_person_minted_by_the_quiet_process_is_known_to_the_holder(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        copy = quiet.bridges.get(bridge.bridge_id)
        assert copy is not None
        # The copy comes up in its own task, after it is started.
        await _eventually(lambda: quiet.bridges.is_connected(bridge.bridge_id))

        # A webhook delivery reaching the quiet process: it mints the person.
        await copy.adapter.hear(  # type: ignore[attr-defined]
            inbound_post(user_id="U7", text="first words", ref="m1")
        )
        await say_in_room(session_factory, bridge, "answer")
        # The holder relays the room out: the person's own words are not
        # echoed back to them, though the holder never minted them.
        assert await _posted(platform, 1) == ["answer"]

        # Then the platform tells the holder about them: adopted, not minted
        # a second time.
        await platform.say(user_id="U7", text="second words", ref="m2")

        async with session_factory() as session:
            people = (
                await session.scalars(
                    select(ExternalUser.client_id).where(
                        ExternalUser.bridge_id == bridge.bridge_id
                    )
                )
            ).all()
            person = await session.get(Client, people[0])
        assert len(people) == 1 and person is not None
        assert await _room_bodies(
            session_factory, bridge.room_id, person.transport_user_id
        ) == ["first words", "second words"]
        assert platform.posted() == ["answer"]

    async def test_two_people_whose_names_read_alike_stay_two_people(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        """`ann.marie` and `ann-marie` sanitize to the same client localpart.
        The second to speak is a person of their own, not the first."""
        await _boot_two(postgres_url, session_factory, processes)

        await platform.say(user_id="Ann.Marie", text="from the first", ref="m1")
        await platform.say(user_id="Ann-Marie", text="from the second", ref="m2")

        async with session_factory() as session:
            people = dict(
                (
                    await session.execute(
                        select(ExternalUser.external_user_id, Client.transport_user_id)
                        .join(Client, Client.id == ExternalUser.client_id)
                        .where(ExternalUser.bridge_id == bridge.bridge_id)
                    )
                )
                .tuples()
                .all()
            )
        assert set(people) == {"Ann.Marie", "Ann-Marie"}
        assert people["Ann.Marie"] != people["Ann-Marie"]
        assert await _room_bodies(
            session_factory, bridge.room_id, people["Ann.Marie"]
        ) == ["from the first"]
        assert await _room_bodies(
            session_factory, bridge.room_id, people["Ann-Marie"]
        ) == ["from the second"]


class TestAPlatformThatCannotKeepQuiet:
    """Every process listens to it, so every process hears each post. The
    room still gets each one once: what a post writes is numbered from it."""

    async def test_a_post_every_process_hears_is_stored_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        await _loud(session_factory, bridge)
        await _boot_two(postgres_url, session_factory, processes)
        await _eventually(lambda: len(platform.listening) == 2)

        await platform.say(user_id="U3", text="heard twice", ref="m9")
        await platform.command(user_id="U3", command="help", ref="m10")

        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Message.event_type, Message.body).where(
                        Message.room_id == bridge.room_id,
                        Message.event_type.in_(
                            ["m.room.message", "com.switch.command"]
                        ),
                    )
                )
            ).all()
        assert sorted(event_type for event_type, _ in rows) == [
            "com.switch.command",
            "m.room.message",
        ]

    async def test_a_reply_is_still_posted_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[Process],
        platform: Platform,
        bridge: Bridge,
    ) -> None:
        await _loud(session_factory, bridge)
        await _boot_two(postgres_url, session_factory, processes)

        await say_in_room(session_factory, bridge, "relayed by the holder alone")

        assert await _posted(platform, 1) == ["relayed by the holder alone"]


async def _loud(
    session_factory: async_sessionmaker[AsyncSession], bridge: Bridge
) -> None:
    async with session_factory() as session:
        await session.execute(
            update(CollaborationBridge)
            .where(CollaborationBridge.id == bridge.bridge_id)
            .values(type=LOUD_CHAT)
        )
        await session.commit()
