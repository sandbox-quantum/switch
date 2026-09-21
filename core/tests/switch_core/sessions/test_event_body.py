import pytest
from starlette.requests import Request

from switch_core.bridges.agent.api.session_routes import read_host_event
from switch_core.sessions.contract import MAX_EVENT_BYTES
from switch_core.sessions.service import SessionError


async def test_event_body_stops_reading_at_limit():
    reads = 0

    async def receive():
        nonlocal reads
        reads += 1
        assert reads <= 2
        return {
            "type": "http.request",
            "body": b"x" * MAX_EVENT_BYTES,
            "more_body": True,
        }

    request = Request({"type": "http"}, receive=receive)
    with pytest.raises(SessionError, match="64 KiB"):
        await read_host_event(request)
    assert reads == 2


async def test_invalid_event_body_is_a_protocol_error():
    async def receive():
        return {"type": "http.request", "body": b"{", "more_body": False}

    with pytest.raises(SessionError, match="Invalid host event"):
        await read_host_event(Request({"type": "http"}, receive=receive))
