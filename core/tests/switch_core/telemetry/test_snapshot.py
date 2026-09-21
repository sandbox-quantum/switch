"""The usage snapshot against real Postgres.

These are the numbers that go in front of the business, so the tests are about
the definitions rather than about the plumbing: what counts as active, who
counts as a human, which room counts as one somebody made, and what a "turn"
between two participants actually is. A mock cannot check any of that — the
window function behind the turn counts, the JSONB read behind the
created-by split and the row-level-security fan-out all only exist in the
database.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    Message,
    Room,
    User,
)
from switch_core.telemetry.snapshot import (
    UsageCounts,
    collect_tenant_counts,
    collect_usage,
    newly_active_rooms,
    normalise_actor_kind,
    normalise_channel_type,
    normalise_known_agent_type,
    normalise_platform,
    room_had_human_activity,
)

NOW = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)


async def _room(
    session: AsyncSession,
    *,
    created_by_kind: str | None = "user",
    created_at: datetime | None = None,
    archived: bool = False,
    bridge_id: str | None = None,
    channel_type: str = "channel_public",
) -> Room:
    room = Room(
        matrix_room_id=f"!{uuid.uuid4().hex[:10]}:test",
        name=f"room-{uuid.uuid4().hex[:6]}",
        description="a room",
        channel_type=channel_type,
        bridge_id=bridge_id,
        created_at=created_at or (NOW - timedelta(days=30)),
        archived_at=NOW if archived else None,
        metadata_=({"created_by_kind": created_by_kind} if created_by_kind else None),
    )
    session.add(room)
    await session.flush()
    return room


async def _client(session: AsyncSession, client_type: str) -> Client:
    client = Client(
        matrix_user_id=f"@{client_type}-{uuid.uuid4().hex[:8]}:test",
        display_name=f"{client_type} client",
        type=client_type,
    )
    session.add(client)
    await session.flush()
    return client


async def _agent(session: AsyncSession, runtime: str | None) -> Agent:
    """An agent with the client and api-key rows its foreign keys require."""
    slug = uuid.uuid4().hex[:10]
    owner = User(
        name="owner", email=f"owner-{slug}@test", role="user", password_hash="x"
    )
    session.add(owner)
    await session.flush()
    key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{slug}",
        encrypted_key="enc",
        label="test",
        type="agent",
    )
    backing = Client(
        matrix_user_id=f"@agent-{slug}:test", display_name="agent", type="agent"
    )
    session.add_all([key, backing])
    await session.flush()
    agent = Agent(
        name=f"agent-{uuid.uuid4().hex[:6]}",
        description="d",
        agent_type="session_addressable",
        connector_type="http",
        integration_profile={},
        client_id=backing.id,
        api_key_id=key.id,
        metadata_=({"known_agent_type": runtime} if runtime else None),
    )
    session.add(agent)
    await session.flush()
    return agent


async def _join(session: AsyncSession, client: Client, room: Room) -> None:
    session.add(ClientRoom(client_id=client.id, room_id=room.id))
    await session.flush()


async def _say(
    session: AsyncSession,
    room: Room,
    sender: Client,
    *,
    seq: int,
    when: datetime | None = None,
) -> Message:
    message = Message(
        room_id=room.id,
        seq=seq,
        transport_event_id=f"$evt-{uuid.uuid4().hex}",
        sender_id=sender.matrix_user_id,
        sender_client_id=sender.id,
        event_type="m.room.message",
        msgtype="m.text",
        body="hello",
        content={"body": "hello"},
        sent_at=when or (NOW - timedelta(hours=1)),
    )
    session.add(message)
    await session.flush()
    return message


TENANT_ZERO = "00000000-0000-0000-0000-000000000000"


async def _counts(session: AsyncSession, tenant_id: str = TENANT_ZERO) -> UsageCounts:
    counts = UsageCounts()
    await collect_tenant_counts(session, tenant_id, counts, NOW)
    return counts


class TestWhatCountsAsActive:
    async def test_a_human_talking_to_an_agent_makes_the_room_active(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _join(session, human, room)
            await _join(session, agent, room)
            await _say(session, room, human, seq=1)

            counts = await _counts(session)

        assert counts.room_active_1d == 1
        assert counts.user_active_1d == 1

    async def test_two_agents_talking_is_not_activity(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The product question is whether people are using it. An orchestration
        chatting to itself all night must not read as adoption."""
        async with session_factory() as session:
            room = await _room(session)
            one = await _client(session, "agent")
            two = await _client(session, "agent")
            await _join(session, one, room)
            await _join(session, two, room)
            await _say(session, room, one, seq=1)
            await _say(session, room, two, seq=2)

            counts = await _counts(session)

        assert counts.room_active_1d == 0
        assert counts.user_active_1d == 0

    async def test_a_human_in_a_room_with_no_agent_is_not_activity(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            await _join(session, human, room)
            await _say(session, room, human, seq=1)

            counts = await _counts(session)

        assert counts.room_active_1d == 0

    async def test_a_bridge_relay_is_not_a_person(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`bridge`, `admin` and `observe` are machinery. Counting them as
        users would make every bridged deployment look busier than it is."""
        async with session_factory() as session:
            room = await _room(session)
            agent = await _client(session, "agent")
            await _join(session, agent, room)
            for machinery in ("bridge", "admin", "observe"):
                relay = await _client(session, machinery)
                await _join(session, relay, room)
                await _say(session, room, relay, seq=100 + len(machinery))

            counts = await _counts(session)

        assert counts.user_active_1d == 0
        assert counts.room_active_1d == 0

    async def test_the_day_and_week_windows_differ(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _join(session, human, room)
            await _join(session, agent, room)
            await _say(session, room, human, seq=1, when=NOW - timedelta(days=3))

            counts = await _counts(session)

        assert counts.room_active_1d == 0
        assert counts.room_active_7d == 1

    async def test_backfilled_history_is_not_activity_either(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Same guard `message_count_1d` already applies, now shared with the
        activity gauges: a negative `seq` is reconstructed history, and a
        backfill is not a person using the room today even with an agent
        present."""
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _join(session, human, room)
            await _join(session, agent, room)
            await _say(session, room, human, seq=-1)

            counts = await _counts(session)

        assert counts.room_active_1d == 0
        assert counts.user_active_1d == 0


class TestRoomsAreCountedByWhoMadeThem:
    async def test_a_user_created_room_is_the_headline_figure(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await _room(session, created_by_kind="user")
            await _room(session, created_by_kind="agent")

            counts = await _counts(session)

        assert counts.room_count == 1
        assert counts.room_agent_created_count == 1

    async def test_a_room_predating_the_stamp_counts_as_user_created(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The conservative reading: agent-created is the newer path, so an
        unstamped room is far more likely to be one a person made."""
        async with session_factory() as session:
            await _room(session, created_by_kind=None)

            counts = await _counts(session)

        assert counts.room_count == 1
        assert counts.room_agent_created_count == 0

    async def test_archived_rooms_leave_the_live_count(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await _room(session)
            await _room(session, archived=True)

            counts = await _counts(session)

        assert counts.room_count == 1
        assert counts.room_archived_count == 1


class TestTurns:
    """Who is actually talking to whom."""

    async def test_an_agent_answering_a_person_is_a_human_to_agent_turn(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _say(session, room, human, seq=1)
            await _say(session, room, agent, seq=2)
            await _say(session, room, human, seq=3)

            counts = await _counts(session)

        assert counts.turn_human_to_agent_1d == 1
        assert counts.turn_agent_to_human_1d == 1
        assert counts.turn_agent_to_agent_1d == 0

    async def test_two_agents_are_agent_to_agent_turns(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The distinction a sender-only count cannot make: both of these are
        "a message from an agent", and only one is a conversation with a
        person."""
        async with session_factory() as session:
            room = await _room(session)
            one = await _client(session, "agent")
            two = await _client(session, "agent")
            await _say(session, room, one, seq=1)
            await _say(session, room, two, seq=2)
            await _say(session, room, one, seq=3)

            counts = await _counts(session)

        assert counts.turn_agent_to_agent_1d == 2
        assert counts.turn_human_to_agent_1d == 0

    async def test_the_first_message_in_a_room_is_not_a_turn(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            await _say(session, room, human, seq=1)

            counts = await _counts(session)

        assert counts.turn_human_to_agent_1d == 0
        assert counts.turn_agent_to_human_1d == 0
        assert counts.turn_agent_to_agent_1d == 0

    async def test_turns_do_not_pair_across_rooms(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two rooms interleaved in time must not make each other's messages
        look like replies."""
        async with session_factory() as session:
            first = await _room(session)
            second = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _say(session, first, human, seq=1)
            await _say(session, second, agent, seq=1)

            counts = await _counts(session)

        assert counts.turn_human_to_agent_1d == 0


class TestMessageCounts:
    async def test_messages_are_split_by_sender_kind(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _say(session, room, human, seq=1)
            await _say(session, room, agent, seq=2)
            await _say(session, room, agent, seq=3)

            counts = await _counts(session)

        assert counts.message_count_1d == 3
        assert counts.message_from_human_1d == 1
        assert counts.message_from_agent_1d == 2

    async def test_backfilled_history_is_not_traffic(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Reconstructed history is numbered below zero. Importing a year of
        Slack must not read as a year's usage arriving today."""
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            await _say(session, room, human, seq=-1)
            await _say(session, room, human, seq=-2)

            counts = await _counts(session)

        assert counts.message_count_1d == 0


class TestAgentsAndConnectors:
    async def test_agents_are_split_by_runtime(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            for runtime in ("claude-code", "codex", "opencode", "something-new", None):
                await _agent(session, runtime)

            counts = await _counts(session)

        assert counts.agent_count == 5
        assert counts.agent_claude_code_count == 1
        assert counts.agent_codex_count == 1
        assert counts.agent_opencode_count == 1
        assert counts.agent_other_count == 2

    async def test_connectors_are_counted_per_platform(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            for platform in ("slack", "slack", "teams"):
                client = await _client(session, "bridge")
                session.add(
                    CollaborationBridge(
                        type=platform,
                        display_name=f"{platform} workspace",
                        client_id=client.id,
                        status="active",
                    )
                )
            await session.flush()

            counts = await _counts(session)

        assert counts.connector_counts["slack"] == 2
        assert counts.connector_counts["teams"] == 1
        assert counts.connector_counts["discord"] == 0
        assert counts.connector_configured_count == 3


class TestMembership:
    async def test_only_humans_count_towards_users_in_rooms(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            for _ in range(3):
                await _join(session, await _client(session, "user"), room)
            await _join(session, await _client(session, "agent"), room)
            await _join(session, await _client(session, "bridge"), room)

            counts = await _counts(session)

        assert counts.room_membership_total == 3
        assert counts.room_users_max == 3


class TestNewlyActiveRooms:
    async def test_a_room_reports_when_a_person_first_speaks_in_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        created = NOW - timedelta(hours=5)
        async with session_factory() as session:
            room = await _room(session, created_at=created)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _join(session, agent, room)
            await _say(session, room, human, seq=1, when=NOW - timedelta(hours=2))
            await session.commit()

        found = await newly_active_rooms(
            session_factory, since=NOW - timedelta(hours=4), now=NOW
        )

        assert len(found) == 1
        assert found[0].seconds_since_room_created == 3 * 3600
        assert found[0].created_by_kind == "user"

    async def test_a_room_already_active_before_the_window_is_not_reported_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """What makes this once-per-room without storing anything: the room
        qualifies only if its *earliest* human message is inside the window."""
        async with session_factory() as session:
            room = await _room(session, created_at=NOW - timedelta(days=10))
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _join(session, agent, room)
            await _say(session, room, human, seq=1, when=NOW - timedelta(days=9))
            await _say(session, room, human, seq=2, when=NOW - timedelta(hours=1))
            await session.commit()

        found = await newly_active_rooms(
            session_factory, since=NOW - timedelta(hours=4), now=NOW
        )

        assert found == []

    async def test_an_agent_only_room_never_becomes_active(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            agent = await _client(session, "agent")
            await _say(session, room, agent, seq=1, when=NOW - timedelta(hours=1))
            await session.commit()

        found = await newly_active_rooms(
            session_factory, since=NOW - timedelta(hours=4), now=NOW
        )

        assert found == []

    async def test_a_room_with_humans_and_no_agent_never_becomes_active(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The defect this predicate now shares with `room_active_1d`: two
        people talking with no agent in the room is not "using the product",
        so it must not surface here either, even though nobody has ever
        called this room active by the room-count definition."""
        async with session_factory() as session:
            room = await _room(session)
            first = await _client(session, "user")
            second = await _client(session, "user")
            await _join(session, first, room)
            await _join(session, second, room)
            await _say(session, room, first, seq=1, when=NOW - timedelta(hours=2))
            await _say(session, room, second, seq=2, when=NOW - timedelta(hours=1))
            await session.commit()

        found = await newly_active_rooms(
            session_factory, since=NOW - timedelta(hours=4), now=NOW
        )

        assert found == []

    async def test_backfilled_history_does_not_report_a_room_as_newly_active(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _join(session, agent, room)
            await _say(session, room, human, seq=-1, when=NOW - timedelta(hours=1))
            await session.commit()

        found = await newly_active_rooms(
            session_factory, since=NOW - timedelta(hours=4), now=NOW
        )

        assert found == []


class TestRoomHadHumanActivity:
    async def test_it_reports_whether_a_person_ever_posted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            quiet = await _room(session)
            busy = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _join(session, agent, busy)
            await _say(session, busy, human, seq=1)

            assert await room_had_human_activity(session, TENANT_ZERO, busy.id) is True
            assert (
                await room_had_human_activity(session, TENANT_ZERO, quiet.id) is False
            )

    async def test_a_room_with_no_agent_never_had_human_activity(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Same predicate as `room_active_1d`: a person posting in a room with
        no agent is not the activity this telemetry means, so it must not make
        `room_deleted.was_ever_active` or `room_archived.was_ever_active`
        `True` either."""
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            await _join(session, human, room)
            await _say(session, room, human, seq=1)

            assert await room_had_human_activity(session, TENANT_ZERO, room.id) is False

    async def test_backfilled_history_is_not_human_activity(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _join(session, agent, room)
            await _say(session, room, human, seq=-1)

            assert await room_had_human_activity(session, TENANT_ZERO, room.id) is False


class TestTheFourPathsAgreeOnActivity:
    """`_human_interaction`, `_active_humans`, `newly_active_rooms` and
    `room_had_human_activity` used to answer "did a human use this room"
    differently — two required an agent in the room and two did not — so the
    same room could be active in one figure and never-active in another. They
    now share `_human_activity_conditions`; this pins that all four agree on
    the same two rooms rather than exercising each in isolation."""

    async def test_all_four_agree_a_room_with_no_agent_is_not_active(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session, created_at=NOW - timedelta(hours=5))
            first = await _client(session, "user")
            second = await _client(session, "user")
            await _join(session, first, room)
            await _join(session, second, room)
            await _say(session, room, first, seq=1, when=NOW - timedelta(hours=2))
            await _say(session, room, second, seq=2, when=NOW - timedelta(hours=1))
            await session.flush()

            counts = await _counts(session)
            was_ever_active = await room_had_human_activity(
                session, TENANT_ZERO, room.id
            )
            await session.commit()

        newly_active = await newly_active_rooms(
            session_factory, since=NOW - timedelta(hours=4), now=NOW
        )

        assert counts.room_active_1d == 0
        assert counts.user_active_1d == 0
        assert was_ever_active is False
        assert newly_active == []

    async def test_all_four_agree_a_room_with_an_agent_is_active(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session, created_at=NOW - timedelta(hours=5))
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _join(session, human, room)
            await _join(session, agent, room)
            await _say(session, room, human, seq=1, when=NOW - timedelta(hours=2))
            await session.flush()

            counts = await _counts(session)
            was_ever_active = await room_had_human_activity(
                session, TENANT_ZERO, room.id
            )
            await session.commit()

        newly_active = await newly_active_rooms(
            session_factory, since=NOW - timedelta(hours=4), now=NOW
        )

        assert counts.room_active_1d == 1
        assert counts.user_active_1d == 1
        assert was_ever_active is True
        assert len(newly_active) == 1


class TestTheDeploymentTotal:
    async def test_users_are_counted_once_for_the_deployment(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`users` carries no tenant, so summing it per tenant would multiply
        it by however many tenants there are."""
        async with session_factory() as session:
            await _room(session)
            await session.commit()

        counts = await collect_usage(session_factory, now=NOW)

        assert counts.tenant_count >= 1
        assert counts.room_count == 1


class TestTheDerivedProperties:
    def test_the_mean_is_zero_rather_than_a_division_by_zero(self) -> None:
        counts = UsageCounts()
        properties = counts.as_event_properties(session_live_count=0)
        assert properties["room_users_mean"] == 0.0

    def test_every_platform_reports_even_with_none_configured(self) -> None:
        """The catalogue requires every key every time, so a deployment with no
        Discord bridge reports zero rather than omitting the property."""
        properties = UsageCounts().as_event_properties(session_live_count=0)
        for platform in ("slack", "mattermost", "discord", "teams", "telegram"):
            assert properties[f"connector_{platform}_count"] == 0

    def test_the_properties_match_the_catalogue_exactly(self) -> None:
        from switch_core.telemetry.catalogue import CATALOGUE

        properties = UsageCounts().as_event_properties(session_live_count=3)
        assert set(properties) == set(CATALOGUE["usage_snapshot"])


class TestNormalising:
    def test_the_pre_rename_channel_type_is_mapped(self) -> None:
        """`group` predates the catalogue's vocabulary; passing it through
        would raise at emission and take a room creation down with it."""
        assert normalise_channel_type("group") == "channel_private"
        assert normalise_channel_type("channel") == "channel_public"
        assert normalise_channel_type("channel_public") == "channel_public"
        assert normalise_channel_type(None) == "none"
        assert normalise_channel_type("something-new") == "none"

    def test_an_unknown_platform_becomes_none(self) -> None:
        assert normalise_platform("slack") == "slack"
        assert normalise_platform(None) == "none"
        assert normalise_platform("irc") == "none"

    def test_a_runtime_switch_does_not_know_becomes_other(self) -> None:
        assert normalise_known_agent_type({"known_agent_type": "codex"}) == "codex"
        assert normalise_known_agent_type({"known_agent_type": "zed"}) == "other"
        assert normalise_known_agent_type({}) == "none"
        assert normalise_known_agent_type(None) == "none"


class TestTheThreeRoomOrigins:
    """A bridge-adopted channel is not a room a person made.

    The headline figure was written as "not agent-created", which quietly
    folded in the third kind this change introduces — every channel Switch was
    invited to on a platform. On a busy Slack that is most of them.
    """

    async def test_each_origin_is_counted_separately(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await _room(session, created_by_kind="user")
            await _room(session, created_by_kind="agent")
            await _room(session, created_by_kind="system")
            await _room(session, created_by_kind="system")

            counts = await _counts(session)

        assert counts.room_count == 1
        assert counts.room_agent_created_count == 1
        assert counts.room_system_created_count == 2

    async def test_the_mean_cannot_exceed_the_maximum(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Numerator and denominator must count the same rooms. Over different
        populations the pair can report a mean above the maximum, which is
        impossible for any one set and reads as a broken metric."""
        async with session_factory() as session:
            mine = await _room(session, created_by_kind="user")
            theirs = await _room(session, created_by_kind="agent")
            await _join(session, await _client(session, "user"), mine)
            # An agent-created room legitimately holds people.
            for _ in range(5):
                await _join(session, await _client(session, "user"), theirs)

            counts = await _counts(session)

        properties = counts.as_event_properties(session_live_count=0)
        assert properties["room_users_mean"] <= properties["room_users_max"]
        assert counts.room_membership_total == 1


class TestNormaliseActorKind:
    def test_an_unstamped_room_reads_as_user(self) -> None:
        assert normalise_actor_kind(None) == "user"

    def test_the_three_kinds_pass_through(self) -> None:
        assert normalise_actor_kind("user") == "user"
        assert normalise_actor_kind("agent") == "agent"
        assert normalise_actor_kind("system") == "system"

    def test_an_unknown_kind_reads_as_system_rather_than_raising(self) -> None:
        """A later kind added without touching this file must not be able to
        fail a room creation at the point of emission."""
        assert normalise_actor_kind("imported") == "system"


class TestATurnNeedsTwoParticipants:
    """A turn is a reply, so the two sides must be different participants.

    Agents normally answer in several messages. Pairing on the sender's *kind*
    alone scored each of those as an agent-to-agent turn, so the figure meant
    to show "two agents talking among themselves" was dominated by one agent
    talking to a person.
    """

    async def test_one_agent_posting_twice_is_not_an_agent_to_agent_turn(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _say(session, room, human, seq=1)
            # One agent answering across three messages, as agents do.
            await _say(session, room, agent, seq=2)
            await _say(session, room, agent, seq=3)
            await _say(session, room, agent, seq=4)

            counts = await _counts(session)

        assert counts.turn_human_to_agent_1d == 1
        assert counts.turn_agent_to_agent_1d == 0

    async def test_two_different_agents_still_count(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            one = await _client(session, "agent")
            two = await _client(session, "agent")
            await _say(session, room, one, seq=1)
            await _say(session, room, two, seq=2)

            counts = await _counts(session)

        assert counts.turn_agent_to_agent_1d == 1

    async def test_a_person_repeating_themselves_is_not_a_turn_either(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session)
            human = await _client(session, "user")
            agent = await _client(session, "agent")
            await _say(session, room, agent, seq=1)
            await _say(session, room, human, seq=2)
            await _say(session, room, human, seq=3)

            counts = await _counts(session)

        assert counts.turn_agent_to_human_1d == 1
