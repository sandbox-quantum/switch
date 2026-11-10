"""Controller connection churn is counted, now that its log lines are debug."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.observability.catalogue import CATALOGUE
from switch_core.observability.metrics import MetricsRegistry, install, uninstall

CONTROLLER = "controller-1"


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _counts(registry: MetricsRegistry) -> dict[tuple, float]:
    payload = next(
        (p for p in registry.collect() if p.name == "switch.controllers.connections"),
        None,
    )
    if payload is None:
        return {}
    return {
        tuple(sorted(point.attributes.items())): point.value
        for point in payload.numbers
    }


def test_the_metric_is_in_the_catalogue():
    spec = CATALOGUE["switch.controllers.connections"]
    assert spec.kind == "sum"
    assert spec.attributes == frozenset({"event", "reason"})


def test_opened_adopted_and_taken_over_are_counted(registry):
    presence = AgentConnectionRegistry().controllers
    conn = presence.open(
        controller_id=CONTROLLER, tenant_id=TENANT_ZERO_ID, resume_cursors={}
    )
    presence.attach_stream(conn)
    presence.supersede(CONTROLLER)
    presence.adopt(
        controller_id=CONTROLLER,
        tenant_id=TENANT_ZERO_ID,
        connection_id="connection-2",
        generation=conn.generation + 1,
        resume_cursors={},
    )

    assert _counts(registry) == {
        (("event", "opened"), ("reason", "none")): 1,
        (("event", "taken_over"), ("reason", "none")): 1,
        (("event", "adopted"), ("reason", "none")): 1,
    }


def test_a_connection_replaced_in_this_process_counts_as_taken_over(registry):
    presence = AgentConnectionRegistry().controllers
    first = presence.open(
        controller_id=CONTROLLER, tenant_id=TENANT_ZERO_ID, resume_cursors={}
    )
    presence.attach_stream(first)
    presence.open(controller_id=CONTROLLER, tenant_id=TENANT_ZERO_ID, resume_cursors={})

    assert _counts(registry) == {
        (("event", "opened"), ("reason", "none")): 2,
        (("event", "taken_over"), ("reason", "none")): 1,
    }
