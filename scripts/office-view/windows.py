#!/usr/bin/env python3
"""Open and arrange Chrome windows over the DevTools protocol for the office-view recording.

A background tab produces no screencast frames, so Slack and the office each get
their own window. Each window is sized so its page viewport is a given size:
by default Slack 840x900 on the left and the office 1080x900 on the right (the
office draws a fixed ~1060x680 frame, which a narrower viewport would crop).

    uv run --with websockets python scripts/office-view/windows.py --port 9333 list
    uv run --with websockets python scripts/office-view/windows.py --port 9333 open http://127.0.0.1:3334/ --side right
    uv run --with websockets python scripts/office-view/windows.py --port 9333 place --match app.slack.com --side left
    uv run --with websockets python scripts/office-view/windows.py --port 9333 layout \\
        --left app.slack.com --right 127.0.0.1:3334 --open-right http://127.0.0.1:3334/

`layout` is the one to use before a walk: it opens the right-hand URL in a new
window if no page matches it yet, resizes the two windows (left one flush with
the screen's left edge, right one flush with its right edge) and prints the
viewport each page ends up with.

It only ever opens a window when asked (open, --open-right) and only resizes
or moves the windows of the pages it is pointed at. It never closes a tab or
window and never navigates an existing page, so it is safe on the Chrome you
use for Slack. Chrome must run with --remote-debugging-port.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

from websockets.sync.client import connect

LEFT_SIZE = (840, 900)
RIGHT_SIZE = (1080, 900)


class CDPError(RuntimeError):
    pass


def http_json(port: int, path: str) -> Any:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as r:
        return json.load(r)


def page_targets(port: int) -> list[dict[str, Any]]:
    """Page targets (no DevTools, extension or worker pages), most recently active first."""
    out = []
    for t in http_json(port, "/json/list"):
        url = t.get("url", "")
        if t.get("type") != "page" or url.startswith(
            ("devtools://", "chrome-extension://")
        ):
            continue
        out.append(t)
    return out


def find_page(port: int, match: str) -> dict[str, Any] | None:
    """The page whose id is `match`, else the first whose URL, else whose title, contains it."""
    pages = page_targets(port)
    for t in pages:
        if t.get("id") == match:
            return t
    for key in ("url", "title"):
        for t in pages:
            if match in t.get(key, ""):
                return t
    return None


def read_script(path: str | None) -> str | None:
    return Path(path).read_text() if path else None


def parse_size(s: str) -> tuple[int, int]:
    m = re.fullmatch(r"(\d+)[x×](\d+)", s.strip())
    if not m:
        raise argparse.ArgumentTypeError(f"expected WIDTHxHEIGHT, not {s!r}")
    return int(m[1]), int(m[2])


def plan_bounds(
    side: str, view: tuple[int, int], chrome: tuple[int, int], screen: dict[str, int]
) -> dict[str, int]:
    """Window bounds giving a `view` viewport, flush with the screen's left or right edge.

    `chrome` is what the window adds around the viewport (tab strip, toolbar, borders),
    measured from the window as it is. `screen` carries the available area as the page
    sees it (sl/st/sw/sh: left, top, width, height).
    """
    if side not in ("left", "right"):
        raise ValueError(f"side must be left or right, not {side!r}")
    w, h = view[0] + max(chrome[0], 0), view[1] + max(chrome[1], 0)
    left = screen.get("sl", 0)
    if side == "right":
        left += max(screen.get("sw", w) - w, 0)
    return {
        "left": int(left),
        "top": int(screen.get("st", 0)),
        "width": int(w),
        "height": int(h),
    }


class Browser:
    """A browser-level CDP connection (synchronous; one command at a time). Use as a context manager."""

    def __init__(self, port: int):
        self.port = port
        self.url = http_json(port, "/json/version")["webSocketDebuggerUrl"]
        self._id = 0

    def __enter__(self) -> Browser:
        self._conn = connect(self.url, max_size=None, open_timeout=5)
        self.ws = self._conn.__enter__()
        return self

    def __exit__(self, *exc: object) -> None:
        self._conn.__exit__(*exc)

    def call(
        self,
        method: str,
        params: dict | None = None,
        session: str | None = None,
        timeout: float = 10,
    ) -> dict:
        self._id += 1
        msg: dict[str, Any] = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.ws.send(json.dumps(msg))
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise CDPError(f"{method}: no answer in {timeout}s")
            m = json.loads(self.ws.recv(timeout=left))
            if m.get("id") == self._id:
                if "error" in m:
                    raise CDPError(
                        f"{method}: {m['error'].get('message')} {m['error'].get('data', '')}".strip()
                    )
                return m.get("result", {})

    def evaluate(self, target_id: str, expression: str) -> Any:
        sess = self.call(
            "Target.attachToTarget", {"targetId": target_id, "flatten": True}
        )["sessionId"]
        try:
            r = self.call(
                "Runtime.evaluate",
                {"expression": expression, "returnByValue": True},
                session=sess,
            )
            return r.get("result", {}).get("value")
        finally:
            try:
                self.call("Target.detachFromTarget", {"sessionId": sess})
            except CDPError:
                pass

    def metrics(self, target_id: str, tries: int = 20) -> dict[str, Any]:
        """Viewport and screen size as the page sees them (CSS px). Retries while a new page is blank."""
        expr = (
            "JSON.stringify({iw: innerWidth, ih: innerHeight, sl: screen.availLeft || 0, st: screen.availTop || 0,"
            " sw: screen.availWidth, sh: screen.availHeight, dpr: devicePixelRatio})"
        )
        last: dict = {}
        for _ in range(tries):
            try:
                v = self.evaluate(target_id, expr)
                last = json.loads(v) if v else {}
                if last.get("iw") and last.get("ih"):
                    return last
            except CDPError:
                pass
            time.sleep(0.25)
        raise CDPError(f"page {target_id} reports no viewport: {last}")

    def open_window(self, url: str, init_script: str | None) -> str:
        """Open `url` in a new window (not a tab: a hidden tab produces no screencast frames).

        `init_script` runs in the page before any of its own scripts (the
        office's quiet script has to beat the office's timers to it)."""
        if init_script is None:
            return self.call(
                "Target.createTarget",
                {"url": url, "newWindow": True, "background": False},
            )["targetId"]
        tid = self.call(
            "Target.createTarget",
            {"url": "about:blank", "newWindow": True, "background": False},
        )["targetId"]
        sess = self.call("Target.attachToTarget", {"targetId": tid, "flatten": True})[
            "sessionId"
        ]
        self.call("Page.enable", session=sess)
        self.call(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": init_script},
            session=sess,
        )
        self.call("Page.navigate", {"url": url}, session=sess)
        time.sleep(3)
        self.call("Target.detachFromTarget", {"sessionId": sess})
        return tid

    def window_for(self, target_id: str) -> tuple[int, dict[str, Any]]:
        r = self.call("Browser.getWindowForTarget", {"targetId": target_id})
        return r["windowId"], r["bounds"]

    def set_bounds(self, window_id: int, **bounds: Any) -> None:
        self.call("Browser.setWindowBounds", {"windowId": window_id, "bounds": bounds})

    def place(self, target_id: str, side: str, view: tuple[int, int]) -> dict[str, Any]:
        """Resize the target's window so its viewport is `view`, flush with the screen's `side` edge."""
        wid, b = self.window_for(target_id)
        if b.get("windowState") != "normal":
            self.set_bounds(wid, windowState="normal")
            time.sleep(0.3)
            wid, b = self.window_for(target_id)
        m = self.metrics(target_id)
        for _ in range(
            3
        ):  # chrome size can change after a resize (e.g. an infobar), so re-measure
            plan = plan_bounds(
                side, view, (b["width"] - m["iw"], b["height"] - m["ih"]), m
            )
            self.set_bounds(wid, **plan)
            time.sleep(0.3)
            wid, b = self.window_for(target_id)
            m = self.metrics(target_id)
            if (m["iw"], m["ih"]) == view:
                break
        return {
            "target": target_id,
            "window": wid,
            "bounds": b,
            "viewport": [m["iw"], m["ih"]],
            "dpr": m.get("dpr"),
            "screen": [m["sw"], m["sh"]],
        }

    def activate(self, target_id: str) -> None:
        self.call("Target.activateTarget", {"targetId": target_id})


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--port",
        type=int,
        default=9333,
        help="Chrome remote debugging port (default 9333)",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="list page targets with their window bounds")
    p_open = sub.add_parser(
        "open", help="open a URL in a new window and print its target id"
    )
    p_open.add_argument("url")
    p_open.add_argument(
        "--init-script",
        help="a script to run in the page before its own (e.g. office_quiet.js)",
    )
    p_open.add_argument(
        "--side", choices=["left", "right"], help="also size and place the new window"
    )
    p_open.add_argument(
        "--size",
        type=parse_size,
        help="viewport WxH (default 840x900 left, 1080x900 right)",
    )
    p_place = sub.add_parser("place", help="resize and position the window of one page")
    p_place.add_argument(
        "--match", required=True, help="URL/title substring or target id"
    )
    p_place.add_argument("--side", choices=["left", "right"], required=True)
    p_place.add_argument(
        "--size",
        type=parse_size,
        help="viewport WxH (default 840x900 left, 1080x900 right)",
    )
    p_lay = sub.add_parser(
        "layout",
        help="Slack window left, office window right (opens the office if asked)",
    )
    p_lay.add_argument(
        "--left", required=True, help="URL/title substring of the left page (Slack)"
    )
    p_lay.add_argument(
        "--right", required=True, help="URL/title substring of the right page (office)"
    )
    p_lay.add_argument(
        "--open-right",
        metavar="URL",
        help="open this URL in a new window if no page matches --right",
    )
    p_lay.add_argument(
        "--init-script", help="a script to run in the --open-right page before its own"
    )
    p_lay.add_argument(
        "--left-size",
        type=parse_size,
        default=LEFT_SIZE,
        help="left viewport WxH (default 840x900)",
    )
    p_lay.add_argument(
        "--right-size",
        type=parse_size,
        default=RIGHT_SIZE,
        help="right viewport WxH (default 1080x900)",
    )
    a = ap.parse_args(argv)

    def default_size(side: str | None, size: tuple[int, int] | None) -> tuple[int, int]:
        return size or (LEFT_SIZE if side == "left" else RIGHT_SIZE)

    try:
        with Browser(a.port) as br:
            if a.cmd == "list":
                rows = []
                for t in page_targets(a.port):
                    try:
                        wid, b = br.window_for(t["id"])
                    except CDPError:
                        wid, b = None, {}
                    rows.append(
                        {
                            "id": t["id"],
                            "window": wid,
                            "bounds": b,
                            "url": t["url"][:120],
                            "title": t.get("title", "")[:60],
                        }
                    )
                print(json.dumps(rows, indent=2))
            elif a.cmd == "open":
                tid = br.open_window(a.url, read_script(a.init_script))
                out: dict[str, Any] = {"target": tid}
                if a.side:
                    out = br.place(tid, a.side, default_size(a.side, a.size))
                print(json.dumps(out, indent=2))
            elif a.cmd == "place":
                t = find_page(a.port, a.match)
                if not t:
                    print(f"no page matches {a.match!r}", file=sys.stderr)
                    return 2
                print(
                    json.dumps(
                        br.place(t["id"], a.side, default_size(a.side, a.size)),
                        indent=2,
                    )
                )
            elif a.cmd == "layout":
                left = find_page(a.port, a.left)
                if not left:
                    print(f"no page matches --left {a.left!r}", file=sys.stderr)
                    return 2
                right = find_page(a.port, a.right)
                if not right and a.open_right:
                    right = {
                        "id": br.open_window(a.open_right, read_script(a.init_script))
                    }
                if not right:
                    print(
                        f"no page matches --right {a.right!r} (pass --open-right URL to open it)",
                        file=sys.stderr,
                    )
                    return 2
                if left["id"] == right["id"]:
                    print("--left and --right match the same page", file=sys.stderr)
                    return 2
                lw, _ = br.window_for(left["id"])
                rw, _ = br.window_for(right["id"])
                if lw == rw:
                    print(
                        "both pages are tabs of one window, and a hidden tab records nothing: open the office in its own "
                        "window (--open-right with a URL no tab matches yet, or drag the tab out)",
                        file=sys.stderr,
                    )
                    return 2
                res = {
                    "left": br.place(left["id"], "left", a.left_size),
                    "right": br.place(right["id"], "right", a.right_size),
                }
                for t in (left, right):
                    br.activate(t["id"])
                print(json.dumps(res, indent=2))
                need = res["left"]["bounds"]["width"] + res["right"]["bounds"]["width"]
                sw = res["left"]["screen"][0]
                if need > sw:
                    print(
                        f"note: the two windows need {need}px and the screen is {sw}px wide, so they overlap. Keep the "
                        "office partly visible: a fully covered window may stop painting.",
                        file=sys.stderr,
                    )
                for k, want in (("left", a.left_size), ("right", a.right_size)):
                    if res[k]["viewport"] != list(want):
                        print(
                            f"warning: {k} viewport is {res[k]['viewport'][0]}x{res[k]['viewport'][1]}, not "
                            f"{want[0]}x{want[1]} (screen too small?); the video builder letterboxes it",
                            file=sys.stderr,
                        )
    except (OSError, CDPError) as e:
        print(f"CDP on port {a.port}: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
