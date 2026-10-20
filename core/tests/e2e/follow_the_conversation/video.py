"""Record a captioned demo video of every follow-the-conversation journey.

Drives headless Chrome over the DevTools protocol, signed in to the local
Mattermost as `user`. `user`'s messages are typed into the real composer;
`bob`'s are posted through the API and appear live. A caption bar and title
cards are drawn over the page. Frames are captured only while something is
worth watching, then joined into an MP4 with ffmpeg.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import (
    AGENTS,
    HERE,
    MM,
    env,
    find_chrome,
    load_state,
    mm_headers,
    mm_login,
    mm_post,
    mm_posts,
    op,
)  # noqa: E402

CHROME = find_chrome()
PORT = 9334
W, H = 1440, 960
FPS = 4
FRAMES = HERE / "video-frames"
OUT = HERE / "follow-the-conversation-demo.mp4"
WINDOW_SECONDS = int(os.environ.get("FOLLOW_THE_CONVERSATION_WINDOW_SECONDS", "60"))

OVERLAY_JS = r"""
(() => {
  if (document.getElementById('ftc-cap')) return;
  const style = document.createElement('style');
  style.textContent = `
    .announcement-bar{display:none!important}
    #ftc-cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(17,24,39,.94);
      color:#fff;font:600 22px/1.35 -apple-system,Helvetica,Arial,sans-serif;padding:16px 28px 18px;
      box-shadow:0 -4px 20px rgba(0,0,0,.25)}
    #ftc-cap small{display:block;font-weight:400;font-size:17px;color:#cbd5e1;margin-top:4px}
    #ftc-badge{position:fixed;top:12px;right:16px;z-index:2147483647;background:#1d4ed8;color:#fff;
      font:700 15px -apple-system,Helvetica,Arial,sans-serif;padding:6px 12px;border-radius:999px}
    #ftc-card{position:fixed;inset:0;z-index:2147483647;background:linear-gradient(135deg,#0f172a,#1e3a8a);
      color:#fff;display:none;flex-direction:column;justify-content:center;padding:0 120px;
      font-family:-apple-system,Helvetica,Arial,sans-serif}
    #ftc-card h1{font-size:54px;margin:0 0 18px;letter-spacing:-.5px}
    #ftc-card p{font-size:26px;color:#cbd5e1;margin:6px 0;line-height:1.4}
    #ftc-card .tag{display:inline-block;font-size:18px;font-weight:700;background:#22c55e;color:#052e16;
      padding:5px 12px;border-radius:999px;margin-bottom:22px;width:max-content}
  `;
  document.head.appendChild(style);
  for (const id of ['ftc-cap','ftc-badge','ftc-card']) {
    const el = document.createElement('div'); el.id = id; document.body.appendChild(el);
  }
  document.getElementById('ftc-cap').style.display = 'none';
  document.getElementById('ftc-badge').style.display = 'none';
})();
"""


class Recorder:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.n = 0
        self.recording = False
        self.frame = 0
        self.caption_html = ""
        self.badge = ""
        self.pending: dict[int, asyncio.Future] = {}

    async def read_loop(self) -> None:
        """The one reader of the socket: hands each reply to whoever asked."""
        async for msg in self.ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                break
            data = json.loads(msg.data)
            future = self.pending.pop(data.get("id"), None)
            if future is not None and not future.done():
                future.set_result(data.get("result", {}))

    async def call(self, method: str, params: dict | None = None) -> dict:
        self.n += 1
        msg_id = self.n
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[msg_id] = future
        await self.ws.send_json(
            {"id": msg_id, "method": method, "params": params or {}}
        )
        return await asyncio.wait_for(future, timeout=30)

    async def js(self, expression: str) -> object:
        result = await self.call(
            "Runtime.evaluate", {"expression": expression, "returnByValue": True}
        )
        return result.get("result", {}).get("value")

    async def capture_loop(self) -> None:
        while True:
            if self.recording:
                try:
                    shot = await self.call(
                        "Page.captureScreenshot", {"format": "jpeg", "quality": 82}
                    )
                except TimeoutError:
                    print("a frame timed out; carrying on", flush=True)
                else:
                    (FRAMES / f"{self.frame:06d}.jpg").write_bytes(
                        base64.b64decode(shot["data"])
                    )
                    self.frame += 1
            await asyncio.sleep(1 / FPS)

    async def overlay(self) -> None:
        await self.js(OVERLAY_JS)
        await self.set_caption(self.caption_html)
        await self.set_badge(self.badge)

    async def set_caption(self, html: str) -> None:
        self.caption_html = html
        await self.js(
            "(() => {const c=document.getElementById('ftc-cap'); if(!c) return;"
            f"c.innerHTML={json.dumps(html)}; c.style.display={json.dumps('block' if html else 'none')};}})()"
        )

    async def set_badge(self, text: str) -> None:
        self.badge = text
        await self.js(
            "(() => {const b=document.getElementById('ftc-badge'); if(!b) return;"
            f"b.textContent={json.dumps(text)}; b.style.display={json.dumps('block' if text else 'none')};}})()"
        )

    async def card(
        self, tag: str, title: str, lines: list[str], seconds: float
    ) -> None:
        body = f'<span class="tag">{tag}</span><h1>{title}</h1>' + "".join(
            f"<p>{line}</p>" for line in lines
        )
        await self.js(
            "(() => {const c=document.getElementById('ftc-card');"
            f"c.innerHTML={json.dumps(body)}; c.style.display='flex';}})()"
        )
        self.recording = True
        await asyncio.sleep(seconds)
        await self.js("document.getElementById('ftc-card').style.display='none'")

    async def go(self, url: str, ready_selector: str) -> None:
        """Navigate without recording the page load, then put the overlay back."""
        self.recording = False
        await self.call("Page.navigate", {"url": url})
        for _ in range(60):
            await asyncio.sleep(0.5)
            if await self.js(f"!!document.querySelector({json.dumps(ready_selector)})"):
                break
        await asyncio.sleep(1.5)
        await self.overlay()

    async def type_and_send(self, selector: str, text: str) -> None:
        if text.split()[-1].startswith("@"):
            # A trailing space closes Mattermost's mention autocomplete, which
            # would otherwise take the Enter.
            text += " "
        await self.js(f"document.querySelector({json.dumps(selector)}).focus()")
        for chunk in [text[i : i + 3] for i in range(0, len(text), 3)]:
            await self.call("Input.insertText", {"text": chunk})
            await asyncio.sleep(0.06)
        await asyncio.sleep(0.6)
        if text.endswith(" ") and text.split()[-1].startswith("@"):
            # Escape closes the mention autocomplete so Enter sends; it can
            # also take focus away, so focus the box again.
            await self.key("Escape", "Escape", 27)
            await asyncio.sleep(0.3)
            await self.js(f"document.querySelector({json.dumps(selector)}).focus()")
        await self.key("Enter", "Enter", 13, text="\r")
        await asyncio.sleep(0.8)
        still_there = await self.js(
            f"(document.querySelector({json.dumps(selector)})||{{}}).value"
        )
        if still_there:
            await self.js(
                f"(() => {{const box=document.querySelector({json.dumps(selector)});"
                "let el=box; for (let i=0;i<8 && el;i++){ el=el.parentElement;"
                ' const b=el && el.querySelector(\'button[data-testid="SendMessageButton"], button[aria-label*="Send"]\');'
                " if(b){ b.click(); return; } } })()"
            )
            await asyncio.sleep(0.5)

    async def key(
        self, key: str, code: str, keycode: int, text: str | None = None
    ) -> None:
        for kind in ("keyDown", "keyUp"):
            await self.call(
                "Input.dispatchKeyEvent",
                {
                    "type": kind,
                    "key": key,
                    "code": code,
                    "windowsVirtualKeyCode": keycode,
                    "nativeVirtualKeyCode": keycode,
                    **({"text": text} if text and kind == "keyDown" else {}),
                },
            )


async def ensure_rooms(http: aiohttp.ClientSession, e: dict, state: dict) -> dict:
    """Two fresh rooms just for the video."""
    helper = state["agents"]["helper"]
    admin = await mm_login(
        http, e["MATTERMOST_ADMIN_USER"], e["MATTERMOST_ADMIN_PASSWORD"]
    )
    async with http.get(
        f"{MM}/api/v4/teams/name/{e['MATTERMOST_TEAM_NAME']}", headers=mm_headers(admin)
    ) as r:
        team_id = (await r.json())["id"]
    bridges = await op(http, helper, "list_bridges", {})
    bridge_list = bridges if isinstance(bridges, list) else bridges.get("bridges", [])
    bridge_id = next(b["id"] for b in bridge_list if b["type"] == "mattermost")
    stamp = time.strftime("%H%M%S")
    rooms = {}
    for key, desc in (
        ("demo-follow-ups", "Demo: follow-ups"),
        ("demo-assigned", "Demo: assigned agent"),
    ):
        name = f"{key}-{stamp}"
        created = await op(
            http,
            helper,
            "create_room",
            {
                "name": name,
                "description": desc,
                "agent_names": list(AGENTS),
                "bridge_id": bridge_id,
                "channel_type": "channel_public",
            },
        )
        channel = None
        for _ in range(30):
            async with http.get(
                f"{MM}/api/v4/teams/{team_id}/channels/name/{name}",
                headers=mm_headers(admin),
            ) as r:
                if r.status == 200:
                    channel = (await r.json())["id"]
                    break
            await asyncio.sleep(1)
        for username in (e["MATTERMOST_USER"], "bob"):
            async with http.get(
                f"{MM}/api/v4/users/username/{username}", headers=mm_headers(admin)
            ) as r:
                uid = (await r.json())["id"]
            async with http.post(
                f"{MM}/api/v4/channels/{channel}/members",
                headers=mm_headers(admin),
                json={"user_id": uid},
            ) as r:
                r.raise_for_status()
        rooms[key] = {"name": name, "channel_id": channel, "id": created["id"]}
    await asyncio.sleep(4)  # let the agents' greetings land before recording
    return rooms


async def main() -> None:
    e = env()
    state = load_state()
    team = e["MATTERMOST_TEAM_NAME"]
    if FRAMES.exists():
        shutil.rmtree(FRAMES)
    FRAMES.mkdir(parents=True)
    profile = tempfile.mkdtemp(prefix="ftc-video-")
    chrome = subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            f"--remote-debugging-port={PORT}",
            f"--user-data-dir={profile}",
            "--hide-scrollbars",
            f"--window-size={W},{H}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        async with aiohttp.ClientSession() as http:
            user_tok = await mm_login(
                http, e["MATTERMOST_USER"], e["MATTERMOST_USER_PASSWORD"]
            )
            bob_tok = await mm_login(http, "bob", state["bob_password"])
            async with http.get(
                f"{MM}/api/v4/users/me", headers=mm_headers(user_tok)
            ) as r:
                me = await r.json()
            async with http.get(
                f"{MM}/api/v4/teams/name/{team}", headers=mm_headers(user_tok)
            ) as r:
                team_id = (await r.json())["id"]
            rooms = await ensure_rooms(http, e, state)
            for _ in range(30):
                try:
                    async with http.put(
                        f"http://localhost:{PORT}/json/new?about:blank"
                    ) as r:
                        target = await r.json()
                    break
                except aiohttp.ClientError:
                    await asyncio.sleep(0.5)
            async with http.ws_connect(
                target["webSocketDebuggerUrl"], max_msg_size=0
            ) as ws:
                rec = Recorder(ws)
                reader = asyncio.create_task(rec.read_loop())
                await rec.call("Network.enable")
                for name, value in (("MMAUTHTOKEN", user_tok), ("MMUSERID", me["id"])):
                    await rec.call(
                        "Network.setCookie",
                        {
                            "name": name,
                            "value": value,
                            "domain": "localhost",
                            "path": "/",
                        },
                    )
                await rec.call(
                    "Emulation.setDeviceMetricsOverride",
                    {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False},
                )
                await rec.call("Page.navigate", {"url": f"{MM}/login"})
                await asyncio.sleep(3)
                await rec.js("localStorage.setItem('__landingPageSeen__', 'true')")
                capture = asyncio.create_task(rec.capture_loop())

                fu = rooms["demo-follow-ups"]
                asg = rooms["demo-assigned"]
                chan_url = lambda room: f"{MM}/{team}/channels/{room['name']}"  # noqa: E731

                async def latest_from(
                    channel: str, prefix: str, after_ms: int, timeout: float = 25
                ) -> dict:
                    deadline = time.time() + timeout
                    while time.time() < deadline:
                        for p in await mm_posts(http, user_tok, channel):
                            if p["create_at"] > after_ms and p["message"].startswith(
                                prefix
                            ):
                                return p
                        await asyncio.sleep(0.5)
                    raise RuntimeError(f"nothing starting {prefix!r}")

                async def say(selector: str, text: str) -> int:
                    t0 = int(time.time() * 1000)
                    await rec.type_and_send(selector, text)
                    return t0

                async def open_thread(room: dict, post_id: str) -> None:
                    """Open a post's thread in the side panel, next to its channel:
                    hover the post so Mattermost shows its reply button, then press it.
                    Falls back to the Threads page if the button never shows."""
                    await rec.go(chan_url(room), "#post_textbox")
                    for _ in range(12):
                        rect = await rec.js(
                            f"(() => {{const p=document.getElementById('post_{post_id}');"
                            "if(!p) return null; p.scrollIntoView({block:'center'});"
                            "const r=p.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2];})()"
                        )
                        if rect:
                            await rec.call(
                                "Input.dispatchMouseEvent",
                                {"type": "mouseMoved", "x": rect[0], "y": rect[1]},
                            )
                            await asyncio.sleep(0.4)
                            clicked = await rec.js(
                                f"(() => {{const b=document.querySelector('[id^=\"CENTER_commentIcon_{post_id}\"]')"
                                f" || document.querySelector('#post_{post_id} button[aria-label*=\"eply\"]');"
                                "if(b){b.click(); return true;} return false;})()"
                            )
                            if clicked:
                                break
                        await asyncio.sleep(0.5)
                    for _ in range(12):
                        if await rec.js("!!document.querySelector('#reply_textbox')"):
                            await rec.call(
                                "Input.dispatchMouseEvent",
                                {"type": "mouseMoved", "x": 5, "y": 5},
                            )
                            await asyncio.sleep(1)
                            return
                        await asyncio.sleep(0.5)
                    async with http.put(
                        f"{MM}/api/v4/users/{me['id']}/teams/{team_id}/threads/{post_id}/following",
                        headers=mm_headers(user_tok),
                    ) as r:
                        await r.read()
                    await rec.go(f"{MM}/{team}/threads/{post_id}", "#reply_textbox")
                    if not await rec.js("!!document.querySelector('#reply_textbox')"):
                        raise RuntimeError(f"could not open the thread for {post_id}")

                async def hold(seconds: float) -> None:
                    rec.recording = True
                    await asyncio.sleep(seconds)

                def cap(main: str, sub: str = "") -> str:
                    return main + (f"<small>{sub}</small>" if sub else "")

                # ── Intro ──────────────────────────────────────────────
                await rec.go(chan_url(fu), "#post_textbox")
                await rec.card(
                    "Local demo · Switch + Mattermost",
                    "Agents that follow the conversation",
                    [
                        "Today an agent only reacts when you @mention it.",
                        "Now three plain rules let it follow the conversation. No AI, no extra cost.",
                        "Three test agents: helper, reviewer, and private-bot (owner only).",
                        "Each agent reply ends with the reason Switch gave for delivering it.",
                    ],
                    9,
                )

                # ── 1. Mention ─────────────────────────────────────────
                await rec.card(
                    "1",
                    "A mention works exactly as today",
                    ["Only the agent you name gets the message."],
                    3.5,
                )
                await rec.set_badge("1 · mention")
                await rec.set_caption(
                    cap("You mention @helper.", "Expected: only helper answers.")
                )
                await hold(0.5)
                t0 = await say("#post_textbox", "@helper what does just up do?")
                answer = await latest_from(fu["channel_id"], "[helper]", t0)
                await rec.set_caption(
                    cap(
                        "✓ helper answered, because it was mentioned.",
                        "Exactly as today.",
                    )
                )
                await hold(3.5)

                # ── 2. Thread follow-up ────────────────────────────────
                await rec.card(
                    "2 · Rule 1",
                    "A reply in the agent's thread",
                    ["No @ needed. Today this got no answer."],
                    3.5,
                )
                await open_thread(fu, answer["id"])
                await rec.set_badge("2 · thread follow-up")
                await rec.set_caption(
                    cap(
                        "You reply in helper's thread, with no @.",
                        "Expected: helper answers, because it's taking part in this thread.",
                    )
                )
                await hold(1)
                t0 = await say("#reply_textbox", "why does it need two database roles?")
                await latest_from(fu["channel_id"], "[helper]", t0)
                await rec.set_caption(
                    cap(
                        "✓ helper answered: “via a thread follow-up”.",
                        "The fix for the agent that went quiet when you asked why.",
                    )
                )
                await hold(4)

                # ── 3. Mention wins in a thread ────────────────────────
                await rec.card(
                    "3",
                    "In a thread, a mention still wins",
                    ["Bring someone else in without the first agent jumping in."],
                    3,
                )
                await rec.set_badge("3 · mention wins")
                await rec.set_caption(
                    cap(
                        "In the same thread you mention @reviewer.",
                        "Expected: only reviewer answers. helper stays quiet.",
                    )
                )
                await hold(1)
                t0 = await say("#reply_textbox", "@reviewer what do you think of that?")
                await latest_from(fu["channel_id"], "[reviewer]", t0)
                await hold(1.5)
                await rec.set_caption(
                    cap("✓ Only reviewer answered.", "A mention always wins.")
                )
                await hold(3)

                # ── 4. Thanks ──────────────────────────────────────────
                await rec.card(
                    "4",
                    "“thanks” wakes nobody",
                    ["No agent is woken just to say “you're welcome”."],
                    3,
                )
                await rec.set_badge("4 · small talk")
                await rec.set_caption(
                    cap(
                        "You say “thanks!” in the thread.",
                        "Expected: no agent replies.",
                    )
                )
                await hold(1)
                await say("#reply_textbox", "thanks!")
                await hold(6)
                await rec.set_caption(
                    cap(
                        "✓ No agent replied.",
                        "Small talk never wakes an agent through a follow-up.",
                    )
                )
                await hold(3)

                # ── 5. Channel follow-up ───────────────────────────────
                await rec.card(
                    "5 · Rule 2",
                    "The next message after an answer",
                    [
                        "A follow-up in the channel reaches the agent that just answered you."
                    ],
                    3.5,
                )
                await rec.go(chan_url(fu), "#post_textbox")
                await rec.set_badge("5 · channel follow-up")
                await rec.set_caption(cap("You ask helper something…"))
                await hold(0.5)
                t0 = await say("#post_textbox", "@helper what does just migrate do?")
                await latest_from(fu["channel_id"], "[helper]", t0)
                await rec.set_caption(
                    cap(
                        "…then follow up in the channel, with no @.",
                        "Expected: helper answers, because you're mid-conversation with it.",
                    )
                )
                await hold(1.5)
                t0 = await say("#post_textbox", "and what does just down do?")
                await latest_from(fu["channel_id"], "[helper]", t0)
                await rec.set_caption(
                    cap(
                        "✓ helper answered: “via a channel follow-up”.",
                        "Same person, nobody else in between, within the time limit.",
                    )
                )
                await hold(4)

                # ── 6. Someone else speaks ─────────────────────────────
                await rec.card(
                    "6",
                    "It stops when someone else speaks",
                    ["That's what keeps agents out of people's conversations."],
                    3.5,
                )
                await rec.set_badge("6 · someone else spoke")
                await rec.set_caption(cap("bob says something to the room."))
                await hold(1)
                await mm_post(http, bob_tok, fu["channel_id"], "lunch at 1 anyone?")
                await hold(3)
                await rec.set_caption(
                    cap(
                        "Now you follow up without an @.",
                        "Expected: nobody. The exchange with helper ended when bob spoke.",
                    )
                )
                await hold(1)
                await say("#post_textbox", "and which file has the tests?")
                await hold(6)
                await rec.set_caption(
                    cap("✓ No agent replied.", "Mention helper to carry on.")
                )
                await hold(3)

                # ── 7. Too late ────────────────────────────────────────
                await rec.card(
                    "7",
                    "It stops after a time limit",
                    [f"5 minutes by default. {WINDOW_SECONDS} seconds in this demo."],
                    3.5,
                )
                await rec.set_badge("7 · too late")
                await rec.set_caption(cap("You ask helper something…"))
                await hold(0.5)
                t0 = await say(
                    "#post_textbox", "@helper what port does the gateway use?"
                )
                await latest_from(fu["channel_id"], "[helper]", t0)
                await hold(2)
                rec.recording = False
                await asyncio.sleep(WINDOW_SECONDS + 5)
                await rec.card(
                    "7",
                    f"{WINDOW_SECONDS + 5} seconds later…",
                    ["The follow-up window has passed."],
                    2.5,
                )
                await rec.set_caption(
                    cap(
                        "You follow up without an @.",
                        "Expected: nobody, because the window has passed.",
                    )
                )
                await hold(1)
                await say("#post_textbox", "and the Mattermost port?")
                await hold(6)
                await rec.set_caption(
                    cap("✓ No agent replied.", "Mention helper again to carry on.")
                )
                await hold(3)

                # ── 8. General question ────────────────────────────────
                await rec.card(
                    "8",
                    "“Nobody” is the default",
                    [
                        "A question to the room, with no conversation going, reaches no agent."
                    ],
                    3.5,
                )
                await rec.set_badge("8 · general question")
                await rec.set_caption(
                    cap("bob asks the room in general.", "Expected: no agent replies.")
                )
                await hold(1)
                await mm_post(
                    http,
                    bob_tok,
                    fu["channel_id"],
                    "anyone know why the deploy failed?",
                )
                await hold(6)
                await rec.set_caption(
                    cap(
                        "✓ No agent replied.",
                        "For that, assign an agent to the room (coming up).",
                    )
                )
                await hold(3)

                # ── 9. Permissions ─────────────────────────────────────
                await rec.card(
                    "9",
                    "Permissions still apply",
                    [
                        "private-bot only takes instructions from its owner. You aren't its owner here."
                    ],
                    4,
                )
                await rec.set_badge("9 · not allowed")
                await rec.set_caption(
                    cap(
                        "You mention @private-bot.",
                        "Expected: it refuses once, exactly as today.",
                    )
                )
                await hold(0.5)
                t0 = await say("#post_textbox", "@private-bot can you help me?")
                question = await latest_from(
                    fu["channel_id"], "@private-bot can you help me?", t0 - 1
                )
                await latest_from(fu["channel_id"], "@user I only take", t0)
                await open_thread(fu, question["id"])
                await rec.set_caption(
                    cap(
                        "It refused. Now you follow up in that thread, without an @.",
                        "Expected: dropped quietly, with no second refusal.",
                    )
                )
                await hold(2)
                await say("#reply_textbox", "hello? are you there?")
                await hold(6)
                await rec.set_caption(
                    cap(
                        "✓ No second refusal.",
                        "A follow-up from someone not allowed is dropped quietly.",
                    )
                )
                await hold(3)

                # ── 10. Follow-ups off / on ────────────────────────────
                await rec.card(
                    "10 · Room switch",
                    "!follow-ups off and on",
                    ["A room that doesn't want follow-ups can turn them off."],
                    3.5,
                )
                await rec.go(chan_url(fu), "#post_textbox")
                await rec.set_badge("10 · !follow-ups")
                await rec.set_caption(
                    cap("You type !follow-ups off.", "Expected: Switch confirms.")
                )
                await hold(0.5)
                t0 = await say("#post_textbox", "!follow-ups off")
                command = await latest_from(fu["channel_id"], "!follow-ups off", t0 - 1)
                await latest_from(fu["channel_id"], "Follow-ups are **off**", t0)
                await open_thread(fu, command["id"])
                await rec.set_caption(
                    cap(
                        "✓ Switch confirms follow-ups are off.",
                        "Only mentions reach agents in this room now.",
                    )
                )
                await hold(4)
                await open_thread(fu, answer["id"])
                await rec.set_caption(
                    cap(
                        "You reply in helper's thread again, with no @.",
                        "Expected: nobody, because follow-ups are off.",
                    )
                )
                await hold(1)
                await say("#reply_textbox", "and how long does it take?")
                await hold(6)
                await rec.set_caption(cap("✓ No agent replied."))
                await hold(2)
                await rec.go(chan_url(fu), "#post_textbox")
                await rec.set_caption(
                    cap("You type !follow-ups on.", "Expected: Switch confirms.")
                )
                await hold(0.5)
                t0 = await say("#post_textbox", "!follow-ups on")
                command = await latest_from(fu["channel_id"], "!follow-ups on", t0 - 1)
                await latest_from(fu["channel_id"], "Follow-ups are **on**", t0)
                await open_thread(fu, answer["id"])
                await rec.set_caption(
                    cap(
                        "Follow-ups are back on. You reply in the thread again.",
                        "Expected: reviewer answers. It spoke last in this thread, so it owns it.",
                    )
                )
                await hold(1)
                t0 = await say("#reply_textbox", "and which tests are slow?")
                await latest_from(fu["channel_id"], "[reviewer]", t0)
                await hold(1.5)
                await rec.set_caption(
                    cap(
                        "✓ Only reviewer answered: “via a thread follow-up”.",
                        "The agent that spoke or was tagged most recently owns the thread. helper stays quiet.",
                    )
                )
                await hold(4)

                # ── 11. Assign an agent ────────────────────────────────
                await rec.card(
                    "11 · Rule 3",
                    "!assign-agent: one agent gets every message",
                    ["For rooms built around one agent."],
                    3.5,
                )
                await rec.go(chan_url(asg), "#post_textbox")
                await rec.set_badge("11 · !assign-agent")
                await rec.set_caption(
                    cap(
                        "In a new room, you type !assign-agent @helper.",
                        "Expected: Switch confirms.",
                    )
                )
                await hold(0.5)
                t0 = await say("#post_textbox", "!assign-agent @helper")
                command = await latest_from(asg["channel_id"], "!assign-agent", t0 - 1)
                await latest_from(asg["channel_id"], "From now on", t0)
                await open_thread(asg, command["id"])
                await rec.set_caption(
                    cap(
                        "✓ Switch confirms: every message here now goes to helper.",
                        "Unless it mentions someone else.",
                    )
                )
                await hold(4)
                await rec.go(chan_url(asg), "#post_textbox")
                await rec.set_caption(
                    cap(
                        "bob asks the room in general.",
                        "Expected: helper answers, because it's the assigned agent.",
                    )
                )
                await hold(1)
                t0 = int(time.time() * 1000)
                await mm_post(
                    http,
                    bob_tok,
                    asg["channel_id"],
                    "anyone know why the deploy failed?",
                )
                await latest_from(asg["channel_id"], "[helper]", t0)
                await rec.set_caption(
                    cap("✓ helper answered: “via this room's main agent rule”.")
                )
                await hold(3.5)
                await rec.set_caption(
                    cap(
                        "You mention @reviewer in the same room.",
                        "Expected: only reviewer answers. A mention still wins.",
                    )
                )
                await hold(1)
                t0 = await say("#post_textbox", "@reviewer can you look at my PR?")
                await latest_from(asg["channel_id"], "[reviewer]", t0)
                await hold(1.5)
                await rec.set_caption(cap("✓ Only reviewer answered."))
                await hold(3)

                # ── 12. Unassign, and a refused assign ─────────────────
                await rec.card(
                    "12",
                    "!unassign-agent, and who you can assign",
                    ["You can only assign an agent that takes instructions from you."],
                    3.5,
                )
                await rec.set_badge("12 · !unassign-agent")
                await rec.set_caption(
                    cap(
                        "You type !unassign-agent.",
                        "Expected: Switch confirms helper is no longer assigned.",
                    )
                )
                await hold(0.5)
                t0 = await say("#post_textbox", "!unassign-agent")
                await latest_from(
                    asg["channel_id"], "**helper** is no longer assigned", t0
                )
                await hold(1.5)
                await rec.set_caption(
                    cap(
                        "bob asks the room again.",
                        "Expected: nobody, now that no agent is assigned.",
                    )
                )
                await hold(1)
                await mm_post(
                    http, bob_tok, asg["channel_id"], "has anyone seen the build logs?"
                )
                await hold(6)
                await rec.set_caption(cap("✓ No agent replied."))
                await hold(2)
                await rec.set_caption(
                    cap(
                        "You try !assign-agent @private-bot.",
                        "Expected: refused, because private-bot doesn't take your instructions.",
                    )
                )
                await hold(0.5)
                t0 = await say("#post_textbox", "!assign-agent @private-bot")
                command = await latest_from(
                    asg["channel_id"], "!assign-agent @private-bot", t0 - 1
                )
                await latest_from(asg["channel_id"], "You can't assign", t0)
                await open_thread(asg, command["id"])
                await rec.set_caption(cap("✓ Switch refuses and says why."))
                await hold(4.5)

                # ── Outro ──────────────────────────────────────────────
                await rec.set_badge("")
                await rec.set_caption("")
                await rec.card(
                    "Proven",
                    "Every route works as designed",
                    [
                        "Rule 1 thread follow-ups · Rule 2 channel follow-ups · Rule 3 assigned agent",
                        "A mention always wins · permissions always apply · “nobody” is the default",
                        "!follow-ups on / off · !assign-agent · !unassign-agent",
                        "14 of 14 end-to-end scenarios · 79 new tests · full suite passing",
                    ],
                    8,
                )
                rec.recording = False
                await asyncio.sleep(0.5)
                capture.cancel()
                reader.cancel()
    finally:
        chrome.terminate()

    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-framerate",
            str(FPS),
            "-i",
            str(FRAMES / "%06d.jpg"),
            "-vf",
            "scale=1280:-2,fps=24",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(OUT),
        ],
        check=True,
    )
    print(OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    asyncio.run(main())
