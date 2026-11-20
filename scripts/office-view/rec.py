#!/usr/bin/env python3
"""Record one Chrome page's DevTools screencast to <outdir>/<epoch_ms>.jpg.

    uv run --with websockets python scripts/office-view/rec.py --port 9333 --match app.slack.com --out rec/slack
    uv run --with websockets python scripts/office-view/rec.py --port 9333 --match 127.0.0.1:3334 --out rec/office

(The old positional form `rec.py <port> <url-substring> <outdir>` still works.)

Chrome sends a frame only when the page repaints, so a quiet page leaves gaps;
the video builder holds the last frame across them. Each frame is named after
the wall-clock time it was painted (the screencast's own timestamp when it is
sane, else the time it arrived), and written atomically so a build can read the
folder while recording goes on. Every frame is acknowledged, or Chrome stops
sending. If the page or Chrome goes away the recorder reconnects with backoff
and keeps going until Ctrl-C (or --duration seconds).

The page must be visible in its own window: a background tab produces no frames
(see windows.py).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import signal
import sys
import time

import websockets
from windows import find_page


def log(*a: object) -> None:
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


class Recorder:
    def __init__(
        self,
        port: int,
        match: str,
        out: str,
        quality: int,
        max_w: int,
        max_h: int,
        viewport: tuple[int, int] | None,
        every_nth: int,
    ):
        self.port, self.match, self.out = port, match, out
        self.viewport = viewport
        self.params = {
            "format": "jpeg",
            "quality": quality,
            "maxWidth": max_w,
            "maxHeight": max_h,
            "everyNthFrame": every_nth,
        }
        self.frames = 0
        self.last_ms = 0
        self.stop = asyncio.Event()

    def frame_name(self, meta_ts: float | None) -> int:
        now = time.time()
        t = meta_ts if meta_ts and abs(meta_ts - now) < 5 else now
        ms = int(t * 1000)
        if ms <= self.last_ms:  # keep names unique and in order
            ms = self.last_ms + 1
        self.last_ms = ms
        return ms

    def save(self, data_b64: str, meta_ts: float | None) -> None:
        ms = self.frame_name(meta_ts)
        path = os.path.join(self.out, f"{ms}.jpg")
        tmp = os.path.join(self.out, f".{ms}.jpg.part")
        with open(tmp, "wb") as f:
            f.write(base64.b64decode(data_b64))
        os.replace(tmp, path)
        self.frames += 1

    async def session(self) -> None:
        t = await asyncio.to_thread(find_page, self.port, self.match)
        if not t:
            raise LookupError(f"no page matches {self.match!r} on port {self.port}")
        async with websockets.connect(
            t["webSocketDebuggerUrl"], max_size=None, open_timeout=5
        ) as ws:
            n = 1
            if self.viewport:
                # Lays the page out at this size for as long as this connection
                # holds it, whatever the window's size; Chrome drops it when the
                # recorder disconnects.
                w, h = self.viewport
                await ws.send(
                    json.dumps(
                        {
                            "id": n,
                            "method": "Emulation.setDeviceMetricsOverride",
                            "params": {
                                "width": w,
                                "height": h,
                                "deviceScaleFactor": 2,
                                "mobile": False,
                            },
                        }
                    )
                )
                n += 1
            await ws.send(
                json.dumps(
                    {"id": n, "method": "Page.startScreencast", "params": self.params}
                )
            )
            log(f"recording {t['url'][:100]} -> {self.out}")
            started, since = self.frames, time.monotonic()
            while not self.stop.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                except TimeoutError:
                    if time.monotonic() - since > 30:
                        log(
                            f"{self.frames - started} frames in the last 30s ({self.frames} total)"
                        )
                        started, since = self.frames, time.monotonic()
                    continue
                m = json.loads(raw)
                if m.get("method") == "Page.screencastFrame":
                    p = m["params"]
                    self.save(p["data"], p.get("metadata", {}).get("timestamp"))
                    n += 1
                    await ws.send(
                        json.dumps(
                            {
                                "id": n,
                                "method": "Page.screencastFrameAck",
                                "params": {"sessionId": p["sessionId"]},
                            }
                        )
                    )
                elif m.get("method") == "Inspector.detached":
                    raise ConnectionError(f"detached: {m['params'].get('reason')}")
                elif "error" in m:
                    raise RuntimeError(f"CDP error: {m['error']}")
            try:
                n += 1
                await ws.send(json.dumps({"id": n, "method": "Page.stopScreencast"}))
            except websockets.ConnectionClosed:
                pass

    async def run(self, duration: float | None) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self.stop.set)
        if duration:
            loop.call_later(duration, self.stop.set)
        backoff = 1.0
        while not self.stop.is_set():
            before = self.frames
            try:
                await self.session()
            except Exception as e:  # reconnect on anything: page reload, Chrome restart, target not open yet
                log("reconnect:", repr(e)[:200])
            if self.frames > before:
                backoff = 1.0
            try:
                await asyncio.wait_for(self.stop.wait(), timeout=backoff)
            except TimeoutError:
                pass
            backoff = min(backoff * 2, 8.0)
        log(f"stopped: {self.frames} frames in {self.out}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("legacy", nargs="*", help=argparse.SUPPRESS)
    ap.add_argument("--port", type=int, help="Chrome remote debugging port (e.g. 9333)")
    ap.add_argument(
        "--match", help="substring of the page URL (or title, or a target id)"
    )
    ap.add_argument(
        "--out", help="folder for <epoch_ms>.jpg frames (created if missing)"
    )
    ap.add_argument("--quality", type=int, default=85, help="JPEG quality (default 85)")
    ap.add_argument(
        "--max-width",
        type=int,
        default=1920,
        help="frame size cap; Retina pages arrive at 2x (default 1920)",
    )
    ap.add_argument("--max-height", type=int, default=1860)
    ap.add_argument("--duration", type=float, help="stop after this many seconds")
    ap.add_argument(
        "--viewport",
        help="lay the page out at WxH CSS px while recording (e.g. 840x900), whatever its window's size",
    )
    ap.add_argument(
        "--every-nth",
        type=int,
        default=1,
        help="keep one repaint in N (an animated page repaints ~60 times a second; 6 gives ~10 fps)",
    )
    a = ap.parse_args(argv)
    if a.legacy:
        if len(a.legacy) != 3:
            ap.error("positional form is: rec.py <port> <url-substring> <outdir>")
        a.port, a.match, a.out = int(a.legacy[0]), a.legacy[1], a.legacy[2]
    if not (a.port and a.match and a.out):
        ap.error("--port, --match and --out are required")
    os.makedirs(a.out, exist_ok=True)
    viewport = (
        tuple(int(v) for v in a.viewport.lower().split("x")) if a.viewport else None
    )
    rec = Recorder(
        a.port,
        a.match,
        a.out,
        a.quality,
        a.max_width,
        a.max_height,
        viewport,
        a.every_nth,
    )
    asyncio.run(rec.run(a.duration))
    return 0


if __name__ == "__main__":
    sys.exit(main())
