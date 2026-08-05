"""Agent connections: the unit of reachability (CHOO-1857).

A connection is created by opening the event stream and owns everything that
used to be spread across a table, three heartbeat endpoints and four agent
profiles: which rooms it covers, which events it wants, how far it has
consumed, whether it is alive, and which rooms it is entitled to act in.

Two properties matter most:

* **The connection outlives its socket.** Losing the stream stops delivery; it
  does not end the connection. A client that reattaches within the heartbeat
  TTL keeps its room slot and its role lease, so a brief network drop costs a
  gap in delivery rather than the agent's place in a room.
* **The heartbeat is the authority.** An open socket proves nothing — a
  sleeping laptop leaves one behind for minutes. A connection is alive while
  its client keeps ticking, and dead when it stops, whatever the socket says.

Connections live in memory only. They cannot outlive the process (their
sockets and buffers cannot), so persisting them would recreate the stale-state
bug this design removes.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

logger = logging.getLogger(__name__)

Scope = Literal["single", "all"]
DeliveryFilter = Literal["all", "addressed"]

# Clients tick every HEARTBEAT_INTERVAL_SECONDS; a connection is declared dead
# once nothing has arrived for HEARTBEAT_TTL_SECONDS. One mechanism replaces
# /connection/renew, /watch/heartbeat and /leases/renew.
HEARTBEAT_INTERVAL_SECONDS = 2.0
HEARTBEAT_TTL_SECONDS = 6.0

# Refuse a client that speaks a different protocol rather than degrading in
# ways neither side can see. The runtime lives on the user's machine and Switch
# moves independently.
PROTOCOL_VERSION = 1

# Upper bound on simultaneous connections per agent. Runaway growth becomes a
# visible error instead of quiet resource creep.
MAX_CONNECTIONS_PER_AGENT = 32


class ConnectionError_(Exception):
    """Base for connection faults that a client must be told about."""


class UnknownConnectionError(ConnectionError_):
    def __init__(self, connection_id: str) -> None:
        super().__init__(
            f"connection {connection_id} is not open; reconnect and resume from "
            "your cursor"
        )
        self.connection_id = connection_id


class NoStreamAttachedError(ConnectionError_):
    def __init__(self, connection_id: str) -> None:
        super().__init__(
            f"connection {connection_id} has no stream attached; reopen the "
            "event stream"
        )
        self.connection_id = connection_id


class RoomOccupiedError(ConnectionError_):
    def __init__(self, room_id: str, holder_id: str) -> None:
        super().__init__(
            f"room {room_id} is already held by connection {holder_id} for this "
            "agent; close it or pass takeover"
        )
        self.room_id = room_id
        self.holder_id = holder_id


def evicted_session_warning(room_id: str, evicted_connection_id: str) -> str:
    """What to tell a caller that took a room off another live session.

    One wording for every door that can evict, so a client does not have to
    recognise the same event phrased two ways. Reported rather than logged
    quietly: an unannounced takeover looks identical to the duplicate-session
    bug it resolves — a session stops receiving a room and nothing says why.
    """
    return (
        f"You evicted another session of this agent from room {room_id} "
        f"(connection {evicted_connection_id}). Only one session of an agent "
        "may act in a room, so that session has been disconnected from it and "
        "will stop receiving its events. If that session was doing work here, "
        "it no longer is."
    )


class ProtocolVersionError(ConnectionError_):
    def __init__(self, requested: int) -> None:
        super().__init__(
            f"protocol version {requested} is not supported (server speaks "
            f"{PROTOCOL_VERSION}); update the Switch agent runtime"
        )
        self.requested = requested


class TooManyConnectionsError(ConnectionError_):
    def __init__(self, agent_id: str, limit: int) -> None:
        super().__init__(
            f"agent {agent_id} already has {limit} open connections; close one "
            "before opening another"
        )
        self.agent_id = agent_id


@dataclass
class Connection:
    id: str
    agent_id: str
    scope: Scope
    delivery_filter: DeliveryFilter
    spawn_capable: bool
    cursor: int
    last_beat: float
    opened_at: float
    # Rooms this connection has subscribed to. A `single` connection holds at
    # most one; an `all` connection leaves this empty and covers every room the
    # agent belongs to that no sibling has claimed.
    rooms: set[str] = field(default_factory=set)
    stream_attached: bool = False
    # How many heartbeats this connection has received. Diagnostic: it is the
    # difference between a client that never started beating and one that beat
    # and then stopped, which the timestamp alone cannot tell you.
    beats: int = 0
    # Bumped when a new stream attaches, so a superseded stream can notice it
    # has been replaced and stop writing.
    stream_generation: int = 0
    closed_reason: str | None = None
    wake: asyncio.Event = field(default_factory=asyncio.Event)

    def is_alive(self, now: float) -> bool:
        return (
            self.closed_reason is None
            and (now - self.last_beat) < HEARTBEAT_TTL_SECONDS
        )


class ConnectionRegistry:
    """The live set of agent connections. Authoritative, in memory."""

    def __init__(self) -> None:
        self._by_id: dict[str, Connection] = {}
        self._by_agent: dict[str, set[str]] = {}

    # ------------------------------------------------------------------
    # Opening and closing
    # ------------------------------------------------------------------

    def open(
        self,
        *,
        agent_id: str,
        connection_id: str,
        scope: Scope,
        delivery_filter: DeliveryFilter,
        spawn_capable: bool,
        cursor: int,
        protocol_version: int,
    ) -> Connection:
        """Open a connection, or reattach to one the client already owns.

        The client chooses the id, which makes opening idempotent: a timed-out
        request can be retried without leaving an orphan behind. Reopening a
        live id takes it over — "the same client returning" and "the same
        client duplicated" are indistinguishable, and takeover is right for
        both.
        """
        if protocol_version != PROTOCOL_VERSION:
            raise ProtocolVersionError(protocol_version)

        existing = self._by_id.get(connection_id)
        if existing is not None:
            if existing.agent_id != agent_id:
                # Never let one agent attach to another's connection.
                raise UnknownConnectionError(connection_id)
            existing.scope = scope
            existing.delivery_filter = delivery_filter
            existing.spawn_capable = spawn_capable
            existing.cursor = cursor
            existing.last_beat = time.monotonic()
            existing.closed_reason = None
            existing.stream_attached = True
            existing.stream_generation += 1
            logger.info(
                "[CONN] reattached agent=%s connection=%s scope=%s generation=%s",
                agent_id,
                connection_id,
                scope,
                existing.stream_generation,
            )
            return existing

        owned = self._by_agent.setdefault(agent_id, set())
        if len(owned) >= MAX_CONNECTIONS_PER_AGENT:
            raise TooManyConnectionsError(agent_id, MAX_CONNECTIONS_PER_AGENT)

        now = time.monotonic()
        conn = Connection(
            id=connection_id,
            agent_id=agent_id,
            scope=scope,
            delivery_filter=delivery_filter,
            spawn_capable=spawn_capable,
            cursor=cursor,
            last_beat=now,
            opened_at=now,
            stream_attached=True,
        )
        self._by_id[connection_id] = conn
        owned.add(connection_id)
        logger.info(
            "[CONN] opened agent=%s connection=%s scope=%s filter=%s spawn=%s",
            agent_id,
            connection_id,
            scope,
            delivery_filter,
            spawn_capable,
        )
        return conn

    def detach_stream(self, connection_id: str, generation: int) -> None:
        """Mark the stream gone while leaving the connection alive.

        Only the generation that is currently attached may detach: a superseded
        stream unwinding must not clear the flag its replacement just set.
        """
        conn = self._by_id.get(connection_id)
        if conn is not None and conn.stream_generation == generation:
            conn.stream_attached = False
            logger.info(
                "[CONN] stream detached agent=%s connection=%s (connection still "
                "alive until heartbeat lapses)",
                conn.agent_id,
                connection_id,
            )

    def close(self, connection_id: str, reason: str) -> Connection | None:
        conn = self._by_id.pop(connection_id, None)
        if conn is None:
            return None
        owned = self._by_agent.get(conn.agent_id)
        if owned:
            owned.discard(connection_id)
            if not owned:
                self._by_agent.pop(conn.agent_id, None)
        conn.closed_reason = reason
        conn.stream_attached = False
        conn.wake.set()
        # `beats` and the age separate the two ways a connection dies, which
        # otherwise look identical in the log: a client that never beat at all
        # (beats=0 — it is not running the heartbeat, or cannot reach us) versus
        # one that beat and then stopped (beats>0 — it went away, or the server
        # was too busy to process ticks).
        logger.info(
            "[CONN] closed agent=%s connection=%s reason=%s beats=%d last_beat_age=%.1fs",
            conn.agent_id,
            connection_id,
            reason,
            conn.beats,
            time.monotonic() - conn.last_beat,
        )
        return conn

    def sweep(self) -> list[Connection]:
        """Close connections whose heartbeat has lapsed. Returns those closed."""
        now = time.monotonic()
        stale = [
            conn
            for conn in self._by_id.values()
            if (now - conn.last_beat) >= HEARTBEAT_TTL_SECONDS
        ]
        closed = []
        for conn in stale:
            gone = self.close(conn.id, "heartbeat lapsed")
            if gone is not None:
                closed.append(gone)
        return closed

    # ------------------------------------------------------------------
    # Liveness
    # ------------------------------------------------------------------

    def beat(self, agent_id: str, connection_id: str, cursor: int) -> Connection:
        """Record a client tick and its cursor.

        Rejects a tick for a connection with no stream: the client is alive but
        receiving nothing, and must be told to reopen rather than left believing
        it is connected.
        """
        conn = self.require(agent_id, connection_id)
        if not conn.stream_attached:
            raise NoStreamAttachedError(connection_id)
        conn.last_beat = time.monotonic()
        conn.beats += 1
        if cursor > conn.cursor:
            conn.cursor = cursor
        return conn

    def require(self, agent_id: str, connection_id: str) -> Connection:
        conn = self._by_id.get(connection_id)
        if conn is None or conn.agent_id != agent_id:
            raise UnknownConnectionError(connection_id)
        if not conn.is_alive(time.monotonic()):
            self.close(connection_id, "heartbeat lapsed")
            raise UnknownConnectionError(connection_id)
        return conn

    def get(self, connection_id: str) -> Connection | None:
        return self._by_id.get(connection_id)

    def for_agent(self, agent_id: str) -> list[Connection]:
        now = time.monotonic()
        return [
            conn
            for cid in self._by_agent.get(agent_id, set())
            if (conn := self._by_id.get(cid)) is not None and conn.is_alive(now)
        ]

    # ------------------------------------------------------------------
    # Room slots
    # ------------------------------------------------------------------

    def claim_room(
        self, conn: Connection, room_id: str, *, takeover: bool = False
    ) -> Connection | None:
        """Subscribe a connection to a room, claiming its slot.

        At most one connection per agent may act in a room. A `single`
        connection subscribing to a new room drops the previous one, so "one
        room at a time" is enforced here rather than left to the client.

        Returns the connection that was evicted, if any.
        """
        claimant = self.claimant_of(conn.agent_id, room_id)
        evicted: Connection | None = None
        if claimant is not None and claimant.id != conn.id:
            if not takeover:
                raise RoomOccupiedError(room_id, claimant.id)
            claimant.rooms.discard(room_id)
            claimant.wake.set()
            evicted = claimant

        if conn.scope == "single":
            conn.rooms.clear()
        conn.rooms.add(room_id)
        conn.wake.set()
        return evicted

    def release_room(self, conn: Connection, room_id: str) -> None:
        conn.rooms.discard(room_id)
        conn.wake.set()

    def claimant_of(self, agent_id: str, room_id: str) -> Connection | None:
        """The connection that has explicitly claimed this room, if any.

        Only an explicit claim conflicts. An `all`-scope connection covering a
        room has not claimed it — it yields to a session that wants it, which
        is the whole point of the fallback.
        """
        for conn in self.for_agent(agent_id):
            if room_id in conn.rooms:
                return conn
        return None

    def holder_of(self, agent_id: str, room_id: str) -> Connection | None:
        """The connection entitled to act as this agent in this room, if any.

        The claimant if there is one, otherwise an `all`-scope connection —
        that is what makes a supervising daemon go dark on rooms a session has
        taken, and pick them up again when the session ends.
        """
        claimant = self.claimant_of(agent_id, room_id)
        if claimant is not None:
            return claimant
        for conn in self.for_agent(agent_id):
            if conn.scope == "all":
                return conn
        return None

    def covers(self, conn: Connection, room_id: str) -> bool:
        if conn.scope == "single":
            return room_id in conn.rooms
        # An `all` connection covers everything no sibling has claimed.
        if room_id in conn.rooms:
            return True
        for sibling in self.for_agent(conn.agent_id):
            if sibling.id != conn.id and room_id in sibling.rooms:
                return False
        return True

    # ------------------------------------------------------------------
    # Presence
    # ------------------------------------------------------------------
    #
    # Presence readers union these with the `agent_sessions` rows the
    # pre-connection clients maintain (CHOO-1857 stage B). A client on the new
    # transport sends none of the old renews, so without the connection arm it
    # would read as DISCONNECTED while alive on the stream; a client still
    # polling keeps its DB arm. When the old clients are gone, the DB arm goes
    # with them and these remain.

    def is_live(self, agent_id: str) -> bool:
        """Whether the agent has any live connection at all.

        The connection equivalent of the room-agnostic heartbeat slot: what
        `always_on` liveness and the `auto_session` DORMANT state ask for.
        """
        return bool(self.for_agent(agent_id))

    def live_in_room(self, agent_id: str, room_id: str) -> bool:
        """Whether some live connection of this agent covers this room.

        Covers, not claims: an `all`-scope daemon is genuinely reachable in the
        rooms it has not yielded to a session. This is the *delivery* question.
        For "is a session attending this room", use `has_session_in`.
        """
        return any(self.covers(conn, room_id) for conn in self.for_agent(agent_id))

    def has_session_in(self, agent_id: str, room_id: str) -> bool:
        """Whether a connection has **claimed** this room — i.e. a session is in it.

        Distinct from `live_in_room`, and the distinction matters. An
        `all`-scope watcher covers every room no session has taken, so `covers`
        answers "would this connection receive the room's events" — true for a
        daemon that is merely watching. Presence for a session-shaped agent asks
        something narrower: is a session actually attending? Only an explicit
        claim answers that.

        Conflating the two reports an agent LIVE in a room where nothing is
        listening but a watcher, which suppresses both the "no session" reply
        and the `auto_session` promise to start one.
        """
        return self.claimant_of(agent_id, room_id) is not None

    def can_spawn_for(self, agent_id: str, room_id: str) -> bool:
        """Whether something live will start a session for this room on demand.

        Declared by the client when it opens the stream (`spawn_capable`), so
        this is an *observed* capability rather than a property inferred from
        the agent's `connection_model`. That matters: the enum says what an
        agent was configured as, this says what is actually connected and
        willing right now. Promising "Starting a session…" on the strength of
        the enum alone is how a room gets told a session is coming when nothing
        is listening.
        """
        return any(
            conn.spawn_capable and self.covers(conn, room_id)
            for conn in self.for_agent(agent_id)
        )

    def live_agent_ids(self) -> set[str]:
        """Every agent with at least one live connection.

        Passed to the role-lease predicates: a connection keeps a role held,
        so a client that has stopped sending `/leases/renew` because it moved
        to the single heartbeat does not silently lose its seat.
        """
        now = time.monotonic()
        return {conn.agent_id for conn in self._by_id.values() if conn.is_alive(now)}

    def live_agents_in_room(self, agent_ids: Iterable[str], room_id: str) -> set[str]:
        return {aid for aid in agent_ids if self.live_in_room(aid, room_id)}

    def agents_with_session_in(
        self, agent_ids: Iterable[str], room_id: str
    ) -> set[str]:
        return {aid for aid in agent_ids if self.has_session_in(aid, room_id)}

    def live_agents(self, agent_ids: Iterable[str]) -> set[str]:
        return {aid for aid in agent_ids if self.is_live(aid)}

    def rooms_covered(self, agent_id: str, candidate_rooms: Iterable[str]) -> set[str]:
        """Which of `candidate_rooms` this agent is reachable in right now."""
        return {room for room in candidate_rooms if self.live_in_room(agent_id, room)}

    def wake_agent(self, agent_id: str) -> None:
        for conn in self.for_agent(agent_id):
            conn.wake.set()
