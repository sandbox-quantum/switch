"""History checks for delivery: what a finished run left in the database.

A run's rows are read once into a `History`, and each check below states a
property of the whole of it. They look at the end state, not at the steps that
led there, so each checks what that state shows of a property and no more: the
model (`specs/delivery.qnt`) and the state machine check the steps.

    DB_HOST=localhost DB_OWNER_USER=... DB_OWNER_PASSWORD=... DB_NAME=... \
        uv run --project core python properties/history/delivery.py

reads every tenant, so it connects as the schema owner, which the row-level
policies do not apply to, and exits 1 with one line per violation. `--json`
prints one object instead (the counts of what was read, and the violations) and
exits 0 whenever it could read, so a nonzero exit is always a failure to run;
`--tag` reads only the rooms and agents whose names start with it.
"""

from __future__ import annotations

import argparse
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


@dataclass(frozen=True)
class Erasure:
    external_user_ids: list[str]
    former_sender_ids: list[str]
    member_client_ids: list[str]
    completed_at: datetime


@dataclass(frozen=True)
class NamedMessage:
    """A message whose sender an erasure names."""

    room_id: str
    sender_id: str
    sender_client_id: str | None
    sent_at: datetime


@dataclass
class History:
    room_seqs: dict[str, list[int]] = field(default_factory=dict)
    events: list[Event] = field(default_factory=list)
    heads: dict[str, tuple[int, int]] = field(default_factory=dict)
    drops: dict[tuple[str, str], int] = field(default_factory=dict)
    members: set[tuple[str, str]] = field(default_factory=set)
    erasures: list[Erasure] = field(default_factory=list)
    external_users_left: set[str] = field(default_factory=set)
    named_messages: list[NamedMessage] = field(default_factory=list)


async def load(connection: asyncpg.Connection, tag: str | None) -> History:
    """The rows of every tenant, or only of the rooms and agents whose names
    start with `tag` (the harness names what a scenario makes that way), in one
    transaction so they agree with each other."""
    history = History()
    async with connection.transaction(isolation="repeatable_read", readonly=True):
        for room_id, seq in await connection.fetch(
            "SELECT m.room_id, m.seq FROM messages m JOIN rooms r ON r.id = m.room_id "
            "WHERE m.seq > 0 AND ($1::text IS NULL OR starts_with(r.name, $1)) "
            "ORDER BY m.room_id, m.seq",
            tag,
        ):
            history.room_seqs.setdefault(room_id, []).append(seq)
        history.events = [
            Event(**dict(row))
            for row in await connection.fetch(
                "SELECT e.agent_id, e.seq, e.room_id, e.room_seq, e.message_key, "
                "e.type, e.created_at FROM agent_events e "
                "JOIN agents a ON a.id = e.agent_id "
                "WHERE $1::text IS NULL OR starts_with(a.name, $1) "
                "ORDER BY e.agent_id, e.seq",
                tag,
            )
        ]
        history.heads = {
            row["agent_id"]: (row["first_seq"], row["last_seq"])
            for row in await connection.fetch(
                "SELECT h.agent_id, h.first_seq, h.last_seq FROM agent_event_heads h "
                "JOIN agents a ON a.id = h.agent_id "
                "WHERE $1::text IS NULL OR starts_with(a.name, $1)",
                tag,
            )
        }
        history.drops = {
            (row["agent_id"], row["room_id"]): row["dropped_through"]
            for row in await connection.fetch(
                "SELECT d.agent_id, d.room_id, d.dropped_through "
                "FROM agent_event_drops d JOIN agents a ON a.id = d.agent_id "
                "WHERE $1::text IS NULL OR starts_with(a.name, $1)",
                tag,
            )
        }
        history.members = {
            (row["agent_id"], row["room_id"])
            for row in await connection.fetch(
                "SELECT a.id AS agent_id, cr.room_id FROM client_rooms cr "
                "JOIN agents a ON a.client_id = cr.client_id "
                "WHERE $1::text IS NULL OR starts_with(a.name, $1)",
                tag,
            )
        }
        history.erasures = [
            Erasure(
                json.loads(row["external_user_ids"]),
                json.loads(row["former_sender_ids"]),
                json.loads(row["member_client_ids"]),
                row["completed_at"],
            )
            for row in await connection.fetch(
                "SELECT external_user_ids, former_sender_ids, member_client_ids, "
                "completed_at FROM person_erasures "
                "WHERE state = 'done' AND completed_at IS NOT NULL"
            )
        ]
        external = [i for e in history.erasures for i in e.external_user_ids]
        clients = [i for e in history.erasures for i in e.member_client_ids]
        senders = [i for e in history.erasures for i in e.former_sender_ids]
        history.external_users_left = {
            row["id"]
            for row in await connection.fetch(
                "SELECT id FROM external_users WHERE id = ANY($1::text[])", external
            )
        }
        history.named_messages = [
            NamedMessage(**dict(row))
            for row in await connection.fetch(
                "SELECT m.room_id, m.sender_id, m.sender_client_id, m.sent_at "
                "FROM messages m JOIN rooms r ON r.id = m.room_id "
                "WHERE ($1::text IS NULL OR starts_with(r.name, $1)) "
                "AND (m.sender_client_id = ANY($2::text[]) "
                "OR m.sender_id = ANY($3::text[]))",
                tag,
                clients,
                senders,
            )
        ]
    return history


def _by_agent(history: History) -> dict[str, list[Event]]:
    grouped: dict[str, list[Event]] = defaultdict(list)
    for event in history.events:
        grouped[event.agent_id].append(event)
    return grouped


@checks("delivery.own-seq-contiguous")
def own_seq_contiguous(history: History) -> list[str]:
    """An agent's own events fall inside what its head row says was handed out,
    and each later number is created no earlier than the one before it (a
    number cannot be stored twice: it is the table's primary key).

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
            if previous is not None and event.created_at < previous.created_at:
                found.append(
                    f"agent {agent}: event {event.seq} was created before "
                    f"event {previous.seq}, which has a lower number"
                )
            previous = event
    return found


@checks("delivery.addressed-exactly-once")
def addressed_exactly_once(history: History) -> list[str]:
    """An agent has one event for each row of a room, and no event is for a
    row past the newest the room has. A room with no rows left, or not read, says
    nothing: retention deletes from the front."""
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
        if rows is not None and event.room_seq > rows[-1]:
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
    at or below the newest number it recorded deleting, in any room (a kept
    event at that number would be a number given out twice), because a reader
    resuming below what is kept is told only about the rooms it recorded."""
    found = []
    by_agent = _by_agent(history)
    for (agent, room), dropped in sorted(history.drops.items()):
        for event in by_agent.get(agent, []):
            if event.seq <= dropped:
                found.append(
                    f"agent {agent}: event {event.seq} is kept at or below "
                    f"{dropped}, which retention deleted in room {room}"
                )
    return found


@checks("retention.erasure-complete")
def erasure_complete(history: History) -> list[str]:
    """After an erasure is done, no identity it names is left, and no message
    from a sender it names was sent before it finished (a member client may send
    again afterwards: the client stays)."""
    found = [
        f"external user {user} is still there after the erasure that named it"
        for user in sorted(history.external_users_left)
    ]
    for erasure in history.erasures:
        for message in history.named_messages:
            named = (
                message.sender_client_id in erasure.member_client_ids
                or message.sender_id in erasure.former_sender_ids
            )
            if named and message.sent_at <= erasure.completed_at:
                found.append(
                    f"a message in room {message.room_id} from "
                    f"{message.sender_client_id or message.sender_id} survives "
                    "the erasure that named its sender"
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--tag", help="only rooms and agents whose names start so")
    args = parser.parse_args(argv)
    names = ("DB_HOST", "DB_PORT", "DB_OWNER_USER", "DB_OWNER_PASSWORD", "DB_NAME")
    missing = [name for name in names if name not in os.environ]
    if missing:
        print(f"history: {', '.join(missing)} not set", file=sys.stderr)
        return 2
    connection = await asyncpg.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ["DB_PORT"]),
        user=os.environ["DB_OWNER_USER"],
        password=os.environ["DB_OWNER_PASSWORD"],
        database=os.environ["DB_NAME"],
    )
    try:
        history = await load(connection, args.tag)
    finally:
        await connection.close()
    found = violations(history)
    counts = {
        "rows": sum(map(len, history.room_seqs.values())),
        "rooms": len(history.room_seqs),
        "events": len(history.events),
        "agents": len(history.heads),
    }
    if args.json:
        print(json.dumps({**counts, "violations": found}))
        return 0
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
