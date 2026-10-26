"""Fake agents on the agent WebSocket, and the traffic between them.

Each agent opens `/agents/{id}/connection/ws` the way the agent runtime does
(console/packages/switch-agent-runtime/src/event-stream.ts): agent-protocol
9, its rooms declared, `start_at` its position, every `ping` answered with a
`pong` carrying its cursor and position. It reads frames and does nothing
else unless the traffic asks it to post or to read a room's context. A
dropped socket is reopened from the last position with backoff, and counted.

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
    seen: set[tuple[str, str]] = field(default_factory=set)
    send_errors: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    reads: dict[str, list[float]] = field(default_factory=lambda: defaultdict(list))
    read_errors: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    events: list[dict] = field(default_factory=list)  # connects, drops, refusals, gaps
    lag_max: dict[str, float] = field(default_factory=lambda: defaultdict(float))

    def event(self, kind: str, agent: str, **kw) -> None:
        self.events.append(
            {"t": time.time(), "phase": self.phase, "kind": kind, "agent": agent, **kw}
        )


class Agent:
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
    ) -> None:
        self.s = seeded
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
            try:
                async with websockets.connect(
                    self._url(),
                    additional_headers={**self.auth, "X-Request-Id": self.ids.next()},
                    open_timeout=30,
                    max_size=None,
                    ping_interval=None,  # the server's own ping frames are the heartbeat
                ) as ws:
                    why = await self._read(ws, opened)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - every ending is counted and retried
                why = type(exc).__name__
            if self.connected.is_set():
                self.stats.event("drop", self.s.name, why=why)
            elif why != "taken_over":
                self.stats.event("connect_failed", self.s.name, why=why)
            self.connected.clear()
            if why == "taken_over":
                return  # reopening would itself be a takeover
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
        try:
            r = await self.http.post(
                f"/agents/{self.s.id}/ops/read_context",
                headers={**self.auth, "X-Request-Id": self.ids.next()},
                json={"room_id": room, "limit": 20},
            )
            ok = r.status_code == 200
        except httpx.HTTPError:
            ok = False
        if ok:
            self.stats.reads[phase].append(time.monotonic() - t)
        else:
            self.stats.read_errors[phase] += 1


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
    stats.messages[token] = msg
    try:
        r = await sender.http.post(
            f"/agents/{sender.s.id}/message",
            headers={**sender.auth, "X-Request-Id": sender.ids.next()},
            json={"room_id": msg.room, "content": payload(token, send.size)},
        )
        msg.status = r.status_code
    except httpx.HTTPError as exc:
        msg.status = -1
        stats.event("send_error", sender.s.name, why=type(exc).__name__)
    msg.acked = time.monotonic()
    if msg.status != 200:
        stats.send_errors[phase] += 1
        msg.expected = 0
