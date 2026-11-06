"""Fake agents on the agent WebSocket, and the traffic between them.

Each agent opens `/agents/{id}/connection/ws` the way the agent runtime does
(console/packages/switch-agent-runtime/src/event-stream.ts): agent-protocol
9, its rooms declared, `start_at` its position, every `ping` answered with a
`pong` carrying its cursor and position. It reads frames and does nothing
else unless the traffic asks it to post or to read a room's context. A
dropped socket is reopened from the last position with backoff, and counted.
With `retry="runtime"` it is reopened the way the real runtime does it: every
250 to 750 ms for a minute after the server closed it with 1012 (restarting),
otherwise a doubling backoff with no jitter, and never again once a reattach
is refused as taken over. With `honor_busy`, a busy server's `retry_after_s`
is waited out first, as the runtime does from the open gate's release on.

A message's text starts `lt:<token>:`; a receiver that sees one of its own
run's tokens records the time from the send to its arrival.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from urllib.parse import urlencode

import httpx
import websockets
from seed import RequestIds, SeededAgent
from workload import Send, payload, rng_for

OWN_EVENTS = "s"
PROTOCOL = 9
TOKEN = re.compile(r"lt:([A-Za-z0-9._-]+):")


def furthest(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        if isinstance(v, int) and v > out.get(k, -1):
            out[k] = v
    return out


@dataclass
class Message:
    token: str
    phase: str
    room: str
    sender: str
    size: int
    sent: float  # monotonic, when the POST went out
    expected: int  # connected members other than the sender, at send time
    acked: float | None = None
    status: int | None = None
    latencies: list[float] = field(default_factory=list)  # seconds, send to receive


@dataclass
class Stats:
    phase: str = "setup"
    messages: dict[str, Message] = field(default_factory=dict)
    # The same messages and events by window, so reading one window's never
    # goes through every window before it.
    by_phase: dict[str, list[Message]] = field(
        default_factory=lambda: defaultdict(list)
    )
    seen: set[tuple[str, str]] = field(default_factory=set)
    send_errors: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    reads: dict[str, list[float]] = field(default_factory=lambda: defaultdict(list))
    read_errors: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    events: list[dict] = field(default_factory=list)  # connects, drops, refusals, gaps
    events_by_phase: dict[str, list[dict]] = field(
        default_factory=lambda: defaultdict(list)
    )
    lag_max: dict[str, float] = field(default_factory=lambda: defaultdict(float))

    def add(self, msg: Message) -> None:
        self.messages[msg.token] = msg
        self.by_phase[msg.phase].append(msg)

    def event(self, kind: str, agent: str, **kw) -> None:
        e = {"t": time.time(), "phase": self.phase, "kind": kind, "agent": agent, **kw}
        self.events.append(e)
        self.events_by_phase[self.phase].append(e)


class Agent:
    # An agent reading its own socket with `scope=all` gets every message in
    # its rooms. A controller-backed agent gets only the messages that address
    # it, so its senders @-mention the receivers (controllers.ManagedAgent).
    mentions_receivers = False

    def __init__(
        self,
        seeded: SeededAgent,
        rooms: list[str],
        base_url: str,
        ids: RequestIds,
        stats: Stats,
        http: httpx.AsyncClient,
        read_fraction: float,
        seed: int,
        retry: str = "harness",
        honor_busy: bool = False,
    ) -> None:
        self.s = seeded
        self.retry = retry
        self.honor_busy = honor_busy
        self._restarting_until = 0.0
        self._refusal: dict | None = None
        self.rooms = rooms
        self.ws_base = base_url.replace("https://", "wss://", 1).replace(
            "http://", "ws://", 1
        )
        self.ids = ids
        self.stats = stats
        self.http = http
        self.read_fraction = read_fraction
        self.seed = seed
        self.connection_id = str(uuid.uuid4())
        self.position: dict[str, int] = {}
        self.generation: int | None = None
        self.connected = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.auth = {"Authorization": f"Bearer {seeded.key}"}

    @property
    def cursor(self) -> int:
        return self.position.get(OWN_EVENTS, 0)

    def start(self) -> None:
        self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        self.connected.clear()

    def _url(self) -> str:
        params = {
            "connection_id": self.connection_id,
            "scope": "all",
            "filter": "all",
            "start_from": str(self.cursor) if self.cursor else "head",
            "start_at": json.dumps(self.position) if self.position else "head",
            "protocol": str(PROTOCOL),
            "protocol_accepts": "1",
            "client": "switch-loadtest",
            "client_version": "1",
            "rooms": ",".join(self.rooms),
        }
        if self.generation is not None:
            params["expected_generation"] = str(self.generation)
        return f"{self.ws_base}/agents/{self.s.id}/connection/ws?{urlencode(params)}"

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            opened = time.monotonic()
            why = "closed"
            close_code: int | None = None
            try:
                async with websockets.connect(
                    self._url(),
                    additional_headers={**self.auth, "X-Request-Id": self.ids.next()},
                    open_timeout=30,
                    max_size=None,
                    ping_interval=None,  # the server's own ping frames are the heartbeat
                ) as ws:
                    self._restarting_until = 0.0  # the runtime ends it on an open
                    why = await self._read(ws, opened)
                close_code = ws.close_code
            except asyncio.CancelledError:
                raise
            except websockets.ConnectionClosed as exc:
                why = type(exc).__name__
                close_code = exc.rcvd.code if exc.rcvd is not None else None
            except Exception as exc:  # noqa: BLE001 - every ending is counted and retried
                why = type(exc).__name__
            if self.connected.is_set():
                self.stats.event("drop", self.s.name, why=why, code=close_code)
            elif why != "taken_over":
                self.stats.event("connect_failed", self.s.name, why=why)
            self.connected.clear()
            if why == "taken_over":
                return  # reopening would itself be a takeover
            refusal, self._refusal = self._refusal, None
            detail = (refusal or {}).get("detail")
            code = detail.get("code") if isinstance(detail, dict) else None
            if self.retry == "runtime" and code == "taken_over":
                # The runtime reads a reattach refused as taken over as another
                # client holding the connection, and stands down for good.
                self.stats.event("stood_down", self.s.name)
                return
            if (
                self.honor_busy
                and code == "busy"
                and isinstance(detail.get("retry_after_s"), (int, float))
            ):
                await asyncio.sleep(detail["retry_after_s"])
                continue
            if self.retry == "runtime":
                if close_code == 1012:
                    self._restarting_until = time.monotonic() + 60
                if time.monotonic() - opened >= 30:
                    backoff = 1.0  # only a stream that lasted resets it
                if time.monotonic() < self._restarting_until:
                    await asyncio.sleep(0.25 + random.random() * 0.5)
                    continue
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
                continue
            if time.monotonic() - opened > 10:
                backoff = 1.0
            await asyncio.sleep(backoff * (0.5 + random.random()))
            backoff = min(backoff * 2, 30)

    async def _read(self, ws, opened: float) -> str:
        async for raw in ws:
            msg = json.loads(raw)
            ev = msg.get("event")
            data = msg.get("data") or {}
            if ev == "ping":
                await ws.send(
                    json.dumps(
                        {
                            "type": "pong",
                            "cursor": self.cursor,
                            "position": self.position,
                        }
                    )
                )
                continue
            if ev == "refused":
                self._refusal = data
                self.stats.event("refused", self.s.name, detail=str(data)[:200])
                return f"refused {data.get('status')}"
            if ev == "connection_state":
                self.generation = data.get("generation", self.generation)
                if isinstance(data.get("position"), dict):
                    self.position = furthest(self.position, data["position"])
                if not self.connected.is_set():
                    self.stats.event(
                        "connected",
                        self.s.name,
                        open_s=round(time.monotonic() - opened, 3),
                    )
                self.connected.set()
                continue
            if ev == "evicted":
                code = str(data.get("code"))
                self.stats.event("evicted", self.s.name, code=code)
                return code
            if ev == "gap":
                self.stats.event(
                    "gap", self.s.name, reason=str(data.get("reason"))[:120]
                )
                if isinstance(data.get("resumed_position"), dict):
                    self.position = data["resumed_position"]
                continue
            self._on_event(data)
            if isinstance(data.get("position"), dict):
                self.position = furthest(self.position, data["position"])
            elif msg.get("id") is not None:
                self.position = furthest(self.position, {OWN_EVENTS: int(msg["id"])})
        return "closed"

    def _on_event(self, data: dict) -> None:
        now = time.monotonic()
        m = TOKEN.search(_text(data))
        if not m:
            return
        token = m.group(1)
        msg = self.stats.messages.get(token)
        if (
            msg is None
            or msg.sender == self.s.id
            or (token, self.s.id) in self.stats.seen
        ):
            return
        self.stats.seen.add((token, self.s.id))
        msg.latencies.append(now - msg.sent)
        if (
            self.read_fraction > 0
            and rng_for(self.seed, "read", token, self.s.index).random()
            < self.read_fraction
        ):
            asyncio.create_task(self.read_context(msg.room, msg.phase))

    async def read_context(self, room: str, phase: str) -> None:
        t = time.monotonic()
        status, detail = await self.read(room)
        if status == 200:
            self.stats.reads[phase].append(time.monotonic() - t)
        else:
            self.stats.read_errors[phase] += 1
            self.stats.event("read_error", self.s.name, status=status, detail=detail)

    async def read(self, room: str) -> tuple[int, str]:
        """One `read_context` of `room`: the status, -1 when nothing came back,
        and what was said about a failure."""
        try:
            r = await self.http.post(
                f"/agents/{self.s.id}/ops/read_context",
                headers={**self.auth, "X-Request-Id": self.ids.next()},
                json={"room_id": room, "limit": 20},
            )
        except httpx.HTTPError as exc:
            return -1, type(exc).__name__
        return r.status_code, "" if r.status_code == 200 else r.text[:200]

    async def post(self, room: str, content: str) -> int:
        """Post `content` to `room`: the status, -1 when nothing came back."""
        try:
            r = await self.http.post(
                f"/agents/{self.s.id}/message",
                headers={**self.auth, "X-Request-Id": self.ids.next()},
                json={"room_id": room, "content": content},
            )
        except httpx.HTTPError as exc:
            self.stats.event("send_error", self.s.name, why=type(exc).__name__)
            return -1
        return r.status_code


def _text(data: dict) -> str:
    """Where a room message's text is, across frame shapes: the body or
    content field when there is one, the whole frame otherwise."""
    for path in (("payload", "body"), ("body",), ("content",), ("message", "body")):
        v: object = data
        for k in path:
            v = v.get(k) if isinstance(v, dict) else None
        if isinstance(v, str):
            return v
    return json.dumps(data)


async def play(
    schedule: list[Send],
    agents: list[Agent],
    room_ids: list[str],
    membership: list[list[int]],
    stats: Stats,
    run_id: str,
    phase: str,
    stop: asyncio.Event,
) -> None:
    """Post the schedule's messages at their times. Records how far behind
    schedule the harness itself fell (`lag_max`): when that grows past a few
    hundred milliseconds the client, not the server, is the limit."""
    t0 = time.monotonic()
    tasks: list[asyncio.Task] = []
    for n, send in enumerate(schedule):
        delay = t0 + send.at - time.monotonic()
        if delay > 0:
            try:
                await asyncio.wait_for(stop.wait(), delay)
                break
            except TimeoutError:
                pass
        elif stop.is_set():
            break
        stats.lag_max[phase] = max(stats.lag_max[phase], -delay if delay < 0 else 0.0)
        tasks.append(
            asyncio.create_task(
                _post(send, n, agents, room_ids, membership, stats, run_id, phase)
            )
        )
    await asyncio.gather(*tasks, return_exceptions=True)


async def _post(
    send: Send,
    n: int,
    agents: list[Agent],
    room_ids: list[str],
    membership: list[list[int]],
    stats: Stats,
    run_id: str,
    phase: str,
) -> None:
    sender = agents[send.sender]
    token = f"{run_id}.{phase.replace('@', '.')}.{n}"
    expected = sum(
        1
        for a in membership[send.room]
        if a != send.sender and a < len(agents) and agents[a].connected.is_set()
    )
    msg = Message(
        token,
        phase,
        room_ids[send.room],
        sender.s.id,
        send.size,
        time.monotonic(),
        expected,
    )
    stats.add(msg)
    content = payload(token, send.size)
    if sender.mentions_receivers:
        names = (
            agents[a].s.name
            for a in membership[send.room]
            if a != send.sender and a < len(agents)
        )
        content = " ".join(f"@{n}" for n in names) + " " + content
    msg.status = await sender.post(msg.room, content)
    msg.acked = time.monotonic()
    if msg.status != 200:
        stats.send_errors[phase] += 1
        msg.expected = 0
