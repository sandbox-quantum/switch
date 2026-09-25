"""In-memory state of hosted workers: bindings, frame queues, relays, idle reports.

A hosted agent's watcher runs on a cloud worker and attaches with a capability
the controller minted for the launch's current revision. Everything here is
per Core boot and lost on restart; loss always reads as busy or retry, never as
idle or delivered.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.connections import (
        Connection,
        ConnectionRegistry,
    )
    from switch_core.db.models import HostedLaunch

#: The protocol revision that carries the hosted worker frames.
HOSTED_PROTOCOL_REVISION = 7

#: Bound on frames that carry a body (a relayed request, a room event).
FRAME_QUEUE_FRAMES = 64
FRAME_QUEUE_BYTES = 8 * 1024 * 1024

IDLE_REPORT_EVERY_SECONDS = 30
IDLE_FRESH_FOR_SECONDS = 75

RELAY_REQUEST_LIMIT_BYTES = 2 * 1024 * 1024
RELAY_REPLY_LIMIT_BYTES = 1024 * 1024
#: Room for the reply's envelope around a value at the limit.
RELAY_REPLY_ENVELOPE_BYTES = 64 * 1024
RELAY_TIMEOUT_LIMIT_MS = 30_000
#: How long a resolved relay is remembered, so a second reply is refused
#: rather than reported unknown.
RELAY_RESOLVED_RETENTION_SECONDS = 60.0

#: Bound on one Console relay stream's undelivered frames.
CONSOLE_VIEW_FRAMES = 1000
CONSOLE_VIEW_BYTES = 4 * 1024 * 1024

#: What a room is told, by notice reason, when a message was not processed.
NOTICE_MESSAGES = {
    "startup": "I could not start the provider, so I could not process your request. Open this session in Switch Console to check the error and restart it.",
    "delivery": "I could not verify your earlier message after reconnecting, so I did not process it. Please send the message and any attachments again.",
    "conversation": "This saved conversation cannot continue. Send !reset @{name} here, or choose Start a fresh conversation in Switch Console. Your pending messages will be delivered after you make that choice.",
    "capacity": "I am already running as many sessions as my cloud worker allows, so I could not start one for this message. Stop a session in Switch Console, then send the message again.",
    "auto_start_off": "I have no session for this room and I am not set to start one automatically, so I did not process this message. Start a session for this room in Switch Console, then send the message again.",
    "stopped": "My cloud worker was stopped before I processed this message, so I did not process it. Start me again in Switch Console, then send it again.",
    "expired": "I could not process this message in time, so I did not process it. Please send it again.",
    "cancelled": "Processing of this message was cancelled before it ran. Please send it again if it is still needed.",
    "revoked": "My owner's provider connection was removed, so I cannot process messages. Ask my owner to reconnect the provider in Switch.",
    "upgrade": "My cloud worker is being upgraded and could not process this message. Please send it again in a few minutes.",
    "started_before_stop": "I had already started processing this message before my cloud worker was stopped, so it may have been processed in part. Check the conversation before sending it again.",
    "started_before_expiry": "I had already started processing this message before it expired, so it may have been processed in part. Check the conversation before sending it again.",
    "expired_uncertain": "I could not confirm whether my cloud worker received this message in time, so it may or may not have been processed. Check the conversation before sending it again.",
}

#: The subscription name a watcher pushes health under.
HEALTH_SUBSCRIPTION = "health"

MUTATING_MESSAGES = frozenset(
    {"command", "place", "forget", "attachment", "attachmentCancel"}
)
REFUSED_MESSAGES = frozenset({"room", "approvals", "ensure"})
READ_ONLY_MESSAGES = frozenset(
    {
        "snapshot",
        "subscribe",
        "unsubscribe",
        "health",
        "watchHealth",
        "list",
        "journal",
        "page",
    }
)

MessageKind = Literal["mutating", "read_only"]


class RelayError(Exception):
    """A relay that could not be answered, with the code Console acts on."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


HOSTED_WORKER_ONLY_MESSAGE = (
    "This agent runs on a cloud worker; only its attached worker may do this."
)


class CodedPermissionError(PermissionError):
    """A refusal every front door renders as the same `{code, message}` object."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(json.dumps({"code": code, "message": message}))
        self.detail = {"code": code, "message": message}


class WorkerBusyError(RelayError):
    def __init__(self) -> None:
        super().__init__(
            "worker_busy",
            "The worker's frame queue is full. Retry shortly.",
            503,
        )


def classify_message(message: dict[str, Any]) -> MessageKind:
    """Whether a relayed message changes the worker's state.

    The message is one element of the host control vocabulary. `room`,
    `approvals` and `ensure` are the watcher's own and are refused; anything
    unrecognised is refused too rather than guessed at.
    """
    if not isinstance(message, dict):
        raise RelayError("refused_message", "A relayed message is an object.", 400)
    if "sessionId" in message:
        request = message.get("request")
        if set(message) != {"sessionId", "request"} or not isinstance(request, dict):
            raise RelayError(
                "refused_message",
                "A session request carries sessionId and request only.",
                400,
            )
        kind = request.get("type")
        if kind in REFUSED_MESSAGES:
            raise RelayError(
                "refused_message",
                f"Session request {kind!r} is the watcher's own.",
                400,
            )
        if kind == "command":
            return "mutating"
        if kind == "snapshot":
            return "read_only"
        raise RelayError("refused_message", f"Unknown session request {kind!r}.", 400)
    if len(message) != 1:
        raise RelayError(
            "refused_message", "A relayed message names exactly one request.", 400
        )
    (name,) = message
    if name in REFUSED_MESSAGES:
        raise RelayError("refused_message", f"{name!r} cannot be relayed.", 400)
    if name in MUTATING_MESSAGES:
        return "mutating"
    if name in READ_ONLY_MESSAGES:
        return "read_only"
    raise RelayError("refused_message", f"Unknown relayed message {name!r}.", 400)


def hosted_launch_of(metadata: dict[str, Any] | None) -> str | None:
    """The hosted launch an agent runs under, from its metadata; None if local."""
    value = (metadata or {}).get("hosted_launch_id")
    return value if isinstance(value, str) else None


def frame_size(data: dict[str, Any]) -> int:
    return len(json.dumps(data, separators=(",", ":")).encode())


@dataclass(frozen=True, slots=True)
class WorkerBinding:
    """What an attach proved: which launch revision and host this stream is."""

    launch_id: str
    launch_revision: int
    boot_id: str
    instance_id: str


@dataclass(frozen=True, slots=True)
class IdleReport:
    report_seq: int
    relays_through: int
    busy: bool
    reasons: list[dict[str, Any]]
    sessions: dict[str, int]
    launch_revision: int
    generation: int
    received_monotonic: float
    received_at: datetime


class FrameSlot:
    """A reserved place in a worker's frame queue. Filling it cannot fail."""

    def __init__(self, queue: WorkerFrames, size: int) -> None:
        self._queue = queue
        self._size = size
        self._open = True

    def put(self, event: str, data: dict[str, Any]) -> None:
        if not self._open:
            raise RuntimeError("A frame slot is filled once.")
        self._open = False
        self._queue._fill(self._size, event, data)

    def release(self) -> None:
        if self._open:
            self._open = False
            self._queue._unreserve(self._size)


class WorkerFrames:
    """The protocol 7 frames queued for one worker stream.

    Frames with a body count against the bound, and their place is reserved
    before anything durable is written for them, so a full queue refuses work
    before it takes a sequence number. Doorbells carry no body and are never
    refused.
    """

    def __init__(self, wake: asyncio.Event) -> None:
        self._wake = wake
        self._frames: list[tuple[str, dict[str, Any]]] = []
        self._body_frames = 0
        self._body_bytes = 0
        self._sizes: list[int] = []

    def reserve(self, size: int) -> FrameSlot:
        if (
            self._body_frames + 1 > FRAME_QUEUE_FRAMES
            or self._body_bytes + size > FRAME_QUEUE_BYTES
        ):
            raise WorkerBusyError()
        self._body_frames += 1
        self._body_bytes += size
        return FrameSlot(self, size)

    def push(self, event: str, data: dict[str, Any]) -> None:
        self._frames.append((event, data))
        self._sizes.append(0)
        self._wake.set()

    def _fill(self, size: int, event: str, data: dict[str, Any]) -> None:
        self._frames.append((event, data))
        self._sizes.append(size)
        self._wake.set()

    def _unreserve(self, size: int) -> None:
        self._body_frames -= 1
        self._body_bytes -= size

    def drain(self) -> list[tuple[str, dict[str, Any]]]:
        frames = self._frames
        for size in self._sizes:
            if size:
                self._unreserve(size)
        self._frames = []
        self._sizes = []
        return frames

    def __bool__(self) -> bool:
        return bool(self._frames)


@dataclass
class PendingRelay:
    id: str
    tenant_id: str
    agent_id: str
    launch_id: str
    launch_revision: int
    relay_seq: int | None
    core_boot: int
    connection_id: str
    generation: int
    boot_id: str
    deadline: float
    future: asyncio.Future[dict[str, Any]] = field(repr=False)
    timer: asyncio.TimerHandle | None = field(default=None, repr=False)


class PendingRelays:
    """Relays dispatched to a worker and not yet answered. Memory only.

    Each relay fails `relay_timeout` at its deadline whether or not anyone is
    still waiting for it, and `on_expire` is told so the worker can be sent
    `relay_cancel`.
    """

    def __init__(self, on_expire: Callable[[PendingRelay], None]) -> None:
        self._by_id: dict[str, PendingRelay] = {}
        self._on_expire = on_expire

    def register(
        self,
        *,
        tenant_id: str,
        agent_id: str,
        binding: WorkerBinding,
        relay_seq: int | None,
        core_boot: int,
        connection_id: str,
        generation: int,
        timeout_ms: int,
    ) -> PendingRelay:
        loop = asyncio.get_running_loop()
        relay = PendingRelay(
            id=str(uuid.uuid4()),
            tenant_id=tenant_id,
            agent_id=agent_id,
            launch_id=binding.launch_id,
            launch_revision=binding.launch_revision,
            relay_seq=relay_seq,
            core_boot=core_boot,
            connection_id=connection_id,
            generation=generation,
            boot_id=binding.boot_id,
            deadline=time.monotonic() + timeout_ms / 1000,
            future=loop.create_future(),
        )
        relay.timer = loop.call_later(timeout_ms / 1000, self._expire, relay)
        self._by_id[relay.id] = relay
        return relay

    def get(self, relay_id: str) -> PendingRelay | None:
        return self._by_id.get(relay_id)

    def unregister(self, relay: PendingRelay) -> None:
        """Withdraw a relay that was never sent."""
        if relay.timer is not None:
            relay.timer.cancel()
        self._by_id.pop(relay.id, None)
        if not relay.future.done():
            relay.future.cancel()

    def resolve(self, relay: PendingRelay, answer: dict[str, Any]) -> None:
        if relay.timer is not None:
            relay.timer.cancel()
        relay.future.set_result(answer)
        self._forget_later(relay.id)

    def fail(self, relay: PendingRelay, error: RelayError) -> None:
        if relay.timer is not None:
            relay.timer.cancel()
        if not relay.future.done():
            relay.future.set_exception(error)
            # Nobody may be waiting any more; the failure is still the answer.
            relay.future.exception()
        self._forget_later(relay.id)

    def _expire(self, relay: PendingRelay) -> None:
        if relay.future.done():
            return
        self.fail(
            relay,
            RelayError(
                "relay_timeout",
                "The worker did not answer in time. The outcome is unknown; "
                "check the session before retrying.",
                504,
            ),
        )
        self._on_expire(relay)

    def _forget_later(self, relay_id: str) -> None:
        asyncio.get_running_loop().call_later(
            RELAY_RESOLVED_RETENTION_SECONDS, self._by_id.pop, relay_id, None
        )

    def fail_connection(self, connection_id: str, generation: int | None) -> None:
        """Fail every open relay dispatched to this connection (or generation)."""
        for relay in list(self._by_id.values()):
            if relay.future.done() or relay.connection_id != connection_id:
                continue
            if generation is not None and relay.generation != generation:
                continue
            self.fail(
                relay,
                RelayError(
                    "generation_changed",
                    "The worker stream changed before it answered.",
                    409,
                ),
            )

    def mutating_pending(self, agent_id: str, launch_id: str) -> bool:
        return any(
            not relay.future.done()
            and relay.relay_seq is not None
            and relay.agent_id == agent_id
            and relay.launch_id == launch_id
            for relay in self._by_id.values()
        )


class ConsoleView:
    """One Console relay stream's undelivered frames.

    Bounded; an overflow drops what is buffered and says `resync`, so the
    Console rebuilds its view instead of applying a view with holes in it.
    """

    def __init__(self, subscriptions: frozenset[str]) -> None:
        self.subscriptions = subscriptions
        self.wake = asyncio.Event()
        self._frames: deque[tuple[str, dict[str, Any], int]] = deque()
        self._bytes = 0

    def push(self, event: str, data: dict[str, Any]) -> None:
        size = frame_size(data)
        if (
            len(self._frames) + 1 > CONSOLE_VIEW_FRAMES
            or self._bytes + size > CONSOLE_VIEW_BYTES
        ):
            self._frames.clear()
            self._bytes = 0
            event, data = "resync", {"sessionId": None, "reason": "overflow"}
            size = frame_size(data)
        self._frames.append((event, data, size))
        self._bytes += size
        self.wake.set()

    def drain(self) -> list[tuple[str, dict[str, Any]]]:
        frames = [(event, data) for event, data, _ in self._frames]
        self._frames.clear()
        self._bytes = 0
        return frames


@dataclass
class _Subscription:
    views: set[ConsoleView] = field(default_factory=set)
    #: The worker generation this subscription was last asked of.
    subscribed_generation: int | None = None
    #: The last push forwarded, as (generation, seq).
    last: tuple[int, int] | None = None


def subscribe_message(subscription: str, on: bool) -> dict[str, Any]:
    """The relayed message that starts or stops a worker subscription."""
    if subscription == HEALTH_SUBSCRIPTION:
        return {"watchHealth": on}
    return {"subscribe": subscription} if on else {"unsubscribe": subscription}


class RelayViews:
    """Console live views of hosted workers, one worker subscription each.

    A worker subscription is held once per (agent, session) however many
    Console streams watch it, and released with the last of them.
    """

    def __init__(self) -> None:
        self._subs: dict[tuple[str, str], _Subscription] = {}

    def open(self, agent_id: str, view: ConsoleView) -> None:
        for name in view.subscriptions:
            self._subs.setdefault((agent_id, name), _Subscription()).views.add(view)

    def close(self, agent_id: str, view: ConsoleView) -> list[tuple[str, int | None]]:
        """Drop the view; the subscriptions nothing watches any more.

        Each comes with the generation it was subscribed at, so the caller
        unsubscribes only a worker that was asked.
        """
        released = []
        for name in view.subscriptions:
            sub = self._subs.get((agent_id, name))
            if sub is None:
                continue
            sub.views.discard(view)
            if not sub.views:
                del self._subs[(agent_id, name)]
                released.append((name, sub.subscribed_generation))
        return released

    def unsubscribed(self, agent_id: str, generation: int) -> list[str]:
        """Subscriptions the worker at `generation` has not been asked for yet.

        Marked asked as they are returned, so one Console stream subscribes
        for all of them.
        """
        names = []
        for (agent, name), sub in self._subs.items():
            if agent == agent_id and sub.subscribed_generation != generation:
                sub.subscribed_generation = generation
                names.append(name)
        return names

    def subscribe_failed(self, agent_id: str, name: str, error: RelayError) -> None:
        """Tell every view of a subscription the worker could not be asked, and ask again later."""
        sub = self._subs.get((agent_id, name))
        if sub is None:
            return
        sub.subscribed_generation = None
        session_id = None if name == HEALTH_SUBSCRIPTION else name
        for view in sub.views:
            view.push(
                "error",
                {"sessionId": session_id, "code": error.code, "message": str(error)},
            )

    def deliver(
        self, agent_id: str, generation: int, pushes: list[dict[str, Any]]
    ) -> list[str]:
        """Forward a worker's pushes in order; the subscriptions nobody holds."""
        unsubscribe: list[str] = []
        for push in pushes:
            name = push["subscription"]
            sub = self._subs.get((agent_id, name))
            if sub is None:
                if name not in unsubscribe:
                    unsubscribe.append(name)
                continue
            seq = push["seq"]
            session_id = None if name == HEALTH_SUBSCRIPTION else name
            if sub.last is not None and sub.last[0] == generation:
                if seq <= sub.last[1]:
                    continue
                if seq != sub.last[1] + 1:
                    for view in sub.views:
                        view.push("resync", {"sessionId": session_id, "reason": "gap"})
            sub.last = (generation, seq)
            for key in ("event", "failure", "health"):
                if key in push:
                    frame = (
                        {"health": push[key]}
                        if key == "health"
                        else {"sessionId": session_id, key: push[key]}
                    )
                    for view in sub.views:
                        view.push(key, frame)
        return unsubscribe


def offer_key(boot: int, conn: Connection) -> str:
    """Who holds a wake mailbox offer: this Core boot, the worker's connection and its generation."""
    return f"{boot}:{conn.id}:{conn.stream_generation}"


def attached_worker_for(
    registry: ConnectionRegistry, launch: HostedLaunch
) -> Connection | None:
    """The launch's attached worker, if it is bound to the launch's current revision."""
    if launch.agent_id is None:
        return None
    conn = registry.attached_worker(launch.agent_id)
    if (
        conn is None
        or conn.worker is None
        or conn.worker.launch_id != launch.id
        or conn.worker.launch_revision != launch.revision
    ):
        return None
    return conn
