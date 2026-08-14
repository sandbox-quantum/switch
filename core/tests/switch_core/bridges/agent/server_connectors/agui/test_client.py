"""The run client, driven through an in-process `httpx.MockTransport`.

No network. The fake AG-UI server is a handler returning a scripted byte
stream, which lets a test express the things that actually go wrong on a real
one: a stream cut mid-sentence, a silent socket, a run that never ends.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from switch_core.bridges.agent.server_connectors.agui.assembly import (
    IncompleteRunError,
    RunAssembler,
    TextOutput,
)
from switch_core.bridges.agent.server_connectors.agui.client import (
    DEFAULT_READ_TIMEOUT_SECONDS,
    AgUiClient,
    AgUiTimeoutError,
    AgUiTransportError,
    build_http_client,
)
from switch_core.bridges.agent.server_connectors.agui.events import (
    AgUiEvent,
    MalformedEventError,
)
from switch_core.bridges.agent.server_connectors.agui.request import (
    RunAgentInput,
    Tool,
    UserMessage,
)

ENDPOINT = "https://agent.example/agui"


class _ScriptedStream(httpx.AsyncByteStream):
    """Replays byte chunks, and raises any exception planted among them."""

    def __init__(self, chunks: list[bytes | Exception]) -> None:
        self._chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk


class _Recorder:
    """Captures the request so a test can assert on what we actually sent."""

    def __init__(self, chunks: list[bytes | Exception], status: int = 200) -> None:
        self._chunks = chunks
        self._status = status
        self.request: httpx.Request | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.request = request
        return httpx.Response(
            self._status,
            headers={"content-type": "text/event-stream"},
            stream=_ScriptedStream(self._chunks),
        )


def _frames(*events: dict[str, Any]) -> list[bytes | Exception]:
    return [f"data: {json.dumps(event)}\n\n".encode() for event in events]


def _client(recorder: _Recorder, run_timeout_seconds: float = 900.0) -> AgUiClient:
    return AgUiClient(
        endpoint_url=ENDPOINT,
        bearer_token="s3cret",
        http=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handler)),
        run_timeout_seconds=run_timeout_seconds,
    )


def _request() -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread-1",
        run_id="run-1",
        messages=[UserMessage(id="u1", content="hello")],
        tools=[Tool(name="post_message", description="Post.", parameters={})],
        context=[],
    )


async def _collect(client: AgUiClient) -> list[AgUiEvent]:
    return [event async for event in client.run(_request())]


# ── The happy path ────────────────────────────────────────────────────────────


async def test_events_arrive_in_order() -> None:
    recorder = _Recorder(
        _frames(
            {"type": "RUN_STARTED", "threadId": "thread-1", "runId": "run-1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "hi"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED"},
        )
    )
    events = await _collect(_client(recorder))
    assert [event.type for event in events] == [
        "RUN_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_FINISHED",
    ]


async def test_frames_split_across_network_chunks_still_parse() -> None:
    # Chunk boundaries fall wherever the network puts them.
    recorder = _Recorder(
        [
            b'data: {"type":"RUN_ST',
            b'ARTED"}\n\ndata: {"type":"RUN_F',
            b'INISHED"}\n\n',
        ]
    )
    events = await _collect(_client(recorder))
    assert [event.type for event in events] == ["RUN_STARTED", "RUN_FINISHED"]


async def test_keepalive_comments_do_not_appear_as_events() -> None:
    recorder = _Recorder(
        [b": keepalive\n\n", *_frames({"type": "RUN_FINISHED"})]  # type: ignore[list-item]
    )
    events = await _collect(_client(recorder))
    assert [event.type for event in events] == ["RUN_FINISHED"]


# ── What we send ──────────────────────────────────────────────────────────────


async def test_request_carries_sse_accept_and_bearer_token() -> None:
    recorder = _Recorder(_frames({"type": "RUN_FINISHED"}))
    await _collect(_client(recorder))

    assert recorder.request is not None
    assert str(recorder.request.url) == ENDPOINT
    assert recorder.request.method == "POST"
    assert recorder.request.headers["accept"] == "text/event-stream"
    assert recorder.request.headers["authorization"] == "Bearer s3cret"


async def test_no_authorization_header_when_there_is_no_token() -> None:
    recorder = _Recorder(_frames({"type": "RUN_FINISHED"}))
    client = AgUiClient(
        endpoint_url=ENDPOINT,
        bearer_token=None,
        http=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handler)),
        run_timeout_seconds=900.0,
    )
    [event async for event in client.run(_request())]

    assert recorder.request is not None
    assert "authorization" not in recorder.request.headers


async def test_body_is_camel_case_and_always_carries_state_and_forwarded_props() -> (
    None
):
    # The two reference SDKs disagree on whether these keys may be absent, so
    # they are always emitted — as null when unset.
    recorder = _Recorder(_frames({"type": "RUN_FINISHED"}))
    await _collect(_client(recorder))

    assert recorder.request is not None
    body = json.loads(recorder.request.content)
    assert body["threadId"] == "thread-1"
    assert body["runId"] == "run-1"
    assert "state" in body
    assert "forwardedProps" in body
    assert body["tools"] == [
        {"name": "post_message", "description": "Post.", "parameters": {}}
    ]
    assert body["messages"] == [
        {"id": "u1", "role": "user", "content": "hello", "name": None}
    ]


# ── Transport failures ────────────────────────────────────────────────────────


async def test_non_200_raises_with_status_and_body() -> None:
    recorder = _Recorder([b"agent exploded"], status=500)
    with pytest.raises(AgUiTransportError, match="HTTP 500") as excinfo:
        await _collect(_client(recorder))
    assert "agent exploded" in str(excinfo.value)


async def test_401_raises_rather_than_returning_nothing() -> None:
    # AG-UI defines no authentication, so a rejected token is an ordinary HTTP
    # error with no protocol-level meaning. It must still be loud.
    recorder = _Recorder([b"unauthorized"], status=401)
    with pytest.raises(AgUiTransportError, match="HTTP 401"):
        await _collect(_client(recorder))


async def test_stream_dropped_mid_flight_raises() -> None:
    recorder = _Recorder(
        [
            b'data: {"type":"RUN_STARTED"}\n\n',
            httpx.ReadError("connection reset"),
        ]
    )
    with pytest.raises(AgUiTransportError, match="failed"):
        await _collect(_client(recorder))


async def test_connect_failure_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    client = AgUiClient(
        endpoint_url=ENDPOINT,
        bearer_token=None,
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        run_timeout_seconds=900.0,
    )
    with pytest.raises(AgUiTransportError, match="failed"):
        [event async for event in client.run(_request())]


# ── Deadlines ─────────────────────────────────────────────────────────────────


async def test_read_timeout_becomes_a_timeout_error() -> None:
    # The no-keepalive case: the socket goes quiet and nothing distinguishes a
    # thinking model from a dead peer.
    recorder = _Recorder(
        [
            b'data: {"type":"RUN_STARTED"}\n\n',
            httpx.ReadTimeout("timed out"),
        ]
    )
    with pytest.raises(AgUiTimeoutError, match="went silent"):
        await _collect(_client(recorder))


async def test_run_timeout_stops_a_stream_that_never_ends() -> None:
    # A producer dribbling bytes forever never trips a read timeout, so the
    # overall deadline is what ends it.
    recorder = _Recorder([b'data: {"type":"TEXT_MESSAGE_CHUNK","delta":"x"}\n\n'] * 50)
    with pytest.raises(AgUiTimeoutError, match="exceeded"):
        await _collect(_client(recorder, run_timeout_seconds=-1.0))


# ── Malformed input ───────────────────────────────────────────────────────────


async def test_unparseable_frame_raises_rather_than_being_skipped() -> None:
    recorder = _Recorder([b"data: {not json\n\n"])
    with pytest.raises(MalformedEventError, match="not valid JSON"):
        await _collect(_client(recorder))


async def test_event_missing_a_required_field_raises() -> None:
    recorder = _Recorder(_frames({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1"}))
    with pytest.raises(MalformedEventError, match="TEXT_MESSAGE_CONTENT"):
        await _collect(_client(recorder))


# ── Client and assembler together ─────────────────────────────────────────────


async def test_truncated_stream_is_caught_by_the_assembler() -> None:
    # The client is transparent about content, so a stream that simply stops is
    # not a transport error — it ends cleanly. The assembler is what refuses to
    # call it a finished run, and this is the seam where that has to hold.
    recorder = _Recorder(
        _frames(
            {"type": "RUN_STARTED"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {
                "type": "TEXT_MESSAGE_CONTENT",
                "messageId": "m1",
                "delta": "Transferring $50,0",
            },
        )
    )
    assembler = RunAssembler()
    async for event in _client(recorder).run(_request()):
        assembler.feed(event)

    with pytest.raises(IncompleteRunError):
        assembler.finish()


async def test_complete_stream_assembles_end_to_end() -> None:
    recorder = _Recorder(
        _frames(
            {"type": "RUN_STARTED"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1", "role": "assistant"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "all "},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "done"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED"},
        )
    )
    assembler = RunAssembler()
    outputs = []
    async for event in _client(recorder).run(_request()):
        outputs.extend(assembler.feed(event))
    assembler.finish()

    assert outputs == [
        TextOutput(message_id="m1", role="assistant", content="all done")
    ]


# ── Timeout policy ────────────────────────────────────────────────────────────


def test_build_http_client_sets_the_read_timeout() -> None:
    client = build_http_client(read_timeout_seconds=DEFAULT_READ_TIMEOUT_SECONDS)
    assert client.timeout.read == DEFAULT_READ_TIMEOUT_SECONDS
    assert client.timeout.connect is not None
