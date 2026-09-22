"""The services that report telemetry actually hold a telemetry service.

`test_every_event_is_emitted.py` proves a call site exists for every catalogue
entry. It cannot prove the call does anything: `emit_safely` returns
immediately when the service is `None`, which is deliberate — several services
are built without one in tests and tooling — and it means a call site can be
present, correct, covered by its own unit test, and dead in production.

That is exactly what happened. The agent bridge built *two* `ProtocolService`
instances: one in `create_agent_bridge_app` that got the telemetry service, and
one in `init_dependencies` that the HTTP handlers actually resolve through
`Depends(get_protocol)` and that got nothing. Every session event and every
agent registration arriving at the agent bridge was validated, handed to
`emit_safely`, and dropped — silently, at a relay nobody watches, to be
discovered later as "usage is zero".

So these tests assert on the wiring rather than on the code: build the app the
way the server does, then ask the objects a request would actually reach
whether they can report.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.dependencies import get_protocol
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import NullSink


def _telemetry() -> TelemetryService:
    return TelemetryService(
        sink=NullSink(),
        enabled=True,
        client_id="deployment-uuid",
        service_name="switch-core",
        version="1.0.0",
        environment=None,
    )


def _build(telemetry: TelemetryService) -> Any:
    """The agent bridge app, wired the way `main.run` wires it."""
    _, protocol = create_agent_bridge_app(
        agent_store=object(),  # type: ignore[arg-type]
        agent_session_store=object(),  # type: ignore[arg-type]
        room_store=object(),  # type: ignore[arg-type]
        room_service=object(),  # type: ignore[arg-type]
        client_lifecycle=object(),  # type: ignore[arg-type]
        collab_lifecycle=object(),  # type: ignore[arg-type]
        event_buffer=EventBuffer(),
        task_store=object(),  # type: ignore[arg-type]
        resource_service=object(),  # type: ignore[arg-type]
        api_key_store=object(),  # type: ignore[arg-type]
        external_user_store=object(),  # type: ignore[arg-type]
        bridge_store=object(),  # type: ignore[arg-type]
        session_factory=object(),
        config=_config(),
        telemetry=telemetry,
    )
    return protocol


def _config() -> Any:
    class _Config:
        agent_auth_cache_ttl_seconds = 1
        agent_auth_cache_max_entries = 16
        jwt_secret_key = "x"
        oauth_issuer_url = None
        oauth_audience = None
        oauth_verify_issuer = True
        matrix_server_name = "test"

    return _Config()


def test_the_protocol_service_a_request_reaches_can_report() -> None:
    """`get_protocol()` is what every handler resolves. If its service has no
    telemetry, every session event and agent registration at the agent bridge
    is silently dropped."""
    telemetry = _telemetry()
    _build(telemetry)

    assert get_protocol().telemetry is telemetry, (
        "The ProtocolService the HTTP handlers resolve has no telemetry "
        "service, so every event it emits is dropped by emit_safely. The app "
        "and init_dependencies must be given the same one."
    )


def test_the_protocol_service_the_app_returns_is_the_one_handlers_use() -> None:
    """Two instances is the shape that caused the drop. They must be one, or
    a future change will wire telemetry to whichever is convenient and leave
    the other dead again."""
    telemetry = _telemetry()
    returned = _build(telemetry)

    assert get_protocol() is returned, (
        "create_agent_bridge_app returns a different ProtocolService from the "
        "one its handlers use. Anything wired onto one is absent from the "
        "other — which is how the session events came to be emitted into "
        "nothing."
    )
