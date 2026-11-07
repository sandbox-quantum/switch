"""History checks for delivery: what a finished run left in the database.

A run's rows are read once into a `History`, and each check below states a
property of the whole of it. They look at the end state, not at the steps that
led there, so each checks what that state shows of a property and no more: the
model (`specs/delivery.qnt`) and the state machine check the steps.

    DB_HOST=localhost DB_OWNER_USER=... DB_OWNER_PASSWORD=... DB_NAME=... \
        uv run --project core python properties/history/delivery.py

reads every tenant, so it connects as the schema owner, which the row-level
policies do not apply to, and exits 1 with one line per violation. `--json`
prints one object instead: the counts of what was read, and the violations.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime

import asyncpg

CHECKS: list[tuple[str, Callable[[History], list[str]]]] = []


def checks(
    property_id: str,
) -> Callable[[Callable[[History], list[str]]], Callable[[History], list[str]]]:
    """Register a check of the property `property_id`, which the gate reads."""

    def register(
        check: Callable[[History], list[str]],
    ) -> Callable[[History], list[str]]:
        CHECKS.append((property_id, check))
        return check

    return register


@dataclass(frozen=True)
class Event:
    agent_id: str
    seq: int
    room_id: str
    room_seq: int
    message_key: str | None
    type: str
    created_at: datetime


@dataclass
class History:
    room_seqs: dict[str, list[int]] = field(default_factory=dict)
    events: list[Event] = field(default_factory=list)
    heads: dict[str, tuple[int, int]] = field(default_factory=dict)
    drops: dict[tuple[str, str], int] = field(default_factory=dict)
    members: set[tuple[str, str]] = field(default_factory=set)


async def load(connection: asyncpg.Connection) -> History:
    """Every tenant's rows, in one transaction so they agree with each other."""
    history = History()
    async with connection.transaction(isolation="repeatable_read", readonly=True):
        for room_id, seq in await connection.fetch(
            "SELECT room_id, seq FROM messages WHERE seq > 0 ORDER BY room_id, seq"
        ):
            history.room_seqs.setdefault(room_id, []).append(seq)
        history.events = [
            Event(**dict(row))
            for row in await connection.fetch(
                "SELECT agent_id, seq, room_id, room_seq, message_key, type, "
                "created_at FROM agent_events ORDER BY agent_id, seq"
            )
        ]
        history.heads = {
            row["agent_id"]: (row["first_seq"], row["last_seq"])
            for row in await connection.fetch(
                "SELECT agent_id, first_seq, last_seq FROM agent_event_heads"
            )
        }
        history.drops = {
            (row["agent_id"], row["room_id"]): row["dropped_through"]
            for row in await connection.fetch(
                "SELECT agent_id, room_id, dropped_through FROM agent_event_drops"
            )
        }
        history.members = {
            (row["agent_id"], row["room_id"])
            for row in await connection.fetch(
                "SELECT a.id AS agent_id, cr.room_id FROM client_rooms cr "
                "JOIN agents a ON a.client_id = cr.client_id"
            )
        }
    return history


def _by_agent(history: History) -> dict[str, list[Event]]:
    grouped: dict[str, list[Event]] = defaultdict(list)
    for event in history.events:
        grouped[event.agent_id].append(event)
    return grouped


@checks("delivery.own-seq-contiguous")
def own_seq_contiguous(history: History) -> list[str]:
    """An agent's own events fall inside what its head row says was handed out,
    each later number is created no earlier than the one before it, and no
    number is stored twice.

    Numbers a leave or retention deleted leave holes, so a hole is not a
    violation here; what retention does with `created_at` is, because it
    deletes by `created_at` and reads treat everything below the lowest number
    kept as deleted."""
    found = []
    for agent, events in sorted(_by_agent(history).items()):
        head = history.heads.get(agent)
        if head is None:
            found.append(f"agent {agent}: has events but no head row")
            continue
        first, last = head
        previous = None
        for event in events:
            if not first <= event.seq <= last:
                found.append(
                    f"agent {agent}: event {event.seq} is outside its head "
                    f"{first}..{last}"
                )
            if previous is not None:
                if event.seq == previous.seq:
                    found.append(f"agent {agent}: number {event.seq} stored twice")
                elif event.created_at < previous.created_at:
                    found.append(
                        f"agent {agent}: event {event.seq} was created before "
                        f"event {previous.seq}, which has a lower number"
                    )
            previous = event
    return found


@checks("delivery.addressed-exactly-once")
def addressed_exactly_once(history: History) -> list[str]:
    """An agent has one event for each row of a room, and each event is for a
    row that exists (or that retention has since deleted)."""
    found = []
    sources: dict[tuple[str, str, int, str], int] = {}
    for event in history.events:
        source = (event.agent_id, event.room_id, event.room_seq, event.type)
        if source in sources:
            found.append(
                f"agent {event.agent_id}: events {sources[source]} and "
                f"{event.seq} are both for {event.type} at room {event.room_id} "
                f"row {event.room_seq}"
            )
        else:
            sources[source] = event.seq
        rows = history.room_seqs.get(event.room_id)
        if rows is None or event.room_seq > rows[-1]:
            found.append(
                f"agent {event.agent_id}: event {event.seq} is for room "
                f"{event.room_id} row {event.room_seq}, which was never committed"
            )
    return found


@checks("delivery.no-events-after-leave")
def no_events_after_leave(history: History) -> list[str]:
    """An agent that is not in a room has no events from it."""
    return [
        f"agent {agent}: has {sum(1 for e in events if e.room_id == room)} "
        f"events from room {room}, which it is not in"
        for agent, events in sorted(_by_agent(history).items())
        for room in sorted({event.room_id for event in events})
        if (agent, room) not in history.members
    ]


@checks("delivery.no-silent-loss")
def no_silent_loss(history: History) -> list[str]:
    """Retention deleted a prefix of each agent's numbers: nothing is kept
    below the newest number it recorded deleting, in any room, because a reader
    resuming below what is kept is told only about the rooms it recorded."""
    found = []
    by_agent = _by_agent(history)
    for (agent, room), dropped in sorted(history.drops.items()):
        for event in by_agent.get(agent, []):
            if event.seq < dropped:
                found.append(
                    f"agent {agent}: event {event.seq} is kept below {dropped}, "
                    f"which retention deleted in room {room}"
                )
    return found


def violations(history: History) -> list[str]:
    """Every violation of every check, each as `property: what`."""
    return [
        f"{property_id}: {line}"
        for property_id, check in CHECKS
        for line in check(history)
    ]


async def main(argv: list[str]) -> int:
    as_json = argv == ["--json"]
    if argv and not as_json:
        print("usage: delivery.py [--json]", file=sys.stderr)
        return 2
    connection = await asyncpg.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ["DB_PORT"]),
        user=os.environ["DB_OWNER_USER"],
        password=os.environ["DB_OWNER_PASSWORD"],
        database=os.environ["DB_NAME"],
    )
    try:
        history = await load(connection)
    finally:
        await connection.close()
    found = violations(history)
    counts = {
        "rows": sum(map(len, history.room_seqs.values())),
        "rooms": len(history.room_seqs),
        "events": len(history.events),
        "agents": len(history.heads),
    }
    if as_json:
        print(json.dumps({**counts, "violations": found}))
    else:
        for line in found:
            print(line)
        print(
            f"history: {counts['rows']} rows in {counts['rooms']} rooms, "
            f"{counts['events']} own events for {counts['agents']} agents, "
            f"checked {len(CHECKS)} properties: {len(found)} violations"
        )
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
