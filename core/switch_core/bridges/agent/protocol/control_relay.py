"""Console relays: the message vocabulary, live views, and controller relays.

A Console request for an agent is relayed through Core to the agents
controller that runs it, which is sent `agent.control` frames on its one stream
and replies over management routes. It answers the host control vocabulary
(`classify_message`, plus `ensure`; see `classify_control_message`) within the
limits here, and its pushes feed Console views (`ConsoleView`, `RelayViews`).

Everything here is memory only and per Core boot. A relay lost to a restart
fails for its caller as a timeout, never as delivered.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

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

#: Start or restart a session; relayed to a controller only.
CONTROL_START_MESSAGE = "ensure"

MessageKind = Literal["mutating", "read_only"]


class RelayError(Exception):
    """A relay that could not be answered, with the code Console acts on."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


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


def classify_control_message(message: dict[str, Any]) -> MessageKind:
    """`classify_message` for a relay to an agent's controller.

    A controller starts and restarts its agents' sessions on Console's
    request, so `ensure` passes here where `classify_message` refuses it.
    """
    if isinstance(message, dict) and set(message) == {CONTROL_START_MESSAGE}:
        return "mutating"
    return classify_message(message)


def frame_size(data: dict[str, Any]) -> int:
    return len(json.dumps(data, separators=(",", ":")).encode())


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
    """Console live views of controller-run agents, one host subscription each.

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
            _show(sub, session_id, push)
        return unsubscribe

    def holds(self, agent_id: str, name: str) -> bool:
        """Whether a Console view still holds the subscription."""
        return (agent_id, name) in self._subs


def _show(sub: _Subscription, session_id: str | None, push: dict[str, Any]) -> None:
    for key in ("event", "failure", "health"):
        if key in push:
            frame = (
                {"health": push[key]}
                if key == "health"
                else {"sessionId": session_id, key: push[key]}
            )
            for view in sub.views:
                view.push(key, frame)


#: The controller stream frames that carry a relayed Console request, and
#: withdraw one whose deadline passed after it was written.
CONTROL_FRAME = "agent.control"
CONTROL_CANCEL_FRAME = "agent.control_cancel"

#: Bound on the control frames queued for one controller and not yet written
#: to its stream.
CONTROL_QUEUE_FRAMES = 64
CONTROL_QUEUE_BYTES = 8 * 1024 * 1024
#: Room for a control frame's own fields around the relayed message.
CONTROL_FRAME_ENVELOPE_BYTES = 256


class AgentControlFrame(BaseModel):
    """`agent.control`: answer `message` for `agent_id`, by `deadline_ms`
    (milliseconds since the epoch), at `POST .../control/{relay_id}`."""

    model_config = ConfigDict(extra="forbid")
    relay_id: str
    agent_id: str
    message: dict[str, Any]
    deadline_ms: int


class AgentControlCancelFrame(BaseModel):
    """`agent.control_cancel`: nobody is waiting for this relay any more."""

    model_config = ConfigDict(extra="forbid")
    relay_id: str


@dataclass
class ControllerRelay:
    """A Console request sent to an agent's controller, until it answers."""

    id: str
    tenant_id: str
    controller_id: str
    agent_id: str
    #: The controller stream it was queued for (`ControlRelays.generation`).
    generation: int | None
    deadline: float
    future: asyncio.Future[dict[str, Any]] = field(repr=False)
    timer: asyncio.TimerHandle | None = field(default=None, repr=False)
    #: Written to a stream; a relay that expires after this is cancelled.
    sent: bool = False


@dataclass(eq=False)
class ControlOutlet:
    """One open controller stream that control frames can be written to."""

    controller_id: str
    generation: int
    wake: asyncio.Event


@dataclass
class _Queued:
    event: str
    data: dict[str, Any]
    size: int
    relay_id: str | None


class ControlRelays:
    """Console relays to agents controllers, and the views fed by their pushes.

    Frames queue per controller and are taken by its newest open stream only,
    so a stream being taken over does not take frames meant for its
    successor. Each relay fails `relay_timeout` at its deadline whether or not
    anyone still waits for it; one already written is then cancelled, one
    still queued is dropped unsent.
    """

    def __init__(self) -> None:
        self.views = RelayViews()
        self._by_id: dict[str, ControllerRelay] = {}
        self._queues: dict[str, deque[_Queued]] = {}
        self._queued_bytes: dict[str, int] = {}
        self._outlets: dict[str, list[ControlOutlet]] = {}
        self._generations = itertools.count(1)

    # -- Console side ---------------------------------------------------

    def dispatch(
        self,
        *,
        tenant_id: str,
        controller_id: str,
        agent_id: str,
        message: dict[str, Any],
        timeout_ms: int,
    ) -> ControllerRelay:
        size = frame_size(message) + CONTROL_FRAME_ENVELOPE_BYTES
        queue = self._queues.get(controller_id, deque())
        if (
            len(queue) + 1 > CONTROL_QUEUE_FRAMES
            or self._queued_bytes.get(controller_id, 0) + size > CONTROL_QUEUE_BYTES
        ):
            raise RelayError(
                "controller_busy",
                "The controller's control queue is full. Retry shortly.",
                503,
            )
        loop = asyncio.get_running_loop()
        relay = ControllerRelay(
            id=str(uuid.uuid4()),
            tenant_id=tenant_id,
            controller_id=controller_id,
            agent_id=agent_id,
            generation=self.generation(controller_id),
            deadline=time.monotonic() + timeout_ms / 1000,
            future=loop.create_future(),
        )
        relay.timer = loop.call_later(timeout_ms / 1000, self._expire, relay)
        self._by_id[relay.id] = relay
        frame = AgentControlFrame(
            relay_id=relay.id,
            agent_id=agent_id,
            message=message,
            deadline_ms=int(time.time() * 1000) + timeout_ms,
        )
        self._enqueue(controller_id, CONTROL_FRAME, frame.model_dump(), size, relay.id)
        return relay

    def pending_control_relays(self, controller_id: str) -> int:
        """Relays dispatched to the controller and not yet answered or expired."""
        return sum(
            1
            for relay in self._by_id.values()
            if relay.controller_id == controller_id and not relay.future.done()
        )

    # -- Controller side ------------------------------------------------

    def get(self, relay_id: str) -> ControllerRelay | None:
        return self._by_id.get(relay_id)

    def resolve(self, relay: ControllerRelay, answer: dict[str, Any]) -> None:
        if relay.timer is not None:
            relay.timer.cancel()
        relay.future.set_result(answer)
        self._forget_later(relay.id)

    def open_outlet(self, controller_id: str, wake: asyncio.Event) -> ControlOutlet:
        """A stream opened for the controller; it takes the frames from now on."""
        outlet = ControlOutlet(controller_id, next(self._generations), wake)
        self._outlets.setdefault(controller_id, []).append(outlet)
        if self._queues.get(controller_id):
            wake.set()
        return outlet

    def close_outlet(self, outlet: ControlOutlet) -> None:
        outlets = self._outlets.get(outlet.controller_id)
        if outlets is None or outlet not in outlets:
            return
        outlets.remove(outlet)
        if not outlets:
            del self._outlets[outlet.controller_id]
        elif self._queues.get(outlet.controller_id):
            outlets[-1].wake.set()

    def generation(self, controller_id: str) -> int | None:
        """Which of the controller's streams is current; None with none open."""
        outlets = self._outlets.get(controller_id)
        return outlets[-1].generation if outlets else None

    def take_frames(self, outlet: ControlOutlet) -> list[tuple[str, dict[str, Any]]]:
        """The frames owed to the controller, if `outlet` is its current stream."""
        outlets = self._outlets.get(outlet.controller_id)
        if not outlets or outlets[-1] is not outlet:
            return []
        queue = self._queues.pop(outlet.controller_id, deque())
        self._queued_bytes.pop(outlet.controller_id, None)
        frames: list[tuple[str, dict[str, Any]]] = []
        for queued in queue:
            if queued.relay_id is not None:
                relay = self._by_id.get(queued.relay_id)
                if relay is None or relay.future.done():
                    continue
                relay.sent = True
            frames.append((queued.event, queued.data))
        return frames

    # -- Internals ------------------------------------------------------

    def _enqueue(
        self,
        controller_id: str,
        event: str,
        data: dict[str, Any],
        size: int,
        relay_id: str | None,
    ) -> None:
        self._queues.setdefault(controller_id, deque()).append(
            _Queued(event, data, size, relay_id)
        )
        self._queued_bytes[controller_id] = (
            self._queued_bytes.get(controller_id, 0) + size
        )
        outlets = self._outlets.get(controller_id)
        if outlets:
            outlets[-1].wake.set()

    def _unqueue(self, relay: ControllerRelay) -> None:
        queue = self._queues.get(relay.controller_id)
        if queue is None:
            return
        for queued in list(queue):
            if queued.relay_id == relay.id:
                queue.remove(queued)
                self._queued_bytes[relay.controller_id] -= queued.size
        if not queue:
            del self._queues[relay.controller_id]
            self._queued_bytes.pop(relay.controller_id, None)

    def _expire(self, relay: ControllerRelay) -> None:
        if relay.future.done():
            return
        relay.future.set_exception(
            RelayError(
                "relay_timeout",
                "The controller did not answer in time. The outcome is unknown; "
                "check the session before retrying.",
                504,
            )
        )
        # Nobody may be waiting any more; the failure is still the answer.
        relay.future.exception()
        self._forget_later(relay.id)
        if relay.sent:
            cancel = AgentControlCancelFrame(relay_id=relay.id).model_dump()
            self._enqueue(
                relay.controller_id,
                CONTROL_CANCEL_FRAME,
                cancel,
                frame_size(cancel),
                None,
            )
        else:
            self._unqueue(relay)

    def _forget_later(self, relay_id: str) -> None:
        asyncio.get_running_loop().call_later(
            RELAY_RESOLVED_RETENTION_SECONDS, self._by_id.pop, relay_id, None
        )
