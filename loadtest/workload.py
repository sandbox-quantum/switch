"""The workload, worked out in advance from the seed and the flags.

Nothing in here talks to a server or reads a clock. Room membership, the
message schedule and the payload sizes all come from `random.Random` seeded
from `--seed` plus the name of the thing being drawn, so the same seed and the
same flags give the same workload on every run, and two different steps or
scenarios do not share a stream of random numbers (adding a scenario does not
shift the messages of another one).
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import asdict, dataclass

SCENARIOS = ("idle", "steady", "burst")


def rng_for(seed: int, *labels: object) -> random.Random:
    """A random stream of its own for one purpose, derived from the seed."""
    key = ":".join([str(seed), *(str(label) for label in labels)])
    return random.Random(int.from_bytes(hashlib.sha256(key.encode()).digest()[:8]))


def build_membership(
    seed: int, n_agents: int, n_rooms: int, room_size: int
) -> list[list[int]]:
    """Which agents (by index) sit in each room.

    Room j draws `room_size` members from the agents. Every agent is placed in
    at least one room when there are enough seats, so no agent is connected
    with nothing to read: the first pass deals agents out in a shuffled order,
    the rest of the seats are drawn at random.
    """
    if n_agents < 2:
        raise ValueError("a room needs at least two agents, so at least two agents")
    size = max(2, min(room_size, n_agents))
    rng = rng_for(seed, "membership", n_agents, n_rooms, size)
    order = list(range(n_agents))
    rng.shuffle(order)
    rooms: list[list[int]] = [[] for _ in range(n_rooms)]
    for i, agent in enumerate(order):
        room = rooms[i % n_rooms]
        if len(room) < size:
            room.append(agent)
    for room in rooms:
        others = [a for a in range(n_agents) if a not in room]
        room.extend(rng.sample(others, size - len(room)))
        room.sort()
    return rooms


@dataclass(frozen=True, slots=True)
class Send:
    """One message the harness will post: when, where, by whom, how big."""

    at: float  # seconds from the start of the measured window
    room: int  # index into the membership
    sender: int  # agent index, a member of the room
    size: int  # payload length in characters


def _payload_size(rng: random.Random, lo: int, hi: int) -> int:
    # Log-uniform: mostly short chat lines, now and then a long one, which is
    # what a room of agents posting results looks like.
    if hi <= lo:
        return lo
    return int(round(lo * (hi / lo) ** rng.random()))


def _pick(
    rng: random.Random, rooms: list[list[int]], active: int, hot_room: int | None
) -> tuple[int, int]:
    """A room with at least two connected members, and a connected sender in it."""
    if hot_room is not None:
        room = hot_room
    else:
        live = [j for j, members in enumerate(rooms) if _live(members, active) >= 2]
        room = rng.choice(live)
    senders = [a for a in rooms[room] if a < active]
    return room, rng.choice(senders)


def _live(members: list[int], active: int) -> int:
    return sum(1 for a in members if a < active)


def build_schedule(
    *,
    seed: int,
    scenario: str,
    step: int,
    duration: float,
    rooms: list[list[int]],
    active: int,
    rate: float,
    burst_every: float = 30.0,
    burst_size: int = 100,
    burst_window: float = 2.0,
    hot_room: bool = False,
    payload_min: int = 40,
    payload_max: int = 2000,
) -> list[Send]:
    """The messages of one scenario at one step, in time order.

    `active` is how many agents are connected at this step (agents 0 to
    active-1); a message only goes to a room with two or more of them, sent by
    one of them.

    - idle: nothing.
    - steady: Poisson arrivals at `rate` per second for `duration` seconds.
    - burst: the steady background at `rate`, plus `burst_size` messages
      spread evenly at random over `burst_window` seconds, every `burst_every`
      seconds (first one `burst_every / 2` in). With `hot_room`, the spikes all
      land in the room with the most connected members.
    """
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario {scenario!r}")
    if scenario == "idle":
        return []
    rng = rng_for(seed, "schedule", scenario, step)
    if not any(_live(m, active) >= 2 for m in rooms):
        raise ValueError(f"no room has two connected members at {active} agents")
    sends: list[Send] = []
    t = 0.0
    while rate > 0:
        t += rng.expovariate(rate)
        if t >= duration:
            break
        room, sender = _pick(rng, rooms, active, None)
        sends.append(
            Send(t, room, sender, _payload_size(rng, payload_min, payload_max))
        )
    if scenario == "burst":
        hot = (
            max(range(len(rooms)), key=lambda j: (_live(rooms[j], active), -j))
            if hot_room
            else None
        )
        start = burst_every / 2
        while start < duration:
            for _ in range(burst_size):
                at = start + rng.random() * burst_window
                if at >= duration:
                    continue
                room, sender = _pick(rng, rooms, active, hot)
                sends.append(
                    Send(at, room, sender, _payload_size(rng, payload_min, payload_max))
                )
            start += burst_every
    sends.sort(key=lambda s: (s.at, s.room, s.sender))
    return sends


def payload(token: str, size: int) -> str:
    """The message text: the token the receivers match on, padded to `size`."""
    head = f"lt:{token}: "
    filler = "load test " * (size // 10 + 1)
    return head + filler[: max(0, size - len(head))]


def fingerprint(obj: object) -> str:
    """A short hash of a membership or a schedule, to show two runs matched."""
    if isinstance(obj, list) and obj and isinstance(obj[0], Send):
        obj = [asdict(s) for s in obj]
    blob = json.dumps(obj, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]
