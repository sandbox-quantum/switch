"""The history checks in `properties/history/delivery.py`: a run the machine's
code produced passes them, and each fails on a history with its bug planted."""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from tests.switch_core.properties.delivery_machine import Delivery, machine_on

_PATH = Path(__file__).parents[4] / "properties" / "history" / "delivery.py"
_SPEC = importlib.util.spec_from_file_location("history_delivery", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
history_delivery = importlib.util.module_from_spec(_SPEC)
sys.modules["history_delivery"] = history_delivery
_SPEC.loader.exec_module(history_delivery)


@pytest.fixture
def run(postgres_schema: str) -> Iterator[Delivery]:
    """A database after a few posts, one agent addressed in each, two in one."""
    machine = machine_on(postgres_schema)()
    try:
        for writer, addressed in enumerate(
            [{"alpha"}, {"alpha", "beta"}, {"alpha"}], start=1
        ):
            machine.begin_post(writer, "r1", frozenset(addressed))
            machine.end_post(writer, "commit")
        machine.begin_post(4, "r2", frozenset({"beta"}))
        machine.end_post(4, "commit")
        yield machine
    finally:
        machine.teardown()


def _found(machine: Delivery, mutate: str | None) -> list[str]:
    async def go() -> list[str]:
        connection = await asyncpg.connect(
            machine.url.replace("postgresql+asyncpg://", "postgresql://")
        )
        try:
            if mutate is not None:
                await connection.execute(mutate)
            history = await history_delivery.load(connection, None)
        finally:
            await connection.close()
        return history_delivery.violations(history)

    found: list[str] = machine.run(go())
    return found


def test_a_history_the_code_wrote_passes(run: Delivery) -> None:
    assert _found(run, None) == []


@pytest.mark.parametrize(
    ("property_id", "mutation"),
    [
        (
            "delivery.own-seq-contiguous",
            "UPDATE agent_events SET created_at = created_at - interval '1 hour' "
            "WHERE seq = (SELECT max(seq) FROM agent_events a "
            "WHERE a.agent_id = agent_events.agent_id)",
        ),
        (
            "delivery.addressed-exactly-once",
            "WITH moved AS (UPDATE agent_event_heads SET last_seq = last_seq + 1 "
            "RETURNING agent_id, last_seq) "
            "INSERT INTO agent_events (tenant_id, agent_id, seq, room_id, room_seq, "
            "message_key, type, payload, notifiable) "
            "SELECT e.tenant_id, e.agent_id, m.last_seq, e.room_id, e.room_seq, "
            "NULL, e.type, e.payload, e.notifiable "
            "FROM agent_events e JOIN moved m ON m.agent_id = e.agent_id "
            "WHERE e.seq = (SELECT min(seq) FROM agent_events a "
            "WHERE a.agent_id = e.agent_id)",
        ),
        (
            "delivery.no-events-after-leave",
            "DELETE FROM client_rooms WHERE client_id = "
            "(SELECT client_id FROM agents WHERE id = "
            "(SELECT agent_id FROM agent_events LIMIT 1))",
        ),
        (
            "delivery.no-silent-loss",
            "INSERT INTO agent_event_drops (tenant_id, agent_id, room_id, "
            "dropped_through) SELECT tenant_id, agent_id, room_id, seq + 1 "
            "FROM agent_events WHERE seq = (SELECT max(seq) FROM agent_events a "
            "WHERE a.agent_id = agent_events.agent_id) LIMIT 1",
        ),
    ],
)
def test_each_check_fails_on_its_bug(
    run: Delivery, property_id: str, mutation: str
) -> None:
    found: list[Any] = _found(run, mutation)
    assert any(line.startswith(f"{property_id}: ") for line in found), found


def test_a_tag_reads_only_the_agents_and_rooms_named_so(run: Delivery) -> None:
    async def go() -> tuple[int, int, int]:
        connection = await asyncpg.connect(
            run.url.replace("postgresql+asyncpg://", "postgresql://")
        )
        try:
            scoped = await history_delivery.load(connection, "alpha")
            nothing = await history_delivery.load(connection, "no-such-tag")
            everything = await history_delivery.load(connection, None)
        finally:
            await connection.close()
        return len(scoped.events), len(nothing.events), len(everything.events)

    scoped, nothing, everything = run.run(go())
    assert (scoped, nothing) == (3, 0)
    assert everything == 5
