"""Controller-backed agents: who runs them, and whether that runner is there.

An agent placed on an agent controller has no connection of its own. Its
controller holds one stream for every agent bound to it, and the agent is
reachable exactly while that stream is: attached, and beating within the same
TTL an agent connection beats in (`connections.HEARTBEAT_TTL_SECONDS`). Core
knows only that much: whether the agent is connected (its controller's stream is
live, its owner has it running, and the controller is not revoked), and which
rooms it is a member of. Where its sessions are, and whether one is running at
all, is the controller's business.

Core owns this state and never reads Management's tables. Management fills it
through the narrow surface at the top of the class (`load`, `bind`, `unbind`,
`reconcile`, `revoke_controller`) at startup, after every change it commits,
and when another process signals a change it committed (`management/signals.py`),
and each of those drops what the controller-token cache (`ControllerAuthCache`)
holds for the controller or agent it touches. Everything
else here is read by Core: the presence readers through `AgentConnectionRegistry`,
the bearer middleware's act-as check, and the controller stream.

A controller's connection lives in the memory of the process holding its
socket. A restart forgets every controller connection, and Management loads
the bindings again before the agent bridge serves. Each controller
connection's transitions, its socket attaching and its socket going (and
why), are also handed to a ledger, which Management installs (`use_ledger`)
and which persists them, so that whether a machine is connected can be read
from any process. Heartbeats are not: they stay here. The ledger is told
synchronously, as each transition happens, once per transition.

Every other process learns from those rows which process holds each
controller's live socket (`held_elsewhere`), so an agent run by a controller
connected anywhere reads as live everywhere, and a connection held here that
another process has since taken over is closed. Management keeps that, and
the bindings, in step across processes (`management/signals.py`).
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
import uuid
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Protocol

from switch_core.bridges.agent.protocol.liveness import (
    HEARTBEAT_LAPSED,
    HEARTBEAT_TTL_SECONDS,
    TAKEN_OVER,
    Closure,
)

if TYPE_CHECKING:
    from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache

logger = logging.getLogger(__name__)

# Why an agent left a controller's stream, as `agent.detached` reports it.
DETACH_UNASSIGNED = "unassigned"
DETACH_DELETED = "deleted"

REVOKED = Closure(
    code="closed", message="the controller has been revoked", room_id=None
)

# Why a connection's socket went, as the ledger records it. A connection
# closed with a closure records the closure's code (`heartbeat_lapsed`,
# `taken_over`) instead.
DISCONNECT_REVOKED = "revoked"
DISCONNECT_SOCKET_CLOSED = "socket_closed"
DISCONNECT_SERVER_SHUTDOWN = "server_shutdown"

# How many superseded connection ids a controller is remembered by, so a late
# beat from one is told `taken_over` rather than `unknown_connection`.
_SUPERSEDED_REMEMBERED = 16


class ControllerConnectionError(Exception):
    """A controller connection request that cannot be honoured; `code` says why."""

    code = "unknown_connection"


class UnknownControllerConnectionError(ControllerConnectionError):
    code = "unknown_connection"

    def __init__(self, connection_id: str) -> None:
        super().__init__(
            f"controller connection {connection_id} is not open; open a new one "
            "with your cursors"
        )


class ControllerTakenOverError(ControllerConnectionError):
    code = "taken_over"

    def __init__(self, connection_id: str) -> None:
        super().__init__(
            f"controller connection {connection_id} was taken over by a newer "
            "connection of this controller"
        )


class StaleGenerationError(ControllerConnectionError):
    code = "stale_generation"

    def __init__(self, connection_id: str, presented: int, current: int) -> None:
        super().__init__(
            f"controller connection {connection_id} is at generation {current}, "
            f"not {presented}"
        )


class ControllerNoStreamError(ControllerConnectionError):
    code = "no_stream"

    def __init__(self, connection_id: str) -> None:
        super().__init__(
            f"controller connection {connection_id} has no stream attached; open "
            "the event stream"
        )


class ControllerRevokedError(ControllerConnectionError):
    code = "controller_revoked"

    def __init__(self, controller_id: str) -> None:
        super().__init__(f"controller {controller_id} has been revoked")


@dataclass(frozen=True)
class Binding:
    """Which controller may act for an agent, and whether its owner wants it
    running. A managed agent always starts a session when it is addressed."""

    agent_id: str
    controller_id: str
    tenant_id: str
    # The controller's name as its owner knows it ("the machine"), for the
    # room to be told which machine is offline.
    controller_name: str
    # False when the owner has set the agent to stopped: its controller runs
    # nothing for it, so it is not live however healthy the controller is.
    running: bool


@dataclass
class ControllerConnection:
    id: str
    controller_id: str
    tenant_id: str
    generation: int
    # Where each agent's delivery resumes when a stream attaches to this
    # connection: the cursor the open asked for, then where the stream first
    # attached it, then forward with every cursor a beat confirms. A stream
    # reattached after a dropped socket resumes from here rather than
    # replaying everything since the open. None, or absent, is the head.
    resume_cursors: dict[str, int | None]
    last_beat: float
    opened_at: float
    beats: int = 0
    stream_attached: bool = False
    # Which attach of the stream is current: a second GET on the same
    # connection takes the stream over, and the first must notice and stop.
    stream_token: int = 0
    closure: Closure | None = None
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    # How far the stream on this connection has sent each attached agent's own
    # events. A beat's confirmed cursor is lowered to it, in memory, so a beat
    # costs no database query.
    sent_cursors: dict[str, int] = field(default_factory=dict)
    # Frames owed to the stream, written on its next pass.
    session_commands: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    warms: set[tuple[str, str]] = field(default_factory=set)
    detached: dict[str, str] = field(default_factory=dict)
    rooms_changed: set[str] = field(default_factory=set)

    def is_live(self, now: float) -> bool:
        return (
            self.closure is None
            and self.stream_attached
            and (now - self.last_beat) < HEARTBEAT_TTL_SECONDS
        )


class ControllerConnectionLedger(Protocol):
    """Where controller connections' transitions are persisted.

    Called as each happens, once each, and must not block. `connected`: a
    socket attached to a connection that had none. `disconnected`: the
    socket went, with the reason to record: `socket_closed`,
    `server_shutdown`, `heartbeat_lapsed`, `taken_over` or `revoked`.
    """

    def connected(self, conn: ControllerConnection) -> None: ...

    def disconnected(self, conn: ControllerConnection, reason: str) -> None: ...


class ControllerPresence:
    def __init__(self, *, on_bound: Callable[[str], None]) -> None:
        # Called with each agent that becomes controller-backed, so the
        # connections it held of its own can be closed.
        self._on_bound = on_bound
        self._bindings: dict[str, Binding] = {}
        self._by_controller: dict[str, set[str]] = {}
        # A count of binding changes, and the count at each agent's last one,
        # so a reconcile built from a read that started earlier can tell
        # which agents changed under it (`change_mark`, `reconcile`).
        self._changes = 0
        self._changed_at: dict[str, int] = {}
        self._connections: dict[str, ControllerConnection] = {}
        self._superseded: dict[str, deque[str]] = {}
        self._revoked: set[str] = set()
        # The rooms each attached agent belongs to, as its controller's stream
        # loaded them and membership changes have kept them since.
        self._rooms: dict[str, set[str]] = {}
        self._next_generation = secrets.randbits(32)
        self._auth_cache: ControllerAuthCache | None = None
        self._ledger: ControllerConnectionLedger | None = None
        # Set as the process begins shutting down: a socket going after that
        # went because the server closed it.
        self._shutting_down = False
        # Controllers whose live socket another process holds, and which one,
        # as Management reads it from their rows. Dropped when that process's
        # lease lapses (`forget_processes`) or its row says the socket went.
        self._elsewhere: dict[str, str] = {}
        # A count of changes to which process holds each controller's
        # connection, and the count at each controller's last one, as for the
        # bindings: so a read of the controllers' rows that started earlier
        # can tell which controllers changed under it (`connection_mark`).
        self._connection_changes = 0
        self._connection_changed_at: dict[str, int] = {}

    def connection_mark(self) -> int:
        """Where the connection changes stand now. Taken before reading the
        controllers' rows, so what is read is not applied over a change made
        here since (`connection_changed_since`)."""
        return self._connection_changes

    def connection_changed_since(self, controller_id: str, mark: int) -> bool:
        return self._connection_changed_at.get(controller_id, 0) > mark

    def _note_connection_change(self, controller_id: str) -> None:
        self._connection_changes += 1
        self._connection_changed_at[controller_id] = self._connection_changes

    def use_auth_cache(self, cache: ControllerAuthCache) -> None:
        """The cache of controller-token reads to keep in step with the
        bindings and revocations recorded here."""
        self._auth_cache = cache

    def use_ledger(self, ledger: ControllerConnectionLedger) -> None:
        """Where each connection's socket attaching and going are persisted."""
        self._ledger = ledger

    def begin_shutdown(self) -> None:
        """The process is shutting down: sockets that go from now are
        recorded as closed by the server."""
        self._shutting_down = True

    def _record_connected(self, conn: ControllerConnection) -> None:
        if self._ledger is not None:
            self._ledger.connected(conn)

    def _record_disconnected(self, conn: ControllerConnection, reason: str) -> None:
        """Record the socket going, if one was attached: a connection whose
        socket already went was recorded then."""
        if conn.stream_attached and self._ledger is not None:
            self._ledger.disconnected(conn, reason)

    def _invalidate_agent_auth(self, agent_id: str) -> None:
        if self._auth_cache is not None:
            self._auth_cache.invalidate_agent(agent_id)

    # ------------------------------------------------------------------
    # Management's surface
    # ------------------------------------------------------------------

    def load(self, bindings: Iterable[Binding]) -> None:
        """Replace every binding, as Management reads them at startup."""
        for agent_id in list(self._bindings):
            self.unbind(agent_id, DETACH_UNASSIGNED)
        for binding in bindings:
            self.bind(binding)

    def change_mark(self) -> int:
        """Where the binding changes stand now. Taken before reading
        Management's tables for `reconcile`."""
        return self._changes

    def _note_change(self, agent_id: str) -> None:
        self._changes += 1
        self._changed_at[agent_id] = self._changes

    def reconcile(
        self, bindings: Iterable[Binding], *, agent_ids: Iterable[str], since: int
    ) -> None:
        """Make the bindings of `agent_ids` what Management's tables said,
        changing only what differs: an agent in `agent_ids` with no binding
        in `bindings` is unbound.

        `bindings` was read after `since` was taken (`change_mark`). An agent
        this process bound or unbound after that has a newer answer than the
        read, so it is left as it is: otherwise a re-check that read the
        tables a moment before a request placed an agent would unbind it
        again until the next re-check.
        """
        wanted = {binding.agent_id: binding for binding in bindings}
        for agent_id in agent_ids:
            if self._changed_at.get(agent_id, 0) > since:
                continue
            binding = wanted.get(agent_id)
            if binding is None:
                if agent_id in self._bindings:
                    self.unbind(agent_id, DETACH_UNASSIGNED)
            elif self._bindings.get(agent_id) != binding:
                self.bind(binding)

    def bound_agent_ids(self) -> set[str]:
        return set(self._bindings)

    def bind(self, binding: Binding) -> None:
        """Bind an agent to a controller, moving it off any other."""
        self._note_change(binding.agent_id)
        previous = self._bindings.get(binding.agent_id)
        if previous is not None:
            self._forget(previous)
        self._invalidate_agent_auth(binding.agent_id)
        self._bindings[binding.agent_id] = binding
        self._by_controller.setdefault(binding.controller_id, set()).add(
            binding.agent_id
        )
        if previous is not None and previous.controller_id != binding.controller_id:
            self._owe_detach(
                previous.controller_id, binding.agent_id, DETACH_UNASSIGNED
            )
            self._rooms.pop(binding.agent_id, None)
        if previous is None or previous.controller_id != binding.controller_id:
            logger.info(
                "[CONTROLLER] agent=%s bound to controller=%s running=%s",
                binding.agent_id,
                binding.controller_id,
                binding.running,
            )
            self._on_bound(binding.agent_id)
        elif previous.running != binding.running:
            logger.info(
                "[CONTROLLER] agent=%s on controller=%s set to %s",
                binding.agent_id,
                binding.controller_id,
                "running" if binding.running else "stopped",
            )
        self._wake(binding.controller_id)

    def unbind(self, agent_id: str, reason: str) -> None:
        """The agent is no longer controller-backed."""
        self._note_change(agent_id)
        previous = self._bindings.pop(agent_id, None)
        self._rooms.pop(agent_id, None)
        self._invalidate_agent_auth(agent_id)
        if previous is None:
            return
        self._forget(previous)
        logger.info(
            "[CONTROLLER] agent=%s unbound from controller=%s (%s)",
            agent_id,
            previous.controller_id,
            reason,
        )
        self._owe_detach(previous.controller_id, agent_id, reason)

    def rename_controller(self, controller_id: str, name: str) -> None:
        """The controller's owner renamed it: what its agents' bindings call it."""
        for agent_id in self._by_controller.get(controller_id, set()):
            self._note_change(agent_id)
            binding = self._bindings[agent_id]
            self._bindings[agent_id] = replace(binding, controller_name=name)

    def revoke_controller(self, controller_id: str) -> None:
        """A revoked controller's stream ends and it cannot open another.

        Its agents stay bound to it, and so stay controller-backed and not
        live, until their owner moves or removes them.
        """
        self._revoked.add(controller_id)
        if self._auth_cache is not None:
            self._auth_cache.invalidate_controller(controller_id)
        conn = self._connections.pop(controller_id, None)
        if conn is not None:
            conn.closure = REVOKED
            self._record_disconnected(conn, DISCONNECT_REVOKED)
            conn.stream_attached = False
            conn.wake.set()

    # ------------------------------------------------------------------
    # Bindings, read by Core
    # ------------------------------------------------------------------

    def binding(self, agent_id: str) -> Binding | None:
        return self._bindings.get(agent_id)

    def is_revoked(self, controller_id: str) -> bool:
        return controller_id in self._revoked

    def is_bound(self, agent_id: str) -> bool:
        return agent_id in self._bindings

    def agents_of(self, controller_id: str) -> set[str]:
        return set(self._by_controller.get(controller_id, ()))

    @staticmethod
    def holder_id(binding: Binding) -> str:
        """The identity a controller-backed agent holds things under.

        It stands where a connection id would for a directly connected agent:
        the operation caller's session key, the reader a room's unread count
        belongs to, and the holder of a role lease, which is held while this
        id is among the live ones. It names the controller, so a lease taken
        on one controller does not survive the agent moving to another.
        """
        return f"controller:{binding.controller_id}:{binding.agent_id}"

    def holder_of(self, agent_id: str) -> str | None:
        binding = self._bindings.get(agent_id)
        return self.holder_id(binding) if binding is not None else None

    # ------------------------------------------------------------------
    # Presence
    # ------------------------------------------------------------------

    def _live_connection(self, controller_id: str) -> ControllerConnection | None:
        conn = self._connections.get(controller_id)
        if conn is None or not conn.is_live(time.monotonic()):
            return None
        return conn

    def _connected(self, controller_id: str) -> bool:
        """Whether the controller's socket is live here or in another process."""
        return self._live_connection(controller_id) is not None or (
            controller_id in self._elsewhere and controller_id not in self._revoked
        )

    def is_stopped(self, agent_id: str) -> bool:
        """Bound, and set to stopped by its owner."""
        binding = self._bindings.get(agent_id)
        return binding is not None and not binding.running

    def is_live(self, agent_id: str) -> bool:
        binding = self._bindings.get(agent_id)
        return (
            binding is not None
            and binding.running
            and self._connected(binding.controller_id)
        )

    def rooms(self, agent_id: str) -> set[str]:
        return set(self._rooms.get(agent_id, ()))

    def rooms_kept(self) -> dict[str, set[str]]:
        """The rooms this process keeps for each agent a controller streamed
        from here, the ones `room_joined` and `room_left` change."""
        return {agent_id: set(rooms) for agent_id, rooms in self._rooms.items()}

    def live_in_room(self, agent_id: str, room_id: str) -> bool:
        return self.is_live(agent_id) and room_id in self._rooms.get(agent_id, ())

    def live_rooms(self, agent_id: str) -> set[str]:
        """The rooms the agent is a member of while it is live, else none."""
        if not self.is_live(agent_id):
            return set()
        return self.rooms(agent_id)

    def live_agent_ids(self) -> set[str]:
        return {agent_id for agent_id in self._bindings if self.is_live(agent_id)}

    def live_agent_ids_held_here(self) -> set[str]:
        """The live agents whose controller's socket this process holds."""
        return {
            agent_id
            for agent_id, binding in self._bindings.items()
            if binding.running
            and self._live_connection(binding.controller_id) is not None
        }

    def live_holder_ids(self) -> set[str]:
        return {
            self.holder_id(binding)
            for binding in self._bindings.values()
            if self.is_live(binding.agent_id)
        }

    def live_connection_count(self) -> int:
        """The controller connections this process holds that are live."""
        now = time.monotonic()
        return sum(1 for conn in self._connections.values() if conn.is_live(now))

    # ------------------------------------------------------------------
    # Controllers held by other processes
    # ------------------------------------------------------------------

    def held_elsewhere(self, controller_id: str, process_id: str | None) -> None:
        """Which other process holds the controller's live socket, or None
        when no other process does."""
        self._note_connection_change(controller_id)
        if process_id is None:
            self._elsewhere.pop(controller_id, None)
        else:
            self._elsewhere[controller_id] = process_id

    def holder_elsewhere(self, controller_id: str) -> str | None:
        """The other process holding the controller's live socket, if any."""
        return self._elsewhere.get(controller_id)

    def process_holding(self, agent_id: str) -> str | None:
        """The other process holding the live socket of the controller that
        runs this agent, while the agent is set running."""
        binding = self._bindings.get(agent_id)
        if binding is None or not binding.running:
            return None
        return self._elsewhere.get(binding.controller_id)

    def processes_elsewhere(self) -> set[str]:
        return set(self._elsewhere.values())

    def controllers_elsewhere(self) -> set[str]:
        return set(self._elsewhere)

    def held_elsewhere_count(self) -> int:
        """How many controllers' live sockets other processes hold."""
        return sum(
            1 for controller_id in self._elsewhere if controller_id not in self._revoked
        )

    def forget_processes(self, process_ids: set[str]) -> set[str]:
        """These processes' leases lapsed: the controllers they held are not
        connected. Returns those controllers."""
        gone = {
            controller_id
            for controller_id, process_id in self._elsewhere.items()
            if process_id in process_ids
        }
        for controller_id in gone:
            self._note_connection_change(controller_id)
            del self._elsewhere[controller_id]
        return gone

    def supersede(self, controller_id: str) -> None:
        """The controller's connection held here was taken over through
        another process: its stream ends with `taken_over`, and a late beat
        from it is told so."""
        self._note_connection_change(controller_id)
        previous = self._connections.pop(controller_id, None)
        if previous is not None:
            self._take_over(previous)
            logger.info(
                "[CONTROLLER] controller=%s connection=%s taken over through "
                "another process",
                controller_id,
                previous.id,
            )

    def _take_over(self, previous: ControllerConnection) -> None:
        previous.closure = TAKEN_OVER
        self._record_disconnected(previous, TAKEN_OVER.code)
        previous.stream_attached = False
        previous.wake.set()
        remembered = self._superseded.setdefault(
            previous.controller_id, deque(maxlen=_SUPERSEDED_REMEMBERED)
        )
        remembered.append(previous.id)

    def relay_session_command(self, agent_id: str, frame: dict[str, Any]) -> bool:
        """Queue a session command on the agent's controller stream, when this
        process holds it. False when its controller is not live here or the
        agent is stopped, so the sender is told rather than the command held
        for a stream that may not return. A controller held by another process
        is reached through the registry (`process_holding`)."""
        binding = self._bindings.get(agent_id)
        if binding is None or not binding.running:
            return False
        conn = self._live_connection(binding.controller_id)
        if conn is None:
            return False
        conn.session_commands.append((agent_id, frame))
        conn.wake.set()
        return True

    def relay_warm(self, agent_id: str, room_id: str) -> bool:
        """Ask the agent's controller to start the session a message to
        `room_id` would start, when this process holds its stream. False when
        its controller is not live here or the agent is stopped. A warm
        already owed for the room is not repeated. A controller held by
        another process is reached through the registry (`process_holding`)."""
        binding = self._bindings.get(agent_id)
        if binding is None or not binding.running:
            return False
        conn = self._live_connection(binding.controller_id)
        if conn is None:
            return False
        conn.warms.add((agent_id, room_id))
        conn.wake.set()
        return True

    def room_joined(self, agent_id: str, room_id: str) -> None:
        self._rooms_changed(agent_id, room_id, joined=True)

    def room_left(self, agent_id: str, room_id: str) -> None:
        self._rooms_changed(agent_id, room_id, joined=False)

    def _rooms_changed(self, agent_id: str, room_id: str, *, joined: bool) -> None:
        binding = self._bindings.get(agent_id)
        rooms = self._rooms.get(agent_id)
        if binding is None or rooms is None:
            return
        if joined:
            rooms.add(room_id)
        else:
            rooms.discard(room_id)
        conn = self._connections.get(binding.controller_id)
        if conn is not None:
            conn.rooms_changed.add(agent_id)
            conn.wake.set()

    # ------------------------------------------------------------------
    # The controller's connection
    # ------------------------------------------------------------------

    def new_connection(self) -> tuple[str, int]:
        """An id and a generation for a connection the controller is opening.

        Drawn before the connection is held (`open`), so the open can be
        recorded first: a read of the controller's row taken between holding
        it and recording it would find the connection it replaces still named
        there, and close the new one as taken over."""
        generation = self._next_generation
        self._next_generation += 1
        return str(uuid.uuid4()), generation

    def open(
        self,
        *,
        controller_id: str,
        tenant_id: str,
        resume_cursors: dict[str, int | None],
        identity: tuple[str, int] | None = None,
    ) -> ControllerConnection:
        """Open a connection for the controller, taking over any it had.

        `identity` is the id and generation drawn for it (`new_connection`);
        a new one is drawn when none is given."""
        connection_id, generation = identity or self.new_connection()
        conn = self._hold(
            controller_id=controller_id,
            tenant_id=tenant_id,
            connection_id=connection_id,
            generation=generation,
            resume_cursors=resume_cursors,
        )
        logger.info(
            "[CONTROLLER] opened controller=%s connection=%s generation=%s agents=%d",
            controller_id,
            conn.id,
            generation,
            len(self.agents_of(controller_id)),
        )
        return conn

    def adopt(
        self,
        *,
        controller_id: str,
        tenant_id: str,
        connection_id: str,
        generation: int,
        resume_cursors: dict[str, int | None],
    ) -> ControllerConnection:
        """Hold here a connection another process opened.

        The open and the socket attaching are two requests, and need not
        reach the same process; nor need a socket reattaching after a drop.
        The connection's id, generation and cursors are read from its row, so
        the attach is fenced on what the open handed the controller wherever
        it lands. The process that held it closes its copy when told.
        """
        conn = self._hold(
            controller_id=controller_id,
            tenant_id=tenant_id,
            connection_id=connection_id,
            generation=generation,
            resume_cursors=resume_cursors,
        )
        logger.info(
            "[CONTROLLER] adopted controller=%s connection=%s generation=%s from "
            "another process",
            controller_id,
            connection_id,
            generation,
        )
        return conn

    def _hold(
        self,
        *,
        controller_id: str,
        tenant_id: str,
        connection_id: str,
        generation: int,
        resume_cursors: dict[str, int | None],
    ) -> ControllerConnection:
        if controller_id in self._revoked:
            raise ControllerRevokedError(controller_id)
        self._note_connection_change(controller_id)
        previous = self._connections.get(controller_id)
        if previous is not None:
            self._take_over(previous)
        # Held again here after another process held it: no longer one of
        # the connections a late beat is told were taken over.
        remembered = self._superseded.get(controller_id)
        if remembered is not None and connection_id in remembered:
            remembered.remove(connection_id)
        now = time.monotonic()
        conn = ControllerConnection(
            id=connection_id,
            controller_id=controller_id,
            tenant_id=tenant_id,
            generation=generation,
            resume_cursors=dict(resume_cursors),
            last_beat=now,
            opened_at=now,
        )
        self._connections[controller_id] = conn
        return conn

    def require(
        self, controller_id: str, connection_id: str, generation: int
    ) -> ControllerConnection:
        conn = self._connections.get(controller_id)
        if conn is None or conn.id != connection_id:
            if connection_id in self._superseded.get(controller_id, ()):
                raise ControllerTakenOverError(connection_id)
            raise UnknownControllerConnectionError(connection_id)
        if conn.closure is not None:
            raise UnknownControllerConnectionError(connection_id)
        if conn.generation != generation:
            raise StaleGenerationError(connection_id, generation, conn.generation)
        if (time.monotonic() - conn.last_beat) >= HEARTBEAT_TTL_SECONDS:
            self._close(conn, HEARTBEAT_LAPSED)
            raise UnknownControllerConnectionError(connection_id)
        return conn

    def attach_stream(self, conn: ControllerConnection) -> int:
        """Attach a stream to the connection, displacing any attached before.

        Attaching counts as a beat: the stream is what the beat proves alive,
        and the client cannot beat before it has one. A connection that had
        no socket attached is recorded as connected; displacing an attached
        one changes nothing the ledger holds.

        Refused when the connection is no longer the controller's current one
        here, as `require` refuses it: the attach was decided on a read of the
        controller's row, and in the wait the controller may have opened
        another connection, or this one closed. Attaching then would hold a
        connection that is over, and forget the process holding the newer one.
        """
        if not self.is_current(conn):
            if conn.closure is not None and conn.closure.code == TAKEN_OVER.code:
                raise ControllerTakenOverError(conn.id)
            raise UnknownControllerConnectionError(conn.id)
        if not conn.stream_attached:
            self._record_connected(conn)
        self._note_connection_change(conn.controller_id)
        self._elsewhere.pop(conn.controller_id, None)
        conn.stream_token += 1
        conn.stream_attached = True
        conn.last_beat = time.monotonic()
        conn.wake.set()
        return conn.stream_token

    def detach_stream(self, conn: ControllerConnection, token: int) -> None:
        """The socket holding this stream went. The connection stays open for
        the socket to reattach within the heartbeat TTL, but the machine is
        recorded as disconnected now."""
        if conn.stream_token == token:
            self._record_disconnected(
                conn,
                DISCONNECT_SERVER_SHUTDOWN
                if self._shutting_down
                else DISCONNECT_SOCKET_CLOSED,
            )
            conn.stream_attached = False

    def beat(
        self, controller_id: str, connection_id: str, generation: int
    ) -> ControllerConnection:
        conn = self.require(controller_id, connection_id, generation)
        if not conn.stream_attached:
            raise ControllerNoStreamError(connection_id)
        conn.last_beat = time.monotonic()
        conn.beats += 1
        return conn

    @staticmethod
    def resume_from(conn: ControllerConnection, agent_id: str, cursor: int) -> None:
        """Move where the agent resumes on this connection. Forward only."""
        current = conn.resume_cursors.get(agent_id)
        if current is None or cursor > current:
            conn.resume_cursors[agent_id] = cursor

    def held_connections(self) -> list[ControllerConnection]:
        """Every controller connection this process holds."""
        return list(self._connections.values())

    def current_connection(self, controller_id: str) -> ControllerConnection | None:
        """The controller's open connection, live or not yet swept."""
        return self._connections.get(controller_id)

    def is_current(self, conn: ControllerConnection) -> bool:
        return self._connections.get(conn.controller_id) is conn

    def close_lapsed(self, conn: ControllerConnection) -> None:
        self._close(conn, HEARTBEAT_LAPSED)

    def sweep(self) -> list[ControllerConnection]:
        """Close connections whose beat has lapsed. Returns those closed."""
        now = time.monotonic()
        lapsed = [
            conn
            for conn in self._connections.values()
            if (now - conn.last_beat) >= HEARTBEAT_TTL_SECONDS
        ]
        for conn in lapsed:
            self._close(conn, HEARTBEAT_LAPSED)
        return lapsed

    def set_rooms(self, agent_id: str, rooms: set[str]) -> None:
        if agent_id in self._bindings:
            self._rooms[agent_id] = set(rooms)

    def take_detached(self, conn: ControllerConnection) -> dict[str, str]:
        owed = dict(conn.detached)
        conn.detached.clear()
        return owed

    def take_rooms_changed(self, conn: ControllerConnection) -> set[str]:
        owed = set(conn.rooms_changed)
        conn.rooms_changed.clear()
        return owed

    def take_session_commands(
        self, conn: ControllerConnection
    ) -> list[tuple[str, dict[str, Any]]]:
        owed = list(conn.session_commands)
        conn.session_commands.clear()
        return owed

    def take_warms(self, conn: ControllerConnection) -> list[tuple[str, str]]:
        owed = sorted(conn.warms)
        conn.warms.clear()
        return owed

    def _close(self, conn: ControllerConnection, closure: Closure) -> None:
        if self._connections.get(conn.controller_id) is conn:
            del self._connections[conn.controller_id]
        if conn.closure is None:
            conn.closure = closure
            logger.info(
                "[CONTROLLER] closed controller=%s connection=%s code=%s beats=%d",
                conn.controller_id,
                conn.id,
                closure.code,
                conn.beats,
            )
            self._record_disconnected(conn, closure.code)
        conn.stream_attached = False
        conn.wake.set()

    def _forget(self, binding: Binding) -> None:
        held = self._by_controller.get(binding.controller_id)
        if held is not None:
            held.discard(binding.agent_id)
            if not held:
                del self._by_controller[binding.controller_id]

    def _owe_detach(self, controller_id: str, agent_id: str, reason: str) -> None:
        conn = self._connections.get(controller_id)
        if conn is not None:
            conn.detached[agent_id] = reason
            conn.wake.set()

    def _wake(self, controller_id: str) -> None:
        conn = self._connections.get(controller_id)
        if conn is not None:
            conn.wake.set()
