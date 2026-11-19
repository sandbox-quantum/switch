"""Switch Console windows, as the gateway sees them.

A Console window re-reads its sidebar every 20 seconds while it is visible
(`ROOM_STATE_RECONCILE_MS` in console/apps/switch-console-desktop/src/
renderer/features/sidebar/sidebar-grouped-list.tsx), and again on focus and
whenever the server pushes a room change. A re-read asks for the room list
and for the rooms of every agent the window tracks, all at once, and the next
one starts on time whether or not the last has finished. Agents' rooms are
read one of two ways, and both are in the field while people update:

- `per-agent`: one `GET /gateway/agents/{id}` per agent, as every Console
  from before `GET /gateway/agents/rooms` does.
- `batch`: one `GET /gateway/agents/rooms` per 100 agents. A server without
  that route answers 404, which counts as an error: a run in this mode is
  there to measure the route, not to fall back quietly.

Every window here is signed in as the run's admin, who owns the run's agents,
as a person's Console tracks the agents they own.
"""

from __future__ import annotations

import asyncio
import time

import httpx
from agents import Stats
from seed import RequestIds
from workload import rng_for

MODES = ("per-agent", "batch")
# The most agents one `GET /gateway/agents/rooms` takes.
BATCH = 100


def membership_reads(mode: str, agent_ids: list[str]) -> list[tuple[str, list]]:
    """The requests, as (path, query), that read these agents' rooms the way a
    Console of `mode` reads them."""
    if mode == "per-agent":
        return [(f"/agents/{agent_id}", []) for agent_id in agent_ids]
    return [
        ("/agents/rooms", [("agent_id", a) for a in agent_ids[i : i + BATCH]])
        for i in range(0, len(agent_ids), BATCH)
    ]


def tracked_agents(
    agent_ids: list[str], windows: int, per_window: int
) -> list[list[str]]:
    """The agents each window tracks: the next `per_window` of the run's
    agents for each window in turn, starting over from the first when the
    windows want more agents than the run has."""
    if not agent_ids:
        return [[] for _ in range(windows)]
    n = min(per_window, len(agent_ids))
    return [
        [agent_ids[(w * per_window + i) % len(agent_ids)] for i in range(n)]
        for w in range(windows)
    ]


class Console:
    """One Console window, re-reading its sidebar every `interval` seconds."""

    def __init__(
        self,
        index: int,
        gateway_url: str,
        cookie: str,
        agent_ids: list[str],
        mode: str,
        interval: float,
        ids: RequestIds,
        stats: Stats,
        seed: int,
    ) -> None:
        if mode not in MODES:
            raise ValueError(f"unknown console mode {mode!r}")
        self.index = index
        self.cookie = cookie
        self.agent_ids = agent_ids
        self.mode = mode
        self.interval = interval
        self.ids = ids
        self.stats = stats
        self.seed = seed
        # One client per window, with no cap on connections: the Console's
        # main process sends every request of a re-read at once.
        self.http = httpx.AsyncClient(
            base_url=gateway_url.rstrip("/"),
            timeout=60,
            limits=httpx.Limits(max_connections=None, max_keepalive_connections=None),
        )
        self._refreshes: set[asyncio.Task] = set()

    async def run(self, stop: asyncio.Event) -> None:
        """Re-read on the window's timer until `stop`. Windows are not in step:
        each starts somewhere in its first interval."""
        rng = rng_for(self.seed, "console", self.index)
        start = time.monotonic() + rng.uniform(0, self.interval)
        due = start
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), max(0.0, due - time.monotonic()))
                return
            except TimeoutError:
                pass
            task = asyncio.create_task(self.refresh())
            self._refreshes.add(task)
            task.add_done_callback(self._refreshes.discard)
            due += self.interval

    async def refresh(self) -> None:
        phase = self.stats.phase
        started = time.monotonic()
        reads = [("/rooms", []), *membership_reads(self.mode, self.agent_ids)]
        ok = await asyncio.gather(*(self._get(path, query) for path, query in reads))
        self.stats.console_refresh(
            phase, time.monotonic() - started, len(reads), ok.count(False)
        )

    async def _get(self, path: str, query: list) -> bool:
        phase = self.stats.phase
        what = "rooms" if path == "/rooms" else "agents"
        started = time.monotonic()
        headers = {
            "X-Request-Id": self.ids.next(),
            # Carried by hand, as the admin's: the cookie is Secure, and httpx
            # will not send a Secure cookie over the plain http of a
            # port-forward.
            "Cookie": f"switch_auth={self.cookie}",
        }
        try:
            r = await self.http.get(f"/gateway{path}", params=query, headers=headers)
        except httpx.HTTPError as exc:
            self.stats.event(
                "console_failed", f"console{self.index}", path=path, error=str(exc)
            )
            return False
        finally:
            self.http.cookies.clear()
        self.stats.console_reads[(phase, what)].append(time.monotonic() - started)
        if r.status_code != 200:
            self.stats.event(
                "console_refused",
                f"console{self.index}",
                path=path,
                status=r.status_code,
            )
            return False
        return True

    async def stop(self) -> None:
        for task in list(self._refreshes):
            task.cancel()
        await asyncio.gather(*self._refreshes, return_exceptions=True)
        await self.http.aclose()
