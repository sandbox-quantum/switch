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

A connection lives in the memory of the process holding its socket: the
socket, its heartbeat and the frames it is owed cannot be anywhere else. What
the other switch-core processes need to know about it is recorded as rows
(`connection_rows.py`), on transitions only and never per heartbeat, and each
process keeps a copy of every other process's live connections here, so the
presence readers below answer for every process without a query. A copy is
an `AgentConnection` whose `held_by` names the process holding it. Rows count
only while the holding process's lease is held, so a connection never
outlives its process, which is what keeping connections in memory alone used
to guarantee.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections.abc import AsyncIterator, Callable, Iterable, Iterator
from contextlib import (
    AbstractAsyncContextManager,
    asynccontextmanager,
    contextmanager,
    nullcontext,
)
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, cast

from switch_core.artifacts import ARTIFACT_VERSIONS, contract_range
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.bridges.agent.protocol.liveness import (
    HEARTBEAT_INTERVAL_SECONDS as HEARTBEAT_INTERVAL_SECONDS,
)
from switch_core.bridges.agent.protocol.liveness import (
    HEARTBEAT_LAPSED as HEARTBEAT_LAPSED,
)
from switch_core.bridges.agent.protocol.liveness import (
    HEARTBEAT_TTL_SECONDS as HEARTBEAT_TTL_SECONDS,
)
from switch_core.bridges.agent.protocol.liveness import TAKEN_OVER as TAKEN_OVER
from switch_core.bridges.agent.protocol.liveness import CloseCode as CloseCode
from switch_core.bridges.agent.protocol.liveness import Closure as Closure
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS, Position
from switch_core.db.stores.agent_connection_store import AgentSlotRows, ConnectionRow
from switch_core.logging_context import log_context
from switch_core.observability.catalogue import (
    AGENT_CONNECTIONS_EXPIRED,
    AGENT_CONNECTIONS_OPENED,
)
from switch_core.observability.metrics import metrics

logger = logging.getLogger(__name__)

Scope = Literal["single", "all"]
DeliveryFilter = Literal["all", "addressed"]
# How a connection's stream reaches its client. `sse` is the event stream an
# agent runtime built before the WebSocket still asks for, served for a
# compatibility window and counted apart so we can see those clients drain.
Transport = Literal["websocket", "sse"]

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

# The revision from which a client understands the `approval_outcome` frame. It
# is withheld from anything older: those clients route unrecognised frames to
# their room-event path, and a frame without a `type` breaks it.
APPROVAL_OUTCOME_PROTOCOL_REVISION = 4

# The revision from which a client takes a `session_command` frame: a command
# for one of the agent's sessions, relayed from Switch Console.
SESSION_COMMAND_PROTOCOL_REVISION = 5

# The revision from which a client takes a `room_released` frame: a room claim
# or session placement on its connection was taken over by another connection.
ROOM_RELEASED_PROTOCOL_REVISION = 6

# From this agent-protocol revision a client tracks a position (one number per
# source, see `positions.py`) instead of a single number. It opens with
# `start_at` and reads `position` from each event. A client on an older
# revision is sent a single number.
POSITIONS_PROTOCOL_REVISION = 9

# Upper bound on simultaneous connections per agent. Runaway growth becomes a
# visible error instead of quiet resource creep.
MAX_CONNECTIONS_PER_AGENT = 32

# The longest connection id or session id a client may choose; clients use
# UUIDs, which are 36. Both travel in the signals switch-core processes send
# each other (`connection_rows.py`), and Postgres refuses one of 8000 bytes or
# more, so an id with no bound could make a signal that cannot be sent.
MAX_ID_LENGTH = 64


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
            "where you got to"
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
            "this heartbeat was refused"
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


# How many closed connection ids are remembered for the reconnect counter.
# Far more than the live fleet, so a lapse storm is still recognised when its
# agents come back.
_RECENTLY_CLOSED_LIMIT = 10_000


@dataclass(frozen=True, slots=True)
class Released:
    """A room another connection lost to a placement, and its session there."""

    connection_id: str
    room_id: str
    session_id: str | None


def evicted_session_warning(room_id: str, evicted: str) -> str:
    """What to tell a caller that took a room off another live session.

    One wording for every door that can evict, so a client does not have to
    recognise the same event phrased two ways. Reported rather than logged
    quietly: an unannounced takeover looks identical to the duplicate-session
    bug it resolves — a session stops receiving a room and nothing says why.

    `evicted` names what was put out, as the caller can best identify it: the
    session where one is known, and otherwise the connection its events were
    travelling over.
    """
    return (
        f"You evicted another session of this agent from room {room_id} "
        f"({evicted}). Only one session of an agent may act in a room, so that "
        "session has been disconnected from it and will stop receiving its "
        "events. If that session was doing work here, it no longer is."
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


def client_label(declaration: ClientDeclaration) -> str:
    """The declared artifact as a metric value: a registered name, or a bucket.

    The client says what it is, so only names in the artifact registry pass
    through. The declared version is never a label: it is the client's own
    string and unbounded, and stays in the `[CONN] opened` log line instead.
    """
    if not declaration.artifact:
        return "unknown"
    if declaration.artifact in ARTIFACT_VERSIONS:
        return declaration.artifact
    return "other"


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
class AgentConnection:
    id: str
    agent_id: str
    scope: Scope
    delivery_filter: DeliveryFilter
    spawn_capable: bool
    # How far the server has sent events to this connection, as a position
    # (`positions.py`). It holds the agent's own events (`agent_events`) and,
    # for a connection that receives every room message, each room it covers.
    position: Position
    last_beat: float
    opened_at: float
    # Rooms this connection has subscribed to. A `single` connection holds at
    # most one; an `all` connection leaves this empty and covers every room the
    # agent belongs to that no sibling has claimed.
    rooms: set[str] = field(default_factory=set)
    stream_attached: bool = False
    # What the attached stream travels over, as of the last attach.
    stream_transport: Transport = "websocket"
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
    # Commands relayed to this connection and not yet written to its stream.
    session_commands: list[dict[str, Any]] = field(default_factory=list)
    # Rooms another connection took off this one, not yet written to its
    # stream, with the session of this connection that was placed there.
    released_rooms: dict[str, str | None] = field(default_factory=dict)
    # The ticket last sent to this connection's client. Only a client that
    # receives every room message but holds a single number is sent tickets. A
    # ticket is the id of a row in `agent_position_tickets` that stores a full
    # position, so the client can resume from it by sending back one number.
    ticket: int = 0
    # True when the client asked to resume from a ticket the server does not
    # have, because it expired or never existed. The stream then opens with a
    # gap frame, and `resume_requested` holds the number the client sent so the
    # gap can report it.
    resume_lost: bool = False
    resume_requested: int = 0
    # The switch-core process holding this connection, when it is another
    # one: this is then a copy of that process's row, kept so presence, room
    # claims and fences read the same here as there. A copy has no socket and
    # no heartbeat of its own; it is live for as long as the row is, and is
    # replaced whenever the row is read again.
    held_by: str | None = None
    # The tenant the connection's row is recorded in. Set once the row is
    # written or read; None on a registry that records nothing.
    tenant_id: str | None = None

    def is_alive(self, now: float) -> bool:
        if self.held_by is not None:
            return self.closure is None
        return self.closure is None and (now - self.last_beat) < HEARTBEAT_TTL_SECONDS

    @property
    def reads_conversation(self) -> bool:
        """Whether this connection asked for every room message (`filter=all`),
        read from `messages`, as well as the agent's own events."""
        return self.delivery_filter == "all"

    @property
    def speaks_positions(self) -> bool:
        """Whether the client is on agent-protocol revision 9 or later, and so
        sends and receives positions instead of a single number."""
        speaks = self.declaration.speaks
        return speaks is not None and speaks >= POSITIONS_PROTOCOL_REVISION

    @property
    def cursor(self) -> int:
        """The single number sent in `cursor` fields, for clients that predate
        positions.

        A client that receives every room message and does not speak positions
        is given the ticket last sent to it, because one number cannot hold its
        place in several rooms. Every other client is given its place in the
        agent's own events, the `s` entry of its position.
        """
        if self.reads_conversation and not self.speaks_positions:
            return self.ticket
        return self.position.get(OWN_EVENTS, 0)


# The `(transport, client)` an agent run by an agents controller counts under:
# it travels on its controller's connection, whatever that connection uses.
CONTROLLER_LABEL = ("controller", "agents-controller")


def connection_transport(conn: AgentConnection) -> str:
    """`websocket` or `sse` while a stream is attached, by what it travels over;
    `detached` while it has dropped and the connection waits out its heartbeat
    window for a reconnect."""
    return conn.stream_transport if conn.stream_attached else "detached"


#: How a deleted agent's connections end, in whichever process holds them. A
#: client that reopens is refused: its key names no agent any more.
AGENT_DELETED = Closure(code="closed", message="the agent was deleted", room_id=None)

#: How an agent's connections end when its key is re-issued, as handing the
#: agent to a new owner does. Its connections authenticated with the old key
#: once, when they opened, so they would otherwise outlive it. A client that
#: reopens with the old key is refused.
KEY_REISSUED = Closure(
    code="closed",
    message="the agent's key was re-issued; reconnect with the new key",
    room_id=None,
)

#: Why an agent's connections were ended by deleting their rows, by the name a
#: signal carries to the other processes (`connection_rows.py`).
ENDINGS: dict[str, Closure] = {"deleted": AGENT_DELETED, "key_reissued": KEY_REISSUED}


class ConnectionRows(Protocol):
    """Where a registry records its connections, so that every switch-core
    process sees them (`connection_rows.SharedConnections`).

    A registry without one records nothing and sees only its own process,
    which is all a single process needs.
    """

    def next_incarnation(self) -> int:
        """An incarnation no process has handed out, from the shared
        sequence."""
        ...

    def recorded(self, agent_id: str) -> AbstractAsyncContextManager[None]:
        """Make the agent's slot moves in the block on what every process has
        recorded, and record them."""
        ...

    async def refresh(self, agent_id: str) -> None:
        """Read the agent's connections again from the rows."""
        ...

    async def agent_ended(self, agent_id: str, ending: str) -> None:
        """The agent's rows were deleted, with the agent or on its own
        (`ENDINGS` names why): end what this process holds of it, and have
        every other process read its rows again."""
        ...

    def closed(self, conn: AgentConnection) -> None:
        """A connection held here closed. Must not block."""
        ...

    def forward_beat(self, conn: AgentConnection, generation: int | None) -> None:
        """A beat for a connection another process holds. Must not block."""
        ...

    def relay_session_command(
        self, tenant_id: str, agent_id: str, process_id: str, frame: dict[str, Any]
    ) -> None:
        """A session command for a stream another process holds. Must not
        block."""
        ...

    def relay_warm(self, agent_id: str, process_id: str, room_id: str) -> None:
        """A warm for a controller whose stream another process holds. Must
        not block."""
        ...


class AgentConnectionRegistry:
    """The live set of agent connections: those this process holds,
    authoritative, and a copy of every other process's (`held_by`)."""

    def __init__(self) -> None:
        # Called with every AgentConnection this registry closes, whoever closed it.
        # A callback rather than a report at each call site: `close` is reached
        # from five places — the sweep, the stale-connection check, the stream,
        # and two room-claim failures — and a sixth added later would silently
        # report nothing. The registry stays unaware of what the callback does.
        self._on_close: Callable[[AgentConnection], None] = lambda conn: None
        # Called with the id of an agent whose connections another process
        # ended (`set_ended_elsewhere_listener`).
        self._on_ended_elsewhere: Callable[[str], None] = lambda agent_id: None
        self._by_id: dict[str, AgentConnection] = {}
        self._by_agent: dict[str, set[str]] = {}
        self._slot_locks: dict[str, tuple[asyncio.Lock, int]] = {}
        # Incarnations are drawn from here, never from the connection, so a
        # number is never handed out twice in one process — including to a
        # connection id that was closed and opened again. The seed is random so
        # that a number does not mean something different after a restart: a
        # client holding one from a previous boot is refused rather than
        # matching whatever this boot has reached.
        self._next_incarnation = secrets.randbits(32)
        # Which room each session of an agent is working in, as its own
        # `connect_to_room` said. Sessions share their agent's connection, so
        # the connection's rooms cannot say whose is whose. Memory only: the
        # session's host keeps everything else about it, and a session whose
        # placement a restart forgot is told to connect again.
        self._session_rooms: dict[str, dict[str, str]] = {}
        # Who placed each of those sessions: the connection id or MCP transport
        # session the placement arrived on. A connection's placements are
        # replaced wholesale, and a placement another connection takes is
        # reported to the one that lost it.
        self._placement_owners: dict[str, dict[str, str]] = {}
        # Agents run by an agents controller hold no connection here: their
        # presence is their controller's. Every presence question below asks
        # it first for those agents, and this registry for the rest.
        self.controllers = ControllerPresence(on_bound=self._close_for_controller)
        # Why each recently closed connection id closed, so its next open can
        # be counted as a return after a lapse rather than a first connect.
        # Insertion-ordered and capped: only the counter reads it.
        self._recently_closed: dict[str, str] = {}
        # Where connections are recorded for the other processes, once wired.
        self._rows: ConnectionRows | None = None
        # The rooms taken off other connections while a recorded move runs,
        # so the processes holding them can be told (`collect_released`).
        self._released: list[Released] | None = None
        # The tenant each agent's connections are recorded in, as last read
        # or written, so a pass over one tenant's rows can find the agents it
        # no longer names.
        self._agent_tenants: dict[str, str] = {}

    def use_rows(self, rows: ConnectionRows) -> None:
        """Record connections for every process, and see theirs."""
        self._rows = rows

    def _new_incarnation(self) -> int:
        """The next never-before-used incarnation number.

        Registry-wide rather than per-connection so that closing an id and
        opening it again cannot reissue a number a departed client still
        holds. With rows wired it comes from the shared sequence, so no two
        processes hand out the same number and any of them can check a fence.
        """
        if self._rows is not None:
            return self._rows.next_incarnation()
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
        position: Position,
        declaration: ClientDeclaration,
        expected_generation: int | None,
        transport: Transport = "websocket",
    ) -> AgentConnection:
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
            moved_from = existing.held_by
            existing.held_by = None
            existing.scope = scope
            existing.delivery_filter = delivery_filter
            existing.spawn_capable = spawn_capable
            existing.position = dict(position)
            existing.ticket = 0
            existing.last_beat = time.monotonic()
            existing.closure = None
            existing.stream_attached = True
            existing.stream_transport = transport
            existing.stream_generation = self._new_incarnation()
            # Wake the stream this one replaces, so its client hears it was
            # taken over now rather than on the stream's next idle tick.
            existing.wake.set()
            # A reattach can come from an upgraded client, so the declaration
            # is replaced rather than kept. The connection outlives the socket;
            # what is on the other end of it need not.
            existing.declaration = declaration
            metrics().increment(AGENT_CONNECTIONS_OPENED, {"kind": "reattach"})
            logger.info(
                "[CONN] reattached agent=%s connection=%s scope=%s generation=%s "
                "transport=%s%s",
                agent_id,
                connection_id,
                scope,
                existing.stream_generation,
                transport,
                f" from process={moved_from}" if moved_from is not None else "",
            )
            return existing

        owned = self._by_agent.setdefault(agent_id, set())
        if len(owned) >= MAX_CONNECTIONS_PER_AGENT:
            raise TooManyConnectionsError(agent_id, MAX_CONNECTIONS_PER_AGENT)

        now = time.monotonic()
        conn = AgentConnection(
            id=connection_id,
            agent_id=agent_id,
            scope=scope,
            delivery_filter=delivery_filter,
            spawn_capable=spawn_capable,
            position=dict(position),
            last_beat=now,
            opened_at=now,
            stream_attached=True,
            stream_transport=transport,
            stream_generation=self._new_incarnation(),
            declaration=declaration,
        )
        self._by_id[connection_id] = conn
        owned.add(connection_id)
        metrics().increment(
            AGENT_CONNECTIONS_OPENED,
            {"kind": self._recently_closed.pop(connection_id, "fresh")},
        )
        logger.info(
            "[CONN] opened agent=%s connection=%s scope=%s filter=%s spawn=%s "
            "client=%s version=%s protocol=%s transport=%s",
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
            transport,
        )
        return conn

    def detach_stream(self, conn: AgentConnection, generation: int) -> None:
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

    def set_close_listener(self, listener: Callable[[AgentConnection], None]) -> None:
        """Observe every connection this registry closes.

        One listener, set once at wiring time. It must not raise — a bad
        observer cannot be allowed to leave a connection half-closed — and it
        is called after the registry's own bookkeeping, so what it sees is the
        closed state rather than a connection mid-teardown.
        """
        self._on_close = listener

    def set_ended_elsewhere_listener(self, listener: Callable[[str], None]) -> None:
        """Register a callback for an agent whose connections another process
        ended, called as soon as this process is told, before it reads the
        agent's rows. The wiring drops the agent's cached keys with it, so a
        client of an agent whose key was re-issued cannot reopen here on a key
        this process still remembers. One listener, set once at wiring time;
        it must not raise."""
        self._on_ended_elsewhere = listener

    def ended_elsewhere(self, agent_id: str) -> None:
        """Another process ended this agent's connections (`connection_rows.py`)."""
        self._on_ended_elsewhere(agent_id)

    def _forget(self, connection_id: str) -> AgentConnection | None:
        conn = self._by_id.pop(connection_id, None)
        if conn is None:
            return None
        owned = self._by_agent.get(conn.agent_id)
        if owned:
            owned.discard(connection_id)
            if not owned:
                self._by_agent.pop(conn.agent_id, None)
        return conn

    def close(self, connection_id: str, closure: Closure) -> AgentConnection | None:
        held = self._by_id.get(connection_id)
        if held is not None and held.held_by is not None:
            # Another process holds it, and only that process can close it.
            return None
        conn = self._forget(connection_id)
        if conn is None:
            return None
        conn.closure = closure
        conn.stream_attached = False
        conn.wake.set()
        lapsed = closure is HEARTBEAT_LAPSED
        self._remember_closed(connection_id, "after_lapse" if lapsed else "after_close")
        if lapsed:
            # Counted here rather than in the sweep: a lapse is also noticed
            # when the dead connection is next used (`require`) and by its own
            # event stream, and counting only the sweep under-reported lapses
            # against the reconnects that follow them.
            metrics().increment(AGENT_CONNECTIONS_EXPIRED, {})
        # `beats` and the age separate the two ways a connection dies, which
        # otherwise look identical in the log: a client that never beat at all
        # (beats=0 — it is not running the heartbeat, or cannot reach us) versus
        # one that beat and then stopped (beats>0 — it went away, or the server
        # was too busy to process ticks).
        # `agent_id` as a field, not only in the message: a connection expiring
        # is swept by the registry's own reaper rather than by anything the
        # agent called, so there is no request context for it to inherit — and
        # this is the line somebody goes looking for when one agent will not
        # stay connected.
        with log_context(agent_id=conn.agent_id):
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
        if self._rows is not None:
            self._rows.closed(conn)
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

    def _close_for_controller(self, agent_id: str) -> None:
        """An agent now run by a controller keeps no connection of its own.

        Only the connections held here: every process is told of the binding,
        and each closes its own."""
        for cid in list(self._by_agent.get(agent_id, ())):
            self.close(
                cid,
                Closure(
                    code="closed",
                    message="this agent is now run by an agents controller, which "
                    "receives its events; its own connection is closed",
                    room_id=None,
                ),
            )

    def _remember_closed(self, connection_id: str, kind: str) -> None:
        self._recently_closed.pop(connection_id, None)
        self._recently_closed[connection_id] = kind
        while len(self._recently_closed) > _RECENTLY_CLOSED_LIMIT:
            del self._recently_closed[next(iter(self._recently_closed))]

    def sweep(self) -> list[AgentConnection]:
        """Close connections whose heartbeat has lapsed. Returns those closed."""
        now = time.monotonic()
        stale = [
            conn
            for conn in self._by_id.values()
            if conn.held_by is None and (now - conn.last_beat) >= HEARTBEAT_TTL_SECONDS
        ]
        closed = []
        for conn in stale:
            gone = self.close(conn.id, HEARTBEAT_LAPSED)
            if gone is not None:
                closed.append(gone)
        return closed

    # ------------------------------------------------------------------
    # Liveness
    # ------------------------------------------------------------------

    def beat(
        self,
        agent_id: str,
        connection_id: str,
        generation: int | None,
    ) -> AgentConnection:
        """Record a client tick: the client is still there.

        A tick says nothing about how far the client has read. The connection's
        position is moved only by the stream, as it sends, and a client that
        drops resumes from the position it sends when it reopens.

        Rejects a tick for a connection with no stream: the client is alive but
        receiving nothing, and must be told to reopen rather than left believing
        it is connected.

        `generation` fences the tick against the incarnation the client is
        actually attached to. Sharing an id is what makes takeover work, and it
        is also what makes a displaced client's tick indistinguishable from the
        winner's — same id, same token. Unfenced, the loser keeps the
        connection alive on the winner's behalf, so the winner is never told it
        was dropped. Nothing is mutated before the check, so a refused tick
        costs the winner nothing.

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
        if conn.held_by is not None:
            # An old event-stream client's beat that reached a process other
            # than the one holding its stream. Fenced here on the row, and
            # handed on to the holder, which is the one that counts it.
            if self._rows is not None:
                self._rows.forward_beat(conn, generation)
            return conn
        conn.last_beat = time.monotonic()
        conn.beats += 1
        return conn

    def require(self, agent_id: str, connection_id: str) -> AgentConnection:
        conn = self._by_id.get(connection_id)
        if conn is None or conn.agent_id != agent_id:
            raise UnknownConnectionError(connection_id)
        if not conn.is_alive(time.monotonic()):
            self.close(connection_id, HEARTBEAT_LAPSED)
            raise UnknownConnectionError(connection_id)
        return conn

    def require_current(
        self, agent_id: str, connection_id: str, *, generation: int | None
    ) -> AgentConnection:
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
    def _fenced_holder(conn: AgentConnection) -> int | None:
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

    def get(self, connection_id: str) -> AgentConnection | None:
        return self._by_id.get(connection_id)

    def for_agent(self, agent_id: str) -> list[AgentConnection]:
        now = time.monotonic()
        return [
            conn
            for cid in self._by_agent.get(agent_id, set())
            if (conn := self._by_id.get(cid)) is not None and conn.is_alive(now)
        ]

    def place_session(
        self, agent_id: str, session_id: str, room_id: str, owner: str
    ) -> tuple[set[str], str | None]:
        """Put a session in a room: the rooms it left, and the sibling it displaced.

        One session of an agent per room. A sibling that was working in the
        room is taken out of it, so events for the room go to the session that
        asked for it last. `owner` is the connection id or transport session the
        placement arrived on; a sibling placed by another connection is
        reported to that connection as released.
        """
        placed = self._session_rooms.setdefault(agent_id, {})
        owners = self._placement_owners.setdefault(agent_id, {})
        previous = placed.get(session_id)
        displaced = next(
            (
                other
                for other, room in placed.items()
                if room == room_id and other != session_id
            ),
            None,
        )
        if displaced is not None:
            self._unplace(agent_id, displaced, room_id, taker=owner)
        placed[session_id] = room_id
        owners[session_id] = owner
        return ({previous} - {room_id} if previous else set()), displaced

    def replace_placements(
        self, conn: AgentConnection, placements: dict[str, str]
    ) -> list[Released]:
        """Make `placements` the whole of this connection's session placements.

        Sessions the connection placed before and does not name now are
        unplaced, and the rooms they held are released from the connection.
        Each named room is claimed on the connection with takeover, the rule
        `connect_to_room` follows: a session of another connection placed there
        is unplaced, and that connection is told. Returns what other
        connections lost.

        The rooms must be distinct, since one session of an agent acts in a
        room; membership is the caller's to check.
        """
        rooms = list(placements.values())
        if len(set(rooms)) != len(rooms):
            twice = sorted({room for room in rooms if rooms.count(room) > 1})
            raise ValueError(
                f"placements name room(s) {', '.join(twice)} for more than one "
                "session; one session of an agent acts in a room"
            )
        agent_id = conn.agent_id
        placed = self._session_rooms.setdefault(agent_id, {})
        owners = self._placement_owners.setdefault(agent_id, {})

        mine = [session for session, owner in owners.items() if owner == conn.id]
        previous_rooms = {placed[session] for session in mine if session in placed}
        for session in mine:
            placed.pop(session, None)
            owners.pop(session, None)

        released: list[Released] = []
        for session_id, room_id in placements.items():
            placed.pop(session_id, None)
            owners.pop(session_id, None)
            occupant = next(
                (other for other, room in placed.items() if room == room_id), None
            )
            if occupant is not None:
                lost = self._unplace(agent_id, occupant, room_id, taker=conn.id)
                if lost is not None:
                    released.append(lost)
            placed[session_id] = room_id
            owners[session_id] = conn.id

        for room_id in sorted(set(rooms)):
            evicted = self.claim_room(conn, room_id, takeover=True)
            if evicted is not None and not any(
                r.connection_id == evicted.id and r.room_id == room_id for r in released
            ):
                released.append(
                    Released(connection_id=evicted.id, room_id=room_id, session_id=None)
                )
        for room_id in previous_rooms - set(rooms):
            self.release_room(conn, room_id)
        return released

    def _unplace(
        self, agent_id: str, session_id: str, room_id: str, *, taker: str
    ) -> Released | None:
        """Take a session out of its room on behalf of `taker`.

        Returns the release when the session was placed by a live connection
        other than the taker, which is then told.
        """
        self._session_rooms.get(agent_id, {}).pop(session_id, None)
        owner = self._placement_owners.get(agent_id, {}).pop(session_id, None)
        if owner is None or owner == taker:
            return None
        loser = self._by_id.get(owner)
        if loser is None or loser.agent_id != agent_id:
            return None
        self._notify_released(loser, room_id, session_id)
        return Released(connection_id=loser.id, room_id=room_id, session_id=session_id)

    def _notify_released(
        self, conn: AgentConnection, room_id: str, session_id: str | None
    ) -> None:
        """Queue a `room_released` frame for a client that can take one.

        A room released twice before the stream writes it is reported once,
        naming the session when either release knew it. A connection another
        process holds is told by that process, from what was collected here.
        """
        if self._released is not None:
            self._released.append(
                Released(connection_id=conn.id, room_id=room_id, session_id=session_id)
            )
        if conn.held_by is not None:
            return
        if (conn.declaration.speaks or 0) < ROOM_RELEASED_PROTOCOL_REVISION:
            return
        if session_id is not None or room_id not in conn.released_rooms:
            conn.released_rooms[room_id] = session_id
        conn.wake.set()

    def _placed_by(self, conn: AgentConnection, room_id: str) -> str | None:
        """The session this connection placed in the room, if any."""
        owners = self._placement_owners.get(conn.agent_id, {})
        return next(
            (
                session_id
                for session_id, room in self._session_rooms.get(
                    conn.agent_id, {}
                ).items()
                if room == room_id and owners.get(session_id) == conn.id
            ),
            None,
        )

    def connection_placements(self, conn: AgentConnection) -> dict[str, str]:
        """The sessions this connection placed, and their rooms."""
        owners = self._placement_owners.get(conn.agent_id, {})
        return {
            session_id: room
            for session_id, room in self._session_rooms.get(conn.agent_id, {}).items()
            if owners.get(session_id) == conn.id
        }

    def session_room(self, agent_id: str, session_id: str) -> str | None:
        return self._session_rooms.get(agent_id, {}).get(session_id)

    def placements(self, agent_id: str) -> dict[str, str]:
        """Each of the agent's sessions that connected to a room, and the room."""
        return dict(self._session_rooms.get(agent_id, {}))

    def placed_rooms(self, agent_id: str) -> set[str]:
        return set(self._session_rooms.get(agent_id, {}).values())

    def session_in_room(self, agent_id: str, room_id: str) -> str | None:
        return next(
            (
                session_id
                for session_id, room in self._session_rooms.get(agent_id, {}).items()
                if room == room_id
            ),
            None,
        )

    def relay_session_command(self, agent_id: str, frame: dict[str, Any]) -> bool:
        """Hand a session command to the agent's watcher stream. False if none is attached.

        Not stored anywhere else: a command relayed to nobody is refused to
        whoever sent it, rather than held for a watcher that may not return.
        A controller-backed agent's command goes to its controller's stream.
        A stream another process holds is handed the command through that
        process (`ConnectionRows.relay_session_command`).
        """
        if self.controllers.is_bound(agent_id):
            if self.controllers.relay_session_command(agent_id, frame):
                return True
            holder = self.controllers.process_holding(agent_id)
            binding = self.controllers.binding(agent_id)
            if holder is None or binding is None or self._rows is None:
                return False
            self._rows.relay_session_command(binding.tenant_id, agent_id, holder, frame)
            return True
        watchers = self._watchers(agent_id)
        relayed_to: set[str] = set()
        for conn in watchers:
            if conn.held_by is None:
                self.deliver_session_command(conn, frame)
            elif (
                self._rows is not None
                and conn.tenant_id is not None
                and conn.held_by not in relayed_to
            ):
                relayed_to.add(conn.held_by)
                self._rows.relay_session_command(
                    conn.tenant_id, agent_id, conn.held_by, frame
                )
        return bool(watchers)

    def deliver_relayed(self, agent_id: str, frame: dict[str, Any]) -> bool:
        """A session command another process relayed to the streams held here.
        False when none of them is still here to take it."""
        if self.controllers.is_bound(agent_id):
            return self.controllers.relay_session_command(agent_id, frame)
        delivered = False
        for conn in self._watchers(agent_id):
            if conn.held_by is None:
                self.deliver_session_command(conn, frame)
                delivered = True
        return delivered

    def relay_warm(self, agent_id: str, room_id: str) -> bool:
        """Ask the controller running the agent to start the session a message
        to `room_id` would start. False when no process holds that controller's
        live socket or the agent is stopped. A controller another process
        holds is asked through that process (`ConnectionRows.relay_warm`),
        which hands the warm to its `ControllerPresence.relay_warm`."""
        if self.controllers.relay_warm(agent_id, room_id):
            return True
        holder = self.controllers.process_holding(agent_id)
        if holder is None or self._rows is None:
            return False
        self._rows.relay_warm(agent_id, holder, room_id)
        return True

    def _watchers(self, agent_id: str) -> list[AgentConnection]:
        return [
            conn
            for conn in self.for_agent(agent_id)
            if conn.scope == "all"
            and conn.stream_attached
            and (conn.declaration.speaks or 0) >= SESSION_COMMAND_PROTOCOL_REVISION
        ]

    @staticmethod
    def deliver_session_command(conn: AgentConnection, frame: dict[str, Any]) -> None:
        """Queue a relayed session command on a watcher held here."""
        conn.session_commands.append(frame)
        conn.wake.set()

    # ------------------------------------------------------------------
    # Room slots
    # ------------------------------------------------------------------

    @asynccontextmanager
    async def slots(self, agent_id: str) -> AsyncIterator[None]:
        """Hold this agent's room slots still.

        The registry is in memory and every move through it is synchronous, so
        within one step nothing can change underneath a reader. What needs more
        than that is a decision recorded elsewhere: a reader that writes what a
        connection is serving into the database is suspended at the commit, and
        a claim moving in that window leaves the two disagreeing with no later
        read able to notice. Whoever moves a slot takes this first, so a move is
        ordered either wholly before such a decision or wholly after it.

        Per agent, because that is the scope a room slot is contested in. It
        does not stand in for the database locks: a caller that takes both takes
        this one first, and no holder of a row lock waits here.
        """
        lock, users = self._slot_locks.get(agent_id, (asyncio.Lock(), 0))
        self._slot_locks[agent_id] = (lock, users + 1)
        try:
            async with lock:
                yield
        finally:
            _, remaining = self._slot_locks[agent_id]
            if remaining == 1:
                del self._slot_locks[agent_id]
            else:
                self._slot_locks[agent_id] = (lock, remaining - 1)

    def holds_slots(self, agent_id: str) -> bool:
        """Whether something holds this agent's slots (`slots`) right now."""
        held = self._slot_locks.get(agent_id)
        return held is not None and held[0].locked()

    def recorded(self, agent_id: str) -> AbstractAsyncContextManager[None]:
        """Make the slot moves inside the block on what every process holds.

        Taken inside `slots`, around moves only: the block must not await. On
        entry the agent's connections, claims and placements are read again
        under a lock every process takes, so a fence, a claimant or a cap is
        judged on what is recorded rather than on a copy that may be a moment
        old. On exit what the block changed is written under the same lock,
        and the processes holding the connections it touched are told. A
        registry that records nothing makes this a no-op.
        """
        if self._rows is None:
            return nullcontext()
        return self._rows.recorded(agent_id)

    async def refresh(self, agent_id: str) -> None:
        """Read this agent's connections again from what every process has
        recorded. For a caller that named a connection or a session this
        process has no copy of yet: its row may have been written a moment
        ago by another process."""
        if self._rows is not None:
            await self._rows.refresh(agent_id)

    async def agent_deleted(self, agent_id: str) -> None:
        """End a deleted agent's connections, here and in every other process.

        Deleting the agent deleted its connections' rows. Each process makes
        the agent's connections what the rows now say, which closes those it
        holds (`apply_rows`): this one at once, and the others when told. A
        registry that records nothing closes the connections it holds.
        """
        await self._end_agent(agent_id, "deleted")

    async def agent_key_reissued(self, agent_id: str) -> None:
        """End the connections of an agent whose key was re-issued, here and
        in every other process, as `agent_deleted` does. The caller deleted
        their rows with the old key (`AgentConnectionStore.delete_agent`), so
        each process closes what it holds when it reads them, even one that
        missed being told."""
        await self._end_agent(agent_id, "key_reissued")

    async def _end_agent(self, agent_id: str, ending: str) -> None:
        if self._rows is not None:
            await self._rows.agent_ended(agent_id, ending)
            return
        for cid in list(self._by_agent.get(agent_id, ())):
            self.close(cid, ENDINGS[ending])

    # ------------------------------------------------------------------
    # Keeping the copies of other processes' connections
    # ------------------------------------------------------------------

    def held_here(self, agent_id: str) -> list[AgentConnection]:
        """The agent's connections this process holds, live or lapsed."""
        return [
            conn
            for cid in self._by_agent.get(agent_id, ())
            if (conn := self._by_id.get(cid)) is not None and conn.held_by is None
        ]

    def agents_recorded_in(self, tenant_id: str) -> set[str]:
        """The agents this process keeps anything of from the tenant's rows,
        so a pass over those rows judges each, the ones they no longer name
        included: those `apply_rows` last set from them, and those with a
        connection recorded in the tenant (`tenant_id`), whose row this
        process may have written since."""
        return {
            agent_id
            for agent_id, tenant in self._agent_tenants.items()
            if tenant == tenant_id
        } | {
            conn.agent_id
            for conn in self._by_id.values()
            if conn.tenant_id == tenant_id
        }

    def held_by_processes(self) -> set[str]:
        """Every other process this registry knows to hold an agent's or a
        controller's connection."""
        return {
            conn.held_by for conn in self._by_id.values() if conn.held_by is not None
        } | self.controllers.processes_elsewhere()

    def slot_state(
        self, agent_id: str
    ) -> tuple[dict[str, str], dict[str, tuple[str, str]]]:
        """The agent's claims (room to connection) and placements (session to
        room and the connection that placed it), as they stand here."""
        claims: dict[str, str] = {}
        now = time.monotonic()
        # A live claimant first, so that a room a lapsed connection still
        # holds and a live one has since claimed is recorded as the live
        # one's: at most one connection of an agent may hold a room.
        conns = sorted(
            (
                conn
                for cid in self._by_agent.get(agent_id, ())
                if (conn := self._by_id.get(cid)) is not None
            ),
            key=lambda conn: (not conn.is_alive(now), conn.id),
        )
        for conn in conns:
            for room_id in sorted(conn.rooms):
                if room_id in claims:
                    conn.rooms.discard(room_id)
                else:
                    claims[room_id] = conn.id
        owners = self._placement_owners.get(agent_id, {})
        placements = {
            session_id: (room_id, owners[session_id])
            for session_id, room_id in self._session_rooms.get(agent_id, {}).items()
            if session_id in owners
        }
        return claims, placements

    def incarnations_held_here(self, agent_id: str) -> dict[str, int]:
        return {conn.id: conn.stream_generation for conn in self.held_here(agent_id)}

    @contextmanager
    def collect_released(self) -> Iterator[list[Released]]:
        """Collect every room taken off a connection inside the block."""
        released: list[Released] = []
        self._released = released
        try:
            yield released
        finally:
            self._released = None

    def apply_rows(
        self,
        agent_id: str,
        tenant_id: str,
        rows: AgentSlotRows,
        process_id: str,
        row_gone: Closure,
    ) -> list[AgentConnection]:
        """Make this agent's connections what the rows say.

        A connection held here that another process (or a later incarnation)
        has taken over is closed `taken_over`, so its stream tells its client.
        One whose row was written and is gone is closed too, with `row_gone`:
        deleting the agent deletes its rows, and so does re-issuing its key.
        Copies of other processes' connections are replaced by what is live
        now. Claims and placements are set from the rows, and a connection
        held here whose rooms changed is woken, so its stream reports the
        change and a session waiting for its first room starts reading.
        Returns the connections closed as taken over.

        The rows are never older than what this process holds of the agent
        (`connection_rows.py` reads them under its slots, or leaves an agent
        moved since its read alone), so a connection opened after the read is
        not here to be judged on them.
        """
        self._agent_tenants[agent_id] = tenant_id
        closed: list[AgentConnection] = []
        for conn in self.held_here(agent_id):
            row = rows.connections.get(conn.id)
            if row is None:
                # Recorded once (`tenant_id` is set when its row is written),
                # and the row is gone since.
                if conn.tenant_id is not None:
                    self.close(conn.id, row_gone)
                continue
            if row.closed:
                continue
            if (
                row.process_id != process_id
                or row.incarnation != conn.stream_generation
            ):
                gone = self.close(conn.id, TAKEN_OVER)
                if gone is not None:
                    closed.append(gone)
        for cid in list(self._by_agent.get(agent_id, ())):
            copy = self._by_id.get(cid)
            if copy is not None and copy.held_by is not None:
                self._forget(cid)
        for row in rows.live_connections():
            if row.process_id == process_id or row.id in self._by_id:
                continue
            self._add_copy(row, tenant_id)

        claims = rows.claims()
        for cid in self._by_agent.get(agent_id, ()):
            conn = self._by_id[cid]
            rooms = {room for room, holder in claims.items() if holder == cid}
            if conn.rooms != rooms:
                conn.rooms = rooms
                conn.wake.set()

        placements = rows.placements()
        if placements:
            self._session_rooms[agent_id] = {
                session_id: room_id for session_id, (room_id, _) in placements.items()
            }
            self._placement_owners[agent_id] = {
                session_id: owner for session_id, (_, owner) in placements.items()
            }
        else:
            self._session_rooms.pop(agent_id, None)
            self._placement_owners.pop(agent_id, None)
        if not self._by_agent.get(agent_id) and not placements:
            self._agent_tenants.pop(agent_id, None)
        return closed

    def _add_copy(self, row: ConnectionRow, tenant_id: str) -> None:
        now = time.monotonic()
        copy = AgentConnection(
            id=row.id,
            agent_id=row.agent_id,
            scope=cast(Scope, row.scope),
            delivery_filter=cast(DeliveryFilter, row.delivery_filter),
            spawn_capable=row.spawn_capable,
            position={},
            last_beat=now,
            opened_at=now,
            stream_attached=True,
            stream_transport=cast(Transport, row.transport),
            stream_generation=row.incarnation,
            declaration=ClientDeclaration(speaks=row.speaks, accepts=row.accepts),
            held_by=row.process_id,
            tenant_id=tenant_id,
        )
        self._by_id[row.id] = copy
        self._by_agent.setdefault(row.agent_id, set()).add(row.id)

    def drop_copies_held_by(self, process_ids: set[str]) -> set[str]:
        """Forget the connections these processes held, agents' and
        controllers': their leases lapsed. Returns the agents that lost one."""
        agents: set[str] = set()
        for conn in list(self._by_id.values()):
            if conn.held_by in process_ids:
                self._forget(conn.id)
                agents.add(conn.agent_id)
        for controller_id in self.controllers.forget_processes(process_ids):
            agents |= self.controllers.agents_of(controller_id)
        return agents

    def notify_released(self, released: Iterable[Released]) -> None:
        """Tell the connections held here that another process took a room
        off them."""
        for lost in released:
            conn = self._by_id.get(lost.connection_id)
            if conn is not None and conn.held_by is None:
                self._notify_released(conn, lost.room_id, lost.session_id)

    def claim_room(
        self, conn: AgentConnection, room_id: str, *, takeover: bool = False
    ) -> AgentConnection | None:
        """Subscribe a connection to a room, claiming its slot.

        At most one connection per agent may act in a room, which is what the
        eviction below enforces. "One room at a time" is *not* enforced here:
        it is a property of a session, and a connection may carry several
        sessions working in different rooms, so a connection's rooms are the
        union of its sessions'. Whoever moves a session out of a room calls
        `release_room` for it — see `connect_to_room`, and `connection_subscribe`
        for the door where the caller is the whole connection.

        Returns the connection that was evicted, if any.
        """
        claimant = self.claimant_of(conn.agent_id, room_id)
        evicted: AgentConnection | None = None
        if claimant is not None and claimant.id != conn.id:
            if not takeover:
                raise RoomOccupiedError(room_id, claimant.id)
            claimant.rooms.discard(room_id)
            claimant.wake.set()
            evicted = claimant
            self._notify_released(claimant, room_id, self._placed_by(claimant, room_id))

        conn.released_rooms.pop(room_id, None)
        conn.rooms.add(room_id)
        conn.wake.set()
        return evicted

    def release_room(self, conn: AgentConnection, room_id: str) -> None:
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

    def claims_held_here(self) -> dict[str, set[str]]:
        """The rooms each agent's connections held by this process have
        claimed, lapsed ones included, for checking them against the agents'
        memberships. A copy of another process's connection is left out: that
        process checks the connections it holds."""
        claims: dict[str, set[str]] = {}
        for agent_id, ids in self._by_agent.items():
            for cid in ids:
                conn = self._by_id.get(cid)
                if conn is not None and conn.held_by is None and conn.rooms:
                    claims.setdefault(agent_id, set()).update(conn.rooms)
        return claims

    def claimant_of(self, agent_id: str, room_id: str) -> AgentConnection | None:
        """The connection that has explicitly claimed this room, if any.

        Only an explicit claim conflicts. An `all`-scope connection covering a
        room has not claimed it — it yields to a session that wants it, which
        is the whole point of the fallback.
        """
        for conn in self.for_agent(agent_id):
            if room_id in conn.rooms:
                return conn
        return None

    def holder_of(self, agent_id: str, room_id: str) -> AgentConnection | None:
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

    def covers(self, conn: AgentConnection, room_id: str) -> bool:
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
        if self.controllers.is_bound(agent_id):
            return self.controllers.is_live(agent_id)
        return bool(self.for_agent(agent_id))

    def live_in_room(self, agent_id: str, room_id: str) -> bool:
        """Whether some live connection of this agent covers this room.

        Covers, not claims: an `all`-scope daemon is genuinely reachable in the
        rooms it has not yielded to a session. This is the *delivery* question.
        For "is a session in this room", ask `protocol.presence.rooms_occupied`,
        which weighs a claim against the sessions that could account for it.
        """
        if self.controllers.is_bound(agent_id):
            return self.controllers.live_in_room(agent_id, room_id)
        return any(self.covers(conn, room_id) for conn in self.for_agent(agent_id))

    def can_spawn_for(self, agent_id: str, room_id: str) -> bool:
        """Whether something live will start a session for this room on demand.

        Declared by the client when it opens the stream (`spawn_capable`), so
        this is an *observed* capability rather than a property inferred from
        the agent's `connection_model`. That matters: the enum says what an
        agent was configured as, this says what is actually connected and
        willing right now. Promising "Starting a session…" on the strength of
        the enum alone is how a room gets told a session is coming when nothing
        is listening.

        Never for a controller-backed agent: Switch does not know where its
        sessions are, so it promises none; the agent says so itself.
        """
        if self.controllers.is_bound(agent_id):
            return False
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
        reports sessions, and a session is a connection. A controller's
        stream is one connection, however many agents it carries.

        Counted across every process: those held here, the copies of the
        others', and the controllers whose socket another process holds.
        """
        now = time.monotonic()
        return (
            sum(1 for conn in self._by_id.values() if conn.is_alive(now))
            + self.controllers.live_connection_count()
            + self.controllers.held_elsewhere_count()
        )

    def live_agent_ids(self) -> set[str]:
        """Every agent with at least one live connection, or a live controller."""
        now = time.monotonic()
        return {
            conn.agent_id for conn in self._by_id.values() if conn.is_alive(now)
        } | self.controllers.live_agent_ids()

    def live_agents_by_transport(self) -> dict[tuple[str, str], int]:
        """Agents with a live connection, per `(transport, client)` label.

        Counted like `live_agent_ids`: an agent is one, however many
        connections it holds, but an agent connected two different ways counts
        once under each, so the labels can sum to more than the agent count.
        An agent run by an agents controller has no connection of its own and
        counts under `CONTROLLER_LABEL` while its controller is live.

        Only what this process holds: each process reports its own, so the
        gauge sums across processes rather than counting every agent once per
        process.
        """
        now = time.monotonic()
        agents: dict[tuple[str, str], set[str]] = {}
        for conn in self._by_id.values():
            if conn.held_by is None and conn.is_alive(now):
                key = (connection_transport(conn), client_label(conn.declaration))
                agents.setdefault(key, set()).add(conn.agent_id)
        controlled = self.controllers.live_agent_ids_held_here()
        if controlled:
            agents.setdefault(CONTROLLER_LABEL, set()).update(controlled)
        return {key: len(ids) for key, ids in agents.items()}

    def live_connection_ids(self) -> set[str]:
        """Every connection currently alive, by id.

        Passed to the role-lease predicates: a seat taken over a connection is
        held for as long as that connection is, so a client that has stopped
        sending `/leases/renew` because it moved to the single heartbeat does
        not silently lose it. The connection, not the agent — an agent's other
        connections say nothing about a seat this one took.

        A controller-backed agent takes its seats under its holder id
        (`ControllerPresence.holder_id`), which is live while the agent is.
        """
        now = time.monotonic()
        return {
            conn.id for conn in self._by_id.values() if conn.is_alive(now)
        } | self.controllers.live_holder_ids()

    def live_agents_in_room(self, agent_ids: Iterable[str], room_id: str) -> set[str]:
        return {aid for aid in agent_ids if self.live_in_room(aid, room_id)}

    def live_agents(self, agent_ids: Iterable[str]) -> set[str]:
        return {aid for aid in agent_ids if self.is_live(aid)}

    def agents_that_can_spawn_for(
        self, agent_ids: Iterable[str], room_id: str
    ) -> set[str]:
        return {aid for aid in agent_ids if self.can_spawn_for(aid, room_id)}

    def rooms_covered(self, agent_id: str, candidate_rooms: Iterable[str]) -> set[str]:
        """Which of `candidate_rooms` this agent is reachable in right now."""
        return {room for room in candidate_rooms if self.live_in_room(agent_id, room)}

    def wake_agent(self, agent_id: str) -> None:
        for conn in self.for_agent(agent_id):
            conn.wake.set()
