"""Screenshot each test channel in Mattermost, signed in as the test person.

Drives headless Chrome over the DevTools protocol: sets the session cookie,
opens the channel, and captures the page. Thread replies are shown inline
and then each thread in the channel, one picture apiece.
"""

from __future__ import annotations

import asyncio
import base64
import subprocess
import sys
import tempfile
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import (
    HERE,
    MM,
    env,
    find_chrome,
    load_state,
    mm_headers,
    mm_login,
    mm_posts,
)  # noqa: E402

CHROME = find_chrome()
PORT = 9333
OUT = HERE / "screens"


async def cdp(ws, msg_id: int, method: str, params: dict | None = None) -> dict:
    await ws.send_json({"id": msg_id, "method": method, "params": params or {}})
    while True:
        msg = await ws.receive_json()
        if msg.get("id") == msg_id:
            return msg.get("result", {})


async def main() -> None:
    e = env()
    state = load_state()
    OUT.mkdir(exist_ok=True)
    profile = tempfile.mkdtemp(prefix="ftc-chrome-")
    chrome = subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            f"--remote-debugging-port={PORT}",
            f"--user-data-dir={profile}",
            "--hide-scrollbars",
            "--window-size=1500,1500",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        async with aiohttp.ClientSession() as http:
            token = await mm_login(
                http, e["MATTERMOST_USER"], e["MATTERMOST_USER_PASSWORD"]
            )
            async with http.get(
                f"{MM}/api/v4/users/me", headers=mm_headers(token)
            ) as r:
                me = await r.json()
            async with http.put(
                f"{MM}/api/v4/users/{me['id']}/preferences",
                headers=mm_headers(token),
                json=[
                    {
                        "user_id": me["id"],
                        "category": "display_settings",
                        "name": "collapsed_reply_threads",
                        "value": "off",
                    },
                    {
                        "user_id": me["id"],
                        "category": "display_settings",
                        "name": "message_display",
                        "value": "compact",
                    },
                ],
            ) as r:
                r.raise_for_status()
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
                n = 0

                async def call(method: str, params: dict | None = None) -> dict:
                    nonlocal n
                    n += 1
                    return await cdp(ws, n, method, params)

                await call("Network.enable")
                for name, value in (("MMAUTHTOKEN", token), ("MMUSERID", me["id"])):
                    await call(
                        "Network.setCookie",
                        {
                            "name": name,
                            "value": value,
                            "domain": "localhost",
                            "path": "/",
                        },
                    )
                await call(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": 1500,
                        "height": 1500,
                        "deviceScaleFactor": 1,
                        "mobile": False,
                    },
                )
                await call("Page.navigate", {"url": f"{MM}/login"})
                await asyncio.sleep(3)
                await call(
                    "Runtime.evaluate",
                    {
                        "expression": "localStorage.setItem('__landingPageSeen__', 'true')"
                    },
                )
                for key in state["rooms"]:
                    await call(
                        "Page.navigate",
                        {"url": f"{MM}/{e['MATTERMOST_TEAM_NAME']}/channels/ftc-{key}"},
                    )
                    await asyncio.sleep(8)
                    shot = await call("Page.captureScreenshot", {"format": "png"})
                    path = OUT / f"ftc-{key}.png"
                    path.write_bytes(base64.b64decode(shot["data"]))
                    print(path)
                    posts = await mm_posts(
                        http, token, state["rooms"][key]["channel_id"]
                    )
                    root_ids = list(
                        dict.fromkeys(p["root_id"] for p in posts if p.get("root_id"))
                    )
                    roots = [{"id": rid} for rid in root_ids]
                    for i, root in enumerate(roots, 1):
                        await call(
                            "Page.navigate",
                            {
                                "url": f"{MM}/{e['MATTERMOST_TEAM_NAME']}/threads/{root['id']}"
                            },
                        )
                        await asyncio.sleep(6)
                        shot = await call("Page.captureScreenshot", {"format": "png"})
                        path = OUT / f"ftc-{key}-thread-{i}.png"
                        path.write_bytes(base64.b64decode(shot["data"]))
                        print(path)
    finally:
        chrome.terminate()


if __name__ == "__main__":
    asyncio.run(main())
