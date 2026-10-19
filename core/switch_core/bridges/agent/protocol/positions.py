"""Positions record how far a reader of an agent's events has read, with one
number per source.

An agent's events come from more than one table. Its own events are the events
meant for the agent (addressed messages, room joins it listens for, task
events, commands), not ones it sent. They are rows in `agent_events`, numbered
per agent (`agent_events.seq`). The rest of each room's conversation is read
from `messages`, which numbers each room separately (`messages.seq`). One
number cannot say how far a reader has got in several separately numbered
lists, so a position holds one number per source.
`{"s": 18, "r:<room_id>": 43}` means the reader has read the agent's own events
up to 18 and that room up to 43.

Two positions merge by taking the larger number for each source (`merged`).
The result does not depend on the order positions arrive in or on how often
the same one arrives, so a duplicated event, sources delivered out of step
with each other, and two processes reporting progress in either order all
leave the reader at the same position.
"""

from __future__ import annotations

import json
from typing import Any

#: The position key for the agent's own events, its rows in `agent_events`.
OWN_EVENTS = "s"

_ROOM_PREFIX = "r:"

Position = dict[str, int]


def room_source(room_id: str) -> str:
    """Return the position key for a room's conversation, `r:<room_id>`."""
    return f"{_ROOM_PREFIX}{room_id}"


def room_of(source: str) -> str | None:
    """Return the room id a position key names, or None for the own-events key."""
    return source[len(_ROOM_PREFIX) :] if source.startswith(_ROOM_PREFIX) else None


def merged(current: Position, reported: Position) -> Position:
    """Return the join (least upper bound) of two positions in their
    join-semilattice: each source at the further of the two, never moving back.

    A source present in only one of them keeps that number. This matches
    `furthest` in console/packages/switch-agent-runtime/src/positions.ts.
    """
    out = dict(current)
    for source, seq in reported.items():
        if seq > out.get(source, -1):
            out[source] = seq
    return out


def parse(raw: Any) -> Position:
    """Parse a position sent by a client, raising ValueError if it is invalid.

    A position is a JSON object, or a string holding one, that maps each source
    to a non-negative integer. A source must be the own-events key `s` or a
    room key `r:<room_id>`. An unknown key is refused rather than stored, so a client
    that misspells a key gets an error instead of an entry that never moves.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError as exc:
            raise ValueError("a position is a JSON object") from exc
    if not isinstance(raw, dict):
        raise ValueError("a position is an object of source to sequence number")
    position: Position = {}
    for source, seq in raw.items():
        if not isinstance(source, str) or not (
            source == OWN_EVENTS
            or (source.startswith(_ROOM_PREFIX) and room_of(source))
        ):
            raise ValueError(f"unknown position source {source!r}")
        if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0:
            raise ValueError(f"position {source!r} must be a non-negative integer")
        position[source] = seq
    return position
