"""End-to-end proof for "follow the conversation" on a local Switch.

  setup       register test agents, a second person, and the rooms
  playground  add a fresh room with all three agents, for trying it by hand
  agents      run the scripted agents (they reply "I got ..." when addressed)
  run         play every scenario as people in the in-Console chat and write a report

The people post and read through the gateway's `/chats` routes, the ones
Switch Console's chat view calls; the rooms are in-Console group chats, with
no bridge.

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
GATEWAY = f"{SWITCH}/gateway"
AGENTS = {
    "helper": "Answers questions about the Switch repo and its local setup.",
    "reviewer": "Reviews code changes and pull requests.",
    "private-bot": "A personal assistant that only takes instructions from its owner.",
}
BOB_EMAIL = "bob@example.test"


def env() -> dict[str, str]:
    values = {}
    for line in (REPO / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip()
    return values


def load_state() -> dict:
    return json.loads(STATE.read_text())


# ── In-Console chat ─────────────────────────────────────────────────────────


async def sign_in(email: str, password: str) -> aiohttp.ClientSession:
    """A session signed in to the gateway; its cookie jar carries the login."""
    # A fresh connection per request: the steps pause 5 s, uvicorn's keep-alive
    # timeout, so a pooled connection is reset as it is reused.
    http = aiohttp.ClientSession(
        cookie_jar=aiohttp.CookieJar(unsafe=True),
        connector=aiohttp.TCPConnector(force_close=True),
    )
    await gw(http, "POST", "/auth/login", {"email": email, "password": password})
    return http


async def gw(
    http: aiohttp.ClientSession, method: str, path: str, body: dict | None = None
) -> dict:
    async with http.request(method, f"{GATEWAY}{path}", json=body) as r:
        if r.status >= 300:
            raise RuntimeError(f"{method} {path}: {r.status} {await r.text()}")
        return await r.json() if r.status != 204 else {}


async def chat_post(
    http: aiohttp.ClientSession,
    room_id: str,
    body: str,
    thread_root_id: str | None = None,
) -> dict:
    sent = await gw(
        http,
        "POST",
        f"/chats/{room_id}/messages",
        {
            "requestId": str(uuid.uuid4()),
            "body": body,
            "threadRootId": thread_root_id,
            "uploadIds": [],
        },
    )
    return sent["messages"][0]


async def chat_messages(http: aiohttp.ClientSession, room_id: str) -> list[dict]:
    """The room's newest 200 messages, oldest first."""
    return (await gw(http, "GET", f"/chats/{room_id}/messages?limit=200"))["messages"]


# An agent may not change its own settings, and these agents have no owner to
# act for, so the admin sets who may address them.
OWNER_ONLY = {
    "rules": [
        {"rooms": "*", "room_groups": "*", "users": [], "agents": [], "owner": True}
    ]
}


async def set_addressing(
    admin: aiohttp.ClientSession, agent_id: str, policy: dict | None
) -> None:
    await gw(admin, "PUT", f"/agents/{agent_id}/addressing-policy", {"policy": policy})


async def open_chats(
    http: aiohttp.ClientSession,
    helper: dict,
    state: dict,
    rooms: dict[str, list[str]],
    member_user_ids: list[str],
) -> None:
    """Open a group chat per room. A chat can only be opened with agents the
    opener may address, so private-bot is open to anyone while they are made."""
    private_bot = state["agents"]["private-bot"]["id"]
    await set_addressing(http, private_bot, None)
    for key, members in rooms.items():
        created = await gw(
            http,
            "POST",
            "/chats",
            {
                "agentIds": [state["agents"][name]["id"] for name in members],
                "memberUserIds": member_user_ids,
                "name": f"ftc-{key}" if key != "playground" else key,
                "kind": "group",
                "requestId": str(uuid.uuid4()),
            },
        )
        state["rooms"][key] = {"id": created["chat"]["roomId"]}
    await set_addressing(http, private_bot, OWNER_ONLY)


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

    admin = await sign_in(e["GATEWAY_ADMIN_EMAIL"], e["GATEWAY_ADMIN_PASSWORD"])
    try:
        for name in ("helper", "reviewer"):
            await set_addressing(admin, state["agents"][name]["id"], None)
        state["tenant_id"] = (await gw(admin, "GET", "/tenants/current"))["id"]
        previous = json.loads(STATE.read_text()) if STATE.exists() else {}
        bob_password = previous.get("bob_password") or "Bob-" + uuid.uuid4().hex[:12]
        bob_id = (
            await gw(
                admin,
                "POST",
                "/users",
                {"name": "bob", "email": BOB_EMAIL, "password": bob_password},
            )
        )["id"]
        invitation = await gw(
            admin,
            "POST",
            f"/tenants/{state['tenant_id']}/invitations",
            {"role": "member"},
        )
        bob = await sign_in(BOB_EMAIL, bob_password)
        try:
            await gw(bob, "POST", "/invitations/accept", {"token": invitation["token"]})
        finally:
            await bob.close()
        state["bob_password"] = bob_password
        state["bob_id"] = bob_id

        rooms = {
            "follow-ups": ["helper", "reviewer", "private-bot"],
            "main-agent": ["helper", "reviewer", "private-bot"],
        }
        await open_chats(admin, helper, state, rooms, [bob_id])
    finally:
        await admin.close()
    STATE.write_text(json.dumps(state, indent=2))
    print(json.dumps({k: v["id"] for k, v in state["rooms"].items()}, indent=2))


async def playground() -> None:
    """A fresh room with all three agents, for trying the rules by hand."""
    e = env()
    state = load_state()
    admin = await sign_in(e["GATEWAY_ADMIN_EMAIL"], e["GATEWAY_ADMIN_PASSWORD"])
    try:
        await open_chats(
            admin,
            state["agents"]["helper"],
            state,
            {"playground": list(AGENTS)},
            [state["bob_id"]],
        )
    finally:
        await admin.close()
    STATE.write_text(json.dumps(state, indent=2))
    print(state["rooms"]["playground"]["id"])


# ── Scripted agents ─────────────────────────────────────────────────────────


async def run_agent(name: str, agent: dict) -> None:
    connection_id = str(uuid.uuid4())
    headers = {"Authorization": f"Bearer {agent['api_key']}"}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None)) as http:

        async def beat() -> None:
            while True:
                await asyncio.sleep(2)
                try:
                    async with http.post(
                        f"{SWITCH}/agents/{agent['id']}/connection/beat",
                        headers=headers,
                        json={"connection_id": connection_id},
                    ) as r:
                        await r.read()
                except aiohttp.ClientError:
                    pass

        url = (
            f"{SWITCH}/agents/{agent['id']}/events?connection_id={connection_id}"
            "&scope=all&filter=all&start_from=head&client=ftc-e2e"
        )
        async with http.get(
            url, headers={**headers, "Accept": "text/event-stream"}
        ) as stream:
            if stream.status != 200:
                raise RuntimeError(
                    f"{name} stream: {stream.status} {await stream.text()}"
                )
            beater = asyncio.create_task(beat())
            print(f"{name} connected", flush=True)
            data_lines: list[str] = []
            async for raw in stream.content:
                line = raw.decode().rstrip("\n")
                if line.startswith("data:"):
                    data_lines.append(line[5:].strip())
                    continue
                if line or not data_lines:
                    continue
                event = json.loads("\n".join(data_lines))
                data_lines = []
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
            beater.cancel()


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

    async def staggered(delay: int, name: str, agent: dict) -> None:
        # shortcut: agents connecting at the same instant can get a 500 ("No
        # incarnation drawn"), a server race; drop the stagger once it is fixed.
        await asyncio.sleep(delay)
        await run_agent(name, agent)

    await asyncio.gather(
        *(staggered(i, n, a) for i, (n, a) in enumerate(state["agents"].items()))
    )


# ── Scenarios ───────────────────────────────────────────────────────────────

# Each step: (who, text, where, expected agents that receive it as addressed).
# where: "top" for a room message, or "thread:<label>" to reply under the
# message an earlier step labelled. A step may label its own message with
# "label=<name>"; "answer:<agent>" labels the agent's reply to that step.
# ("cmd", who, command, reply) types a `!command` and waits for Switch's reply
# containing that text.
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
            ("user", "and the Postgres port?", "top", set(), None),
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


async def wait_for_agent_reply(http, room_id, agent, after_seq, timeout=20) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for message in await chat_messages(http, room_id):
            if message["seq"] > after_seq and message["body"].startswith(
                f"[{agent}] I got"
            ):
                return message
        await asyncio.sleep(0.5)
    raise RuntimeError(f"no reply from {agent}")


async def wait_for_command_reply(http, room_id, expect, after_seq, timeout=20):
    """The body of Switch's reply to a typed command, or None if none came."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for message in await chat_messages(http, room_id):
            if message["seq"] > after_seq and expect in message["body"]:
                return message["body"]
        await asyncio.sleep(0.5)
    return None


async def run() -> None:
    e = env()
    state = load_state()
    log_offset = SERVER_LOG.stat().st_size
    RECEIVED.write_text("")
    results = []
    people = {
        "user": await sign_in(e["GATEWAY_ADMIN_EMAIL"], e["GATEWAY_ADMIN_PASSWORD"]),
        "bob": await sign_in(BOB_EMAIL, state["bob_password"]),
    }
    try:
        start_seq = {
            key: max(
                (m["seq"] for m in await chat_messages(people["user"], room["id"])),
                default=0,
            )
            for key, room in state["rooms"].items()
        }
        labels: dict[str, str] = {}
        for scenario in SCENARIOS:
            room_id = state["rooms"][scenario["room"]]["id"]
            step_results = []
            for step in scenario["steps"]:
                if step[0] == "wait":
                    await asyncio.sleep(step[1])
                    step_results.append({"wait": step[1]})
                    continue
                if step[0] == "cmd":
                    _, who, command, expect_reply = step
                    sent = await chat_post(people[who], room_id, command)
                    reply_text = await wait_for_command_reply(
                        people[who], room_id, expect_reply, sent["seq"]
                    )
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
                    else None
                )
                sent = await chat_post(people[who], room_id, tagged, root)
                if label and label.startswith("label="):
                    labels[label[6:]] = sent["messageId"]
                if label and label.startswith("answer:"):
                    agent_part = label[7:]
                    agent_name, _, answer_label = agent_part.partition("=")
                    answer = await wait_for_agent_reply(
                        people["user"], room_id, agent_name, sent["seq"]
                    )
                    if answer_label:
                        labels[answer_label] = answer["messageId"]
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
                m
                for m in await chat_messages(people["user"], room["id"])
                if m["seq"] > start_seq[key]
            ]
            for key, room in state["rooms"].items()
        }
    finally:
        for http in people.values():
            await http.close()
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
        f"Run at {time.strftime('%Y-%m-%d %H:%M:%S')} against a local Switch built from the branch, through the in-Console chat."
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
            where = "thread reply" if st["where"].startswith("thread") else "room"
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
    out.append("## Transcripts")
    out.append("")
    for key, messages in transcripts.items():
        out.append(f"### ftc-{key}")
        out.append("")
        out.append("```")
        for m in messages:
            indent = "    ↳ " if m.get("threadRootId") else ""
            out.append(f"{indent}{m['sender']['name']}: {m['body']}")
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
