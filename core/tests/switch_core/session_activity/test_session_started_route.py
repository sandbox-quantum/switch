"""A session host reporting that a session started, and how.

The only way the server learns who started a session: sessions share their
agent's one connection, so nothing about a new one reaches the server unless
the host that runs it says so.
"""

from __future__ import annotations

import uuid
from typing import get_args

import httpx
import pytest
from fastapi import FastAPI

from switch_core.bridges.agent.api.activity_routes import router
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import (
    get_session_factory,
    get_session_start_limiter,
    get_telemetry,
)
from switch_core.db.models import Agent
from switch_core.telemetry.catalogue import CATALOGUE
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.session_start import (
    SessionStartLimiter,
    StartSource,
    default_session_start_limiter,
)
from switch_core.telemetry.sink import TelemetryRecord

# What every launcher mints: a random v4 from Console, or a v5-shaped hash from
# the room watcher.
SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e"


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
        telemetry_environment="prod",
    )


def _app(
    session_factory,
    telemetry: TelemetryService | None,
    agent: Agent,
    limiter: SessionStartLimiter | None = None,
) -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_agent_from_scope] = lambda: agent
    app.dependency_overrides[get_telemetry] = lambda: telemetry
    chosen = limiter or default_session_start_limiter()
    app.dependency_overrides[get_session_start_limiter] = lambda: chosen
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

    response = await _post(app, SESSION, {"start_source": "user"})
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

    first = await _post(app, SESSION, {"start_source": "room"})
    again = await _post(app, SESSION, {"start_source": "room"})
    await telemetry.aclose()

    assert first.json() == {"reported": True}
    assert again.json() == {"reported": False}
    assert len(_started(sink)) == 1


async def test_two_agents_with_the_same_session_id_each_count(session_factory) -> None:
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)

    await _post(
        _app(session_factory, telemetry, _agent()),
        SESSION,
        {"start_source": "user"},
    )
    await _post(
        _app(session_factory, telemetry, _agent()),
        SESSION,
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
        _app(session_factory, off, agent), SESSION, {"start_source": "user"}
    )
    once_on = await _post(
        _app(session_factory, on, agent), SESSION, {"start_source": "user"}
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
        _app(session_factory, None, _agent()), SESSION, {"start_source": "user"}
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

    response = await _post(_app(session_factory, telemetry, _agent()), SESSION, body)
    await telemetry.aclose()

    assert response.status_code == 422
    assert _started(sink) == []


@pytest.mark.parametrize("start_source", get_args(StartSource))
async def test_every_source_the_route_accepts_is_sent(
    session_factory, start_source
) -> None:
    """The route spends the once-only claim before it emits. A value it accepts
    that the catalogue refuses would be claimed, dropped by the emitter, and
    answered `reported: true` — lost for good with nothing saying so."""
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)

    response = await _post(
        _app(session_factory, telemetry, _agent()),
        SESSION,
        {"start_source": start_source},
    )
    await telemetry.aclose()

    assert response.json() == {"reported": True}
    assert [e["start_source"] for e in _started(sink)] == [start_source]


def test_the_route_and_the_catalogue_accept_the_same_sources() -> None:
    declared = CATALOGUE["session_started"]["start_source"]
    assert set(get_args(StartSource)) == set(declared.values)  # type: ignore[attr-defined]


@pytest.mark.parametrize("session_id", ["session-1", "s" * 201, "not-a-uuid-at-all"])
async def test_a_session_id_that_is_not_a_uuid_is_refused(
    session_factory, session_id
) -> None:
    """Every launcher mints UUIDs. Anything else is a caller making ids up,
    and each one would be another claim row."""
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)

    response = await _post(
        _app(session_factory, telemetry, _agent()), session_id, {"start_source": "user"}
    )
    await telemetry.aclose()

    assert response.status_code == 422
    assert _started(sink) == []


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


async def test_an_agent_past_its_cap_is_not_counted(session_factory, caplog) -> None:
    """One agent inventing sessions cannot fill the table or the chart."""
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)
    limiter = SessionStartLimiter(max_per_window=2, window_seconds=3600, clock=_Clock())
    app = _app(session_factory, telemetry, _agent(), limiter)

    answers = [
        (await _post(app, str(uuid.uuid4()), {"start_source": "user"})).json()
        for _ in range(3)
    ]
    await telemetry.aclose()

    assert answers == [{"reported": True}, {"reported": True}, {"reported": False}]
    assert len(_started(sink)) == 2
    assert "more than 2 session starts" in caplog.text


async def test_the_cap_is_per_agent(session_factory) -> None:
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)
    limiter = SessionStartLimiter(max_per_window=1, window_seconds=3600, clock=_Clock())
    busy, other = _agent(), _agent()

    await _post(
        _app(session_factory, telemetry, busy, limiter),
        str(uuid.uuid4()),
        {"start_source": "user"},
    )
    capped = await _post(
        _app(session_factory, telemetry, busy, limiter),
        str(uuid.uuid4()),
        {"start_source": "user"},
    )
    unaffected = await _post(
        _app(session_factory, telemetry, other, limiter),
        str(uuid.uuid4()),
        {"start_source": "user"},
    )
    await telemetry.aclose()

    assert capped.json() == {"reported": False}
    assert unaffected.json() == {"reported": True}


async def test_the_cap_lifts_once_the_window_has_passed(session_factory) -> None:
    sink = _RecordingSink()
    telemetry = _telemetry(sink, enabled=True)
    clock = _Clock()
    limiter = SessionStartLimiter(max_per_window=1, window_seconds=3600, clock=clock)
    app = _app(session_factory, telemetry, _agent(), limiter)

    await _post(app, str(uuid.uuid4()), {"start_source": "user"})
    clock.now = 3600.0
    later = await _post(app, str(uuid.uuid4()), {"start_source": "user"})
    await telemetry.aclose()

    assert later.json() == {"reported": True}
