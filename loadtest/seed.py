"""Creating the run's agents, rooms and key, and removing them again.

Everything a run creates is named after it: the API key is labelled
`load-<run_id>`, agents are `load-<run_id>-aNNNN`, rooms `load-<run_id>-rNNN`,
and with `--controllers` the controllers are `load-<run_id>-cNNN`.
Teardown and `--cleanup` find what to remove by those names, through the
gateway as the environment's admin, so they work even when the process that
created them died without saying what it made.

No secret leaves this process: the admin password, the session cookie, the
registration key, the agents' keys and the controllers' credentials are held
in memory and never printed or written to the run folder.
"""

from __future__ import annotations

import asyncio
import itertools
from dataclasses import dataclass

import httpx

# What a load agent says it can do: always connected, exchanges messages,
# nothing else. The same profile the throwaway agents of
# runbooks/scripts/dev-load-agents.py register with.
PROFILE = {
    "connection_model": "always_on",
    "message_exchange": True,
    "pre_invocation_mediation": [],
    "post_invocation_mediation": [],
    "event_reporting": [],
    # Retired on main, which drops unknown keys, but still required by builds
    # from before that change, so a run against an older environment works.
    "task_protocol": {"can_delegate": False, "can_accept": False},
}


class RequestIds:
    """`load-<run_id>-<n>`, one per harness request, so a run can be picked
    out of the server's logs and traces."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._n = itertools.count(1)

    def next(self) -> str:
        return f"load-{self.run_id}-{next(self._n)}"


def prefix(run_id: str) -> str:
    return f"load-{run_id}-"


@dataclass
class SeededAgent:
    index: int
    id: str
    name: str
    key: str  # the agent's own API key; memory only


class NoWorkspace(RuntimeError):
    """The workspace a run was told to use is not there, and it may not make it."""


class Admin:
    """The gateway, signed in as the environment's admin."""

    def __init__(self, gateway_url: str, ids: RequestIds) -> None:
        self.ids = ids
        self._cookie: str | None = None
        self.http = httpx.AsyncClient(base_url=gateway_url.rstrip("/"), timeout=60)

    @property
    def cookie(self) -> str | None:
        """The session, bound to the run's workspace once `use_workspace` ran."""
        return self._cookie

    async def call(self, method: str, path: str, **kw) -> httpx.Response:
        headers = {"X-Request-Id": self.ids.next()}
        if self._cookie:
            # Carried by hand: the session cookie is Secure, and httpx will not
            # send a Secure cookie over the plain http of a port-forward.
            headers["Cookie"] = f"switch_auth={self._cookie}"
        r = await self.http.request(method, f"/gateway{path}", headers=headers, **kw)
        self.http.cookies.clear()
        return r

    async def login(self, email: str, password: str) -> None:
        r = await self.call(
            "POST", "/auth/login", json={"email": email, "password": password}
        )
        if r.status_code != 200:
            raise RuntimeError(f"admin sign-in refused: HTTP {r.status_code}")
        self._cookie = r.cookies.get("switch_auth")
        if not self._cookie:
            raise RuntimeError("admin sign-in returned no switch_auth cookie")

    async def use_workspace(self, name: str, create: bool = True) -> dict:
        """Bind this session to the admin's workspace called `name`, made as
        an organization of its own when there is none (unless `create` is
        false: then NoWorkspace), then put the admin's own selection back.

        Signing in selects the workspace the admin last switched to, so
        without that, whoever signs in as the admin while a run is going, a
        person or a scheduled job, would land in the load test's workspace.
        This session keeps the cookie bound to `name`; the one the second
        switch mints is dropped."""
        r = await self.call("GET", "/tenants/current")
        before = r.json()["id"] if r.status_code == 200 else None
        r = await self.call("GET", "/tenants")
        if r.status_code != 200:
            raise _fail("listing the admin's workspaces", r)
        named = [t for t in r.json() if t.get("name") == name]
        if len(named) > 1:
            raise RuntimeError(f"the admin has {len(named)} workspaces named {name}")
        if named:
            workspace = named[0]
            r = await self.call("POST", f"/tenants/{workspace['id']}/switch")
            if r.status_code != 200:
                raise _fail(f"switching to the workspace {name}", r)
        elif not create:
            raise NoWorkspace(f"the admin has no workspace named {name}")
        else:
            r = await self.call("POST", "/organizations", json={"name": name})
            if r.status_code != 201:
                raise _fail(f"creating the workspace {name}", r)
            workspace = r.json()["workspace"]
        cookie = r.cookies.get("switch_auth")
        if not cookie:
            raise RuntimeError(f"switching to {name} returned no switch_auth cookie")
        self._cookie = cookie
        if before is not None and before != workspace["id"]:
            r = await self.call("POST", f"/tenants/{before}/switch")
            if r.status_code != 200:
                raise _fail("putting the admin's own workspace back", r)
        return {"id": workspace["id"], "name": name, "made": not named}

    async def refuse_bridges(self) -> None:
        """Refuse a workspace with an active bridge: each bridge gives every
        agent of its workspace an identity on its platform (a role on
        Discord, a user group on Slack, a bot on Mattermost), so a run there
        would make thousands of them."""
        r = await self.call("GET", "/collaborations")
        if r.status_code != 200:
            raise _fail("listing the workspace's bridges", r)
        active = [b for b in r.json() if b.get("status") == "active"]
        if active:
            names = ", ".join(
                f"{b.get('bridge_type')} {b.get('display_name')!r}" for b in active
            )
            raise RuntimeError(
                f"the run's workspace has active bridges ({names}); "
                "run it in a workspace of its own with --workspace"
            )

    async def close(self) -> None:
        await self.http.aclose()


def _fail(what: str, r: httpx.Response) -> RuntimeError:
    # Only for error responses, which carry a status and a reason, never a key.
    return RuntimeError(f"{what}: HTTP {r.status_code} {r.text[:200]}")


async def seed(
    admin: Admin,
    api_url: str,
    run_id: str,
    n_agents: int,
    membership: list[list[int]],
    state: dict,
    *,
    concurrency: int,
) -> tuple[list[SeededAgent], list[str]]:
    """Create the key, the agents and the rooms. Records each id in `state`
    as it is made, so a failure part way still tears down what exists."""
    r = await admin.call("POST", "/api-keys", json={"label": f"load-{run_id}"})
    if r.status_code != 200:
        raise _fail("creating the API key", r)
    body = r.json()
    state["api_key_id"], reg_key = body["id"], body["key"]

    sem = asyncio.Semaphore(concurrency)
    agents: list[SeededAgent | None] = [None] * n_agents
    async with httpx.AsyncClient(base_url=api_url.rstrip("/"), timeout=60) as api:

        async def register(i: int) -> None:
            name = f"{prefix(run_id)}a{i:04d}"
            async with sem:
                r = await api.post(
                    "/agents",
                    headers={
                        "Authorization": f"Bearer {reg_key}",
                        "X-Request-Id": admin.ids.next(),
                    },
                    json={
                        "name": name,
                        "description": f"load test {run_id}, removed when the run ends",
                        "connector_type": "e2e",
                        "integration_profile": PROFILE,
                    },
                )
            if r.status_code != 200:
                raise _fail(f"registering {name}", r)
            b = r.json()
            agents[i] = SeededAgent(i, b["id"], name, b["api_key"])
            state["agents"].append(b["id"])

        await asyncio.gather(*(register(i) for i in range(n_agents)))

    seeded = [a for a in agents if a is not None]
    return seeded, await create_rooms(admin, run_id, seeded, membership, state, sem)


@dataclass
class SeededController:
    index: int
    id: str
    name: str
    credential: str  # memory only


async def seed_managed(
    admin: Admin,
    run_id: str,
    n_agents: int,
    n_controllers: int,
    membership: list[list[int]],
    state: dict,
    *,
    concurrency: int,
) -> tuple[list[SeededAgent], list[str], list[SeededController]]:
    """Create the controllers, the agents they will run and the rooms, through
    the gateway's management routes, as Switch Console does. The agents are
    made unplaced: each is placed on its controller when its step connects it
    (`controllers.ManagedAgent`), since placing needs the controller online.
    Records each id in `state` as it is made."""
    sem = asyncio.Semaphore(concurrency)
    made = await create_controllers(admin, run_id, n_controllers, state, sem)
    agents: list[SeededAgent | None] = [None] * n_agents

    async def agent(i: int) -> None:
        name = f"{prefix(run_id)}a{i:04d}"
        async with sem:
            r = await admin.call(
                "POST",
                "/management/agents",
                json={
                    "name": name,
                    "description": f"load test {run_id}, removed when the run ends",
                    "controller_id": None,
                    "desired_state": "running",
                    "definition": {"provider": "claude"},
                },
            )
        if r.status_code != 201:
            raise _fail(f"creating managed agent {name}", r)
        agents[i] = SeededAgent(i, r.json()["agent_id"], name, "")
        state["agents"].append(agents[i].id)

    await asyncio.gather(*(agent(i) for i in range(n_agents)))
    seeded = [a for a in agents if a is not None]
    rooms = await create_rooms(admin, run_id, seeded, membership, state, sem)
    return seeded, rooms, made


async def create_controllers(
    admin: Admin,
    run_id: str,
    n_controllers: int,
    state: dict,
    sem: asyncio.Semaphore,
) -> list[SeededController]:
    """Create the run's controllers, named after it. A run that reuses another
    run's agents makes its own, since a controller's credential is never kept."""
    controllers: list[SeededController | None] = [None] * n_controllers

    async def controller(k: int) -> None:
        name = f"{prefix(run_id)}c{k:03d}"
        async with sem:
            r = await admin.call(
                "POST",
                "/management/controllers",
                json={
                    "name": name,
                    "description": f"load test {run_id}, removed when the run ends",
                    "kind": "console",
                    "platform": {
                        "os": "linux",
                        "arch": "x64",
                        "os_version": "loadtest",
                    },
                    "version": "loadtest",
                },
            )
        if r.status_code != 201:
            raise _fail(f"creating controller {name}", r)
        b = r.json()
        controllers[k] = SeededController(k, b["controller_id"], name, b["credential"])
        state.setdefault("controllers", []).append(b["controller_id"])

    await asyncio.gather(*(controller(k) for k in range(n_controllers)))
    return [c for c in controllers if c is not None]


async def create_rooms(
    admin: Admin,
    run_id: str,
    seeded: list[SeededAgent],
    membership: list[list[int]],
    state: dict,
    sem: asyncio.Semaphore,
) -> list[str]:
    room_ids: list[str | None] = [None] * len(membership)

    async def create_room(j: int, members: list[int]) -> None:
        name = f"{prefix(run_id)}r{j:03d}"
        async with sem:
            r = await admin.call(
                "POST",
                "/rooms",
                json={
                    "name": name,
                    "description": f"load test {run_id}",
                    "agent_ids": [seeded[m].id for m in members],
                    "internal_only": True,
                },
            )
        if r.status_code not in (200, 201):
            raise _fail(f"creating room {name}", r)
        room_ids[j] = r.json()["id"]
        state["rooms"].append(room_ids[j])

    await asyncio.gather(*(create_room(j, m) for j, m in enumerate(membership)))
    return [rid for rid in room_ids if rid]


async def teardown(
    admin: Admin, run_id: str, log=print, concurrency: int = 8
) -> dict[str, int]:
    """Remove everything named after the run: agents deleted, rooms archived,
    the key deleted. `run_id` "*" removes every load run's leftovers.
    Returns what it removed, and what is still there after (should be 0)."""
    pre = "load-" if run_id == "*" else prefix(run_id)
    label = None if run_id == "*" else f"load-{run_id}"
    done = {
        "agents_deleted": 0,
        "rooms_archived": 0,
        "keys_deleted": 0,
        "controllers_revoked": 0,
        "errors": 0,
    }
    sem = asyncio.Semaphore(concurrency)

    async def one(method: str, path: str, counter: str) -> None:
        async with sem:
            try:
                r = await admin.call(method, path)
            except httpx.HTTPError as exc:
                log(f"  {method} {path}: {type(exc).__name__}")
                done["errors"] += 1
                return
        if r.status_code in (200, 204, 404):
            done[counter] += r.status_code != 404
        else:
            log(f"  {method} {path}: HTTP {r.status_code} {r.text[:120]}")
            done["errors"] += 1

    # Controller-backed agents go through the management routes, which also
    # drop their definitions; then their controllers are revoked.
    managed = await _managed_agents(admin, pre)
    await asyncio.gather(
        *(
            one("DELETE", f"/management/agents/{a['agent_id']}", "agents_deleted")
            for a in managed
        )
    )
    controllers = await _controllers(admin, pre)
    await asyncio.gather(
        *(
            one("DELETE", f"/management/controllers/{c['id']}", "controllers_revoked")
            for c in controllers
        )
    )
    rooms = await _rooms(admin, pre)
    await asyncio.gather(
        *(one("POST", f"/rooms/{r['id']}/archive", "rooms_archived") for r in rooms)
    )
    agents = await _agents(admin, pre)
    await asyncio.gather(
        *(one("DELETE", f"/agents/{a['id']}", "agents_deleted") for a in agents)
    )
    keys = await _keys(admin, pre, label)
    await asyncio.gather(
        *(one("DELETE", f"/api-keys/{k['id']}", "keys_deleted") for k in keys)
    )

    done["left_agents"] = len(await _agents(admin, pre))
    done["left_rooms"] = len(await _rooms(admin, pre))
    done["left_keys"] = len(await _keys(admin, pre, label))
    done["left_controllers"] = len(await _controllers(admin, pre))
    return done


async def revoke_controllers(
    admin: Admin, run_id: str, log=print, concurrency: int = 8
) -> dict[str, int]:
    """Revoke the run's controllers and nothing else: what a kept run removes,
    so the agents and rooms it leaves carry no credential with them."""
    pre = prefix(run_id)
    done = {"controllers_revoked": 0, "errors": 0}
    sem = asyncio.Semaphore(concurrency)

    async def one(controller_id: str) -> None:
        path = f"/management/controllers/{controller_id}"
        async with sem:
            try:
                r = await admin.call("DELETE", path)
            except httpx.HTTPError as exc:
                log(f"  DELETE {path}: {type(exc).__name__}")
                done["errors"] += 1
                return
        if r.status_code in (200, 204, 404):
            done["controllers_revoked"] += r.status_code != 404
        else:
            log(f"  DELETE {path}: HTTP {r.status_code} {r.text[:120]}")
            done["errors"] += 1

    await asyncio.gather(*(one(c["id"]) for c in await _controllers(admin, pre)))
    done["left_controllers"] = len(await _controllers(admin, pre))
    return done


async def _managed_agents(admin: Admin, pre: str) -> list[dict]:
    r = await admin.call("GET", "/management/agents")
    if r.status_code == 404:
        return []  # agent management is off here, so there are none
    if r.status_code != 200:
        raise _fail("listing managed agents", r)
    return [a for a in r.json() if str(a.get("name", "")).startswith(pre)]


async def _controllers(admin: Admin, pre: str) -> list[dict]:
    # Unrevoked only: revoked is the end state, so it is not a leftover.
    r = await admin.call("GET", "/management/controllers")
    if r.status_code == 404:
        return []
    if r.status_code != 200:
        raise _fail("listing controllers", r)
    return [
        c
        for c in r.json()
        if str(c.get("name", "")).startswith(pre) and not c.get("revoked_at")
    ]


async def _agents(admin: Admin, pre: str) -> list[dict]:
    r = await admin.call("GET", "/agents")
    if r.status_code != 200:
        raise _fail("listing agents", r)
    return [a for a in r.json() if str(a.get("name", "")).startswith(pre)]


async def _rooms(admin: Admin, pre: str) -> list[dict]:
    # Active rooms only: archived is the end state, so it is not a leftover.
    r = await admin.call("GET", "/rooms", params={"search": pre})
    if r.status_code != 200:
        raise _fail("listing rooms", r)
    return [
        x
        for x in r.json()
        if str(x.get("name", "")).startswith(pre) and not x.get("archived")
    ]


async def _keys(admin: Admin, pre: str, label: str | None) -> list[dict]:
    r = await admin.call("GET", "/api-keys")
    if r.status_code != 200:
        raise _fail("listing API keys", r)
    # The registration key is labelled `load-<run_id>`. Each agent's own key is
    # labelled with the agent's name, and deleting the agent does not delete
    # that key's row (agents point at their key, not the other way round), so
    # those are matched by the run's name prefix and removed too.
    found = []
    for k in r.json():
        lab = str(k.get("label") or "")
        if lab.startswith(pre) or (label is not None and lab == label):
            found.append(k)
    return found
