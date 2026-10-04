"""Controller-backed agents: who runs them, and whether that runner is there.

An agent placed on an agents controller has no connection of its own. Its
controller holds one stream for every agent bound to it, and the agent is
reachable exactly while that stream is: attached, and beating within the same
TTL an agent connection beats in (`connections.HEARTBEAT_TTL_SECONDS`). Each
beat also says which rooms each agent has a session working in, and those are
the rooms the agent is present in.

Core owns this state and never reads Management's tables. Management fills it
through the narrow surface at the top of the class (`load`, `bind`, `unbind`,
`revoke_controller`) at startup and after every change it commits, and each of
those drops what the controller-token cache (`ControllerAuthCache`) holds for
the controller or agent it touches. Everything
else here is read by Core: the presence readers through `AgentConnectionRegistry`,
the bearer middleware's act-as check, and the controller stream.

Like the connection registry it is memory only. A restart forgets every
controller connection, and Management loads the bindings again before the
agent bridge serves.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
import uuid
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from switch_core.bridges.agent.protocol.hosted_workers import (
    IdleReport,
    WorkerBinding,
    WorkerFrames,
)
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
    # The rooms each agent has a session working in, as the controller last
    # said: the whole map on every beat, replacing the one before. Only agents
    # bound to this controller are kept. Cleared when the stream detaches or
    # the connection closes, since nothing then vouches for it.
    placements: dict[str, set[str]]
    last_beat: float
    opened_at: float
    beats: int = 0
    stream_attached: bool = False
    # Which attach of the stream is current: a second GET on the same
    # connection takes the stream over, and the first must notice and stop.
    stream_token: int = 0
    closure: Closure | None = None
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    # Frames owed to the stream, written on its next pass.
    session_commands: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    detached: dict[str, str] = field(default_factory=dict)
    rooms_changed: set[str] = field(default_factory=set)

    def is_live(self, now: float) -> bool:
        return (
            self.closure is None
            and self.stream_attached
            and (now - self.last_beat) < HEARTBEAT_TTL_SECONDS
        )


@dataclass(eq=False)
class ControllerWorker:
    """A cloud agent's worker, attached through its controller's relay.

    It stands where an `AgentConnection` bound to a worker stands for a cloud
    agent that holds its own connection, with the same attributes the hosted
    worker code reads (`id`, `stream_generation`, `worker`, `worker_frames`,
    `idle_report`, `spawn_capable`, `stream_attached`), so that code runs
    unchanged for both:

    - `id` and `stream_generation` are the relay's: the local connection and
      incarnation the worker was told in its `connection_state`, and names on
      every up-call. Up-calls are fenced on them.
    - Its frames are queued here and written on the controller's stream as
      `agent.worker`, which the relay replays on the worker's local stream.
    - It lives as long as the controller connection it attached on, and is
      dropped when that connection closes, is taken over or loses its stream,
      when the worker's local stream ends, or when another attach replaces it.
    - `holder` is the identity the agent holds things under on its
      controller (`ControllerPresence.holder_id`).
    """

    id: str
    agent_id: str
    controller: ControllerConnection
    holder: str
    stream_generation: int
    spawn_capable: bool
    worker: WorkerBinding | None
    idle_report: IdleReport | None = None
    closure: Closure | None = None
    worker_frames: WorkerFrames = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.worker_frames = WorkerFrames(self.controller.wake)

    @property
    def wake(self) -> asyncio.Event:
        return self.controller.wake

    @property
    def stream_attached(self) -> bool:
        """Frames queued now reach the worker: its controller's stream is up."""
        return (
            self.closure is None
            and self.controller.closure is None
            and self.controller.is_live(time.monotonic())
        )


class ControllerPresence:
    def __init__(
        self,
        *,
        on_bound: Callable[[str], None],
        on_worker_dropped: Callable[[ControllerWorker], None],
    ) -> None:
        # Called with each agent that becomes controller-backed, so the
        # connections it held of its own can be closed.
        self._on_bound = on_bound
        # Called with each cloud agent worker this presence lets go of, so the
        # relays dispatched to it fail rather than wait out their deadline.
        self._on_worker_dropped = on_worker_dropped
        self._workers: dict[str, ControllerWorker] = {}
        self._bindings: dict[str, Binding] = {}
        self._by_controller: dict[str, set[str]] = {}
        self._connections: dict[str, ControllerConnection] = {}
        self._superseded: dict[str, deque[str]] = {}
        self._revoked: set[str] = set()
        # The rooms each attached agent belongs to, as its controller's stream
        # loaded them and membership changes have kept them since.
        self._rooms: dict[str, set[str]] = {}
        self._next_generation = secrets.randbits(32)
        self._auth_cache: ControllerAuthCache | None = None

    def use_auth_cache(self, cache: ControllerAuthCache) -> None:
        """The cache of controller-token reads to keep in step with the
        bindings and revocations recorded here."""
        self._auth_cache = cache

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

    def bind(self, binding: Binding) -> None:
        """Bind an agent to a controller, moving it off any other."""
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
            self._drop_worker(binding.agent_id)
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
        previous = self._bindings.pop(agent_id, None)
        self._rooms.pop(agent_id, None)
        self._invalidate_agent_auth(agent_id)
        self._drop_worker(agent_id)
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
            conn.stream_attached = False
            conn.placements.clear()
            self._drop_workers_of(conn)
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

    def is_stopped(self, agent_id: str) -> bool:
        """Bound, and set to stopped by its owner."""
        binding = self._bindings.get(agent_id)
        return binding is not None and not binding.running

    def is_live(self, agent_id: str) -> bool:
        binding = self._bindings.get(agent_id)
        return (
            binding is not None
            and binding.running
            and self._live_connection(binding.controller_id) is not None
        )

    def rooms(self, agent_id: str) -> set[str]:
        return set(self._rooms.get(agent_id, ()))

    def placed_rooms(self, agent_id: str) -> set[str]:
        """The rooms a session of the agent is working in, as its live
        controller reports them, narrowed to the rooms it still belongs to.
        Empty while the controller is not live or the agent is stopped."""
        binding = self._bindings.get(agent_id)
        if binding is None or not binding.running:
            return set()
        conn = self._live_connection(binding.controller_id)
        if conn is None:
            return set()
        return conn.placements.get(agent_id, set()) & self._rooms.get(agent_id, set())

    def is_placed(self, agent_id: str, room_id: str) -> bool:
        return room_id in self.placed_rooms(agent_id)

    def live_in_room(self, agent_id: str, room_id: str) -> bool:
        return self.is_live(agent_id) and room_id in self._rooms.get(agent_id, ())

    def can_spawn_for(self, agent_id: str, room_id: str) -> bool:
        """Live, starting sessions on demand, and a member of the room."""
        return agent_id in self._bindings and self.live_in_room(agent_id, room_id)

    def live_agent_ids(self) -> set[str]:
        return {agent_id for agent_id in self._bindings if self.is_live(agent_id)}

    def live_holder_ids(self) -> set[str]:
        return {
            self.holder_id(binding)
            for binding in self._bindings.values()
            if self.is_live(binding.agent_id)
        }

    def live_connection_count(self) -> int:
        now = time.monotonic()
        return sum(1 for conn in self._connections.values() if conn.is_live(now))

    def relay_session_command(self, agent_id: str, frame: dict[str, Any]) -> bool:
        """Queue a session command on the agent's controller stream. False when
        its controller is not live or the agent is stopped, so the sender is
        told rather than the command held for a stream that may not return."""
        binding = self._bindings.get(agent_id)
        if binding is None or not binding.running:
            return False
        conn = self._live_connection(binding.controller_id)
        if conn is None:
            return False
        conn.session_commands.append((agent_id, frame))
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

    def open(
        self,
        *,
        controller_id: str,
        tenant_id: str,
        resume_cursors: dict[str, int | None],
        placements: dict[str, list[str]],
    ) -> ControllerConnection:
        """Open a connection for the controller, taking over any it had."""
        if controller_id in self._revoked:
            raise ControllerRevokedError(controller_id)
        previous = self._connections.get(controller_id)
        if previous is not None:
            previous.closure = TAKEN_OVER
            previous.stream_attached = False
            previous.placements.clear()
            self._drop_workers_of(previous)
            previous.wake.set()
            remembered = self._superseded.setdefault(
                controller_id, deque(maxlen=_SUPERSEDED_REMEMBERED)
            )
            remembered.append(previous.id)
        now = time.monotonic()
        generation = self._next_generation
        self._next_generation += 1
        conn = ControllerConnection(
            id=str(uuid.uuid4()),
            controller_id=controller_id,
            tenant_id=tenant_id,
            generation=generation,
            resume_cursors=dict(resume_cursors),
            placements={},
            last_beat=now,
            opened_at=now,
        )
        self._connections[controller_id] = conn
        self.replace_placements(conn, placements)
        logger.info(
            "[CONTROLLER] opened controller=%s connection=%s generation=%s agents=%d",
            controller_id,
            conn.id,
            generation,
            len(self.agents_of(controller_id)),
        )
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
        and the client cannot beat before it has one.
        """
        conn.stream_token += 1
        conn.stream_attached = True
        conn.last_beat = time.monotonic()
        conn.wake.set()
        return conn.stream_token

    def detach_stream(self, conn: ControllerConnection, token: int) -> None:
        if conn.stream_token == token:
            conn.stream_attached = False
            conn.placements.clear()
            self._drop_workers_of(conn)

    def replace_placements(
        self, conn: ControllerConnection, placements: dict[str, list[str]]
    ) -> None:
        """Make `placements` the whole of where this controller's sessions are.

        An agent left out is in no room. An agent not bound to this controller
        is ignored, and so is a room the agent is known not to belong to —
        logged at debug, since a relay a moment behind a membership change says
        exactly that and nothing is wrong. Membership is applied again when
        the map is read, so a room the agent leaves later drops out too.
        """
        bound = self.agents_of(conn.controller_id)
        kept: dict[str, set[str]] = {}
        for agent_id, rooms in placements.items():
            if agent_id not in bound:
                logger.debug(
                    "[CONTROLLER] controller=%s placed agent=%s, which is not "
                    "bound to it; ignored",
                    conn.controller_id,
                    agent_id,
                )
                continue
            member = self._rooms.get(agent_id)
            placed = set(rooms)
            if member is not None and not placed <= member:
                logger.debug(
                    "[CONTROLLER] controller=%s placed agent=%s in rooms it is not "
                    "a member of; ignored: %s",
                    conn.controller_id,
                    agent_id,
                    ", ".join(sorted(placed - member)),
                )
                placed &= member
            kept[agent_id] = placed
        conn.placements = kept

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
        conn.stream_attached = False
        conn.placements.clear()
        self._drop_workers_of(conn)
        conn.wake.set()

    # ------------------------------------------------------------------
    # Cloud agent workers
    # ------------------------------------------------------------------

    def worker(self, agent_id: str) -> ControllerWorker | None:
        """The agent's worker, while its controller connection is the
        current one of the controller the agent is bound to."""
        worker = self._workers.get(agent_id)
        binding = self._bindings.get(agent_id)
        if (
            worker is None
            or worker.closure is not None
            or binding is None
            or binding.controller_id != worker.controller.controller_id
            or self._connections.get(worker.controller.controller_id)
            is not worker.controller
        ):
            return None
        return worker

    def attach_worker(
        self,
        conn: ControllerConnection,
        agent_id: str,
        *,
        connection_id: str,
        generation: int,
        spawn_capable: bool,
        binding: WorkerBinding,
    ) -> ControllerWorker:
        """Attach the agent's worker on `conn`, replacing any it had."""
        current = self._bindings.get(agent_id)
        if current is None or current.controller_id != conn.controller_id:
            raise ValueError(f"agent {agent_id} is not bound to {conn.controller_id}")
        self._drop_worker(agent_id)
        worker = ControllerWorker(
            id=connection_id,
            agent_id=agent_id,
            controller=conn,
            holder=self.holder_id(current),
            stream_generation=generation,
            spawn_capable=spawn_capable,
            worker=binding,
        )
        self._workers[agent_id] = worker
        logger.info(
            "[CONTROLLER] controller=%s attached the worker of agent=%s "
            "(launch=%s revision=%s local connection=%s generation=%s)",
            conn.controller_id,
            agent_id,
            binding.launch_id,
            binding.launch_revision,
            connection_id,
            generation,
        )
        return worker

    def detach_worker(self, agent_id: str, connection_id: str, generation: int) -> bool:
        """The worker's stream on the relay ended. False if it was not this one."""
        worker = self._workers.get(agent_id)
        if (
            worker is None
            or worker.id != connection_id
            or worker.stream_generation != generation
        ):
            return False
        self._drop_worker(agent_id)
        return True

    def supersede_worker(self, agent_id: str, revision: int, closure: Closure) -> None:
        """End a worker bound to a launch revision older than `revision`.

        It stays queued for its controller's stream, which writes what the
        worker is still owed and then `agent.worker_closed`, and then lets go
        of it.
        """
        worker = self._workers.get(agent_id)
        if (
            worker is None
            or worker.closure is not None
            or worker.worker is None
            or worker.worker.launch_revision >= revision
        ):
            return
        worker.closure = closure
        self._on_worker_dropped(worker)
        worker.controller.wake.set()

    def take_worker_frames(
        self, conn: ControllerConnection
    ) -> list[tuple[ControllerWorker, list[tuple[str, dict[str, Any]]]]]:
        """Each of `conn`'s workers with frames owed, and the frames; a closed
        worker is handed over once, with only its cancellations, and let go."""
        owed: list[tuple[ControllerWorker, list[tuple[str, dict[str, Any]]]]] = []
        for agent_id, worker in list(self._workers.items()):
            if worker.controller is not conn:
                continue
            if worker.closure is not None:
                frames = [
                    frame
                    for frame in worker.worker_frames.drain()
                    if frame[0] == "mailbox_cancel"
                ]
                del self._workers[agent_id]
                owed.append((worker, frames))
            elif worker.worker_frames:
                owed.append((worker, worker.worker_frames.drain()))
        return owed

    def worker_frames_owed(self, conn: ControllerConnection) -> bool:
        return any(
            worker.controller is conn
            and (worker.closure is not None or bool(worker.worker_frames))
            for worker in self._workers.values()
        )

    def _drop_worker(self, agent_id: str) -> None:
        worker = self._workers.pop(agent_id, None)
        if worker is not None and worker.closure is None:
            self._on_worker_dropped(worker)

    def _drop_workers_of(self, conn: ControllerConnection) -> None:
        for agent_id, worker in list(self._workers.items()):
            if worker.controller is conn:
                self._drop_worker(agent_id)

    def _forget(self, binding: Binding) -> None:
        conn = self._connections.get(binding.controller_id)
        if conn is not None:
            conn.placements.pop(binding.agent_id, None)
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
