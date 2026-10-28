"""Fake agent controllers: many agents behind one connection each, the way
most agents reach switch-core (console/packages/agent-controller).

A controller is made through the gateway as the admin, the way Switch Console
makes one for its own machine (`POST /gateway/management/controllers`). From
then on it speaks controller protocol 2 on the agent API, as the real one
does: its credential for an access token, `POST /v1/controllers/{id}/connection`
naming where each of its agents resumes, then the socket
(`.../connection/ws`), where every server `ping` is answered with a `pong`
carrying each agent's cursor. Its agents' events arrive as `agent.event`
frames tagged with the agent and go to that agent's own receiving code, so a
delivery is timed exactly as for an agent with a socket of its own.

The rest of what the real controller sends is sent at the same pace: a
status report on connecting, when its agents change (at most every 5 s) and
every `report_within_s`, saying the provider is installed and signed in,
which placing an agent on it needs; the assignment on connecting, on every
`assignment.changed` and every 10 minutes, with the pending operations. A
dropped socket is reopened from the last cursors with the real controller's
backoff (1 s, doubling to 8 s), and counted, per agent, as a drop.

A controller-backed agent has no key or socket of its own: it posts and reads
on the agent routes with its controller's token (`ManagedAgent`).
"""

from __future__ import annotations

import asyncio
import itertools
import json
import random
import time
from datetime import UTC, datetime
from urllib.parse import urlencode

import httpx
import websockets
from agents import Agent, Stats
from seed import Admin, RequestIds, SeededAgent

PROTOCOL_HEADER = "Switch-Controller-Protocol"
PROTOCOL = "2"
PROVIDER = "claude"
PLATFORM = {"os": "linux", "arch": "x64", "os_version": "loadtest"}
# The real controller's pace (console/packages/agent-controller/src/controller.ts).
STATUS_POLL_S = 5.0
RESYNC_S = 600.0
INITIAL_BACKOFF_S = 1.0
MAX_BACKOFF_S = 8.0
# Exchanged again this long before the access token (an hour) runs out.
TOKEN_MARGIN_S = 300.0


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class FakeController:
    def __init__(
        self,
        index: int,
        controller_id: str,
        name: str,
        credential: str,
        api_base: str,
        http: httpx.AsyncClient,
        ids: RequestIds,
        stats: Stats,
    ) -> None:
        self.index = index
        self.id = controller_id
        self.name = name
        self._credential = credential  # memory only
        self.ws_base = api_base.replace("https://", "wss://", 1).replace(
            "http://", "ws://", 1
        )
        self.http = http
        self.ids = ids
        self.stats = stats
        self.token: str | None = None  # memory only
        self._expires = 0.0
        self.agents: dict[str, ManagedAgent] = {}
        self.cursors: dict[str, int] = {}
        self.attached = asyncio.Event()
        self.reported = asyncio.Event()  # a status report accepted since connecting
        self.report_within = 60.0
        self.revision = 0
        self._seq = itertools.count(int(time.time() * 1000))
        self._changed = asyncio.Event()  # its agents changed: report soon
        self._sync = asyncio.Event()  # pull the assignment soon
        self._tasks: list[asyncio.Task] = []

    def add(self, agent: ManagedAgent) -> None:
        self.agents[agent.s.id] = agent

    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            PROTOCOL_HEADER: PROTOCOL,
            "X-Request-Id": self.ids.next(),
        }

    def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._run()),
            asyncio.create_task(self._report_loop()),
            asyncio.create_task(self._sync_loop()),
        ]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self.attached.clear()
        for a in self.agents.values():
            a.connected.clear()

    async def ensure_token(self) -> None:
        if self.token and time.time() < self._expires - TOKEN_MARGIN_S:
            return
        r = await self.http.post(
            f"/v1/management/controllers/{self.id}/token",
            headers={PROTOCOL_HEADER: PROTOCOL, "X-Request-Id": self.ids.next()},
            json={"credential": self._credential},
        )
        if r.status_code != 200:
            raise RuntimeError(f"token exchange: HTTP {r.status_code}")
        body = r.json()
        self.token = body["access_token"]
        expires = datetime.fromisoformat(body["expires_at"].replace("Z", "+00:00"))
        self._expires = expires.timestamp()

    # ── The connection ─────────────────────────────────────────────────────

    async def _run(self) -> None:
        backoff = INITIAL_BACKOFF_S
        while True:
            opened = time.monotonic()
            why = "closed"
            try:
                await self.ensure_token()
                r = await self.http.post(
                    f"/v1/controllers/{self.id}/connection",
                    headers=self.headers(),
                    json={
                        "client": "switch-loadtest",
                        "client_version": "1",
                        "cursors": dict(self.cursors),
                    },
                )
                if r.status_code != 201:
                    why = f"open HTTP {r.status_code}"
                else:
                    body = r.json()
                    query = urlencode(
                        {
                            "connection_id": body["connection_id"],
                            "generation": str(body["generation"]),
                        }
                    )
                    async with websockets.connect(
                        f"{self.ws_base}/v1/controllers/{self.id}/connection/ws?{query}",
                        additional_headers=self.headers(),
                        open_timeout=30,
                        max_size=None,
                        ping_interval=None,  # the server's ping frames are the heartbeat
                    ) as ws:
                        why = await self._read(ws, opened)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - every ending is counted and retried
                why = type(exc).__name__
            self._lost(why)
            if why == "taken_over":
                return  # reopening would itself be a takeover
            if time.monotonic() - opened > 10:
                backoff = INITIAL_BACKOFF_S
            await asyncio.sleep(backoff * (0.5 + random.random()))
            backoff = min(backoff * 2, MAX_BACKOFF_S)

    def _lost(self, why: str) -> None:
        if self.attached.is_set():
            self.stats.event("controller_drop", self.name, why=why)
        else:
            self.stats.event("controller_connect_failed", self.name, why=why)
        self.attached.clear()
        self.reported.clear()
        now = time.monotonic()
        for a in self.agents.values():
            if a.connected.is_set():
                self.stats.event("drop", a.s.name, why=why)
                a.connected.clear()
                a.waiting_since = now

    async def _read(self, ws, opened: float) -> str:
        async for raw in ws:
            msg = json.loads(raw)
            ev = msg.get("event")
            data = msg.get("data") or {}
            if ev == "ping":
                await ws.send(json.dumps({"type": "pong", "cursors": self.cursors}))
                continue
            if ev == "agent.event":
                agent_id = data.get("agent_id")
                seq = data.get("seq")
                if isinstance(seq, int) and seq > self.cursors.get(agent_id, -1):
                    self.cursors[agent_id] = seq
                agent = self.agents.get(agent_id)
                if agent is not None and isinstance(data.get("event"), dict):
                    agent._on_event(data["event"])
                continue
            if ev == "connection_state":
                self.report_within = float(data.get("report_within_s") or 60)
                self.revision = int(data.get("assignment_revision") or 0)
                if not self.attached.is_set():
                    self.stats.event(
                        "controller_connected",
                        self.name,
                        open_s=round(time.monotonic() - opened, 3),
                    )
                self.attached.set()
                self._changed.set()
                self._sync.set()
                continue
            if ev == "agent.attached":
                self._attach(data)
                continue
            if ev == "agent.gap":
                agent = self.agents.get(data.get("agent_id"))
                self.stats.event(
                    "gap",
                    agent.s.name if agent else self.name,
                    reason=str(data.get("reason"))[:120],
                )
                if isinstance(data.get("resumed_at"), int):
                    self.cursors[data["agent_id"]] = data["resumed_at"]
                continue
            if ev == "agent.detached":
                agent = self.agents.get(data.get("agent_id"))
                if agent is not None and agent.connected.is_set():
                    self.stats.event(
                        "detached", agent.s.name, reason=str(data.get("reason"))
                    )
                    agent.connected.clear()
                    self._changed.set()
                continue
            if ev == "assignment.changed":
                self._sync.set()
                continue
            if ev == "evicted":
                code = str(data.get("code"))
                self.stats.event("controller_evicted", self.name, code=code)
                return code
            if ev == "refused":
                self.stats.event("refused", self.name, detail=str(data)[:200])
                return f"refused {data.get('status')}"
            if ev == "credential.revoked":
                return "credential_revoked"
            # agent.rooms, agent.warm, agent.session_command,
            # agent.approval_outcome, operation.pending: nothing to run here.
        return "closed"

    def _attach(self, data: dict) -> None:
        agent_id = data.get("agent_id")
        from_seq = data.get("from_seq")
        if isinstance(from_seq, int) and from_seq > self.cursors.get(agent_id, -1):
            self.cursors[agent_id] = from_seq
        agent = self.agents.get(agent_id)
        if agent is None or agent.connected.is_set():
            return
        waited = time.monotonic() - (agent.waiting_since or time.monotonic())
        self.stats.event("connected", agent.s.name, open_s=round(waited, 3))
        agent.connected.set()
        self._changed.set()

    # ── What the controller sends besides its beat ─────────────────────────

    async def report(self) -> None:
        await self.ensure_token()
        now = _now()
        body = {
            "seq": next(self._seq),
            "observed_at": now,
            "controller": {
                "version": "loadtest",
                "protocol": int(PROTOCOL),
                "assignment_revision": self.revision,
                "updated_by": "console",
            },
            "machine": {
                "platform": PLATFORM,
                "disk_free_bytes": 50 * 2**30,
                "disk_total_bytes": 100 * 2**30,
                "mem_free_bytes": 8 * 2**30,
                "mem_total_bytes": 16 * 2**30,
                "sessions_running": 0,
                "sessions_max": 40,
                "workspaces_dir": "/srv/loadtest",
            },
            "providers": [
                {
                    "provider": PROVIDER,
                    "installed": True,
                    "version": "loadtest",
                    "auth": "ok",
                    "auth_source": "loadtest",
                    "checked_at": now,
                }
            ],
            "tools": [],
            "agents": [
                {
                    "agent_id": a.s.id,
                    "applied_revision": None,
                    "process": "running",
                    "attached": True,
                    "sessions": {"active": 0, "ids": []},
                    "restarts_10m": 0,
                    "oom_kills": 0,
                    "since": now,
                }
                for a in self.agents.values()
                if a.connected.is_set()
            ],
        }
        r = await self.http.put(
            f"/v1/management/controllers/{self.id}/status",
            headers=self.headers(),
            json=body,
        )
        if r.status_code != 200:
            self.stats.event("status_failed", self.name, status=r.status_code)
            return
        answer = r.json()
        self.report_within = float(answer.get("report_within_s") or self.report_within)
        self.reported.set()

    async def _report_loop(self) -> None:
        last = 0.0
        while True:
            await self.attached.wait()
            due = time.monotonic() - last >= self.report_within
            if due or self._changed.is_set() or not self.reported.is_set():
                self._changed.clear()
                last = time.monotonic()
                try:
                    await self.report()
                except (httpx.HTTPError, RuntimeError) as exc:
                    self.stats.event("status_failed", self.name, why=type(exc).__name__)
            await asyncio.sleep(STATUS_POLL_S)

    async def _sync_loop(self) -> None:
        last = time.monotonic()
        while True:
            try:
                await asyncio.wait_for(
                    self._sync.wait(),
                    timeout=max(0.0, RESYNC_S - (time.monotonic() - last)),
                )
            except TimeoutError:
                pass
            self._sync.clear()
            last = time.monotonic()
            if not self.attached.is_set():
                continue
            try:
                await self.ensure_token()
                await self.http.get(
                    f"/v1/management/controllers/{self.id}/assignment",
                    headers=self.headers(),
                )
                await self.http.get(
                    f"/v1/management/controllers/{self.id}/operations",
                    headers=self.headers(),
                    params={"state": "pending"},
                )
            except (httpx.HTTPError, RuntimeError) as exc:
                self.stats.event("sync_failed", self.name, why=type(exc).__name__)


class ManagedAgent(Agent):
    """An agent behind a fake controller, with no socket of its own.

    Starting it places it on its controller, as moving an agent onto a machine
    in the gateway does (`PATCH /gateway/management/agents/{id}`); the
    controller's stream then attaches it, and it counts as connected from that
    `agent.attached` frame. It posts and reads with the controller's token.
    It receives only the messages that address it, so its messages @-mention
    the room's other members, as a person would to bring their agents in.
    """

    mentions_receivers = True

    def __init__(
        self,
        seeded: SeededAgent,
        rooms: list[str],
        ids: RequestIds,
        stats: Stats,
        http: httpx.AsyncClient,
        read_fraction: float,
        seed: int,
        controller: FakeController,
        admin: Admin,
    ) -> None:
        self.controller = controller
        super().__init__(
            seeded, rooms, "http://unused", ids, stats, http, read_fraction, seed
        )
        self.admin = admin
        self.waiting_since: float | None = None
        controller.add(self)

    @property
    def auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.controller.token}"}

    @auth.setter
    def auth(self, value: dict[str, str]) -> None:
        pass  # the controller's token, never a key of its own

    def start(self) -> None:
        self.task = asyncio.create_task(self._place())

    async def _place(self) -> None:
        backoff = 1.0
        while True:
            self.waiting_since = time.monotonic()
            try:
                r = await self.admin.call(
                    "PATCH",
                    f"/management/agents/{self.s.id}",
                    json={"controller_id": self.controller.id},
                )
                if r.status_code == 200:
                    return
                why = f"place HTTP {r.status_code} {r.text[:120]}"
            except httpx.HTTPError as exc:
                why = f"place {type(exc).__name__}"
            self.stats.event("connect_failed", self.s.name, why=why)
            await asyncio.sleep(backoff * (0.5 + random.random()))
            backoff = min(backoff * 2, 30)
