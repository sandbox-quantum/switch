"""Taking a host's events into the log.

The log is the record, so this is the only place a host event becomes durable,
and everything that decides whether it may is here rather than spread between
the route and the store. The store enforces uniqueness; it does not know what
an epoch means or which position should come next.

Four rules, in the order they are checked:

- **The session exists and is this agent's.** An id nobody registered is not a
  session, and a lease is what registers one.
- **The epoch is the one the lease holds.** The epoch is the fence, and the
  lease is where it lives. A host emitting under a generation it has lost is
  the exact case the fence exists for, so it is refused before anything is read
  about ordering.
- **The host's log has no holes.** Positions arrive contiguously or not at all.
  A batch that repeats what is already durable is the retry path and is
  accepted as a no-op; a batch that skips a position is refused with the number
  the server wants next.
- **Nothing is rewritten.** A position already holding different content is a
  conflict, not an update. The log is append-only and a host that has lost
  track of what it sent must be told rather than have its history quietly
  replaced.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from switch_core.bridges.agent.sessions.errors import SessionApiError
from switch_core.bridges.agent.sessions.ownership import require_session
from switch_core.bridges.agent.sessions.schemas import EventsRequest, EventsResponse
from switch_core.bridges.collaboration.session.contract import (
    MAX_EVENT_BYTES,
    HostEvent,
    SessionUpsert,
    event_bytes,
    parse_host_event,
)
from switch_core.db.models import SessionEvent
from switch_core.db.stores.session_event_store import (
    DuplicateEventId,
    HostSequenceTaken,
    SessionEventStore,
)
from switch_core.db.stores.session_lease_store import SessionLeaseStore
from switch_core.db.stores.session_store import SessionStore

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import SessionLease

# The contract's batch cap. It is not in `contract.py` with the 64 KiB event cap
# because only a server receives a batch: the host's own parser has no batch to
# measure, so mirroring it there would claim a parity that does not exist.
MAX_BATCH_BYTES = 1024 * 1024


class SessionIngestService:
    def __init__(
        self,
        sessions: SessionStore,
        leases: SessionLeaseStore,
        events: SessionEventStore,
    ) -> None:
        self.sessions = sessions
        self.leases = leases
        self.events = events

    async def ingest(
        self,
        db: AsyncSession,
        session_id: str,
        agent_id: str,
        request: EventsRequest,
    ) -> EventsResponse:
        """Take a batch of host events into the log.

        The caller commits. Nothing is durable until it does, which is what
        makes the batch all-or-nothing: a refusal part way through leaves the
        host's outbox exactly where it was.
        """
        await require_session(self.sessions, db, session_id, agent_id)
        self._check_batch_size(request.events)
        parsed = [self._parse(raw, session_id) for raw in request.events]

        # Everything from here happens under two locks held to commit: the
        # log's, so deciding "already have it" or "next one" cannot race a
        # second batch reading the same position as free, and the lease row's,
        # so the generation this batch is checked against is still the current
        # one when it lands. Taken in that order because a lease claim takes
        # only the second, so the two can never wait on each other.
        await self.events.lock(db, session_id)
        lease = await self._require_lease(db, session_id)
        self._check_identity(parsed, lease, agent_id)

        accepted = await self._store(db, session_id, lease.epoch, parsed)

        # Cannot fail: the row is held, and the host and epoch come from the
        # read that holds it.
        await self.leases.renew(db, session_id, lease.host_id, lease.epoch)
        return EventsResponse(
            session_id=session_id,
            epoch=lease.epoch,
            accepted_through=accepted,
            sequence=await self.events.head_sequence(db, session_id),
        )

    def _check_batch_size(self, events: list[dict[str, Any]]) -> None:
        size = event_bytes(events)
        if size > MAX_BATCH_BYTES:
            raise SessionApiError(
                "PAYLOAD_TOO_LARGE",
                f"This batch is {size} bytes and the limit is {MAX_BATCH_BYTES}. "
                f"Send fewer events per request.",
                retryable=False,
            )

    def _parse(self, raw: dict[str, Any], session_id: str) -> HostEvent:
        """One event, validated by the host's own rules.

        The size is measured here as well as inside `parse_host_event`, from the
        same function and the same constant. Not a second answer to "is this
        event too big" — the same answer, one frame earlier, where the caller
        has a status code to attach to it. `parse_host_event` is shared with
        readers that have no status to return, so it can only raise a plain
        error, and reading its code back out of the message text would make an
        HTTP response depend on a string.
        """
        if event_bytes(raw) > MAX_EVENT_BYTES:
            raise SessionApiError(
                "PAYLOAD_TOO_LARGE",
                f"This event is {event_bytes(raw)} bytes and the limit is "
                f"{MAX_EVENT_BYTES}. Split it before sending.",
                retryable=False,
            )
        try:
            event = parse_host_event(raw)
        except ValueError as error:
            raise SessionApiError(
                "INVALID_REQUEST",
                f"This is not a valid host event: {error}",
                retryable=False,
            ) from error
        if event.session_id != session_id:
            raise SessionApiError(
                "INVALID_REQUEST",
                f"Event {event.event_id!r} names session {event.session_id!r} "
                f"but was sent to {session_id!r}.",
                retryable=False,
            )
        return event

    async def _require_lease(self, db: AsyncSession, session_id: str) -> SessionLease:
        """The generation this batch has to be emitting under, held to commit.

        Liveness is not consulted. A host whose lease has aged out still holds
        it until someone else takes it, and refusing its events would throw away
        work that nothing else has any claim to. What matters is that the
        generation is current, and a lease that is still there is still the
        current generation.
        """
        lease = await self.leases.get_held(db, session_id)
        if lease is None:
            raise SessionApiError(
                "STALE_EPOCH",
                f"Session {session_id!r} has no lease. Acquire one before emitting.",
                retryable=False,
            )
        return lease

    def _check_identity(
        self, parsed: list[HostEvent], lease: SessionLease, agent_id: str
    ) -> None:
        """Every event agrees with the lease about who is running this session.

        The epoch is the fence and is refused as a stale generation. The agent
        and host a `session.upsert` restates are a different failure: the host
        is emitting under the right generation and describing itself wrongly.
        `parse_host_event` already checks the session id and epoch the body
        repeats, because those sit in the envelope beside it — these two do not,
        and nothing downstream re-derives them. A body naming another host would
        be read as fact by every later reader of the log while the lease and the
        session row both said otherwise.
        """
        for event in parsed:
            if event.epoch != lease.epoch:
                raise SessionApiError(
                    "STALE_EPOCH",
                    f"Event {event.event_id!r} was emitted under epoch "
                    f"{event.epoch!r} and session {lease.session_id!r} is now on "
                    f"{lease.epoch!r}. Acquire a lease before emitting.",
                    retryable=False,
                )
            if not isinstance(event.body, SessionUpsert):
                continue
            reported = event.body.session
            if reported.agent_id != agent_id:
                raise SessionApiError(
                    "INVALID_REQUEST",
                    f"Event {event.event_id!r} reports session state for agent "
                    f"{reported.agent_id!r} and was sent by {agent_id!r}.",
                    retryable=False,
                )
            if reported.host_id != lease.host_id:
                raise SessionApiError(
                    "INVALID_REQUEST",
                    f"Event {event.event_id!r} reports session state for host "
                    f"{reported.host_id!r} and the lease is held by "
                    f"{lease.host_id!r}.",
                    retryable=False,
                )

    async def _store(
        self, db: AsyncSession, session_id: str, epoch: str, parsed: list[HostEvent]
    ) -> int:
        accepted = await self.events.head_host_sequence(db, session_id, epoch)
        # Rows this batch appends are added as they go, so a position repeated
        # inside one batch is compared against what this batch just wrote rather
        # than reported as a conflict with something that is not there.
        already = await self._overlap(db, session_id, epoch, accepted, parsed)
        for event in parsed:
            if event.host_sequence <= accepted:
                self._confirm_repeat(event, already.get(event.host_sequence))
                continue
            if event.host_sequence != accepted + 1:
                raise SessionApiError(
                    "EXPECTED_SEQUENCE",
                    f"Session {session_id!r} has accepted host sequence "
                    f"{accepted} of epoch {epoch!r} and the next event is "
                    f"{event.host_sequence}. Resend from {accepted + 1}.",
                    retryable=True,
                )
            already[event.host_sequence] = await self._append(db, event)
            accepted = event.host_sequence
        return accepted

    async def _overlap(
        self,
        db: AsyncSession,
        session_id: str,
        epoch: str,
        accepted: int,
        parsed: list[HostEvent],
    ) -> dict[int, SessionEvent]:
        """What is already logged at the positions this batch repeats.

        Only those positions. A host that has lost its place resends from a
        cursor that can be a long way behind, and reading everything between
        the ends of that span would pull the whole intervening log, bodies and
        all, to compare two events.
        """
        repeats = {e.host_sequence for e in parsed if e.host_sequence <= accepted}
        if not repeats:
            return {}
        return await self.events.read_host_positions(db, session_id, epoch, repeats)

    def _confirm_repeat(self, event: HostEvent, stored: SessionEvent | None) -> None:
        """Accept a position the host is sending again, if it is the same event.

        A host truncates its outbox on `acceptedThrough`, so a lost response
        means it resends what the server already has. That has to be a no-op or
        the retry path never converges. Different content under the same
        position is the opposite case: someone has lost track of what was sent,
        and overwriting the log would hide it.
        """
        body = _body(event)
        if stored is not None and stored.event_id == event.event_id:
            if stored.body == body:
                return
            raise SessionApiError(
                "IDEMPOTENCY_CONFLICT",
                f"Event {event.event_id!r} is already in the log with different "
                f"content. The log is append-only.",
                retryable=False,
            )
        raise SessionApiError(
            "IDEMPOTENCY_CONFLICT",
            f"Position {event.host_sequence} of epoch {event.epoch!r} already "
            f"holds a different event. The log is append-only.",
            retryable=False,
        )

    async def _append(self, db: AsyncSession, event: HostEvent) -> SessionEvent:
        row = _row(event)
        try:
            await self.events.append(db, row)
        except DuplicateEventId as error:
            # Not the position check failing: this is the same event id arriving
            # at a *different* position, which the position check cannot see.
            raise SessionApiError(
                "IDEMPOTENCY_CONFLICT", str(error), retryable=False
            ) from error
        except HostSequenceTaken as error:
            # The position was free when it was read and is not now, so another
            # batch committed in between. Nothing is wrong with this event; the
            # host's view of how far it got is stale.
            raise SessionApiError(
                "EXPECTED_SEQUENCE",
                f"{error} Re-read the accepted position and resend from there.",
                retryable=True,
            ) from error
        if isinstance(event.body, SessionUpsert):
            await self._record_reported_state(db, event.body)
        return row

    async def _record_reported_state(
        self, db: AsyncSession, body: SessionUpsert
    ) -> None:
        """Keep what the host says about itself where the server can read it.

        Capabilities are enforced on every command, and re-folding the log to
        find out what a session supports would make that check depend on
        history. `connectivity` is not stored: the server derives it from the
        lease, and the contract says a host's own report cannot replace that.
        """
        await self.sessions.record_reported_state(
            db,
            body.session.session_id,
            body.session.provider,
            body.session.capabilities.model_dump(by_alias=True, mode="json"),
            body.session.status,
        )


def _body(event: HostEvent) -> dict[str, Any]:
    return event.body.model_dump(by_alias=True, mode="json")


def _occurred_at(value: str) -> datetime:
    """The contract's timestamp as something the column can hold.

    The contract accepts what `z.iso.datetime()` accepts, which includes a
    `Z` suffix Python did not read until 3.11 and, more awkwardly, a local time
    with no offset at all. The column is `timestamptz`, so an offset has to come
    from somewhere: reading a bare time as UTC is the only reading that does not
    depend on where the server happens to be running.
    """
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _row(event: HostEvent) -> SessionEvent:
    """The envelope becomes columns and the body stays JSON.

    Everything the server orders, fences or refuses a repeat on is a column, so
    none of it depends on reading the JSON back. `sequence` is left unset
    because the store assigns it.
    """
    return SessionEvent(
        session_id=event.session_id,
        epoch=event.epoch,
        host_sequence=event.host_sequence,
        event_id=event.event_id,
        type=event.body.type,
        body=_body(event),
        occurred_at=_occurred_at(event.occurred_at),
    )
