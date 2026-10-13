"""Opening an agent connection, and the /events endpoint.

The WebSocket and the event stream both open through `_open_connection`,
which these drive directly: validation, protocol ranges, declarations, room
claims and session reporting. `/events` with `Accept: text/event-stream` opens
the event stream an old client still asks for; anything else long polls.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from starlette.responses import StreamingResponse

from switch_core.bridges.agent.api import session_reporter
from switch_core.bridges.agent.api.handlers import (
    _open_connection,
    _resolve_start_cursor,
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
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord

AGENT_ID = "agent-1"


class _Protocol:
    def __init__(self) -> None:
        self.event_buffer = EventBuffer(sequence_base=0)
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
    return SimpleNamespace(id=AGENT_ID, metadata_={"known_agent_type": "claude-code"})


async def _call(protocol: _Protocol, **kw: Any) -> Any:
    params: dict[str, Any] = {
        "agent_id": AGENT_ID,
        "agent": _agent(),
        "protocol": protocol,
        "config": None,
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


async def test_without_the_sse_accept_header_it_long_polls() -> None:
    protocol = _Protocol()
    resp = await _call(protocol, accept="application/json")

    assert protocol.polled
    assert resp.status_code == 204


async def test_with_the_sse_accept_header_it_opens_the_event_stream() -> None:
    """How a runtime built before the WebSocket connects, kept for a
    compatibility window."""
    protocol = _Protocol()
    resp = await poll_events(
        agent_id=AGENT_ID,
        agent=_agent(),
        protocol=protocol,  # type: ignore[arg-type]
        config=None,  # type: ignore[arg-type]
        accept="text/event-stream",
        connection_id="c1",
        scope="all",
    )

    assert isinstance(resp, StreamingResponse)
    assert resp.media_type == "text/event-stream"
    # Buffering proxies would defeat the point of a push channel.
    assert resp.headers["x-accel-buffering"] == "no"
    assert resp.headers["connection"] == "keep-alive"
    assert not protocol.polled

    conn = protocol.connections.get("c1")
    assert conn is not None
    assert conn.scope == "all"
    assert conn.stream_transport == "sse"


async def test_opening_registers_the_connection() -> None:
    protocol = _Protocol()
    conn = await _call(
        protocol, accept="text/event-stream", connection_id="c1", scope="all"
    )

    assert protocol.connections.get("c1") is conn
    assert conn.scope == "all"
    assert conn.stream_attached
    assert conn.stream_transport == "websocket"


async def test_streaming_without_a_connection_id_is_refused() -> None:
    protocol = _Protocol()
    with pytest.raises(HTTPException) as excinfo:
        await _call(protocol, accept="text/event-stream")

    assert excinfo.value.status_code == 400
    assert "connection_id is required" in excinfo.value.detail


@pytest.mark.parametrize(
    ("field", "value"),
    [("scope", "everything"), ("event_filter", "some")],
)
async def test_bad_scope_or_filter_is_refused(field: str, value: str) -> None:
    protocol = _Protocol()
    with pytest.raises(HTTPException) as excinfo:
        await _call(
            protocol, accept="text/event-stream", connection_id="c1", **{field: value}
        )

    assert excinfo.value.status_code == 400


async def test_an_incompatible_protocol_version_is_refused() -> None:
    protocol = _Protocol()
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


async def test_the_refusal_body_carries_both_ranges() -> None:
    """The refused client never gets a connection_state frame.

    So the 409 is the only place it can learn what the server speaks, and it
    is structured rather than a sentence to parse (CHOO-1865).
    """
    protocol = _Protocol()
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


async def test_a_client_that_declares_nothing_connects_and_records_unknown() -> None:
    """Part 1 refuses nobody on silence.

    The parameter used to default to the server's own value, so a silent
    client read as having agreed — and since no shipped client sent it, the
    check had never fired at all. Absent must mean unknown, and unknown must
    still connect.
    """
    protocol = _Protocol()
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


async def test_a_declared_client_is_recorded_in_full() -> None:
    protocol = _Protocol()
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


async def test_a_refused_client_is_not_recorded() -> None:
    """Recording happens after the connection opens.

    A bookkeeping failure must never be why an agent could not connect, and a
    client we refused is not one we are running.
    """
    protocol = _Protocol()
    with pytest.raises(HTTPException):
        await _call(
            protocol,
            accept="text/event-stream",
            connection_id="c1",
            protocol_version=PROTOCOL_VERSION + 1,
        )

    assert protocol.recorded == []


async def test_an_older_client_inside_the_server_range_is_accepted() -> None:
    """Overlap, not equality, is the test.

    The two numbers are equal today, so this pins the behaviour before a
    future bump makes it observable.
    """
    protocol = _Protocol()
    await _call(
        protocol,
        accept="text/event-stream",
        connection_id="c1",
        protocol_version=PROTOCOL_VERSION,
        protocol_accepts=max(PROTOCOL_ACCEPTS - 1, 1),
    )

    assert protocol.connections.get("c1") is not None


# ── Start cursor ────────────────────────────────────────────────────────────


def test_head_means_only_what_happens_next() -> None:
    protocol = _Protocol()
    protocol.event_buffer.enqueue(AGENT_ID, "room", _event())
    assert _resolve_start_cursor(protocol, AGENT_ID, "head") == 1


def test_last_event_id_wins_over_start_from() -> None:
    protocol = _Protocol()
    assert _resolve_start_cursor(protocol, AGENT_ID, "head", "42") == 42


def test_explicit_start_from_is_honoured() -> None:
    protocol = _Protocol()
    assert _resolve_start_cursor(protocol, AGENT_ID, "17") == 17


def test_a_nonsense_cursor_is_refused_rather_than_guessed() -> None:
    protocol = _Protocol()
    with pytest.raises(HTTPException) as excinfo:
        _resolve_start_cursor(protocol, AGENT_ID, "banana")
    assert excinfo.value.status_code == 400


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

    async def test_an_incumbent_is_evicted_from_the_room(self) -> None:
        protocol = _Protocol()
        incumbent = protocol.connections.open(
            agent_id=AGENT_ID,
            connection_id="in-session-runtime",
            scope="single",
            delivery_filter="all",
            spawn_capable=False,
            cursor=0,
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
) -> None:
    protocol = _Protocol()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def record(*_: Any) -> None:
        if not entered.is_set():
            entered.set()
            await release.wait()

    async def open_stream() -> Any:
        return await poll_events(
            agent_id=AGENT_ID,
            agent=_agent(),
            protocol=protocol,  # type: ignore[arg-type]
            config=None,  # type: ignore[arg-type]
            accept="text/event-stream",
            connection_id="c1",
        )

    monkeypatch.setattr(protocol, "record_client_declaration", record)
    first = asyncio.create_task(open_stream())
    await entered.wait()
    newer = await open_stream()
    await anext(newer.body_iterator)
    release.set()
    older = await first
    frames = [frame async for frame in older.body_iterator]
    assert frames == []
    conn = protocol.connections.get("c1")
    assert conn is not None
    assert protocol.connections.beat(
        AGENT_ID, "c1", 0, conn.stream_generation
    ).stream_attached
    await newer.body_iterator.aclose()


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

    def _reporting(self) -> tuple[_Protocol, TelemetryService, _RecordingSink]:
        sink = _RecordingSink()
        service = TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=True,
            client_id="11111111-1111-1111-1111-111111111111",
            version="1.0.0",
            telemetry_environment="prod",
            telemetry_internal=False,
        )
        protocol = _Protocol()
        protocol.sessions = SessionReporter(service, protocol.connections)
        protocol.connections.set_close_listener(protocol.sessions.on_close)
        return protocol, service, sink

    async def test_a_new_connection_reports_a_session_start(self) -> None:
        protocol, service, sink = self._reporting()

        await _call(protocol, accept="text/event-stream", connection_id="c1")
        await service.aclose()

        assert [r.name for r in sink.sent] == ["switch_core.agent_session_started"]

    async def test_a_reattach_to_the_same_connection_is_not_another_start(
        self,
    ) -> None:
        protocol, service, sink = self._reporting()

        await _call(protocol, accept="text/event-stream", connection_id="c1")
        await _call(protocol, accept="text/event-stream", connection_id="c1")
        await service.aclose()

        assert [r.name for r in sink.sent] == ["switch_core.agent_session_started"]

    async def test_a_refused_open_then_a_retry_is_one_start(self) -> None:
        """The room claim refuses the first attempt; nothing began, so only the
        retry that gets a stream reports."""
        protocol, service, sink = self._reporting()
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
        self,
    ) -> None:
        """An unexpected failure leaves the connection registered, so the retry
        on the same id reattaches to it. It is still the session's first
        stream."""
        protocol, service, sink = self._reporting()
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
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The end is reported only for a connection the start was reported
        on, so a start that never fires takes the end down with it."""
        monkeypatch.setattr(session_reporter, "_RECONNECT_GRACE_SECONDS", 0)
        protocol, service, sink = self._reporting()

        await _call(protocol, accept="text/event-stream", connection_id="c1")
        protocol.connections.close("c1", HEARTBEAT_LAPSED)
        await asyncio.sleep(0.01)
        await service.aclose()

        assert [r.name for r in sink.sent] == [
            "switch_core.agent_session_started",
            "switch_core.agent_session_ended",
        ]
