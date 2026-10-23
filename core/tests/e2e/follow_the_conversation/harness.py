"""End-to-end proof for "follow the conversation" on a local Switch + Mattermost.

  setup       register test agents, a second Mattermost person, and the rooms
  playground  add a fresh room with all three agents, for trying it by hand
  agents      run the scripted agents (they reply "I got ..." when addressed)
  run         play every scenario as people in Mattermost and write a report

`run.sh` beside this file drives the whole thing against a fresh local stack;
see README.md. Output goes to build/e2e/follow-the-conversation (or $E2E_OUT).

The scripted agents open their event stream with filter=all, so they see every
message with Switch's own `addressed` flag on it. That flag, per agent, is what
the report checks, alongside the server's log line for the same message id.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import time
import uuid
from pathlib import Path

import aiohttp

REPO = Path(__file__).resolve().parents[4]
HERE = Path(
    os.environ.get("E2E_OUT", REPO / "build" / "e2e" / "follow-the-conversation")
)
STATE = HERE / "state.json"
RECEIVED = HERE / "received.jsonl"
SERVER_LOG = HERE / "switch-core.log"
SWITCH = "http://localhost:8000"
MM = "http://localhost:8065"
AGENTS = {
    "helper": "Answers questions about the Switch repo and its local setup.",
    "reviewer": "Reviews code changes and pull requests.",
    "private-bot": "A personal assistant that only takes instructions from its owner.",
}


def find_chrome() -> str:
    """Chrome or Chromium, for screenshots and the video: $CHROME, else the
    usual install locations."""
    candidates = [
        os.environ.get("CHROME", ""),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        shutil.which("google-chrome") or "",
        shutil.which("chromium") or "",
        shutil.which("chromium-browser") or "",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise SystemExit("Chrome or Chromium not found; set CHROME to its path.")


def env() -> dict[str, str]:
    values = {}
    for line in (REPO / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip()
    return values


def load_state() -> dict:
    return json.loads(STATE.read_text())


# ── Mattermost ──────────────────────────────────────────────────────────────


async def mm_login(http: aiohttp.ClientSession, login: str, password: str) -> str:
    async with http.post(
        f"{MM}/api/v4/users/login", json={"login_id": login, "password": password}
    ) as r:
        r.raise_for_status()
        return r.headers["Token"]


def mm_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def mm_post(
    http: aiohttp.ClientSession,
    token: str,
    channel_id: str,
    message: str,
    root_id: str = "",
) -> str:
    async with http.post(
        f"{MM}/api/v4/posts",
        headers=mm_headers(token),
        json={"channel_id": channel_id, "message": message, "root_id": root_id},
    ) as r:
        r.raise_for_status()
        return (await r.json())["id"]


async def mm_posts(
    http: aiohttp.ClientSession, token: str, channel_id: str
) -> list[dict]:
    async with http.get(
        f"{MM}/api/v4/channels/{channel_id}/posts?per_page=200",
        headers=mm_headers(token),
    ) as r:
        r.raise_for_status()
        data = await r.json()
    posts = [data["posts"][pid] for pid in data["order"]]
    return sorted(posts, key=lambda p: p["create_at"])


# ── Switch agent protocol ───────────────────────────────────────────────────


async def op(
    http: aiohttp.ClientSession,
    agent: dict,
    name: str,
    args: dict,
    connection_id: str | None = None,
) -> dict:
    headers = {"Authorization": f"Bearer {agent['api_key']}"}
    if connection_id:
        headers["X-Switch-Connection-Id"] = connection_id
    async with http.post(
        f"{SWITCH}/agents/{agent['id']}/ops/{name}", headers=headers, json=args
    ) as r:
        body = await r.json()
        if r.status != 200:
            raise RuntimeError(f"{name} failed {r.status}: {body}")
        return body["result"]


async def setup() -> None:
    e = env()
    state: dict = {"agents": {}, "rooms": {}}
    async with aiohttp.ClientSession() as http:
        for name, description in AGENTS.items():
            async with http.post(
                f"{SWITCH}/agents",
                headers={"Authorization": f"Bearer {e['AGENT_REGISTRATION_TOKEN']}"},
                json={
                    "name": name,
                    "description": description,
                    "connector_type": "custom",
                    "overwrite": True,
                    "integration_profile": {
                        "connection_model": "always_on",
                        "message_exchange": True,
                        "pre_invocation_mediation": [],
                        "post_invocation_mediation": [],
                        "event_reporting": [],
                    },
                },
            ) as r:
                body = await r.json()
                if r.status != 200:
                    raise RuntimeError(f"register {name}: {r.status} {body}")
                state["agents"][name] = {"id": body["id"], "api_key": body["api_key"]}
        helper = state["agents"]["helper"]
        await op(
            http,
            helper,
            "update_agent_detail",
            {
                "agent_id": state["agents"]["private-bot"]["id"],
                "addressing": "owner_only",
            },
        )
        for name in ("helper", "reviewer"):
            await op(
                http,
                helper,
                "update_agent_detail",
                {"agent_id": state["agents"][name]["id"], "addressing": "anyone"},
            )

        admin_token = await mm_login(
            http, e["MATTERMOST_ADMIN_USER"], e["MATTERMOST_ADMIN_PASSWORD"]
        )
        async with http.get(
            f"{MM}/api/v4/teams/name/{e['MATTERMOST_TEAM_NAME']}",
            headers=mm_headers(admin_token),
        ) as r:
            team_id = (await r.json())["id"]
        previous = json.loads(STATE.read_text()) if STATE.exists() else {}
        bob_password = previous.get("bob_password") or "Bob-" + uuid.uuid4().hex[:12]
        async with http.post(
            f"{MM}/api/v4/users",
            headers=mm_headers(admin_token),
            json={
                "username": "bob",
                "email": "bob@example.test",
                "password": bob_password,
            },
        ) as r:
            if r.status not in (200, 201):
                raise RuntimeError(f"create bob: {r.status} {await r.text()}")
            bob_id = (await r.json())["id"]
        async with http.post(
            f"{MM}/api/v4/teams/{team_id}/members",
            headers=mm_headers(admin_token),
            json={"team_id": team_id, "user_id": bob_id},
        ) as r:
            r.raise_for_status()
        state["bob_password"] = bob_password
        async with http.get(
            f"{MM}/api/v4/users/username/{e['MATTERMOST_USER']}",
            headers=mm_headers(admin_token),
        ) as r:
            user_id = (await r.json())["id"]

        bridges = await op(http, helper, "list_bridges", {})
        bridge_list = (
            bridges if isinstance(bridges, list) else bridges.get("bridges", [])
        )
        bridge_id = next(b["id"] for b in bridge_list if b["type"] == "mattermost")
        rooms = {
            "follow-ups": ["helper", "reviewer", "private-bot"],
            "main-agent": ["helper", "reviewer", "private-bot"],
        }
        for key, members in rooms.items():
            created = await op(
                http,
                helper,
                "create_room",
                {
                    "name": f"ftc-{key}",
                    "description": f"Follow-the-conversation proof: {key}",
                    "agent_names": members,
                    "bridge_id": bridge_id,
                    "channel_type": "channel_public",
                },
            )
            channel = None
            for _ in range(20):
                async with http.get(
                    f"{MM}/api/v4/teams/{team_id}/channels/name/ftc-{key}",
                    headers=mm_headers(admin_token),
                ) as r:
                    if r.status == 200:
                        channel = (await r.json())["id"]
                        break
                await asyncio.sleep(1)
            if channel is None:
                raise RuntimeError(f"no Mattermost channel for ftc-{key}")
            for uid in (user_id, bob_id):
                async with http.post(
                    f"{MM}/api/v4/channels/{channel}/members",
                    headers=mm_headers(admin_token),
                    json={"user_id": uid},
                ) as r:
                    r.raise_for_status()
            state["rooms"][key] = {"id": created["id"], "channel_id": channel}
    STATE.write_text(json.dumps(state, indent=2))
    print(json.dumps({k: v["id"] for k, v in state["rooms"].items()}, indent=2))


async def playground() -> None:
    """A fresh room with all three agents, for trying the rules by hand."""
    e = env()
    state = load_state()
    async with aiohttp.ClientSession() as http:
        helper = state["agents"]["helper"]
        admin_token = await mm_login(
            http, e["MATTERMOST_ADMIN_USER"], e["MATTERMOST_ADMIN_PASSWORD"]
        )
        async with http.get(
            f"{MM}/api/v4/teams/name/{e['MATTERMOST_TEAM_NAME']}",
            headers=mm_headers(admin_token),
        ) as r:
            team_id = (await r.json())["id"]
        bridges = await op(http, helper, "list_bridges", {})
        bridge_list = (
            bridges if isinstance(bridges, list) else bridges.get("bridges", [])
        )
        bridge_id = next(b["id"] for b in bridge_list if b["type"] == "mattermost")
        created = await op(
            http,
            helper,
            "create_room",
            {
                "name": "playground",
                "description": "Try follow-the-conversation by hand",
                "agent_names": list(AGENTS),
                "bridge_id": bridge_id,
                "channel_type": "channel_public",
            },
        )
        channel = None
        for _ in range(20):
            async with http.get(
                f"{MM}/api/v4/teams/{team_id}/channels/name/playground",
                headers=mm_headers(admin_token),
            ) as r:
                if r.status == 200:
                    channel = (await r.json())["id"]
                    break
            await asyncio.sleep(1)
        for username in (e["MATTERMOST_USER"], "bob"):
            async with http.get(
                f"{MM}/api/v4/users/username/{username}",
                headers=mm_headers(admin_token),
            ) as r:
                uid = (await r.json())["id"]
            async with http.post(
                f"{MM}/api/v4/channels/{channel}/members",
                headers=mm_headers(admin_token),
                json={"user_id": uid},
            ) as r:
                r.raise_for_status()
        state["rooms"]["playground"] = {"id": created["id"], "channel_id": channel}
    STATE.write_text(json.dumps(state, indent=2))
    print(created["id"])


# ── Scripted agents ─────────────────────────────────────────────────────────


async def run_agent(name: str, agent: dict) -> None:
    connection_id = str(uuid.uuid4())
    headers = {"Authorization": f"Bearer {agent['api_key']}"}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None)) as http:
        # The connection is one WebSocket: events come down as JSON frames,
        # and the server's `ping` is answered with a `pong` to stay alive.
        url = (
            f"{SWITCH.replace('http', 'ws', 1)}/agents/{agent['id']}/connection/ws"
            f"?connection_id={connection_id}"
            "&scope=all&filter=all&start_from=head&client=ftc-e2e"
        )
        async with http.ws_connect(url, headers=headers) as socket:
            print(f"{name} connected", flush=True)
            async for raw in socket:
                if raw.type != aiohttp.WSMsgType.TEXT:
                    continue
                frame = json.loads(raw.data)
                if frame.get("event") == "refused":
                    raise RuntimeError(f"{name} socket refused: {frame.get('data')}")
                if frame.get("event") == "ping":
                    await socket.send_json({"type": "pong", "cursor": 0})
                    continue
                event = frame.get("data") or {}
                if event.get("type") != "message":
                    continue
                p = event["payload"]
                record = {
                    "agent": name,
                    "room_id": event["room_id"],
                    "message_id": p["message_id"],
                    "sender_name": p.get("sender_name"),
                    "body": p.get("body"),
                    "thread_id": p.get("thread_id"),
                    "addressed": p.get("addressed"),
                    "at": time.time(),
                }
                with RECEIVED.open("a") as f:
                    f.write(json.dumps(record) + "\n")
                if p.get("addressed") and p.get("sender_name") not in AGENTS:
                    asyncio.create_task(reply(http, name, agent, connection_id, event))


def why(message_id: str, name: str) -> str:
    """The server's own reason this agent got the message, read from its log."""
    pattern = f"message={message_id} agent={name} "
    for line in reversed(SERVER_LOG.read_text().splitlines()[-4000:]):
        if "Follow the conversation:" in line and pattern in line:
            route = re.search(r"route=(\S+)", line).group(1)
            reason = line.split("reason=", 1)[1]
            label = {
                "thread_follow_up": "a thread follow-up",
                "channel_follow_up": "a channel follow-up",
                "main_agent": "this room's main agent rule",
            }.get(route, route)
            return f"via {label} ({reason})"
    return "because I was mentioned"


async def reply(
    http: aiohttp.ClientSession, name: str, agent: dict, connection_id: str, event: dict
) -> None:
    p = event["payload"]
    await asyncio.sleep(0.3)
    reason = why(p["message_id"], name)
    try:
        await op(
            http,
            agent,
            "connect_to_room",
            {"room_id": event["room_id"], "include_general_instructions": False},
            connection_id,
        )
        await op(
            http,
            agent,
            "post_message",
            {
                "body": f"[{name}] I got: “{(p.get('body') or '')[:80].replace('@', '(at)')}” — {reason}",
                "thread_id": p.get("thread_id"),
            },
            connection_id,
        )
    except Exception as exc:  # noqa: BLE001 — a test agent reports and carries on
        print(f"{name} could not reply: {exc}", flush=True)


async def agents() -> None:
    state = load_state()
    await asyncio.gather(*(run_agent(n, a) for n, a in state["agents"].items()))


# ── Scenarios ───────────────────────────────────────────────────────────────

# Each step: (who, text, where, expected agents that receive it as addressed).
# where: "top" for a channel message, or "thread:<label>" to reply under the
# Mattermost post an earlier step labelled. A step may label its own post with
# "label=<name>"; "answer:<agent>" labels the agent's reply to that step.
SCENARIOS = [
    {
        "id": "S1",
        "room": "follow-ups",
        "title": "A mention works exactly as today",
        "steps": [
            (
                "user",
                "@helper what does just up do?",
                "top",
                {"helper"},
                "answer:helper=a1",
            )
        ],
    },
    {
        "id": "S2",
        "room": "follow-ups",
        "title": "Rule 1: a reply in the agent's thread reaches it, no @ needed",
        "steps": [
            (
                "user",
                "why does it need two database roles?",
                "thread:a1",
                {"helper"},
                None,
            )
        ],
    },
    {
        "id": "S3",
        "room": "follow-ups",
        "title": "In a thread, a mention still wins",
        "steps": [
            (
                "user",
                "@reviewer what do you think of that?",
                "thread:a1",
                {"reviewer"},
                None,
            )
        ],
    },
    {
        "id": "S4",
        "room": "follow-ups",
        "title": "Rule 1: the agent that spoke last owns the thread",
        "steps": [
            (
                "user",
                "can you double-check the tests?",
                "thread:a1",
                {"reviewer"},
                None,
            )
        ],
    },
    {
        "id": "S5",
        "room": "follow-ups",
        "title": '"thanks" in a thread wakes nobody',
        "steps": [("user", "thanks!", "thread:a1", set(), None)],
    },
    {
        "id": "S6",
        "room": "follow-ups",
        "title": "Rule 2: the next channel message after an answer reaches that agent",
        "steps": [
            (
                "user",
                "@helper what does just migrate do?",
                "top",
                {"helper"},
                "answer:helper",
            ),
            ("user", "and what does just down do?", "top", {"helper"}, "answer:helper"),
            ("user", "and just reset?", "top", {"helper"}, "answer:helper"),
        ],
    },
    {
        "id": "S7",
        "room": "follow-ups",
        "title": "Rule 2 stops when someone else speaks",
        "steps": [
            (
                "user",
                "@helper where is addressing decided?",
                "top",
                {"helper"},
                "answer:helper",
            ),
            ("bob", "lunch at 1 anyone?", "top", set(), None),
            ("user", "and which file has the tests?", "top", set(), None),
        ],
    },
    {
        "id": "S8",
        "room": "follow-ups",
        "title": "Rule 2 stops after the window (20 seconds in this run)",
        "steps": [
            (
                "user",
                "@helper what port does the gateway use?",
                "top",
                {"helper"},
                "answer:helper",
            ),
            ("wait", 25),
            ("user", "and the Mattermost port?", "top", set(), None),
        ],
    },
    {
        "id": "S9",
        "room": "follow-ups",
        "title": "A question to the room with no exchange reaches nobody",
        "steps": [("bob", "anyone know why the deploy failed?", "top", set(), None)],
    },
    {
        "id": "S10",
        "room": "follow-ups",
        "title": "A follow-up the sender isn't allowed to send is dropped quietly",
        "steps": [
            ("user", "@private-bot can you help me?", "top", set(), "label=p1"),
            ("user", "hello? are you there?", "thread:p1", set(), None),
        ],
    },
    {
        "id": "S11",
        "room": "main-agent",
        "title": "Rule 3: after !assign-agent, every message reaches the main agent",
        "steps": [
            (
                "cmd",
                "user",
                "!assign-agent @helper",
                "From now on, every message here goes to",
            ),
            ("bob", "anyone know why the deploy failed?", "top", {"helper"}, None),
            ("user", "morning all", "top", {"helper"}, None),
        ],
    },
    {
        "id": "S12",
        "room": "main-agent",
        "title": "In a main-agent room, a mention still wins",
        "steps": [
            ("user", "@reviewer can you look at my PR?", "top", {"reviewer"}, None)
        ],
    },
    {
        "id": "S14",
        "room": "main-agent",
        "title": "!unassign-agent ends it, and you can't assign an agent that won't take your instructions",
        "steps": [
            ("cmd", "user", "!unassign-agent", "is no longer assigned"),
            ("bob", "has anyone seen the build logs?", "top", set(), None),
            (
                "cmd",
                "user",
                "!assign-agent @reviewer",
                "From now on, every message here goes to",
            ),
            ("bob", "can someone check the release notes?", "top", {"reviewer"}, None),
            ("cmd", "user", "!unassign-agent", "is no longer assigned"),
            ("cmd", "user", "!assign-agent @private-bot", "You can't assign"),
        ],
    },
    {
        "id": "S13",
        "room": "follow-ups",
        "title": "!follow-ups off stops follow-ups in a room; !follow-ups on brings them back",
        "steps": [
            (
                "user",
                "@helper what does just test do?",
                "top",
                {"helper"},
                "answer:helper=f1",
            ),
            ("cmd", "user", "!follow-ups off", "Follow-ups are **off**"),
            ("user", "and how long does it take?", "thread:f1", set(), None),
            ("cmd", "user", "!follow-ups on", "Follow-ups are **on**"),
            ("user", "and which tests are slow?", "thread:f1", {"helper"}, None),
        ],
    },
]


UNTAGGED = {"thanks!"}


def received() -> list[dict]:
    if not RECEIVED.exists():
        return []
    return [
        json.loads(line) for line in RECEIVED.read_text().splitlines() if line.strip()
    ]


async def wait_for_agent_reply(
    http, token, channel_id, agent, after_ms, timeout=20
) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for post in await mm_posts(http, token, channel_id):
            if post["create_at"] > after_ms and post["message"].startswith(
                f"[{agent}] I got"
            ):
                return post
        await asyncio.sleep(0.5)
    raise RuntimeError(f"no reply from {agent}")


async def run() -> None:
    e = env()
    state = load_state()
    log_offset = SERVER_LOG.stat().st_size
    RECEIVED.write_text("")
    start_ms = int(time.time() * 1000)
    results = []
    async with aiohttp.ClientSession() as http:
        tokens = {
            "user": await mm_login(
                http, e["MATTERMOST_USER"], e["MATTERMOST_USER_PASSWORD"]
            ),
            "bob": await mm_login(http, "bob", state["bob_password"]),
        }
        labels: dict[str, str] = {}
        for scenario in SCENARIOS:
            room = state["rooms"][scenario["room"]]
            channel = room["channel_id"]
            step_results = []
            for step in scenario["steps"]:
                if step[0] == "wait":
                    await asyncio.sleep(step[1])
                    step_results.append({"wait": step[1]})
                    continue
                if step[0] == "cmd":
                    _, who, command, expect_reply = step
                    before_ms = int(time.time() * 1000)
                    await mm_post(http, tokens[who], channel, command)
                    reply_text = None
                    for _ in range(40):
                        for post in await mm_posts(http, tokens[who], channel):
                            if (
                                post["create_at"] > before_ms
                                and expect_reply in post["message"]
                            ):
                                reply_text = post["message"]
                        if reply_text:
                            break
                        await asyncio.sleep(0.5)
                    step_results.append(
                        {
                            "cmd": command,
                            "who": who,
                            "reply": reply_text,
                            "ok": reply_text is not None,
                        }
                    )
                    continue
                who, text, where, expected, label = step
                # Small talk is sent exactly as a person would type it: a tag
                # would make it more than "thanks".
                untagged = text in UNTAGGED
                tagged = text if untagged else f"{text} [{scenario['id']}]"
                root = (
                    labels[where.split(":", 1)[1]]
                    if where.startswith("thread:")
                    else ""
                )
                before_ms = int(time.time() * 1000)
                post_id = await mm_post(http, tokens[who], channel, tagged, root)
                if label and label.startswith("label="):
                    labels[label[6:]] = post_id
                if label and label.startswith("answer:"):
                    agent_part = label[7:]
                    agent_name, _, answer_label = agent_part.partition("=")
                    answer = await wait_for_agent_reply(
                        http, tokens["user"], channel, agent_name, before_ms
                    )
                    if answer_label:
                        labels[answer_label] = answer["id"]
                else:
                    await asyncio.sleep(5)
                step_results.append(
                    {
                        "who": who,
                        "text": tagged,
                        "key": text
                        if untagged
                        else " ".join(text.split()[-3:]) + f" [{scenario['id']}]",
                        "where": where,
                        "expected": sorted(expected),
                    }
                )
            results.append({**scenario, "step_results": step_results})
        await asyncio.sleep(3)
        transcripts = {
            key: [
                p
                for p in await mm_posts(http, tokens["user"], room["channel_id"])
                if p["create_at"] >= start_ms
            ]
            for key, room in state["rooms"].items()
        }
        user_ids = sorted(
            {p["user_id"] for posts in transcripts.values() for p in posts}
        )
        async with http.post(
            f"{MM}/api/v4/users/ids", headers=mm_headers(tokens["user"]), json=user_ids
        ) as r:
            names = {u["id"]: u["username"] for u in await r.json()}
        for posts in transcripts.values():
            for p in posts:
                p["_who"] = names.get(p["user_id"], p["user_id"][:6])
    log_text = SERVER_LOG.read_text()[log_offset:]
    failed = write_report(results, received(), log_text, transcripts, state)
    if failed:
        raise SystemExit(f"{failed} scenario(s) failed; see {HERE / 'report.md'}")


def write_report(results, events, log_text, transcripts, state) -> int:
    """Write report.md and return how many scenarios failed."""
    ftc_lines = [
        line for line in log_text.splitlines() if "Follow the conversation:" in line
    ]
    out = ["# Follow the conversation: end-to-end proof", ""]
    out.append(
        f"Run at {time.strftime('%Y-%m-%d %H:%M:%S')} against a local Switch built from the branch, with Mattermost."
    )
    out.append("")
    passed = failed = 0
    summary = []
    body = []
    for sc in results:
        sc_ok = True
        body.append(f"## {sc['id']}: {sc['title']}")
        body.append(f"Room: `ftc-{sc['room']}`")
        body.append("")
        body.append(
            "| Step | Sent by | Message | Expected to reach | Actually reached | Result |"
        )
        body.append("|---|---|---|---|---|---|")
        logs_for_sc = []
        for i, st in enumerate(sc["step_results"], 1):
            if "wait" in st:
                body.append(f"| {i} | — | *waited {st['wait']} seconds* | | | |")
                continue
            if "cmd" in st:
                sc_ok &= st["ok"]
                answer = (st["reply"] or "no reply").split(".")[0]
                body.append(
                    f"| {i} | {st['who']} | `{st['cmd']}` (command) | Switch confirms | {answer} | {'✅ pass' if st['ok'] else '❌ FAIL'} |"
                )
                continue
            mine = [
                ev
                for ev in events
                if ev["body"]
                and ev["body"].strip().endswith(st["key"])
                and ev["sender_name"] not in AGENTS
            ]
            reached = sorted({ev["agent"] for ev in mine if ev["addressed"]})
            seen_by = sorted({ev["agent"] for ev in mine})
            ok = reached == st["expected"] and bool(seen_by)
            sc_ok &= ok
            where = "thread reply" if st["where"].startswith("thread") else "channel"
            body.append(
                f"| {i} | {st['who']} | {st['text']} ({where}) | {', '.join(st['expected']) or 'nobody'} | "
                f"{', '.join(reached) or 'nobody'} | {'✅ pass' if ok else '❌ FAIL'} |"
            )
            ids = {ev["message_id"] for ev in mine}
            for line in ftc_lines:
                if any(f"message={mid} " in line for mid in ids):
                    logs_for_sc.append(
                        f"step {i}: " + line.split("Follow the conversation: ", 1)[1]
                    )
        body.append("")
        body.append("Server log lines for these messages:")
        body.append("")
        body.append("```")
        body.extend(logs_for_sc or ["(none: the rules did not run for these messages)"])
        body.append("```")
        body.append("")
        summary.append(
            f"| {sc['id']} | {sc['title']} | {'✅ pass' if sc_ok else '❌ FAIL'} |"
        )
        passed += sc_ok
        failed += not sc_ok
    out.append(f"**{passed} of {passed + failed} scenarios passed.**")
    out.append("")
    out.append("| Scenario | What it shows | Result |")
    out.append("|---|---|---|")
    out.extend(summary)
    out.append("")
    out.extend(body)
    out.append("## Mattermost transcripts")
    out.append("")
    for key, posts in transcripts.items():
        out.append(f"### ftc-{key}")
        out.append("")
        out.append("```")
        for p in posts:
            if p.get("type"):
                continue
            who = p["_who"]
            indent = "    ↳ " if p.get("root_id") else ""
            out.append(f"{indent}{who}: {p['message']}")
        out.append("```")
        out.append("")
    report = HERE / "report.md"
    report.write_text("\n".join(out))
    print("\n".join(out[: 8 + len(summary)]))
    print(f"\nreport: {report}")
    return failed


if __name__ == "__main__":
    asyncio.run(
        {"setup": setup, "agents": agents, "run": run, "playground": playground}[
            sys.argv[1]
        ]()
    )
