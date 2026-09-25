"""A session host reporting that a session started, and how.

The only way the server learns who started a session: sessions share their
agent's one connection, so nothing about a new one reaches the server unless
the host that runs it says so.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi import FastAPI

from switch_core.bridges.agent.api.activity_routes import router
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_session_factory, get_telemetry
from switch_core.db.models import Agent
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    async def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _telemetry(sink: _RecordingSink, *, enabled: bool) -> TelemetryService:
    return TelemetryService(
        sink=sink,  # type: ignore[arg-type]
        enabled=enabled,
        client_id="11111111-1111-1111-1111-111111111111",
        service_name="switch-core",
        version=None,
        environment=None,
    )


def _app(session_factory, telemetry: TelemetryService | None, agent: Agent) -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_agent_from_scope] = lambda: agent
    app.dependency_overrides[get_telemetry] = lambda: telemetry
    return app


def _agent(runtime: str = "codex") -> Agent:
    return Agent(
        id=f"agent-{uuid.uuid4().hex[:8]}", metadata_={"known_agent_type": runtime}
    )


async def _post(app: FastAPI, session_id: str, body: object) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as http:
        return await http.post(f"/agent-sessions/{session_id}/started", json=body)


def _started(sink: _RecordingSink) -> list[dict[str, object]]:
    return [
        dict(r.properties) for r in sink.sent if r.name == "switch_core.session_started"
    ]


async def test_a_new_session_is_reported_with_how_it_started(session_factory) -> None:
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)
    app = _app(session_factory, telemetry, _agent("claude-code"))

    response = await _post(app, "session-1", {"start_source": "user"})
    await telemetry.aclose()

    assert (response.status_code, response.json()) == (200, {"reported": True})
    assert _started(sink) == [
        {"start_source": "user", "known_agent_type": "claude-code"}
    ]


async def test_reporting_the_same_session_again_counts_once(session_factory) -> None:
    """A host retries until the server answers, so an answer lost on the way
    back arrives as a second report of the same start."""
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)
    app = _app(session_factory, telemetry, _agent())

    first = await _post(app, "session-1", {"start_source": "room"})
    again = await _post(app, "session-1", {"start_source": "room"})
    await telemetry.aclose()

    assert first.json() == {"reported": True}
    assert again.json() == {"reported": False}
    assert len(_started(sink)) == 1


async def test_two_agents_with_the_same_session_id_each_count(session_factory) -> None:
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)

    await _post(
        _app(session_factory, telemetry, _agent()),
        "shared-id",
        {"start_source": "user"},
    )
    await _post(
        _app(session_factory, telemetry, _agent()),
        "shared-id",
        {"start_source": "user"},
    )
    await telemetry.aclose()

    assert len(_started(sink)) == 2


async def test_nothing_is_sent_or_claimed_while_telemetry_is_off(
    session_factory,
) -> None:
    """Switching telemetry on later must still count a session reported
    while it was off — here, the same host retrying after the switch."""
    agent = _agent()
    off_sink = _RecordingSink()
    off = _telemetry(off_sink, enabled=False)
    on_sink = _RecordingSink()
    on = _telemetry(on_sink, enabled=True)

    while_off = await _post(
        _app(session_factory, off, agent), "session-1", {"start_source": "user"}
    )
    once_on = await _post(
        _app(session_factory, on, agent), "session-1", {"start_source": "user"}
    )
    await off.aclose()
    await on.aclose()

    assert while_off.json() == {"reported": False}
    assert _started(off_sink) == []
    assert once_on.json() == {"reported": True}


async def test_a_server_with_no_telemetry_service_answers_rather_than_failing(
    session_factory,
) -> None:
    response = await _post(
        _app(session_factory, None, _agent()), "session-1", {"start_source": "user"}
    )

    assert (response.status_code, response.json()) == (200, {"reported": False})


@pytest.mark.parametrize(
    "body",
    [
        {"start_source": "console"},
        {"start_source": None},
        {},
        {"start_source": "user", "unexpected": 1},
    ],
)
async def test_a_source_outside_the_set_is_refused(session_factory, body) -> None:
    """The value goes straight into a telemetry property, so it is held to the
    catalogue here rather than trusted."""
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)

    response = await _post(
        _app(session_factory, telemetry, _agent()), "session-1", body
    )
    await telemetry.aclose()

    assert response.status_code == 422
    assert _started(sink) == []
