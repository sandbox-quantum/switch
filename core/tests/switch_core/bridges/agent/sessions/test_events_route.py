"""The events route: what the server will take into a session's log.

The log is the record, so the interesting assertions are about what is in it
afterwards and what the host is told it may forget. Driven through the real
router against real Postgres for the same reason the lease tests are: the
ordering guarantee is a lock and a unique index, and neither of those exists in
a mock.

The last class replays a recorded conversation over HTTP and folds what comes
back out of the database, so the projection a reader would build from the log
has to match the one the fixture builds directly. That is the slice's
acceptance: everything above it is a rule, and this is the rules not having
broken anything.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.sessions.errors import SessionApiError
from switch_core.bridges.agent.sessions.ingest_service import SessionIngestService
from switch_core.bridges.agent.sessions.schemas import EventsRequest
from switch_core.bridges.collaboration.session.contract import (
    ServerEvent,
    parse_snapshot,
)
from switch_core.bridges.collaboration.session.projection import SessionProjection
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.db.models import HostSession, SessionEvent, SessionLease
from switch_core.db.stores.session_event_store import SessionEventStore
from switch_core.db.stores.session_lease_store import SessionLeaseStore
from switch_core.db.stores.session_store import SessionStore

from .conftest import Caller

REPO_ROOT = Path(__file__).resolve().parents[6]
ACTIVITY_PATH = (
    REPO_ROOT / "console/packages/shared/src/session-v1/examples.activity.json"
)

TURN = {"type": "turn.upsert", "turnId": "turn-1", "status": "running"}


def _event(
    epoch: str,
    host_sequence: int,
    *,
    event_id: str | None = None,
    session_id: str = "s1",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "contractVersion": 1,
        "eventId": event_id or f"event-{host_sequence}",
        "sessionId": session_id,
        "epoch": epoch,
        "hostSequence": host_sequence,
        "occurredAt": "2026-09-08T09:00:00Z",
        "body": {**TURN, "commandId": None} if body is None else body,
    }


async def _leased(caller: Caller, session_id: str = "s1") -> str:
    resp = await caller.lease(session_id, hostId="host-a")
    assert resp.status_code == 200
    return str(resp.json()["epoch"])


async def _logged(
    session_factory: async_sessionmaker[AsyncSession], session_id: str = "s1"
) -> list[SessionEvent]:
    async with session_factory() as session:
        result = await session.execute(
            select(SessionEvent)
            .where(SessionEvent.session_id == session_id)
            .order_by(SessionEvent.sequence)
        )
        return list(result.scalars())


class TestTheDoor:
    async def test_an_unregistered_session_takes_no_events(
        self, caller: Caller
    ) -> None:
        """A lease is what registers a session, so there is nothing to append to."""
        resp = await caller.send(
            "never-seen", [_event("e", 1, session_id="never-seen")]
        )

        assert resp.status_code == 404
        assert resp.json()["code"] == "NOT_FOUND"

    async def test_another_agents_session_takes_no_events(self, caller: Caller) -> None:
        epoch = await _leased(caller)

        caller.as_agent(caller.other)
        resp = await caller.send("s1", [_event(epoch, 1)])

        assert resp.status_code == 403
        assert resp.json()["code"] == "NOT_AUTHORIZED"

    async def test_an_event_naming_a_different_session_is_refused(
        self, caller: Caller
    ) -> None:
        """The envelope and the URL are two statements of the same fact.

        Trusting the URL and writing the event anyway would put one session's
        history under another session's id, which no later reader could undo.
        """
        epoch = await _leased(caller)

        resp = await caller.send("s1", [_event(epoch, 1, session_id="s2")])

        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_REQUEST"

    async def test_a_session_upsert_may_not_name_another_agent(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The only party who knows who authenticated is the server."""
        epoch = await _leased(caller)
        body = _session_upsert("s1", caller.other.id, epoch)

        resp = await caller.send("s1", [_event(epoch, 1, body=body)])

        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_REQUEST"
        assert await _logged(session_factory) == []

    async def test_a_session_upsert_may_not_name_another_host(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The lease says which machine is running this session.

        Nothing downstream re-derives it, so a body naming a host that does not
        hold the lease would be read as fact by the snapshot fold and the
        console while the lease and the session row both said otherwise.
        """
        epoch = await _leased(caller)
        body = _session_upsert("s1", caller.agent.id, epoch, host_id="host-b")

        resp = await caller.send("s1", [_event(epoch, 1, body=body)])

        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_REQUEST"
        assert await _logged(session_factory) == []


class TestTheEpochIsTheFence:
    async def test_a_session_with_no_lease_takes_no_events(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Registered but unleased: the row exists and the generation does not."""
        await _leased(caller)
        async with session_factory() as session:
            lease = await session.get(SessionLease, "s1")
            assert lease is not None
            await session.delete(lease)
            await session.commit()

        resp = await caller.send("s1", [_event("gone", 1)])

        assert resp.status_code == 409
        assert resp.json()["code"] == "STALE_EPOCH"

    async def test_an_epoch_that_is_not_the_current_one_is_refused(
        self, caller: Caller
    ) -> None:
        epoch = await _leased(caller)

        resp = await caller.send("s1", [_event(epoch + "-not", 1)])

        assert resp.status_code == 409
        assert resp.json()["code"] == "STALE_EPOCH"
        assert resp.json()["retryable"] is False

    async def test_a_displaced_host_cannot_keep_emitting(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """What the fence is for.

        The loser is never told it lost — it finds out here, on the first thing
        it tries to write under the generation it no longer holds.
        """
        stale = await _leased(caller)
        await caller.send("s1", [_event(stale, 1)])
        await caller.lease("s1", hostId="host-b", takeover=True)

        resp = await caller.send("s1", [_event(stale, 2)])

        assert resp.status_code == 409
        assert resp.json()["code"] == "STALE_EPOCH"
        assert [row.host_sequence for row in await _logged(session_factory)] == [1]

    async def test_one_stale_event_refuses_the_whole_batch(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Checked before anything is written, so the host's outbox is intact."""
        epoch = await _leased(caller)

        resp = await caller.send("s1", [_event(epoch, 1), _event(epoch + "-not", 2)])

        assert resp.status_code == 409
        assert await _logged(session_factory) == []

    async def test_numbering_restarts_with_a_new_generation(
        self, caller: Caller
    ) -> None:
        """Host sequence is per epoch, so a restart counts from 1 again.

        The server has position 1 of the old generation and must not read the
        new one's position 1 as a repeat of it.
        """
        first = await _leased(caller)
        await caller.send("s1", [_event(first, 1)])
        second = (await caller.lease("s1", hostId="host-a")).json()["epoch"]

        resp = await caller.send("s1", [_event(second, 1, event_id="event-b1")])

        assert resp.status_code == 200
        assert resp.json()["acceptedThrough"] == 1
        assert resp.json()["epoch"] == second


class TestOrder:
    async def test_a_batch_is_accepted_and_reported_to_its_last_position(
        self, caller: Caller
    ) -> None:
        epoch = await _leased(caller)

        resp = await caller.send(
            "s1", [_event(epoch, 1), _event(epoch, 2), _event(epoch, 3)]
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "sessionId": "s1",
            "epoch": epoch,
            "acceptedThrough": 3,
            "sequence": 3,
        }

    async def test_a_log_that_starts_at_two_is_refused(self, caller: Caller) -> None:
        epoch = await _leased(caller)

        resp = await caller.send("s1", [_event(epoch, 2)])

        assert resp.status_code == 409
        body = resp.json()
        assert body["code"] == "EXPECTED_SEQUENCE"
        assert body["retryable"] is True
        assert "Resend from 1" in body["message"]

    async def test_a_gap_after_what_is_already_held_is_refused(
        self, caller: Caller
    ) -> None:
        epoch = await _leased(caller)
        await caller.send("s1", [_event(epoch, 1)])

        resp = await caller.send("s1", [_event(epoch, 3)])

        assert resp.status_code == 409
        assert resp.json()["code"] == "EXPECTED_SEQUENCE"
        assert "Resend from 2" in resp.json()["message"]

    async def test_a_gap_inside_a_batch_writes_nothing_before_it(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """All or nothing.

        The route commits once. A batch that appended its first half and then
        refused would move `acceptedThrough` somewhere the host was never told
        about, and the host would truncate its outbox from the wrong place.
        """
        epoch = await _leased(caller)

        resp = await caller.send(
            "s1", [_event(epoch, 1), _event(epoch, 2), _event(epoch, 4)]
        )

        assert resp.status_code == 409
        assert await _logged(session_factory) == []

    async def test_events_are_written_in_the_order_the_host_numbered_them(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        epoch = await _leased(caller)

        await caller.send("s1", [_event(epoch, 1), _event(epoch, 2)])
        await caller.send("s1", [_event(epoch, 3)])

        rows = await _logged(session_factory)
        assert [row.host_sequence for row in rows] == [1, 2, 3]
        assert [row.sequence for row in rows] == [1, 2, 3]


class TestRepeats:
    async def test_resending_an_accepted_batch_changes_nothing(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The retry path.

        A host truncates its outbox on the answer, so a lost answer means it
        sends the same events again. Refusing that would leave the outbox stuck
        forever on events the server already has.
        """
        epoch = await _leased(caller)
        batch = [_event(epoch, 1), _event(epoch, 2)]
        first = await caller.send("s1", batch)

        second = await caller.send("s1", batch)

        assert second.status_code == 200
        assert second.json() == first.json()
        assert len(await _logged(session_factory)) == 2

    async def test_a_batch_that_overlaps_and_continues_takes_the_remainder(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The usual retry: the host resends from a cursor behind the truth."""
        epoch = await _leased(caller)
        await caller.send("s1", [_event(epoch, 1), _event(epoch, 2)])

        resp = await caller.send(
            "s1", [_event(epoch, 2), _event(epoch, 3), _event(epoch, 4)]
        )

        assert resp.status_code == 200
        assert resp.json()["acceptedThrough"] == 4
        assert [row.host_sequence for row in await _logged(session_factory)] == [
            1,
            2,
            3,
            4,
        ]

    async def test_a_different_event_at_a_taken_position_is_a_conflict(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The log is append-only, so this is reported rather than resolved."""
        epoch = await _leased(caller)
        await caller.send("s1", [_event(epoch, 1)])

        resp = await caller.send("s1", [_event(epoch, 1, event_id="event-other")])

        assert resp.status_code == 409
        assert resp.json()["code"] == "IDEMPOTENCY_CONFLICT"
        assert [row.event_id for row in await _logged(session_factory)] == ["event-1"]

    async def test_the_same_id_with_a_different_body_is_a_conflict(
        self, caller: Caller
    ) -> None:
        """Same event id, same position, rewritten content.

        Accepting the newer body would silently replace history; accepting the
        older one silently discards an edit. Neither is a thing a log does.
        """
        epoch = await _leased(caller)
        await caller.send("s1", [_event(epoch, 1)])

        resp = await caller.send(
            "s1",
            [
                _event(
                    epoch,
                    1,
                    body={**TURN, "status": "completed", "commandId": None},
                )
            ],
        )

        assert resp.status_code == 409
        assert resp.json()["code"] == "IDEMPOTENCY_CONFLICT"

    async def test_one_batch_repeating_a_position_is_compared_against_itself(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A repeat inside a batch is a repeat of what the batch just wrote.

        The overlap is read once, before anything is appended, so a position
        that only becomes taken part way through the loop is not in it. Left
        alone, the second copy would be refused as conflicting with an event
        the server would report as missing.
        """
        epoch = await _leased(caller)
        twice = _event(epoch, 1)

        resp = await caller.send("s1", [twice, twice])

        assert resp.status_code == 200
        assert resp.json()["acceptedThrough"] == 1
        assert len(await _logged(session_factory)) == 1

    async def test_one_batch_contradicting_itself_says_what_is_wrong(
        self, caller: Caller
    ) -> None:
        epoch = await _leased(caller)

        resp = await caller.send(
            "s1", [_event(epoch, 1), _event(epoch, 1, event_id="event-other")]
        )

        assert resp.status_code == 409
        assert resp.json()["code"] == "IDEMPOTENCY_CONFLICT"

    async def test_the_same_id_at_a_new_position_is_a_conflict(
        self, caller: Caller
    ) -> None:
        """An event id names one event, wherever the host thinks it goes.

        The position check cannot see this one: position 2 is genuinely free.
        The unique index is what catches it.
        """
        epoch = await _leased(caller)
        await caller.send("s1", [_event(epoch, 1, event_id="event-once")])

        resp = await caller.send("s1", [_event(epoch, 2, event_id="event-once")])

        assert resp.status_code == 409
        assert resp.json()["code"] == "IDEMPOTENCY_CONFLICT"


class TestTheFenceHoldsUntilTheBatchLands:
    """The epoch is checked against a lease held for the rest of the batch.

    Otherwise the check is a read of a row anyone may change a moment later,
    and events emitted under a generation that has already been taken away
    commit anyway. That the following `renew` would then fail is not a fence:
    it is a side effect of the heartbeat, and a later slice that moves the
    renew or makes it tolerant would open the gap with nothing to notice.
    """

    async def test_the_generation_is_held_from_the_moment_it_is_checked(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Not from the moment the batch happens to renew the lease.

        The renew at the end of an accepted batch locks the same row, so a
        fence that only began there would look identical from outside — right
        up until a batch that never reaches it. This one is refused for a gap,
        after the epoch has been checked and before anything is written, and
        the generation still may not move underneath it.
        """
        epoch = await _leased(caller)
        ingest = SessionIngestService(
            SessionStore(), SessionLeaseStore(), SessionEventStore()
        )

        async with session_factory() as sending:
            with pytest.raises(SessionApiError):
                await ingest.ingest(
                    sending,
                    "s1",
                    caller.agent.id,
                    EventsRequest(events=[_event(epoch, 7)]),
                )

            async with session_factory() as displacing:
                await displacing.execute(text("SET LOCAL lock_timeout = '250ms'"))
                with pytest.raises(DBAPIError):
                    await SessionLeaseStore().take_over(
                        displacing, "s1", epoch, caller.agent.id, "host-b", "epoch-b"
                    )

    async def test_a_takeover_that_lands_first_refuses_the_batch(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The other side of the same fence, and the answer the host needs."""
        epoch = await _leased(caller)
        await caller.lease("s1", hostId="host-b", takeover=True)

        resp = await caller.send("s1", [_event(epoch, 1)])

        assert resp.status_code == 409
        assert resp.json()["code"] == "STALE_EPOCH"
        assert await _logged(session_factory) == []


class TestWhatTheServerAddsOfItsOwn:
    async def test_the_servers_sequence_is_not_the_hosts(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two counters, reported together and never comparable.

        The server's numbers events the host never sent, so a host that treated
        `sequence` as an outbox cursor would delete work it never got an answer
        for. Proved with an event the host has no way to produce.
        """
        epoch = await _leased(caller)
        async with session_factory() as session:
            await SessionEventStore().append(
                session,
                SessionEvent(
                    session_id="s1",
                    event_id="event-server",
                    type="session.connectivity",
                    body={"type": "session.connectivity", "connectivity": "online"},
                    occurred_at=_now(),
                ),
            )
            await session.commit()

        resp = await caller.send("s1", [_event(epoch, 1)])

        assert resp.json()["acceptedThrough"] == 1
        assert resp.json()["sequence"] == 2

    async def test_a_session_upsert_updates_what_the_server_holds(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Capabilities are enforced per command, so they are kept at rest.

        Answering "can this session be interrupted" by re-folding the log would
        make an authorisation check depend on history.
        """
        epoch = await _leased(caller)
        body = _session_upsert("s1", caller.agent.id, epoch)

        resp = await caller.send("s1", [_event(epoch, 1, body=body)])

        assert resp.status_code == 200
        async with session_factory() as session:
            record = await session.get(HostSession, "s1")
            assert record is not None
            assert record.provider == "claude"
            assert record.status == "running"
            assert record.capabilities["interrupt"] is True

    async def test_sending_events_keeps_the_lease_alive(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A host emitting is a host that is plainly alive.

        Without this a busy host that never gets round to a heartbeat becomes
        displaceable at the TTL while it is mid-turn.
        """
        epoch = await _leased(caller)
        async with session_factory() as session:
            lease = await session.get(SessionLease, "s1")
            assert lease is not None
            before = lease.last_seen_at

        await caller.send("s1", [_event(epoch, 1)])

        async with session_factory() as session:
            lease = await session.get(SessionLease, "s1")
            assert lease is not None
            assert lease.last_seen_at > before


class TestWhatIsRefusedBeforeItIsRead:
    async def test_an_empty_batch_is_refused(self, caller: Caller) -> None:
        """A host with nothing to send does not send."""
        await _leased(caller)

        resp = await caller.send("s1", [])

        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_REQUEST"

    async def test_an_event_that_is_not_a_host_event_is_refused(
        self, caller: Caller
    ) -> None:
        epoch = await _leased(caller)
        broken = _event(epoch, 1)
        del broken["occurredAt"]

        resp = await caller.send("s1", [broken])

        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_REQUEST"

    async def test_an_event_over_64_kib_is_refused(self, caller: Caller) -> None:
        epoch = await _leased(caller)

        resp = await caller.send("s1", [_event(epoch, 1, body=_bulky(70_000))])

        assert resp.status_code == 413
        assert resp.json()["code"] == "PAYLOAD_TOO_LARGE"

    async def test_a_batch_over_1_mib_is_refused(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Every event legal on its own, and too many of them together."""
        epoch = await _leased(caller)
        events = [
            _event(epoch, n, event_id=f"event-{n}", body=_bulky(60_000))
            for n in range(1, 20)
        ]

        resp = await caller.send("s1", events)

        assert resp.status_code == 413
        assert resp.json()["code"] == "PAYLOAD_TOO_LARGE"
        assert await _logged(session_factory) == []


class TestReplayingTheRecording:
    """The slice's acceptance: the log is a faithful carrier.

    A recorded conversation goes in over HTTP and comes back out of Postgres,
    and the projection built from what came back is the same object the fixture
    builds from the recording directly. Nothing about the round trip — the
    envelope the server rewrites, the columns it splits the event into, the
    JSON round trip through the database — may change what a reader sees.
    """

    async def test_the_log_rebuilds_the_fixtures_projection(
        self, caller: Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        recorded = json.loads(ACTIVITY_PATH.read_text())
        session_id = recorded["initialSnapshot"]["session"]["sessionId"]
        epoch = await _leased(caller, session_id)

        posted = await caller.send(
            session_id,
            [_as_host_event(event, epoch) for event in recorded["turnActivity"]],
        )
        assert posted.status_code == 200, posted.text
        assert posted.json()["acceptedThrough"] == len(recorded["turnActivity"])

        rows = await _logged(session_factory, session_id)
        # Byte-for-byte what the host sent, in the contract's own dialect. The
        # projection alone would not pin this: it reads a body through Pydantic,
        # which takes snake_case as happily as camelCase, so a log written in
        # the wrong dialect would rebuild here and break the moment a
        # TypeScript reader parsed it.
        assert [row.body for row in rows] == [
            event["body"] for event in recorded["turnActivity"]
        ]

        replayed = SessionProjection(parse_snapshot(recorded["initialSnapshot"]))
        for row in rows:
            assert replayed.apply(_as_server_event(row))

        source = FixtureEventSource.from_examples(
            ACTIVITY_PATH, events=["turnActivity"]
        )
        assert replayed.snapshot == (await project(source, session_id)).snapshot


def _as_host_event(recorded: dict[str, Any], epoch: str) -> dict[str, Any]:
    """A recorded server event as the host would have emitted it.

    The recording is what a reader receives, which is the server's numbering.
    Going backwards is only possible because nothing else differs: the host
    numbers its own log and names its generation, and the server replaces the
    first and strips the second on the way out.
    """
    envelope = {k: v for k, v in recorded.items() if k != "sequence"}
    return {**envelope, "epoch": epoch, "hostSequence": recorded["sequence"]}


def _as_server_event(row: SessionEvent) -> ServerEvent:
    """A logged row as a reader will be given it.

    Done here rather than imported because there is nothing to import yet: the
    gateway read route is where this conversion lands for real, and until it
    exists this test is the only thing that needs it. It is deliberately
    literal — every field straight off the row — so that when the real one
    arrives the difference between them is visible.
    """
    return ServerEvent.model_validate(
        {
            "contractVersion": 1,
            "eventId": row.event_id,
            "sessionId": row.session_id,
            "sequence": row.sequence,
            "occurredAt": row.occurred_at.isoformat(),
            "body": row.body,
        }
    )


def _session_upsert(
    session_id: str, agent_id: str, epoch: str, host_id: str = "host-a"
) -> dict[str, Any]:
    return {
        "type": "session.upsert",
        "session": {
            "sessionId": session_id,
            "agentId": agent_id,
            "provider": "claude",
            "hostId": host_id,
            "epoch": epoch,
            "status": "running",
            "connectivity": "online",
            "capabilities": {
                "input": "queue",
                "approvals": True,
                "questions": True,
                "interrupt": True,
                "reset": False,
                "compact": False,
                "modelChange": False,
                "attachmentMimeTypes": [],
            },
            "pendingRequestIds": [],
        },
    }


def _bulky(size: int) -> dict[str, Any]:
    return {
        "type": "item.upsert",
        "item": {
            "itemId": "item-bulky",
            "turnId": "turn-1",
            "revision": 1,
            "kind": "agent-message",
            "status": "completed",
            "title": "",
            "text": "x" * size,
            "attachments": [],
            "origin": None,
            "audience": {"kind": "private"},
        },
    }


def _now() -> datetime:
    return datetime.now(UTC)
