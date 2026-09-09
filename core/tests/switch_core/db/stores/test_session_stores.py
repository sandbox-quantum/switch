from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    Room,
    SessionCommand,
    SessionEvent,
    SessionPublication,
    SessionRoomAssociation,
    User,
)
from switch_core.db.stores.session_command_store import (
    DuplicateCommandId,
    RequestAlreadyReserved,
    SessionCommandStore,
)
from switch_core.db.stores.session_event_store import (
    DuplicateEventId,
    HostSequenceTaken,
    SessionEventStore,
)
from switch_core.db.stores.session_lease_store import SessionLeaseStore
from switch_core.db.stores.session_publication_store import SessionPublicationStore
from switch_core.db.stores.session_room_association_store import (
    SessionRoomAssociationStore,
)
from switch_core.db.stores.session_store import SessionStore


async def _make_agent(session: AsyncSession) -> str:
    """Minimal User → ApiKey → Client → Agent chain (sessions.agent_id FK)."""
    name = f"agent-{uuid.uuid4().hex[:8]}"
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(matrix_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent.id


async def _make_room(session: AsyncSession) -> str:
    suffix = uuid.uuid4().hex[:8]
    room = Room(
        matrix_room_id=f"!room-{suffix}:test",
        name=f"room-{suffix}",
        description="a room",
    )
    session.add(room)
    await session.flush()
    return room.id


async def _make_bridge(session: AsyncSession) -> str:
    client = Client(
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name="bridge client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="slack", display_name="Slack", client_id=client.id, status="active"
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


async def _make_session(session: AsyncSession, session_id: str = "s-1") -> str:
    """A registered session, which everything else in this module hangs off."""
    agent_id = await _make_agent(session)
    await SessionStore().register(session, session_id, agent_id)
    return agent_id


def _event(session_id: str, **overrides: object) -> SessionEvent:
    fields: dict[str, object] = {
        "session_id": session_id,
        "epoch": "epoch-1",
        "host_sequence": 1,
        "event_id": f"ev-{uuid.uuid4().hex[:8]}",
        "type": "message",
        "body": {"text": "hello"},
        "occurred_at": datetime.now(UTC),
    }
    fields.update(overrides)
    return SessionEvent(**fields)


def _command(session_id: str, **overrides: object) -> SessionCommand:
    fields: dict[str, object] = {
        "session_id": session_id,
        "command_id": f"cmd-{uuid.uuid4().hex[:8]}",
        "epoch": "epoch-1",
        "actor_id": "actor-1",
        "status": "accepted",
        "origin": {"kind": "room", "roomId": "r-1"},
        "body": {"kind": "prompt", "text": "go"},
    }
    fields.update(overrides)
    return SessionCommand(**fields)


class TestSessionStore:
    async def test_a_session_is_registered_against_the_agent_that_presented_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionStore()
        async with session_factory() as session:
            agent_id = await _make_session(session)
            await session.commit()

        async with session_factory() as session:
            found = await store.get(session, "s-1")

        assert found is not None
        assert found.agent_id == agent_id
        assert found.status == "starting"
        assert found.provider is None

    async def test_a_session_id_cannot_be_rebound_to_another_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Otherwise whoever claims an id last owns everything logged under it."""
        store = SessionStore()
        async with session_factory() as session:
            await _make_session(session)
            await session.commit()

        async with session_factory() as session:
            other_agent_id = await _make_agent(session)
            with pytest.raises(IntegrityError):
                await store.register(session, "s-1", other_agent_id)

    async def test_what_the_host_reports_is_kept_at_rest(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Capabilities gate every command, so the check cannot need the log."""
        store = SessionStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.record_reported_state(
                session,
                "s-1",
                provider="claude-code",
                capabilities={"interrupt": True},
                status="running",
            )
            await session.commit()

        async with session_factory() as session:
            found = await store.get(session, "s-1")

        assert found is not None
        assert found.provider == "claude-code"
        assert found.capabilities == {"interrupt": True}
        assert found.status == "running"

    async def test_reporting_state_for_an_unregistered_session_is_an_error(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionStore()
        async with session_factory() as session:
            with pytest.raises(LookupError):
                await store.record_reported_state(
                    session, "s-nope", provider="p", capabilities={}, status="running"
                )


class TestSessionLeaseStore:
    async def test_the_holder_and_its_epoch_are_readable(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionLeaseStore()
        async with session_factory() as session:
            agent_id = await _make_session(session)
            await store.acquire(session, "s-1", agent_id, "host-a", "epoch-1")
            await session.commit()

        async with session_factory() as session:
            lease = await store.get(session, "s-1")

        assert lease is not None
        assert lease.host_id == "host-a"
        assert lease.epoch == "epoch-1"

    async def test_a_second_host_cannot_take_a_held_session(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two holders means two epochs emitting into one log."""
        store = SessionLeaseStore()
        async with session_factory() as session:
            agent_id = await _make_session(session)
            await store.acquire(session, "s-1", agent_id, "host-a", "epoch-1")
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await store.acquire(session, "s-1", agent_id, "host-b", "epoch-2")

    async def test_renewal_keeps_the_epoch(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A heartbeat must not invalidate what the host has already emitted."""
        store = SessionLeaseStore()
        async with session_factory() as session:
            agent_id = await _make_session(session)
            lease = await store.acquire(session, "s-1", agent_id, "host-a", "epoch-1")
            acquired_at = lease.acquired_at
            await session.commit()

        async with session_factory() as session:
            await store.renew(session, "s-1", "host-a", "epoch-1")
            await session.commit()

        async with session_factory() as session:
            renewed = await store.get(session, "s-1")

        assert renewed is not None
        assert renewed.epoch == "epoch-1"
        assert renewed.last_seen_at > acquired_at

    async def test_renewing_a_lease_nobody_holds_is_an_error(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The caller believes it owns a session it does not; say so."""
        store = SessionLeaseStore()
        async with session_factory() as session:
            await _make_session(session)
            with pytest.raises(LookupError):
                await store.renew(session, "s-1", "host-a", "epoch-1")

    async def test_a_displaced_host_cannot_renew_its_successors_lease(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A displaced host does not know it has been displaced.

        Keyed on the session alone, its next heartbeat keeps a dead host
        looking alive under someone else's epoch.
        """
        store = SessionLeaseStore()
        async with session_factory() as session:
            agent_id = await _make_session(session)
            await store.acquire(session, "s-1", agent_id, "host-b", "epoch-2")
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(LookupError):
                await store.renew(session, "s-1", "host-a", "epoch-1")

    async def test_a_displaced_host_cannot_release_its_successors_lease(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Otherwise host A shutting down strands the session host B now owns."""
        store = SessionLeaseStore()
        async with session_factory() as session:
            agent_id = await _make_session(session)
            await store.acquire(session, "s-1", agent_id, "host-b", "epoch-2")
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(LookupError):
                await store.release(session, "s-1", "host-a", "epoch-1")

        async with session_factory() as session:
            lease = await store.get(session, "s-1")

        assert lease is not None
        assert lease.host_id == "host-b"

    async def test_release_frees_the_session_for_the_next_host(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionLeaseStore()
        async with session_factory() as session:
            agent_id = await _make_session(session)
            await store.acquire(session, "s-1", agent_id, "host-a", "epoch-1")
            await store.release(session, "s-1", "host-a", "epoch-1")
            await store.acquire(session, "s-1", agent_id, "host-b", "epoch-2")
            await session.commit()

        async with session_factory() as session:
            lease = await store.get(session, "s-1")

        assert lease is not None
        assert lease.host_id == "host-b"


class TestSessionEventStore:
    async def test_appends_are_numbered_from_one_without_gaps(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            first = await store.append(session, _event("s-1", host_sequence=1))
            second = await store.append(session, _event("s-1", host_sequence=2))
            await session.commit()

        assert (first.sequence, second.sequence) == (1, 2)

    async def test_an_empty_log_is_at_position_zero(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`after=0` has to mean "everything", so the head before anything is 0."""
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            assert await store.head_sequence(session, "s-1") == 0

    async def test_reading_from_a_cursor_is_repeatable(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`after` is a position, not a count: a reconnect re-reads the same page."""
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            for host_sequence in range(1, 4):
                await store.append(session, _event("s-1", host_sequence=host_sequence))
            await session.commit()

        async with session_factory() as session:
            first_read = await store.read_after(session, "s-1", after=1, limit=10)
            second_read = await store.read_after(session, "s-1", after=1, limit=10)

        assert [e.sequence for e in first_read] == [2, 3]
        assert [e.sequence for e in second_read] == [2, 3]

    async def test_one_session_does_not_see_anothers_log(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session, "s-1")
            await _make_session(session, "s-2")
            await store.append(session, _event("s-1"))
            await store.append(session, _event("s-2"))
            await session.commit()

        async with session_factory() as session:
            events = await store.read_after(session, "s-1", after=0, limit=10)

        assert [e.session_id for e in events] == ["s-1"]

    async def test_a_replayed_event_id_is_refused_as_a_replay(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A host retrying from its outbox must not double the log.

        Named apart from a position conflict because ingest answers the two
        differently, and which index Postgres checks first is not something the
        caller controls.
        """
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.append(session, _event("s-1", event_id="ev-1"))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(DuplicateEventId):
                await store.append(
                    session, _event("s-1", event_id="ev-1", host_sequence=2)
                )

    async def test_a_host_position_is_taken_once_per_epoch(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.append(session, _event("s-1", host_sequence=1))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(HostSequenceTaken):
                await store.append(session, _event("s-1", host_sequence=1))

    async def test_a_refused_append_leaves_the_transaction_usable(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Ingest has to answer the host, and answering takes a working session."""
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.append(session, _event("s-1", event_id="ev-1"))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(DuplicateEventId):
                await store.append(
                    session, _event("s-1", event_id="ev-1", host_sequence=2)
                )
            assert await store.head_sequence(session, "s-1") == 1

    async def test_a_new_epoch_restarts_the_host_numbering(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A restarted host counts from 1 again; that is not a replay."""
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.append(session, _event("s-1", host_sequence=1))
            second = await store.append(
                session, _event("s-1", epoch="epoch-2", host_sequence=1)
            )
            await session.commit()

        assert second.sequence == 2

    async def test_server_events_share_the_log_without_a_host_position(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Command status and connectivity are ours, and there are many of them."""
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.append(
                session, _event("s-1", host_sequence=None, type="command.status")
            )
            await store.append(
                session, _event("s-1", host_sequence=None, type="connectivity")
            )
            await session.commit()

        async with session_factory() as session:
            assert await store.head_sequence(session, "s-1") == 2

    async def test_a_server_event_needs_no_epoch(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Connectivity going offline is written when the lease has just gone.

        The lease is the only place an epoch is kept, so requiring one here
        would leave the server inventing a value or, worse, not logging the
        transition at all.
        """
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            event = await store.append(
                session,
                _event(
                    "s-1", epoch=None, host_sequence=None, type="session.connectivity"
                ),
            )
            await session.commit()

        assert event.sequence == 1
        assert event.epoch is None

    async def test_overlapping_appends_do_not_share_a_position(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The per-session lock, exercised.

        The barrier holds both transactions open until each has one, so the
        second reads the head while the first is still uncommitted. Without the
        lock both read the same head and the second insert dies on the
        uniqueness constraint.
        """
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            await session.commit()

        both_open = asyncio.Barrier(2)

        async def append(host_sequence: int) -> int:
            async with session_factory() as session:
                await session.execute(text("SELECT 1"))
                await both_open.wait()
                event = await store.append(
                    session, _event("s-1", host_sequence=host_sequence)
                )
                await session.commit()
                return event.sequence

        sequences = await asyncio.gather(append(1), append(2))

        assert sorted(sequences) == [1, 2]

    async def test_a_reader_never_sees_a_position_above_an_unfinished_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Commit order, which uniqueness alone does not give.

        A database sequence would pass the test above and still fail this one:
        it hands numbers out at INSERT time, so a writer holding 1 open lets a
        writer holding 2 commit first, and a reader paging on `sequence > n`
        advances to 2 and never comes back for 1. Under the lock the second
        writer cannot get its number until the first has committed, so the
        committed log is always a contiguous prefix.
        """
        store = SessionEventStore()
        async with session_factory() as session:
            await _make_session(session)
            await session.commit()

        first_allocated = asyncio.Event()
        first_may_commit = asyncio.Event()

        async def slow_writer() -> None:
            async with session_factory() as session:
                await store.append(session, _event("s-1", host_sequence=1))
                first_allocated.set()
                await first_may_commit.wait()
                await session.commit()

        async def fast_writer() -> None:
            async with session_factory() as session:
                await store.append(session, _event("s-1", host_sequence=2))
                await session.commit()

        slow = asyncio.create_task(slow_writer())
        fast: asyncio.Task[None] | None = None
        try:
            await first_allocated.wait()
            fast = asyncio.create_task(fast_writer())
            # Long enough that a writer free to proceed would have committed.
            await asyncio.sleep(0.2)

            async with session_factory() as session:
                visible = await store.read_after(session, "s-1", after=0, limit=10)
            assert [e.sequence for e in visible] == []
        finally:
            # Releasing the held transaction even on failure; leaving it open
            # blocks the fixture's DROP TABLE and hangs the run.
            first_may_commit.set()
            await asyncio.gather(slow, *([fast] if fast else []))

        async with session_factory() as session:
            visible = await store.read_after(session, "s-1", after=0, limit=10)
        assert [e.sequence for e in visible] == [1, 2]


class TestSessionCommandStore:
    async def test_commands_are_positioned_in_the_order_they_are_accepted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            first = await store.create(session, _command("s-1"))
            second = await store.create(session, _command("s-1"))
            await session.commit()

        assert (first.delivery_position, second.delivery_position) == (1, 2)

    async def test_a_second_answer_to_one_request_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The reservation. Two people press at once; one of them is told no.

        Raised apart from a repeated command id, which is idempotency and gets
        the saved command back rather than `REQUEST_BUSY`.
        """
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.create(
                session, _command("s-1", request_id="req-1", expected_revision=1)
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(RequestAlreadyReserved):
                await store.create(
                    session, _command("s-1", request_id="req-1", expected_revision=1)
                )

    async def test_a_re_asked_request_can_be_answered_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A new revision is a new question, so the old answer does not block it."""
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.create(
                session, _command("s-1", request_id="req-1", expected_revision=1)
            )
            second = await store.create(
                session, _command("s-1", request_id="req-1", expected_revision=2)
            )
            await session.commit()

        assert second.delivery_position == 2

    async def test_an_answer_naming_no_revision_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Postgres NULLs are distinct, so a half-filled answer reserves nothing.

        Two of them would both insert, both look reserved, and both be
        delivered. The contract makes `expectedRevision` required, so this only
        fires on a caller bug — but silently, and against the one constraint
        the design leans on.
        """
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            with pytest.raises(IntegrityError):
                await store.create(
                    session,
                    _command("s-1", request_id="req-1", expected_revision=None),
                )

    async def test_commands_that_answer_nothing_reserve_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Prompts and interrupts are not answers; any number of them may queue."""
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.create(session, _command("s-1"))
            await store.create(session, _command("s-1"))
            await store.create(session, _command("s-1"))
            await session.commit()

        async with session_factory() as session:
            queued = await store.read_after(session, "s-1", after=0, limit=10)

        assert [c.delivery_position for c in queued] == [1, 2, 3]

    async def test_a_repeated_command_id_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The caller compares against the saved row instead of accepting twice."""
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.create(session, _command("s-1", command_id="cmd-1"))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(DuplicateCommandId):
                await store.create(session, _command("s-1", command_id="cmd-1"))
            saved = await store.get_by_command_id(session, "s-1", "cmd-1")

        assert saved is not None

    async def test_delivery_pages_from_a_position(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            for _ in range(3):
                await store.create(session, _command("s-1"))
            await session.commit()

        async with session_factory() as session:
            page = await store.read_after(session, "s-1", after=1, limit=1)

        assert [c.delivery_position for c in page] == [2]

    async def test_overlapping_acceptances_do_not_share_a_position(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A command that shares a position with another is a command nobody gets.

        Same lock and same failure as the event log: the host pages on this
        column, so a position handed out twice loses one of the two commands.
        """
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            await session.commit()

        both_open = asyncio.Barrier(2)

        async def accept() -> int:
            async with session_factory() as session:
                await session.execute(text("SELECT 1"))
                await both_open.wait()
                command = await store.create(session, _command("s-1"))
                await session.commit()
                return command.delivery_position

        positions = await asyncio.gather(accept(), accept())

        assert sorted(positions) == [1, 2]

    async def test_a_rejection_records_why(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            await store.create(session, _command("s-1", command_id="cmd-1"))
            await store.set_status(
                session,
                "s-1",
                "cmd-1",
                status="rejected",
                code="UNSUPPORTED",
                message="this host cannot interrupt",
            )
            await session.commit()

        async with session_factory() as session:
            saved = await store.get_by_command_id(session, "s-1", "cmd-1")

        assert saved is not None
        assert saved.status == "rejected"
        assert saved.code == "UNSUPPORTED"
        assert saved.message == "this host cannot interrupt"

    async def test_setting_the_status_of_a_command_nobody_accepted_is_an_error(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionCommandStore()
        async with session_factory() as session:
            await _make_session(session)
            with pytest.raises(LookupError):
                await store.set_status(
                    session,
                    "s-1",
                    "cmd-nope",
                    status="delivered",
                    code=None,
                    message=None,
                )


class TestSessionRoomAssociationStore:
    async def test_a_session_publishes_into_the_room_it_was_granted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionRoomAssociationStore()
        async with session_factory() as session:
            await _make_session(session)
            room_id = await _make_room(session)
            await store.associate(
                session,
                SessionRoomAssociation(
                    session_id="s-1",
                    room_id=room_id,
                    thread_id="thread-1",
                    origin_message_id="msg-1",
                    granted_by_actor_id="actor-1",
                    source="room-command",
                ),
            )
            await session.commit()

        async with session_factory() as session:
            found = await store.get(session, "s-1")

        assert found is not None
        assert found.room_id == room_id
        assert found.origin_message_id == "msg-1"
        assert found.source == "room-command"

    async def test_an_unassociated_session_publishes_nowhere(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Every Console-started session. Nothing here means nothing published."""
        store = SessionRoomAssociationStore()
        async with session_factory() as session:
            await _make_session(session)
            assert await store.get(session, "s-1") is None

    async def test_a_session_cannot_be_moved_to_a_second_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionRoomAssociationStore()
        async with session_factory() as session:
            await _make_session(session)
            first_room = await _make_room(session)
            await store.associate(
                session,
                SessionRoomAssociation(
                    session_id="s-1",
                    room_id=first_room,
                    granted_by_actor_id="actor-1",
                    source="room-command",
                ),
            )
            await session.commit()

        async with session_factory() as session:
            second_room = await _make_room(session)
            with pytest.raises(IntegrityError):
                await store.associate(
                    session,
                    SessionRoomAssociation(
                        session_id="s-1",
                        room_id=second_room,
                        granted_by_actor_id="actor-2",
                        source="grant",
                    ),
                )


class TestSessionPublicationStore:
    async def test_an_intent_is_found_again_by_the_request_it_stands_for(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A retry has only the request in hand; that has to be enough to find it."""
        store = SessionPublicationStore()
        async with session_factory() as session:
            await _make_session(session)
            bridge_id = await _make_bridge(session)
            await store.create(
                session,
                SessionPublication(
                    bridge_id=bridge_id,
                    session_id="s-1",
                    request_id="req-1",
                    state="in-flight",
                ),
            )
            await session.commit()

        async with session_factory() as session:
            found = await store.get(session, bridge_id, "s-1", "req-1")

        assert found is not None
        assert found.state == "in-flight"
        assert found.external_post_id is None
        assert found.attempts == 0

    async def test_one_request_has_one_intent_per_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two intents is two cards, and two sets of buttons for one decision."""
        store = SessionPublicationStore()
        async with session_factory() as session:
            await _make_session(session)
            bridge_id = await _make_bridge(session)
            await store.create(
                session,
                SessionPublication(
                    bridge_id=bridge_id,
                    session_id="s-1",
                    request_id="req-1",
                    state="in-flight",
                ),
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await store.create(
                    session,
                    SessionPublication(
                        bridge_id=bridge_id,
                        session_id="s-1",
                        request_id="req-1",
                        state="intended",
                    ),
                )

    async def test_an_attempt_is_counted_whether_or_not_it_worked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A try that ended in silence is the one worth backing off on."""
        store = SessionPublicationStore()
        async with session_factory() as session:
            await _make_session(session)
            bridge_id = await _make_bridge(session)
            publication = await store.create(
                session,
                SessionPublication(
                    bridge_id=bridge_id,
                    session_id="s-1",
                    request_id="req-1",
                    state="in-flight",
                ),
            )
            await store.record_failure(
                session, publication, state="in-flight", last_error="timeout"
            )
            await store.record_posted(session, publication, "C1:111.0")
            await session.commit()

        async with session_factory() as session:
            found = await store.get(session, bridge_id, "s-1", "req-1")

        assert found is not None
        assert found.attempts == 2
        assert found.state == "posted"
        assert found.external_post_id == "C1:111.0"
        assert found.last_error is None

    async def test_a_later_failure_cannot_erase_a_known_post(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A card is out there. Forgetting where means posting a second one."""
        store = SessionPublicationStore()
        async with session_factory() as session:
            await _make_session(session)
            bridge_id = await _make_bridge(session)
            publication = await store.create(
                session,
                SessionPublication(
                    bridge_id=bridge_id,
                    session_id="s-1",
                    request_id="req-1",
                    state="in-flight",
                ),
            )
            await store.record_posted(session, publication, "C1:111.0")
            await store.record_failure(
                session, publication, state="in-flight", last_error="edit rejected"
            )
            await session.commit()

        async with session_factory() as session:
            found = await store.get(session, bridge_id, "s-1", "req-1")

        assert found is not None
        assert found.external_post_id == "C1:111.0"
        assert found.state == "in-flight"
        assert found.last_error == "edit rejected"

    async def test_the_sweep_sees_only_what_never_settled(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A posted card needs no reconciling; an in-flight one is the whole point."""
        store = SessionPublicationStore()
        async with session_factory() as session:
            await _make_session(session)
            bridge_id = await _make_bridge(session)
            for request_id, state in (
                ("req-posted", "posted"),
                ("req-intended", "intended"),
                ("req-in-flight", "in-flight"),
                ("req-failed", "failed"),
            ):
                await store.create(
                    session,
                    SessionPublication(
                        bridge_id=bridge_id,
                        session_id="s-1",
                        request_id=request_id,
                        state=state,
                    ),
                )
            await session.commit()

        async with session_factory() as session:
            unresolved = await store.claim_unresolved(session, limit=10)

        assert {p.request_id for p in unresolved} == {"req-intended", "req-in-flight"}

    async def test_a_second_sweep_does_not_get_rows_the_first_is_holding(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Reconciling takes a call to Slack, which can outlast the sweep timer.

        Two passes that both adopt one in-flight intent post the second card
        this table exists to prevent.
        """
        store = SessionPublicationStore()
        async with session_factory() as session:
            await _make_session(session)
            bridge_id = await _make_bridge(session)
            await store.create(
                session,
                SessionPublication(
                    bridge_id=bridge_id,
                    session_id="s-1",
                    request_id="req-1",
                    state="in-flight",
                ),
            )
            await session.commit()

        async with session_factory() as first_sweep:
            held = await store.claim_unresolved(first_sweep, limit=10)
            assert [p.request_id for p in held] == ["req-1"]

            async with session_factory() as second_sweep:
                also_held = await store.claim_unresolved(second_sweep, limit=10)

        assert also_held == []
