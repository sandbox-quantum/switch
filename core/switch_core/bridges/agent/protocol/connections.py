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
import secrets
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Literal

from switch_core.artifacts import contract_range
from switch_core.observability.catalogue import AGENT_CONNECTIONS_EXPIRED
from switch_core.observability.metrics import metrics

logger = logging.getLogger(__name__)

Scope = Literal["single", "all"]
DeliveryFilter = Literal["all", "addressed"]

# Clients tick every HEARTBEAT_INTERVAL_SECONDS; a connection is declared dead
# once nothing has arrived for HEARTBEAT_TTL_SECONDS. One mechanism replaces
# /connection/renew, /watch/heartbeat and /leases/renew.
HEARTBEAT_INTERVAL_SECONDS = 2.0
HEARTBEAT_TTL_SECONDS = 6.0

# Refuse a client that cannot meet this server's protocol rather than degrading
# in ways neither side can see. The runtime lives on the user's machine and
# Switch moves independently.
#
# Both numbers come from artifacts.yaml, the one place a human declares them
# (CHOO-1865). PROTOCOL_VERSION is the newest revision this server implements;
# PROTOCOL_ACCEPTS is the oldest it still handles. They are equal today, and
# the range is what compatibility is judged on so that they need not stay so.
_SERVER_AGENT_PROTOCOL = contract_range("agent-protocol", "switch-core")
PROTOCOL_VERSION = _SERVER_AGENT_PROTOCOL.speaks
PROTOCOL_ACCEPTS = _SERVER_AGENT_PROTOCOL.accepts

# The revision from which a client carries the connection incarnation on every
# heartbeat and every room request. A client that declares it and then sends one
# without an incarnation is refused rather than trusted: naming nothing is only
# honest from a client that never had an incarnation to name, and otherwise it
# is the way past the check.
FENCED_PROTOCOL_REVISION = 2

# Upper bound on simultaneous connections per agent. Runaway growth becomes a
# visible error instead of quiet resource creep.
MAX_CONNECTIONS_PER_AGENT = 32


class ConnectionError_(Exception):
    """Base for connection faults that a client must be told about.

    `code` travels beside the prose so a client decides what to do from a
    stable token rather than by matching words. The refusals a heartbeat can
    receive share a status and differ only here, and they call for opposite
    responses — reopen, or stand down.
    """

    code = "connection_error"


class UnknownConnectionError(ConnectionError_):
    def __init__(self, connection_id: str) -> None:
        super().__init__(
            f"connection {connection_id} is not open; reconnect and resume from "
            "your cursor"
        )
        self.connection_id = connection_id


class NoStreamAttachedError(ConnectionError_):
    code = "no_stream"

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


class SupersededConnectionError(ConnectionError_):
    """A tick for an incarnation of the connection that is no longer current.

    Carries the same code as the eviction a displaced stream is sent, because
    it is the same ending reaching the client by the other door: a client whose
    socket dropped before that frame arrived learns it here instead. Reopening
    is a takeover, so this is terminal for whoever receives it — treating it as
    recoverable is how the loser takes the connection back from the winner.
    """

    code = "taken_over"

    def __init__(self, connection_id: str, *, presented: int, current: int) -> None:
        super().__init__(
            f"connection {connection_id} was reopened since incarnation "
            f"{presented} and is now at {current}; another client holds it, so "
            "this heartbeat was refused and its cursor was not applied"
        )
        self.connection_id = connection_id
        self.presented = presented
        self.current = current


class SupersededReattachError(ConnectionError_):
    """A reattach claiming an incarnation of the connection that has moved on.

    Attaching is a takeover, so a client that reattaches unconditionally takes
    the connection back off whoever holds it — and a client that missed its own
    eviction, because the socket died before the frame or the heartbeat refusal
    never arrived, cannot know it is doing so. A reattach that names the
    incarnation it believes it still holds can be refused instead, and refusing
    it changes nothing: the holder keeps the stream, the incarnation does not
    move, and the client that asked is told, in the one exchange it has left.
    """

    code = "taken_over"

    def __init__(self, connection_id: str, *, presented: int, current: int) -> None:
        super().__init__(
            f"connection {connection_id} has been reopened since incarnation "
            f"{presented} and is now at {current}; another client holds it, so "
            "this reattach was refused and the connection was left untouched"
        )
        self.connection_id = connection_id
        self.presented = presented
        self.current = current


class SupersededControlError(ConnectionError_):
    """A room-control request from a client that no longer holds the connection.

    Claiming and releasing rooms resolve the connection by id, and an id
    survives a takeover — so the loser of one can still reach the connection and
    rewrite the winner's room set, evicting whoever holds the room it claims.
    The fenced open cannot help: this happens before it, and refusing the open
    afterwards does not undo it. So the room surface is fenced on the same
    incarnation, and refused before the membership check and before any change.
    """

    code = "taken_over"

    def __init__(self, connection_id: str, *, presented: int, current: int) -> None:
        super().__init__(
            f"connection {connection_id} has been reopened since incarnation "
            f"{presented} and is now at {current}; another client holds it, so "
            "this room request was refused and no room was claimed or released"
        )
        self.connection_id = connection_id
        self.presented = presented
        self.current = current


class UnfencedControlError(ConnectionError_):
    """A room request carrying no incarnation, from a holder that sends one.

    Accepting silence is only honest for a client too old to have an
    incarnation to send. A client speaking the fenced revision has one by the
    first frame of its stream, so an unfenced request from it is either one sent
    before that frame arrived or one that withheld it — and the first is exactly
    the window a displaced client's repoint would slip through, claiming nothing
    and so being checked against nothing.
    """

    code = "unfenced"

    def __init__(self, connection_id: str, *, speaks: int) -> None:
        super().__init__(
            f"connection {connection_id} is held by a client speaking "
            f"agent-protocol {speaks}, which names the connection incarnation on "
            "every room request; this one named none, so it could not be fenced "
            "and no room was claimed or released — wait for the first frame of "
            "the stream and send the incarnation it gives you"
        )
        self.connection_id = connection_id
        self.speaks = speaks


class UnfencedBeatError(ConnectionError_):
    """A tick carrying no incarnation, from a client whose holder sends one."""

    code = "unfenced"

    def __init__(self, connection_id: str, *, speaks: int) -> None:
        super().__init__(
            f"connection {connection_id} is held by a client speaking "
            f"agent-protocol {speaks}, which carries the connection incarnation "
            "on every heartbeat; this tick carried none, so it could not be "
            "fenced and was refused — reopen the stream and beat with the "
            "incarnation its first frame gives you"
        )
        self.connection_id = connection_id
        self.speaks = speaks


CloseCode = Literal["taken_over", "heartbeat_lapsed", "closed"]


@dataclass(frozen=True, slots=True)
class Closure:
    """Why a connection ended, in a form both sides can act on.

    The prose alone was not enough. Three producers phrased the same three
    endings six different ways, and the clients that had to tell a recoverable
    ending from a fatal one did it by comparing those strings — so one of them
    matched the short heartbeat-lapse wording, missed the long one, and killed
    a watcher that only needed to reconnect. `code` is the part that is
    promised and compared; `message` is for a human reading a log and may be
    reworded freely.

    `room_id` names the room the ending was about, and is null when it was not
    about one. A client that loses a connection over a room it declared cannot
    otherwise tell which room, and so cannot stop declaring it.
    """

    code: CloseCode
    message: str
    room_id: str | None


#: The connection's client stopped ticking. Recoverable: reopen and resume.
HEARTBEAT_LAPSED = Closure(
    code="heartbeat_lapsed",
    message="heartbeat lapsed; reopen the stream and resume from your cursor",
    room_id=None,
)

#: Another stream attached to this id. Terminal for the displaced client:
#: reopening is itself a takeover, so retrying is how two clients trade the
#: connection back and forth forever.
TAKEN_OVER = Closure(
    code="taken_over",
    message="another stream attached to this connection and took it over",
    room_id=None,
)


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


@dataclass(frozen=True)
class ClientDeclaration:
    """What a client said about itself when it opened a connection (CHOO-1865).

    Every field is optional, because a client built before this existed says
    nothing at all. That has to record as *unknown* rather than as a default:
    a default is indistinguishable from an answer, and the whole point is to
    know which clients we cannot account for.

    `speaks` and `accepts` are the client's `agent-protocol` range. `artifact`
    and `version` say which released thing is connecting and where it is —
    they are reported, never judged, since a semver says nothing about
    compatibility.
    """

    speaks: int | None = None
    accepts: int | None = None
    artifact: str | None = None
    version: str | None = None

    @property
    def declares_protocol(self) -> bool:
        return self.speaks is not None

    @property
    def protocol_floor(self) -> int | None:
        """The oldest revision the client handles.

        A client that sends only `speaks` is declaring a single revision, so
        its floor is that same number — which is exactly how the original
        exact-match check behaved.
        """
        if self.speaks is None:
            return None
        return self.accepts if self.accepts is not None else self.speaks

    def as_dict(self) -> dict[str, object]:
        """The declaration as recorded and reported. Absent stays null."""
        return {
            "speaks": self.speaks,
            "accepts": self.protocol_floor,
            "artifact": self.artifact,
            "version": self.version,
        }


class ProtocolVersionError(ConnectionError_):
    """A client's declared agent-protocol range cannot meet this server's.

    Carries both ranges, and names which side is behind. A refusal that only
    says "no" leaves the user guessing which thing to update, and guessing
    wrong means downgrading the peer that was already right.
    """

    def __init__(self, *, client_speaks: int, client_accepts: int) -> None:
        remedy = (
            "update the Switch agent runtime"
            if client_speaks < PROTOCOL_ACCEPTS
            else "update switch-core"
        )
        super().__init__(
            f"this client speaks agent-protocol {client_accepts}-{client_speaks} "
            f"and the server speaks {PROTOCOL_ACCEPTS}-{PROTOCOL_VERSION}; the "
            f"ranges do not overlap, so {remedy}"
        )
        self.client_speaks = client_speaks
        self.client_accepts = client_accepts
        self.server_speaks = PROTOCOL_VERSION
        self.server_accepts = PROTOCOL_ACCEPTS
        self.remedy = remedy


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
    # Which incarnation of this connection the attached stream is. Taken from
    # the registry's sequence on every attach, so a superseded stream can
    # notice it has been replaced and stop writing, and so a client can name
    # the incarnation it holds and be refused if it has moved on. Never derived
    # from the connection's own history: an id can be closed and opened again,
    # and a per-connection counter would restart and make the new incarnation
    # indistinguishable from the old one to a client holding a stale number.
    stream_generation: int = 0
    closure: Closure | None = None
    # What the client said about itself on connect (CHOO-1865). Defaults to an
    # empty declaration, which means unknown — never "current".
    declaration: ClientDeclaration = field(default_factory=lambda: ClientDeclaration())
    wake: asyncio.Event = field(default_factory=asyncio.Event)

    def is_alive(self, now: float) -> bool:
        return self.closure is None and (now - self.last_beat) < HEARTBEAT_TTL_SECONDS


class ConnectionRegistry:
    """The live set of agent connections. Authoritative, in memory."""

    def __init__(self) -> None:
        # Called with every Connection this registry closes, whoever closed it.
        # A callback rather than a report at each call site: `close` is reached
        # from five places — the sweep, the stale-connection check, the stream,
        # and two room-claim failures — and a sixth added later would silently
        # report nothing. The registry stays unaware of what the callback does.
        self._on_close: Callable[[Connection], None] = lambda conn: None
        self._by_id: dict[str, Connection] = {}
        self._by_agent: dict[str, set[str]] = {}
        # Incarnations are drawn from here, never from the connection, so a
        # number is never handed out twice in one process — including to a
        # connection id that was closed and opened again. The seed is random so
        # that a number does not mean something different after a restart: a
        # client holding one from a previous boot is refused rather than
        # matching whatever this boot has reached.
        self._next_incarnation = secrets.randbits(32)

    def _new_incarnation(self) -> int:
        """The next never-before-used incarnation number.

        Monotonic so it is readable in a log and orderable in a comparison, and
        registry-wide rather than per-connection so that closing an id and
        opening it again cannot reissue a number a departed client still holds.
        """
        incarnation = self._next_incarnation
        self._next_incarnation += 1
        return incarnation

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
        declaration: ClientDeclaration,
        expected_generation: int | None,
    ) -> Connection:
        """Open a connection, or reattach to one the client already owns.

        The client chooses the id, which makes opening idempotent: a timed-out
        request can be retried without leaving an orphan behind. Reopening a
        live id takes it over — "the same client returning" and "the same
        client duplicated" are indistinguishable, and takeover is right for
        both.

        `expected_generation` is what makes that takeover deliberate. A client
        reattaching names the incarnation it believes it still holds, and is
        refused without mutation if the connection has moved past it. The
        heartbeat fence alone cannot cover this: the loser of a takeover may
        never receive its eviction or its refused tick — a partition drops
        both — and would then reopen and take the connection straight back off
        the winner, which is the reversal the fence exists to prevent. `None`
        means no claim is being made, which is a first open, a deliberate
        takeover, or a client built before the check, and keeps the
        unconditional attach all three have always had.

        A client that declares an `agent-protocol` range with no overlap is
        refused. A client that declares nothing is recorded as unknown and
        connects: unknown is not incompatible, and refusing on silence would
        lock out every client built before it could speak up.
        """
        floor = declaration.protocol_floor
        if declaration.speaks is not None and floor is not None:
            overlaps = (
                floor <= PROTOCOL_VERSION and PROTOCOL_ACCEPTS <= declaration.speaks
            )
            if not overlaps:
                raise ProtocolVersionError(
                    client_speaks=declaration.speaks, client_accepts=floor
                )

        existing = self._by_id.get(connection_id)
        if existing is not None:
            if existing.agent_id != agent_id:
                # Never let one agent attach to another's connection.
                raise UnknownConnectionError(connection_id)
            if (
                expected_generation is not None
                and expected_generation != existing.stream_generation
            ):
                # Nothing above this line has changed the connection, and
                # nothing below it runs. The holder is undisturbed.
                raise SupersededReattachError(
                    connection_id,
                    presented=expected_generation,
                    current=existing.stream_generation,
                )
            existing.scope = scope
            existing.delivery_filter = delivery_filter
            existing.spawn_capable = spawn_capable
            existing.cursor = cursor
            existing.last_beat = time.monotonic()
            existing.closure = None
            existing.stream_attached = True
            existing.stream_generation = self._new_incarnation()
            # A reattach can come from an upgraded client, so the declaration
            # is replaced rather than kept. The connection outlives the socket;
            # what is on the other end of it need not.
            existing.declaration = declaration
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
            stream_generation=self._new_incarnation(),
            declaration=declaration,
        )
        self._by_id[connection_id] = conn
        owned.add(connection_id)
        logger.info(
            "[CONN] opened agent=%s connection=%s scope=%s filter=%s spawn=%s "
            "client=%s version=%s protocol=%s",
            agent_id,
            connection_id,
            scope,
            delivery_filter,
            spawn_capable,
            declaration.artifact or "unknown",
            declaration.version or "unknown",
            f"{floor}-{declaration.speaks}"
            if declaration.declares_protocol
            else "unknown",
        )
        return conn

    def detach_stream(self, conn: Connection, generation: int) -> None:
        """Mark the stream gone while leaving the connection alive.

        Only the generation that is currently attached may detach: a superseded
        stream unwinding must not clear the flag its replacement just set.
        """
        if self._by_id.get(conn.id) is conn and conn.stream_generation == generation:
            conn.stream_attached = False
            logger.info(
                "[CONN] stream detached agent=%s connection=%s (connection still "
                "alive until heartbeat lapses)",
                conn.agent_id,
                conn.id,
            )

    def set_close_listener(self, listener: Callable[[Connection], None]) -> None:
        """Observe every connection this registry closes.

        One listener, set once at wiring time. It must not raise — a bad
        observer cannot be allowed to leave a connection half-closed — and it
        is called after the registry's own bookkeeping, so what it sees is the
        closed state rather than a connection mid-teardown.
        """
        self._on_close = listener

    def close(self, connection_id: str, closure: Closure) -> Connection | None:
        conn = self._by_id.pop(connection_id, None)
        if conn is None:
            return None
        owned = self._by_agent.get(conn.agent_id)
        if owned:
            owned.discard(connection_id)
            if not owned:
                self._by_agent.pop(conn.agent_id, None)
        conn.closure = closure
        conn.stream_attached = False
        conn.wake.set()
        # `beats` and the age separate the two ways a connection dies, which
        # otherwise look identical in the log: a client that never beat at all
        # (beats=0 — it is not running the heartbeat, or cannot reach us) versus
        # one that beat and then stopped (beats>0 — it went away, or the server
        # was too busy to process ticks).
        logger.info(
            "[CONN] closed agent=%s connection=%s code=%s room=%s reason=%s "
            "beats=%d last_beat_age=%.1fs",
            conn.agent_id,
            connection_id,
            closure.code,
            closure.room_id or "-",
            closure.message,
            conn.beats,
            time.monotonic() - conn.last_beat,
        )
        # After the bookkeeping and the log, so an observer sees the closed
        # state. Guarded because the registry's own contract — the connection
        # is closed and the caller gets it back — must not depend on whoever
        # is watching.
        try:
            self._on_close(conn)
        except Exception:
            logger.warning(
                "A close listener raised for connection %s; the connection is "
                "closed regardless.",
                connection_id,
                exc_info=True,
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
            gone = self.close(conn.id, HEARTBEAT_LAPSED)
            if gone is not None:
                closed.append(gone)
        if closed:
            # A gauge of live connections cannot show churn: agents
            # reconnecting as fast as they expire hold it perfectly flat.
            metrics().increment(AGENT_CONNECTIONS_EXPIRED, {}, float(len(closed)))
        return closed

    # ------------------------------------------------------------------
    # Liveness
    # ------------------------------------------------------------------

    def beat(
        self,
        agent_id: str,
        connection_id: str,
        cursor: int,
        generation: int | None,
    ) -> Connection:
        """Record a client tick and its cursor.

        Rejects a tick for a connection with no stream: the client is alive but
        receiving nothing, and must be told to reopen rather than left believing
        it is connected.

        `generation` fences the tick against the incarnation the client is
        actually attached to. Sharing an id is what makes takeover work, and it
        is also what makes a displaced client's tick indistinguishable from the
        winner's — same id, same token. Unfenced, the loser keeps the
        connection alive on the winner's behalf and, because a higher cursor is
        adopted, drags the winner past events it was never sent. Nothing is
        mutated before the check, so a refused tick costs the winner nothing.

        `None` is a tick that cannot be fenced, and it is accepted only from a
        connection whose holder is a client built before the fence existed.
        That client is unknown rather than current, and accepting it is the
        honest answer until the protocol floor rises past it. Once the holder
        has declared a revision that carries the incarnation, a tick without
        one is refused: that client is told its incarnation on the first frame
        of its stream, so an unfenced tick is either one that never received a
        frame or one that withheld it, and neither may keep the holder's
        connection alive. Both answers follow from the declaration on the
        connection, so who cannot be fenced stays answerable.
        """
        conn = self.require(agent_id, connection_id)
        if generation is None:
            speaks = self._fenced_holder(conn)
            if speaks is not None:
                raise UnfencedBeatError(connection_id, speaks=speaks)
        elif generation != conn.stream_generation:
            raise SupersededConnectionError(
                connection_id, presented=generation, current=conn.stream_generation
            )
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
            self.close(connection_id, HEARTBEAT_LAPSED)
            raise UnknownConnectionError(connection_id)
        return conn

    def require_current(
        self, agent_id: str, connection_id: str, *, generation: int | None
    ) -> Connection:
        """Resolve a connection the caller must still be the client on.

        `require` answers "does this connection exist", which is the wrong
        question for anything that mutates it: a connection id is stable across
        a takeover, so a displaced client still resolves the connection that was
        taken from it and would go on changing the winner's state. Naming the
        incarnation turns the lookup into a claim, refused if it has moved on.

        `None` makes no claim, and is read the same way an unfenced tick is:
        accepted from a holder too old to have an incarnation to send, refused
        once the holder speaks a revision that carries one. Claiming nothing
        would otherwise be the way past the claim — a displaced client that
        never saw its first frame has no incarnation to name, and that is
        precisely when its repoint would reach the winner's rooms.

        Callers must use this before touching the connection, and before any
        other check, so a refusal costs the holder nothing.
        """
        conn = self.require(agent_id, connection_id)
        if generation is None:
            speaks = self._fenced_holder(conn)
            if speaks is not None:
                raise UnfencedControlError(connection_id, speaks=speaks)
        elif generation != conn.stream_generation:
            raise SupersededControlError(
                connection_id, presented=generation, current=conn.stream_generation
            )
        return conn

    @staticmethod
    def _fenced_holder(conn: Connection) -> int | None:
        """The holder's revision, when it is one that carries the incarnation.

        The declaration on the connection is the holder's, not the caller's, so
        this answers "should this connection's client have named an
        incarnation" — which is the question, since the caller may not be that
        client at all.
        """
        speaks = conn.declaration.speaks
        if speaks is not None and speaks >= FENCED_PROTOCOL_REVISION:
            return speaks
        return None

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

        At most one connection per agent may act in a room, which is what the
        eviction below enforces. "One room at a time" is *not* enforced here:
        it is a property of a session, and a connection may carry several
        sessions working in different rooms, so a connection's rooms are the
        union of its sessions'. Whoever moves a session out of a room calls
        `release_room` for it — see `connect_to_room`, which does both.

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

        conn.rooms.add(room_id)
        conn.wake.set()
        return evicted

    def release_room(self, conn: Connection, room_id: str) -> None:
        conn.rooms.discard(room_id)
        conn.wake.set()

    def release_room_everywhere(self, agent_id: str, room_id: str) -> None:
        """Take the room off every one of this agent's connections.

        A claim outlives the membership it was checked against:
        `require_room_member` runs when the room is claimed and never again.

        Every connection, not only the live ones — a lapsed connection still
        holds its claim, and a client reconnecting to it resumes covering the
        room.
        """
        for cid in self._by_agent.get(agent_id, set()):
            conn = self._by_id.get(cid)
            if conn is not None and room_id in conn.rooms:
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

    def live_connection_count(self) -> int:
        """How many connections are open right now.

        Distinct from `live_agent_ids`, which answers how many *agents* hold
        one: an agent may hold several (the cap is
        `MAX_CONNECTIONS_PER_AGENT`), so ten people running two windows each
        against one agent is twenty connections and one agent. Telemetry
        reports sessions, and a session is a connection.
        """
        now = time.monotonic()
        return sum(1 for conn in self._by_id.values() if conn.is_alive(now))

    def live_agent_ids(self) -> set[str]:
        """Every agent with at least one live connection."""
        now = time.monotonic()
        return {conn.agent_id for conn in self._by_id.values() if conn.is_alive(now)}

    def live_connection_ids(self) -> set[str]:
        """Every connection currently alive, by id.

        Passed to the role-lease predicates: a seat taken over a connection is
        held for as long as that connection is, so a client that has stopped
        sending `/leases/renew` because it moved to the single heartbeat does
        not silently lose it. The connection, not the agent — an agent's other
        connections say nothing about a seat this one took.
        """
        now = time.monotonic()
        return {conn.id for conn in self._by_id.values() if conn.is_alive(now)}

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
