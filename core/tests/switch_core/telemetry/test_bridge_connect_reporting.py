"""A bridge that fails to start is reported by something.

`bridge_connected{outcome:"failure"}` used to be emitted only from inside
`_run_bridge`'s own exception handler — but `_run_bridge` is scheduled as a
background task at the very end of `start()`, after every other way `start()`
can fail. An operator connecting a bridge on a host where its port (or its
stored config, or its adapter type) does not work never got a `start_all`-time
or request-time failure logged to telemetry at all: not a failure, because
nothing downstream reports one, and not a success, because none happened. The
connect success rate — `bridge_connected{outcome:"success"}` over every
`connector_configured` — was then computed over a denominator that silently
excluded the attempts that failed hardest.

These exercise `start()` itself (real Postgres, since the failures being
pinned are read failures — an unregistered adapter type, a resource already
held, a stored config that no longer validates) and confirm two things for
each: the `bridge_connected` failure fires with the right platform and
reason, and the original exception still reaches the caller unchanged, so
`start_all`'s existing catch-and-log and an HTTP handler's error response are
both unaffected by telemetry being added.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import BridgeConnectionConfig
from switch_core.db.models import Client, CollaborationBridge
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord
from tests.switch_core.bridges.collaboration.test_lifecycle_callback_endpoint import (
    _FailingClient,
)
from tests.switch_core.bridges.collaboration.test_lifecycle_tenant_binding import (
    _make_bridge,
    _make_tenant,
    _StubAdapter,
    _StubConfig,
)


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    async def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _service_with_telemetry(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    callback_port: int = 0,
    client_store: Any = None,
) -> tuple[CollaborationBridgeLifecycleService, _RecordingSink]:
    sink = _RecordingSink()
    telemetry = TelemetryService(
        sink=sink,  # type: ignore[arg-type]
        enabled=True,
        client_id="deployment-uuid",
        service_name="switch-core",
        version=None,
        environment=None,
        session_factory=session_factory,
    )
    config = MagicMock()
    config.gateway_public_url = "https://gw.example"
    config.collaboration_callback_host = "127.0.0.1"
    config.collaboration_callback_port = callback_port
    config.jwt_secret_key = "server-secret-for-tests"
    service = CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
        session_request_post_store=MagicMock(),
        room_store=RoomStore(),
        agent_store=MagicMock(),
        client_store=client_store if client_store is not None else ClientStore(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        matrix_admin=MagicMock(),
        session_factory=session_factory,
        config=config,
        client_factory=MagicMock(),
        telemetry=telemetry,
    )
    return service, sink


async def _bridge_connected_events(sink: _RecordingSink) -> list[dict[str, Any]]:
    """Every `bridge_connected` the sink saw, in order, minus its duration.

    Sending is dispatched onto a background task by `TelemetryService.emit`, so
    the caller must have already closed (or otherwise awaited) the telemetry
    service producing `sink` before this is meaningful.

    `duration_ms` is elapsed wall time, so no test can pin its value — but
    dropping it silently would mean every assertion below passed against an
    event that had lost it, or that carried something no clock produces. It is
    asserted here to be a whole, non-negative number and then removed, so the
    comparisons stay exact.
    """
    events = []
    for record in sink.sent:
        if record.name != "switch_core.bridge_connected":
            continue
        properties = dict(record.properties)
        duration = properties.pop("duration_ms")
        assert isinstance(duration, int | float) and not isinstance(duration, bool)
        assert duration >= 0, "a connect cannot take less than no time"
        events.append(properties)
    return events


class _StrictConfig(BridgeConnectionConfig):
    """A config schema with a required field nothing in these tests supplies,
    standing in for an adapter whose schema gained a new required setting
    after some bridges were already stored without it."""

    required_setting: str


class _ExplodingAdapter(_StubAdapter):
    """An adapter whose construction itself fails — the same shape a real
    adapter takes if it does eager, fallible work in `__init__` (e.g.
    generating key material) rather than in `start`."""

    def __init__(self, *, config: Any) -> None:
        raise RuntimeError("adapter construction blew up")


class _PortHoldingAdapter(_StubAdapter):
    @staticmethod
    def exclusive_resource(config: dict[str, Any]) -> str | None:
        port = config.get("listen_port")
        return f"port:{port}" if port else None


class _FailingCore:
    """A `bridge_core.start()` that never reaches the platform at all -- the
    `_run_bridge` branch that still reports `bridge_connected{failure}`,
    as opposed to a `bridge_disconnected` for a bridge that connected and
    then dropped."""

    async def start(self) -> None:
        raise RuntimeError("adapter connect failed")


async def _bridge_row(
    session: AsyncSession,
    *,
    tenant_id: str,
    bridge_type: str = "mattermost",
    connection_config: dict[str, Any] | None = None,
) -> str:
    """A stored bridge (and its client) with a caller-chosen type and config,
    for the scenarios `_make_bridge` (fixed to a plain "mattermost" row) does
    not cover."""
    client = Client(
        tenant_id=tenant_id,
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name="bridge client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        tenant_id=tenant_id,
        type=bridge_type,
        display_name="Test Bridge",
        client_id=client.id,
        status="active",
        connection_config=connection_config,
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


class TestEachStartFailurePointReportsAndReraises:
    async def test_a_bridge_id_nobody_has_heard_of(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`tenant_of_collaboration_bridge` finds nothing to bind, so there is
        no row and no platform to read off it.

        `unknown`, not `none`: every bridge is on some platform, so `none` is
        the value reserved for a room that has no bridge at all — and reporting
        an unreadable row as one would put a failure that cannot be attributed
        to any platform into the same bucket as the rooms that are on none.
        """
        service, sink = _service_with_telemetry(session_factory)

        with pytest.raises(ValueError, match="Bridge not found"):
            await service.start(f"no-such-bridge-{uuid.uuid4().hex[:8]}")
        await service._telemetry.aclose()  # type: ignore[union-attr]

        events = await _bridge_connected_events(sink)
        assert events == [
            {
                "bridge_platform": "unknown",
                "outcome": "failure",
                "failure_reason": "config_invalid",
            }
        ]

    async def test_a_bridge_type_no_adapter_is_registered_for(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`lifecycle_service.py`'s `:541`. The platform is still nameable —
        the row says what type it is — even though nothing can run it."""
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        service, sink = _service_with_telemetry(session_factory)
        # Deliberately not calling register_adapter for "mattermost".

        with pytest.raises(ValueError, match="Unknown bridge type"):
            await service.start(bridge_id)
        await service._telemetry.aclose()  # type: ignore[union-attr]

        events = await _bridge_connected_events(sink)
        assert events == [
            {
                "bridge_platform": "mattermost",
                "outcome": "failure",
                "failure_reason": "config_invalid",
            }
        ]

    async def test_a_resource_another_bridge_already_holds(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`lifecycle_service.py`'s `:550-555`: the exact scenario an operator
        hits connecting Teams on a host whose listen port a bridge that
        predates the registration-time check already holds."""
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id = await _bridge_row(
                session,
                tenant_id=tenant,
                bridge_type="teams",
                connection_config={"listen_port": 3978},
            )
            await session.commit()

        service, sink = _service_with_telemetry(session_factory)
        service.register_adapter("teams", _PortHoldingAdapter, _StubConfig)
        service._held_resources["some-other-bridge"] = "port:3978"

        with pytest.raises(ValueError, match="already held by bridge"):
            await service.start(bridge_id)
        await service._telemetry.aclose()  # type: ignore[union-attr]

        events = await _bridge_connected_events(sink)
        assert events == [
            {
                "bridge_platform": "teams",
                "outcome": "failure",
                "failure_reason": "config_invalid",
            }
        ]

    async def test_a_stored_config_that_no_longer_validates(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`lifecycle_service.py`'s `:557`: an adapter's config schema gained a
        required field after this bridge was stored."""
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id = await _bridge_row(
                session, tenant_id=tenant, connection_config={}
            )
            await session.commit()

        service, sink = _service_with_telemetry(session_factory)
        service.register_adapter("mattermost", _StubAdapter, _StrictConfig)

        with pytest.raises(Exception, match="required_setting"):
            await service.start(bridge_id)
        await service._telemetry.aclose()  # type: ignore[union-attr]

        events = await _bridge_connected_events(sink)
        assert events == [
            {
                "bridge_platform": "mattermost",
                "outcome": "failure",
                "failure_reason": "config_invalid",
            }
        ]

    async def test_the_adapter_itself_fails_to_construct(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`lifecycle_service.py`'s `:558`."""
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        service, sink = _service_with_telemetry(session_factory)
        service.register_adapter("mattermost", _ExplodingAdapter, _StubConfig)

        with pytest.raises(RuntimeError, match="adapter construction blew up"):
            await service.start(bridge_id)
        await service._telemetry.aclose()  # type: ignore[union-attr]

        events = await _bridge_connected_events(sink)
        assert events == [
            {
                "bridge_platform": "mattermost",
                "outcome": "failure",
                # RuntimeError carries no reason any rule recognises -- an
                # adapter constructor can fail for reasons that fit none of
                # `auth_failed`/`network`/`platform_error`/`config_invalid`.
                "failure_reason": "unknown",
            }
        ]

    async def test_the_bridges_own_client_row_is_gone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`lifecycle_service.py`'s `:588`. The client row cannot actually be
        deleted out from under a live bridge (the foreign key refuses it), so
        this is exercised at the store boundary instead of with real bad data:
        `client_store.get` returning `None` is the only way `start` itself
        distinguishes this case from a client that is merely elsewhere."""
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        missing_client_store = AsyncMock()
        missing_client_store.get = AsyncMock(return_value=None)
        service, sink = _service_with_telemetry(
            session_factory, client_store=missing_client_store
        )
        service.register_adapter("mattermost", _StubAdapter, _StubConfig)

        with pytest.raises(ValueError, match="Bridge client not found"):
            await service.start(bridge_id)
        await service._telemetry.aclose()  # type: ignore[union-attr]

        events = await _bridge_connected_events(sink)
        assert events == [
            {
                "bridge_platform": "mattermost",
                "outcome": "failure",
                "failure_reason": "config_invalid",
            }
        ]


class TestStartAllsBootPathIsCoveredToo:
    async def test_a_bridge_that_fails_at_boot_is_reported_and_the_rest_still_start(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`start_all` (`:309-313`) only ever logged and moved on past a
        bridge that failed to start — it still does, but the failure now
        reaches telemetry too, because `start` (which it calls unmodified)
        reports before raising back out to it."""
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            # No adapter is ever registered for "teams" below, so this one
            # fails at start()'s "Unknown bridge type" check.
            broken_bridge = await _bridge_row(
                session, tenant_id=tenant, bridge_type="teams"
            )
            healthy_bridge, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        service, sink = _service_with_telemetry(session_factory)
        service.register_adapter("mattermost", _StubAdapter, _StubConfig)
        # Isolates start_all's own boot loop from _run_bridge's separate
        # (already covered) success/failure reporting.
        service._run_bridge = AsyncMock()  # type: ignore[method-assign]

        await service.start_all()
        await service._telemetry.aclose()  # type: ignore[union-attr]

        events = await _bridge_connected_events(sink)
        assert events == [
            {
                "bridge_platform": "teams",
                "outcome": "failure",
                "failure_reason": "config_invalid",
            }
        ]
        assert broken_bridge not in service._started
        assert healthy_bridge in service._started


class TestStartingSuccessfullyDoesNotReportAnything:
    """`start` reports only on the paths that were previously silent. On the
    path that already worked -- scheduling `_run_bridge`, which reports its
    own success once the platform actually answers -- `start` itself must
    stay silent, or a working connect would now report twice."""

    async def test_start_alone_emits_nothing_when_it_schedules_the_task(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        service, sink = _service_with_telemetry(session_factory)
        service.register_adapter("mattermost", _StubAdapter, _StubConfig)
        # `_run_bridge` is where success (and a post-schedule failure) is
        # reported; stubbing it isolates exactly what `start` itself does.
        service._run_bridge = AsyncMock()  # type: ignore[method-assign]

        await service.start(bridge_id)
        await service._telemetry.aclose()  # type: ignore[union-attr]

        assert await _bridge_connected_events(sink) == []


class TestATaskFailureAfterStartSucceedsIsStillReportedExactlyOnce:
    """The other half of not double-reporting: `start` succeeding must not
    swallow a failure that only happens once `_run_bridge` actually runs, and
    that failure must not *also* be reported by `start`."""

    async def test_the_task_failing_is_the_only_event_and_start_reported_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        service, sink = _service_with_telemetry(session_factory)
        service.register_adapter("mattermost", _StubAdapter, _StubConfig)
        service._run_bridge = AsyncMock()  # type: ignore[method-assign]

        await service.start(bridge_id)
        assert await _bridge_connected_events(sink) == []

        # What the scheduled task would have done, awaited directly rather
        # than raced, the same way `test_lifecycle_callback_endpoint.py`'s
        # crash test does -- except `bridge_core.start()` itself is what
        # fails here (`_FailingCore`), the branch that reports
        # `bridge_connected{failure}` from inside `_run_bridge`.
        # `bridge_client` never gets far enough to have `.start()` called, so
        # only its `client_id` attribute (read first, by
        # `_record_bridge_memberships`) matters.
        await type(service)._run_bridge(
            service, bridge_id, tenant, _FailingCore(), _FailingClient()
        )
        await service._telemetry.aclose()  # type: ignore[union-attr]

        events = await _bridge_connected_events(sink)
        assert len(events) == 1
        assert events[0]["outcome"] == "failure"


class TestHowLongTheConnectTook:
    """A connect that succeeds after ninety seconds and one that succeeds in
    two are otherwise the same row.

    Nothing else times this: a bridge comes up on a background task rather
    than inside a request the server serves, so it is invisible to
    `switch.http.request.duration`. The failure half matters more than the
    success half — a timeout and a refusal carry the same `failure_reason` and
    nothing alike in the time.
    """

    async def test_it_is_the_span_of_the_attempt_not_the_time_of_day(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A monotonic clock reads seconds since the process started, which is
        a large number that only grows — so an assertion that the duration is
        merely a non-negative number passes against a reading that was never
        subtracted from anything. Bounding it above is what catches that."""
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        service, sink = _service_with_telemetry(session_factory)
        # No adapter registered, so `start` fails immediately.
        with pytest.raises(ValueError):
            await service.start(bridge_id)
        await service._telemetry.aclose()  # type: ignore[union-attr]

        durations = [
            record.properties["duration_ms"]
            for record in sink.sent
            if record.name == "switch_core.bridge_connected"
        ]
        assert len(durations) == 1
        # Generous, because it is a real database read — but nothing like the
        # process uptime a bare clock reading would report.
        assert 0 <= durations[0] < 60_000

    async def test_a_second_attempt_is_timed_from_its_own_start(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The reading is spent when the outcome is reported. Left behind, the
        next attempt on the same bridge would be timed from the first one, and
        a bridge that is retried reports a duration that only grows."""
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        service, sink = _service_with_telemetry(session_factory)
        for _ in range(2):
            with pytest.raises(ValueError):
                await service.start(bridge_id)
        await service._telemetry.aclose()  # type: ignore[union-attr]

        durations = [
            record.properties["duration_ms"]
            for record in sink.sent
            if record.name == "switch_core.bridge_connected"
        ]
        assert len(durations) == 2
        assert all(0 <= duration < 60_000 for duration in durations)
