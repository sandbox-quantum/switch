"""Outbound platform calls are timed, and the running gauge says which.

Two gaps on the same signal. Bridges were counted in three ways and timed in
none, so a room that felt unresponsive — the commonest report there is — looked
from a dashboard like a healthy server relaying messages: the counters go up,
nothing errors, and people wait. An outbound relay is also the only external
API call this process makes, so its latency is the only place a slow platform
can show at all.

And `switch.bridges.running` was a bare total, which answers "how many bridges
died" and never "which" — a Slack outage and a misconfigured Teams app are the
same number.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.observability.catalogue import BRIDGE_CALL_DURATION
from switch_core.observability.metrics import MetricsRegistry, install, uninstall


@pytest.fixture
def registry():
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _calls(registry: MetricsRegistry) -> dict[tuple[str, str], tuple[int, float]]:
    """(platform, kind) → (count, total ms)."""
    for payload in registry.collect():
        if payload.name != BRIDGE_CALL_DURATION.name:
            continue
        return {
            (point.attributes["platform"], point.attributes["kind"]): (
                point.count,
                point.total,
            )
            for point in payload.histograms
        }
    return {}


class _Bridge:
    """The `_counted_outbound` contextmanager, off a real `BridgeCore`.

    Built by `__new__` rather than through the constructor: the manager reads
    one attribute, and standing up a whole `BridgeCore` would need a database,
    an adapter and six stores to test a `time.perf_counter()` pair.
    """

    def __new__(cls, bridge_type: str):
        core = object.__new__(BridgeCore)
        core._bridge_type = bridge_type  # type: ignore[attr-defined]
        return core


class TestAnOutboundRelayIsTimed:
    def test_a_successful_relay_records_its_duration(
        self, registry: MetricsRegistry
    ) -> None:
        bridge = _Bridge("slack")

        with bridge._counted_outbound("message"):
            pass

        assert _calls(registry)[("slack", "message")][0] == 1

    def test_the_platform_and_kind_are_carried(self, registry: MetricsRegistry) -> None:
        """Both, because "Slack is slow" and "attachments are slow" are
        different findings and a single series answers neither."""
        for platform, kind in [("slack", "message"), ("teams", "attachment")]:
            with _Bridge(platform)._counted_outbound(kind):
                pass

        assert set(_calls(registry)) == {("slack", "message"), ("teams", "attachment")}

    def test_a_failed_relay_is_not_timed(self, registry: MetricsRegistry) -> None:
        """A call that raised took however long its own failure took, which is
        a different distribution under the same name. `switch.bridge.errors` is
        where a failure shows."""
        bridge = _Bridge("mattermost")

        with pytest.raises(RuntimeError):
            with bridge._counted_outbound("message"):
                raise RuntimeError("platform refused")

        assert _calls(registry) == {}

    def test_the_exception_still_reaches_the_caller(
        self, registry: MetricsRegistry
    ) -> None:
        """Timing must not swallow: whoever handles the failure above still
        has to."""
        boom = RuntimeError("platform refused")

        with pytest.raises(RuntimeError) as raised:
            with _Bridge("discord")._counted_outbound("message"):
                raise boom

        assert raised.value is boom


class TestTheRunningGaugeSaysWhichPlatform:
    def test_it_counts_each_platform_separately(self) -> None:
        service = object.__new__(CollaborationBridgeLifecycleService)
        service._started = {"a", "b", "c"}  # type: ignore[attr-defined]
        service._platforms_seen = set()  # type: ignore[attr-defined]
        service._bridges = {"a": object(), "b": object()}  # type: ignore[attr-defined]
        service._tasks = {  # type: ignore[attr-defined]
            "a": _DoneTask(False),
            "b": _DoneTask(False),
            "c": _DoneTask(True),
        }
        service._bridge_facts = {  # type: ignore[attr-defined]
            "a": ("slack", None),
            "b": ("slack", None),
            "c": ("teams", None),
        }

        assert service.running_by_platform() == {"slack": 2, "teams": 0}

    def test_a_platform_that_is_fully_down_still_reports_zero(self) -> None:
        """The whole signal. A series that stops being reported looks on a
        dashboard exactly like one nobody is looking at — "Teams went from one
        to zero" is the alert, and it cannot fire on an absence."""
        service = object.__new__(CollaborationBridgeLifecycleService)
        service._started = {"c"}  # type: ignore[attr-defined]
        service._platforms_seen = {"teams"}  # type: ignore[attr-defined]
        service._bridges = {}  # type: ignore[attr-defined]
        service._tasks = {"c": _DoneTask(True)}  # type: ignore[attr-defined]
        service._bridge_facts = {"c": ("teams", None)}  # type: ignore[attr-defined]

        assert service.running_by_platform() == {"teams": 0}

    def test_a_platform_whose_last_bridge_was_stopped_still_reports_zero(self) -> None:
        """`_started` drops a bridge that was stopped deliberately, so reading
        only that would end the series at the moment it has something to say —
        a dashboard cannot tell an ended series from one nobody is watching."""
        service = object.__new__(CollaborationBridgeLifecycleService)
        service._started = set()  # type: ignore[attr-defined]
        service._platforms_seen = {"slack"}  # type: ignore[attr-defined]
        service._bridges = {}  # type: ignore[attr-defined]
        service._tasks = {}  # type: ignore[attr-defined]
        service._bridge_facts = {}  # type: ignore[attr-defined]

        assert service.running_by_platform() == {"slack": 0}

    def test_a_process_with_no_bridges_at_all_reports_nothing(self) -> None:
        """Not zero: there is no bridge here to be up or down, and five
        platforms sitting at zero would invite an alert on one nobody
        configured."""
        service = object.__new__(CollaborationBridgeLifecycleService)
        service._started = set()  # type: ignore[attr-defined]
        service._platforms_seen = set()  # type: ignore[attr-defined]
        service._bridges = {}  # type: ignore[attr-defined]
        service._tasks = {}  # type: ignore[attr-defined]
        service._bridge_facts = {}  # type: ignore[attr-defined]

        assert service.running_by_platform() == {}

    def test_it_agrees_with_the_total_it_replaces(self) -> None:
        """The per-platform readings must sum to `running_count`, or two panels
        built from the same fact disagree."""
        service = object.__new__(CollaborationBridgeLifecycleService)
        service._started = {"a", "b", "c"}  # type: ignore[attr-defined]
        service._platforms_seen = set()  # type: ignore[attr-defined]
        service._bridges = {"a": object(), "b": object()}  # type: ignore[attr-defined]
        service._tasks = {  # type: ignore[attr-defined]
            "a": _DoneTask(False),
            "b": _DoneTask(False),
            "c": _DoneTask(True),
        }
        service._bridge_facts = {  # type: ignore[attr-defined]
            "a": ("slack", None),
            "b": ("mattermost", None),
            "c": ("teams", None),
        }

        assert sum(service.running_by_platform().values()) == service.running_count()


class _DoneTask:
    def __init__(self, done: bool) -> None:
        self._done = done

    def done(self) -> bool:
        return self._done
