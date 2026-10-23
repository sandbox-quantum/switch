"""Opening an agent connection, and what is left of the /events endpoint.

The connection opens over the WebSocket through `_open_connection`, which
these drive directly: validation, protocol ranges, declarations, room claims
and session reporting. `/events` itself is now only the long poll, and a
request for the old Server-Sent Events stream is refused with what to do.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api import session_reporter
from switch_core.bridges.agent.api.handlers import (
    _open_connection,
    _resolve_start_position,
    poll_events,
)
from switch_core.bridges.agent.api.session_reporter import SessionReporter
from switch_core.bridges.agent.protocol.agent_connections import (
    HEARTBEAT_LAPSED,
    PROTOCOL_ACCEPTS,
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import TICKET_FLOOR, EventBuffer
from switch_core.bridges.agent.protocol.positions import (
    OWN_EVENTS,
    Position,
    room_source,
)
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord
from tests.db_buffer import seed_agent

AGENT_ID = "agent-1"


@pytest.fixture(autouse=True)
async def _agent_row(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent these connections are for, so its events have a row to belong to."""
    await seed_agent(session_factory, AGENT_ID)


class _Protocol:
    def __init__(self, event_buffer: EventBuffer) -> None:
        self.event_buffer = event_buffer
        self.connections = AgentConnectionRegistry()
        # No approval outcomes: these tests are about opening the stream.
        self.approval_outcomes = None
        # Opening and closing a stream reports a session; a reporter with no
        # telemetry service reports nothing, which is what these tests want.
        self.telemetry = None
        self.sessions = SessionReporter(None)
        self.polled = False
        self.recorded: list[tuple[str, str, ClientDeclaration]] = []

    async def record_client_declaration(
        self, agent_id: str, connection_id: str, declaration: ClientDeclaration
    ) -> None:
        self.recorded.append((agent_id, connection_id, declaration))

    async def poll_events(self, agent_id: str, timeout: float) -> list[Any]:
        self.polled = True
        return []

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        return None

    async def require_recorded_rooms_unmoved(
        self,
        agent_id: str,
        connection: Any,
        claiming: frozenset[str],
        dropping: frozenset[str],
    ) -> None:
        """No session of this agent is recorded anywhere, so nothing is fenced."""


def _agent() -> Any:
    # `metadata_` carries the agent's runtime, which opening a stream reports.
    return SimpleNamespace(
        id=AGENT_ID,
        tenant_id=TENANT_ZERO_ID,
        metadata_={"known_agent_type": "claude-code"},
    )


async def _call(protocol: _Protocol, **kw: Any) -> Any:
    params: dict[str, Any] = {
        "agent_id": AGENT_ID,
        "agent": _agent(),
        "protocol": protocol,
        "timeout": 0,
        "accept": None,
        "connection_id": None,
        "scope": "single",
        "event_filter": "all",
        "start_from": "head",
        "spawn_capable": False,
        "protocol_version": PROTOCOL_VERSION,
        "protocol_accepts": None,
        "client": None,
        "client_version": None,
        "rooms": None,
    }
    params.update(kw)
    if params.pop("accept") != "text/event-stream":
        return await poll_events(**params, accept=None)
    # What used to open the stream now opens the connection the WebSocket
    # carries; the rules are the same ones.
    conn, _frames = await _open_connection(
        config=None,  # type: ignore[arg-type]
        agent=params["agent"],
        protocol=params["protocol"],
        connection_id=params["connection_id"],
        scope=params["scope"],
        event_filter=params["event_filter"],
        start_from=params["start_from"],
        spawn_capable=params["spawn_capable"],
        declaration=ClientDeclaration(
            speaks=params["protocol_version"],
            accepts=params["protocol_accepts"],
            artifact=params["client"],
            version=params["client_version"],
        ),
        rooms=params["rooms"],
        expected_generation=params.get("expected_generation"),
    )
    return conn


async def test_without_the_sse_accept_header_it_long_polls(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    resp = await _call(protocol, accept="application/json")

    assert protocol.polled
    assert resp.status_code == 204


async def test_asking_for_the_old_stream_is_refused_with_a_remedy(
    db_buffer: EventBuffer,
) -> None:
    """An old runtime is told to update, not left retrying a stream that is
    gone."""
    protocol = _Protocol(db_buffer)
    with pytest.raises(HTTPException) as excinfo:
        await poll_events(
            agent_id=AGENT_ID,
            agent=_agent(),
            protocol=protocol,  # type: ignore[arg-type]
            accept="text/event-stream",
        )

    assert excinfo.value.status_code == 410
    assert excinfo.value.detail["code"] == "transport_removed"  # type: ignore[index]
    assert "connection/ws" in excinfo.value.detail["message"]  # type: ignore[index]
    assert not protocol.polled


async def test_opening_registers_the_connection(db_buffer: EventBuffer) -> None:
    protocol = _Protocol(db_buffer)
    conn = await _call(
        protocol, accept="text/event-stream", connection_id="c1", scope="all"
    )

    assert protocol.connections.get("c1") is conn
    assert conn.scope == "all"
    assert conn.stream_attached


async def test_streaming_without_a_connection_id_is_refused(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    with pytest.raises(HTTPException) as excinfo:
        await _call(protocol, accept="text/event-stream")

    assert excinfo.value.status_code == 400
    assert "connection_id is required" in excinfo.value.detail


async def test_streaming_with_an_over_long_connection_id_is_refused(
    db_buffer: EventBuffer,
) -> None:
    """The id travels in the signals switch-core processes send each other,
    which Postgres caps at 8000 bytes, so one this long cannot be opened."""
    protocol = _Protocol(db_buffer)
    with pytest.raises(HTTPException) as excinfo:
        await _call(protocol, accept="text/event-stream", connection_id="c" * 7900)

    assert excinfo.value.status_code == 400
    assert "connection_id" in excinfo.value.detail
    assert protocol.connections.get("c" * 7900) is None


@pytest.mark.parametrize(
    ("field", "value"),
    [("scope", "everything"), ("event_filter", "some")],
)
async def test_bad_scope_or_filter_is_refused(
    field: str, value: str, db_buffer: EventBuffer
) -> None:
    protocol = _Protocol(db_buffer)
    with pytest.raises(HTTPException) as excinfo:
        await _call(
            protocol, accept="text/event-stream", connection_id="c1", **{field: value}
        )

    assert excinfo.value.status_code == 400


async def test_an_incompatible_protocol_version_is_refused(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    with pytest.raises(HTTPException) as excinfo:
        await _call(
            protocol,
            accept="text/event-stream",
            connection_id="c1",
            protocol_version=PROTOCOL_VERSION + 1,
        )

    assert excinfo.value.status_code == 409
    # A client ahead of the server means the server is what is behind. The
    # original wording always blamed the runtime, which would have sent the
    # user to downgrade the side that was already right.
    assert excinfo.value.detail["remedy"] == "update switch-core"


async def test_the_refusal_body_carries_both_ranges(db_buffer: EventBuffer) -> None:
    """The refused client never gets a connection_state frame.

    So the 409 is the only place it can learn what the server speaks, and it
    is structured rather than a sentence to parse (CHOO-1865).
    """
    protocol = _Protocol(db_buffer)
    with pytest.raises(HTTPException) as excinfo:
        await _call(
            protocol,
            accept="text/event-stream",
            connection_id="c1",
            protocol_version=PROTOCOL_VERSION + 1,
        )

    detail = excinfo.value.detail
    assert detail["contract"] == "agent-protocol"
    assert detail["server"]["speaks"] == PROTOCOL_VERSION
    assert detail["server"]["accepts"] == PROTOCOL_ACCEPTS
    assert detail["client"] == {
        "speaks": PROTOCOL_VERSION + 1,
        "accepts": PROTOCOL_VERSION + 1,
    }
    assert detail["message"]


async def test_a_client_that_declares_nothing_connects_and_records_unknown(
    db_buffer: EventBuffer,
) -> None:
    """Part 1 refuses nobody on silence.

    The parameter used to default to the server's own value, so a silent
    client read as having agreed — and since no shipped client sent it, the
    check had never fired at all. Absent must mean unknown, and unknown must
    still connect.
    """
    protocol = _Protocol(db_buffer)
    await _call(
        protocol,
        accept="text/event-stream",
        connection_id="c1",
        protocol_version=None,
    )

    conn = protocol.connections.get("c1")
    assert conn is not None
    assert conn.declaration == ClientDeclaration()
    assert conn.declaration.declares_protocol is False


async def test_a_declared_client_is_recorded_in_full(db_buffer: EventBuffer) -> None:
    protocol = _Protocol(db_buffer)
    await _call(
        protocol,
        accept="text/event-stream",
        connection_id="c1",
        protocol_version=PROTOCOL_VERSION,
        protocol_accepts=PROTOCOL_ACCEPTS,
        client="agent-runtime",
        client_version="0.1.5",
    )

    declared = ClientDeclaration(
        speaks=PROTOCOL_VERSION,
        accepts=PROTOCOL_ACCEPTS,
        artifact="agent-runtime",
        version="0.1.5",
    )
    conn = protocol.connections.get("c1")
    assert conn is not None
    assert conn.declaration == declared
    # Also persisted, since connections die with the process and an accepts
    # floor is raised offline against what is actually deployed.
    assert protocol.recorded == [(AGENT_ID, "c1", declared)]


async def test_a_refused_client_is_not_recorded(db_buffer: EventBuffer) -> None:
    """Recording happens after the connection opens.

    A bookkeeping failure must never be why an agent could not connect, and a
    client we refused is not one we are running.
    """
    protocol = _Protocol(db_buffer)
    with pytest.raises(HTTPException):
        await _call(
            protocol,
            accept="text/event-stream",
            connection_id="c1",
            protocol_version=PROTOCOL_VERSION + 1,
        )

    assert protocol.recorded == []


async def test_an_older_client_inside_the_server_range_is_accepted(
    db_buffer: EventBuffer,
) -> None:
    """Overlap, not equality, is the test.

    The two numbers are equal today, so this pins the behaviour before a
    future bump makes it observable.
    """
    protocol = _Protocol(db_buffer)
    await _call(
        protocol,
        accept="text/event-stream",
        connection_id="c1",
        protocol_version=PROTOCOL_VERSION,
        protocol_accepts=max(PROTOCOL_ACCEPTS - 1, 1),
    )

    assert protocol.connections.get("c1") is not None


# ── Start position ──────────────────────────────────────────────────────────


async def _start(
    protocol: _Protocol,
    *,
    start_from: str = "head",
    start_at: str | None = None,
    reads_conversation: bool = False,
) -> tuple[Position, int | None]:
    return await _resolve_start_position(
        protocol,  # type: ignore[arg-type]
        _agent(),
        start_at=start_at,
        start_from=start_from,
        reads_conversation=reads_conversation,
    )


async def _keep(protocol: _Protocol) -> int:
    """One of the agent's own events, so its head is somewhere."""
    return await protocol.event_buffer.enqueue(
        TENANT_ZERO_ID, AGENT_ID, "room", _event(), room_seq=0, message_key="$e"
    )


async def test_head_means_only_what_happens_next(db_buffer: EventBuffer) -> None:
    protocol = _Protocol(db_buffer)
    seq = await _keep(protocol)
    assert await _start(protocol) == ({OWN_EVENTS: seq}, None)
    assert await _start(protocol, start_at="head") == ({OWN_EVENTS: seq}, None)


async def test_explicit_start_from_is_honoured(db_buffer: EventBuffer) -> None:
    protocol = _Protocol(db_buffer)
    assert await _start(protocol, start_from="17") == ({OWN_EVENTS: 17}, None)


async def test_a_nonsense_cursor_is_refused_rather_than_guessed(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    with pytest.raises(HTTPException) as excinfo:
        await _start(protocol, start_from="banana")
    assert excinfo.value.status_code == 400


async def test_a_client_that_keeps_a_position_starts_from_it(
    db_buffer: EventBuffer,
) -> None:
    """One number per source it has read. The agent's own events, when it
    names none of them, start at head like any fresh stream."""
    protocol = _Protocol(db_buffer)
    seq = await _keep(protocol)
    assert await _start(protocol, start_at='{"s": 3, "r:room": 7}') == (
        {OWN_EVENTS: 3, room_source("room"): 7},
        None,
    )
    assert await _start(protocol, start_at='{"r:room": 7}') == (
        {OWN_EVENTS: seq, room_source("room"): 7},
        None,
    )


async def test_a_position_that_cannot_be_read_is_refused(
    db_buffer: EventBuffer,
) -> None:
    """A typo is an error the client sees, not a position that never moves."""
    protocol = _Protocol(db_buffer)
    with pytest.raises(HTTPException) as excinfo:
        await _start(protocol, start_at='{"room": 7}')
    assert excinfo.value.status_code == 400


async def test_a_ticket_resumes_the_position_it_stands_for(
    db_buffer: EventBuffer,
) -> None:
    """A client that keeps one number, on a stream that reads the conversation
    too, was handed tickets, and sends back the last one it saw."""
    protocol = _Protocol(db_buffer)
    position = {OWN_EVENTS: 4, room_source("room"): 9}
    (ticket,) = await db_buffer.mint_tickets(TENANT_ZERO_ID, AGENT_ID, [position])
    assert await _start(protocol, start_from=str(ticket), reads_conversation=True) == (
        position,
        None,
    )


async def test_an_unknown_ticket_starts_at_head_and_is_kept_to_say_so(
    db_buffer: EventBuffer,
) -> None:
    """Expired, or never this server's: where it stood is not known, so the
    stream opens at head, and the number is returned for the gap it opens
    with."""
    protocol = _Protocol(db_buffer)
    seq = await _keep(protocol)
    lost = TICKET_FLOOR + 12345
    assert await _start(protocol, start_from=str(lost), reads_conversation=True) == (
        {OWN_EVENTS: seq},
        lost,
    )


def _event() -> Any:
    from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload

    return AgentEvent(
        type="message",
        room_id="room",
        payload=MessagePayload(
            addressed=True,
            sender="@u:s",
            sender_name="u",
            message_id="$e",
            body="hi",
            timestamp=0,
        ),
    )


class TestDeclaringARoomAtOpenTakesOver:
    """A supervisor opening a stream for a room it manages must win the slot.

    The rule: the client doing the delivering owns the room. Naming a room on
    the URL is a supervisor asserting ownership of a session it is about to
    feed; a `connect_to_room` claim is cooperative and yields.

    Without the takeover, a session started before its supervisor learned to
    share connections keeps the slot, and the supervisor's restored stream 409s
    and retries forever while the session sits silent.
    """

    async def test_an_incumbent_is_evicted_from_the_room(
        self, db_buffer: EventBuffer
    ) -> None:
        protocol = _Protocol(db_buffer)
        incumbent = protocol.connections.open(
            agent_id=AGENT_ID,
            connection_id="in-session-runtime",
            scope="single",
            delivery_filter="all",
            spawn_capable=False,
            position={OWN_EVENTS: 0},
            declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
            expected_generation=None,
        )
        protocol.connections.claim_room(incumbent, "room-1")

        await _call(
            protocol,
            accept="text/event-stream",
            connection_id="supervisor",
            rooms="room-1",
        )

        claimant = protocol.connections.claimant_of(AGENT_ID, "room-1")
        assert claimant is not None
        assert claimant.id == "supervisor"
        assert "room-1" not in incumbent.rooms


async def test_reconnect_during_bookkeeping_cannot_detach_the_new_stream(
    monkeypatch: pytest.MonkeyPatch,
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    entered = asyncio.Event()
    release = asyncio.Event()

    async def record(*_: Any) -> None:
        if not entered.is_set():
            entered.set()
            await release.wait()

    async def open_stream() -> Any:
        _conn, frames = await _open_connection(
            agent=_agent(),
            protocol=protocol,  # type: ignore[arg-type]
            config=None,  # type: ignore[arg-type]
            connection_id="c1",
            scope="single",
            event_filter="all",
            start_from="head",
            spawn_capable=False,
            declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
            rooms=None,
            expected_generation=None,
        )
        return frames

    monkeypatch.setattr(protocol, "record_client_declaration", record)
    first = asyncio.create_task(open_stream())
    await entered.wait()
    newer = await open_stream()
    await anext(newer)
    release.set()
    older = await first
    frames = [frame async for frame in older]
    assert frames == []
    conn = protocol.connections.get("c1")
    assert conn is not None
    assert protocol.connections.beat(
        AGENT_ID, "c1", conn.stream_generation
    ).stream_attached
    await newer.aclose()


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


class TestOpeningAStreamReportsASession:
    """Through the endpoint, not the reporter. Whether a connection is new is
    decided here, so a gate that never opens silences both session events
    while every test of the reporter alone stays green."""

    def _reporting(
        self, db_buffer: EventBuffer
    ) -> tuple[_Protocol, TelemetryService, _RecordingSink]:
        sink = _RecordingSink()
        service = TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=True,
            client_id="11111111-1111-1111-1111-111111111111",
            version="1.0.0",
            telemetry_environment="prod",
            telemetry_internal=False,
        )
        protocol = _Protocol(db_buffer)
        protocol.sessions = SessionReporter(service, protocol.connections)
        protocol.connections.set_close_listener(protocol.sessions.on_close)
        return protocol, service, sink

    async def test_a_new_connection_reports_a_session_start(
        self, db_buffer: EventBuffer
    ) -> None:
        protocol, service, sink = self._reporting(db_buffer)

        await _call(protocol, accept="text/event-stream", connection_id="c1")
        await service.aclose()

        assert [r.name for r in sink.sent] == ["switch_core.agent_session_started"]

    async def test_a_reattach_to_the_same_connection_is_not_another_start(
        self, db_buffer: EventBuffer
    ) -> None:
        protocol, service, sink = self._reporting(db_buffer)

        await _call(protocol, accept="text/event-stream", connection_id="c1")
        await _call(protocol, accept="text/event-stream", connection_id="c1")
        await service.aclose()

        assert [r.name for r in sink.sent] == ["switch_core.agent_session_started"]

    async def test_a_refused_open_then_a_retry_is_one_start(
        self, db_buffer: EventBuffer
    ) -> None:
        """The room claim refuses the first attempt; nothing began, so only the
        retry that gets a stream reports."""
        protocol, service, sink = self._reporting(db_buffer)
        refusals = [PermissionError("not a member yet")]

        async def member(agent_id: str, room_id: str) -> None:
            if refusals:
                raise refusals.pop()

        protocol.require_room_member = member  # type: ignore[method-assign]

        with pytest.raises(HTTPException):
            await _call(
                protocol, accept="text/event-stream", connection_id="c1", rooms="r1"
            )
        await _call(
            protocol, accept="text/event-stream", connection_id="c1", rooms="r1"
        )
        await service.aclose()

        assert [r.name for r in sink.sent] == ["switch_core.agent_session_started"]

    async def test_an_open_that_failed_after_registering_is_counted_on_retry(
        self, db_buffer: EventBuffer
    ) -> None:
        """An unexpected failure leaves the connection registered, so the retry
        on the same id reattaches to it. It is still the session's first
        stream."""
        protocol, service, sink = self._reporting(db_buffer)
        failures = [RuntimeError("database went away")]

        async def member(agent_id: str, room_id: str) -> None:
            if failures:
                raise failures.pop()

        protocol.require_room_member = member  # type: ignore[method-assign]

        with pytest.raises(RuntimeError):
            await _call(
                protocol, accept="text/event-stream", connection_id="c1", rooms="r1"
            )
        assert protocol.connections.get("c1") is not None
        await _call(
            protocol, accept="text/event-stream", connection_id="c1", rooms="r1"
        )
        await service.aclose()

        assert [r.name for r in sink.sent] == ["switch_core.agent_session_started"]

    async def test_closing_the_only_connection_ends_the_session(
        self, monkeypatch: pytest.MonkeyPatch, db_buffer: EventBuffer
    ) -> None:
        """The end is reported only for a connection the start was reported
        on, so a start that never fires takes the end down with it."""
        monkeypatch.setattr(session_reporter, "_RECONNECT_GRACE_SECONDS", 0)
        protocol, service, sink = self._reporting(db_buffer)

        await _call(protocol, accept="text/event-stream", connection_id="c1")
        protocol.connections.close("c1", HEARTBEAT_LAPSED)
        await asyncio.sleep(0.01)
        await service.aclose()

        assert [r.name for r in sink.sent] == [
            "switch_core.agent_session_started",
            "switch_core.agent_session_ended",
        ]
