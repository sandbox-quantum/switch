#!/usr/bin/env python3
"""Write synthetic Slack and office frame folders plus a marks TSV, for testing build_video.py offline.

    uv run --with pillow python scripts/office-view/fake_frames.py /tmp/ov-fake
    # -> /tmp/ov-fake/slack/<epoch_ms>.jpg, /tmp/ov-fake/office/<epoch_ms>.jpg, /tmp/ov-fake/marks.tsv

The fake walk lasts about 60 seconds and has the shapes a real recording has:
Slack only repaints when a message lands; the office starts 2.5 s late (so the
right pane shows its placeholder first) and keeps a faint idle animation going
through a ~30 s quiet stretch (which the builder should speed up), with bigger
movement while agents work. Every frame shows its own clock so sync can be
checked by eye.
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import os
import shutil
import sys

from PIL import Image, ImageDraw, ImageFont

SANS = "/System/Library/Fonts/SFNS.ttf"
MONO = "/System/Library/Fonts/SFNSMono.ttf"

SLACK_MSGS = [  # (seconds, author, is_agent, text)
    (1.0, "mo", False, "Morning! Let's see the agents at work today."),
    (3.0, "mo", False, "@reviewer can you check PR #42 and run the tests?"),
    (
        11.0,
        "reviewer",
        True,
        "On it - running the test suite and a subagent for the diff.",
    ),
    (
        16.0,
        "reviewer",
        True,
        "Tests pass (212). One nit on error handling, left a comment.",
    ),
    (47.0, "mo", False, "@deployer ship it to staging please"),
    (52.5, "deployer", True, "Needs approval: deploy to staging?"),
    (56.0, "mo", False, "approved"),
    (58.0, "deployer", True, "Deployed to staging in 41s."),
]
OFFICE_ACTIVE = [(3.2, 16.5), (47.2, 59.0)]


def font(size: int, mono: bool = False) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype(MONO if mono else SANS, size)
    except OSError:
        return ImageFont.load_default(size)


def slack_frame(
    t: float, base: dt.datetime, w: int, h: int, s: float, typing: str | None
) -> Image.Image:
    img = Image.new("RGB", (w, h), (255, 255, 255))
    d = ImageDraw.Draw(img)
    side = int(220 * s)
    d.rectangle([0, 0, side, h], fill=(63, 14, 64))
    d.text(
        (int(18 * s), int(18 * s)),
        "Sandbox",
        font=font(int(20 * s)),
        fill=(255, 255, 255),
    )
    for i, ch in enumerate(["# general", "# office-demo", "# random", "# deploys"]):
        y = int((80 + 30 * i) * s)
        if ch == "# office-demo":
            d.rounded_rectangle(
                [int(8 * s), y - int(4 * s), side - int(8 * s), y + int(24 * s)],
                radius=int(6 * s),
                fill=(18, 100, 163),
            )
        d.text((int(20 * s), y), ch, font=font(int(16 * s)), fill=(230, 220, 230))
    d.rectangle([side, 0, w, int(56 * s)], fill=(248, 248, 248))
    d.line(
        [side, int(56 * s), w, int(56 * s)], fill=(221, 221, 221), width=max(1, int(s))
    )
    d.text(
        (side + int(20 * s), int(16 * s)),
        "# office-demo",
        font=font(int(20 * s)),
        fill=(29, 28, 29),
    )
    clock = (base + dt.timedelta(seconds=t)).strftime("%H:%M:%S.%f")[:-5]
    d.text(
        (w - int(170 * s), int(18 * s)),
        f"slack {clock}",
        font=font(int(15 * s), mono=True),
        fill=(150, 150, 150),
    )
    y = int(80 * s)
    for at, who, agent, text in SLACK_MSGS:
        if at > t:
            break
        col = (217, 119, 87) if agent else (54, 197, 240)
        d.rounded_rectangle(
            [side + int(20 * s), y, side + int(56 * s), y + int(36 * s)],
            radius=int(6 * s),
            fill=col,
        )
        d.text((side + int(68 * s), y), who, font=font(int(17 * s)), fill=(29, 28, 29))
        if agent:
            d.rounded_rectangle(
                [
                    side + int(150 * s),
                    y + int(2 * s),
                    side + int(200 * s),
                    y + int(20 * s),
                ],
                radius=int(3 * s),
                fill=(232, 232, 232),
            )
            d.text(
                (side + int(156 * s), y + int(3 * s)),
                "AGENT",
                font=font(int(11 * s)),
                fill=(97, 96, 97),
            )
        d.text(
            (side + int(68 * s), y + int(22 * s)),
            text,
            font=font(int(16 * s)),
            fill=(29, 28, 29),
        )
        y += int(70 * s)
    d.rounded_rectangle(
        [side + int(20 * s), h - int(90 * s), w - int(20 * s), h - int(30 * s)],
        radius=int(8 * s),
        outline=(200, 200, 200),
        width=max(1, int(s)),
    )
    d.text(
        (side + int(36 * s), h - int(70 * s)),
        "Message #office-demo",
        font=font(int(16 * s)),
        fill=(150, 150, 150),
    )
    if typing:
        d.text(
            (side + int(24 * s), h - int(24 * s)),
            f"{typing} is typing...",
            font=font(int(13 * s)),
            fill=(120, 120, 120),
        )
    return img


def office_page(t: float, base: dt.datetime, w: int, h: int, s: float) -> Image.Image:
    """The office page: a fixed 1056x682 frame centred on a plain dark page, like the real one."""
    page = Image.new("RGB", (w, h), (14, 14, 16))
    fw, fh = int(1056 * s), int(682 * s)
    page.paste(office_frame(t, base, fw, fh, s), ((w - fw) // 2, (h - fh) // 2))
    return page


def office_frame(t: float, base: dt.datetime, w: int, h: int, s: float) -> Image.Image:
    img = Image.new("RGB", (w, h), (38, 34, 46))
    d = ImageDraw.Draw(img)
    tile = int(48 * s)
    for gx in range(0, w, tile):
        for gy in range(int(60 * s), h, tile):
            if (gx // tile + gy // tile) % 2:
                d.rectangle([gx, gy, gx + tile - 1, gy + tile - 1], fill=(44, 40, 54))
    d.rectangle([0, 0, w, int(60 * s)], fill=(24, 22, 30))
    d.text(
        (int(16 * s), int(18 * s)),
        "Agent Office",
        font=font(int(20 * s)),
        fill=(240, 200, 120),
    )
    clock = (base + dt.timedelta(seconds=t)).strftime("%H:%M:%S.%f")[:-5]
    d.text(
        (w - int(170 * s), int(20 * s)),
        f"office {clock}",
        font=font(int(15 * s), mono=True),
        fill=(150, 140, 170),
    )
    active = any(a <= t <= b for a, b in OFFICE_ACTIVE)
    desks = [
        (230, 210, "reviewer"),
        (640, 210, "deployer"),
        (230, 470, ""),
        (640, 470, ""),
    ]
    for i, (x, y, name) in enumerate(desks):
        x, y = int(x * s), int(y * s)
        d.rectangle([x, y, x + int(140 * s), y + int(60 * s)], fill=(120, 84, 60))
        d.rectangle(
            [x + int(40 * s), y - int(30 * s), x + int(100 * s), y], fill=(30, 30, 36)
        )
        glow = (90, 200, 255) if active and name else (60, 70, 90)
        d.rectangle(
            [x + int(44 * s), y - int(26 * s), x + int(96 * s), y - int(4 * s)],
            fill=glow,
        )
        if name:
            bob = int((2 if active else 1) * s * math.sin(t * (9 if active else 2) + i))
            d.ellipse(
                [
                    x + int(55 * s),
                    y + int(64 * s) + bob,
                    x + int(85 * s),
                    y + int(94 * s) + bob,
                ],
                fill=(217, 119, 87),
            )
            pw = d.textlength(name, font=font(int(13 * s)))
            d.rounded_rectangle(
                [
                    x + int(70 * s) - pw / 2 - 8 * s,
                    y + int(100 * s),
                    x + int(70 * s) + pw / 2 + 8 * s,
                    y + int(122 * s),
                ],
                radius=int(10 * s),
                fill=(20, 20, 26),
            )
            d.text(
                (x + int(70 * s) - pw / 2, y + int(103 * s)),
                name,
                font=font(int(13 * s)),
                fill=(255, 255, 255),
            )
    for a, b in OFFICE_ACTIVE:  # a worker walks in and out during each active period
        if a <= t <= b:
            u = (t - a) / (b - a)
            wx = int((40 + 900 * (u if u < 0.5 else 1 - u)) * s)
            d.rectangle(
                [wx, int(380 * s), wx + int(28 * s), int(430 * s)], fill=(120, 200, 140)
            )
            d.ellipse(
                [wx + int(2 * s), int(350 * s), wx + int(26 * s), int(376 * s)],
                fill=(250, 220, 180),
            )
            if t - a < 1.2:
                d.rounded_rectangle(
                    [int(380 * s), int(80 * s), int(690 * s), int(130 * s)],
                    radius=int(10 * s),
                    fill=(255, 255, 255),
                )
                d.text(
                    (int(400 * s), int(92 * s)),
                    "BOSS: review PR #42!" if a < 30 else "BOSS: ship it!",
                    font=font(int(18 * s)),
                    fill=(20, 20, 20),
                )
    if 52.5 <= t < 56.0:  # hand up for the approval
        x, y = int(640 * s), int(210 * s)
        d.line(
            [x + int(88 * s), y + int(70 * s), x + int(100 * s), y + int(30 * s)],
            fill=(250, 220, 180),
            width=int(6 * s),
        )
        d.text(
            (x + int(96 * s), y + int(4 * s)),
            "!",
            font=font(int(28 * s)),
            fill=(255, 210, 80),
        )
    return img


def write(img: Image.Image, folder: str, ms: int) -> None:
    img.save(os.path.join(folder, f"{ms}.jpg"), quality=85)


def generate(out: str, scale: float, start: dt.datetime | None) -> dict[str, object]:
    base = start or dt.datetime.now().replace(microsecond=0) - dt.timedelta(minutes=5)
    t0 = base.timestamp()
    for sub in ("slack", "office"):
        shutil.rmtree(os.path.join(out, sub), ignore_errors=True)
        os.makedirs(os.path.join(out, sub))
    sw, sh = int(840 * scale), int(900 * scale)  # Slack viewport
    ow, oh = int(1080 * scale), int(900 * scale)  # office viewport

    # Slack: a frame when each message lands, a typing indicator a moment before agent replies.
    events: list[tuple[float, str | None]] = [(0.0, None)]
    for at, who, agent, _ in SLACK_MSGS:
        if agent:
            events += [(at - 1.5, who), (at - 0.8, who)]
        events.append((at, None))
        events.append((at + 0.25, None))  # a repaint just after (scroll settle)
    n_slack = 0
    for at, typing in sorted(events):
        write(
            slack_frame(at, base, sw, sh, scale, typing),
            os.path.join(out, "slack"),
            int((t0 + at) * 1000),
        )
        n_slack += 1

    # Office: 8 fps while agents work, 2 fps idle animation otherwise, nothing before 2.5 s.
    n_office, t = 0, 2.5
    while t <= 60.0:
        write(
            office_page(t, base, ow, oh, scale),
            os.path.join(out, "office"),
            int((t0 + t) * 1000),
        )
        n_office += 1
        t += 0.125 if any(a <= t <= b for a, b in OFFICE_ACTIVE) else 0.5

    def iso(sec: float) -> str:
        return (base + dt.timedelta(seconds=sec)).isoformat(timespec="milliseconds")

    rows = [
        "# time\tcaption\ttag",
        f"{iso(0.5)}\tA person opens #office-demo in the Slack sandbox; the office is still starting.\tslack",
        f"{int((t0 + 3.0) * 1000)}\tThey ask @reviewer to check PR #42: the boss shouts the prompt in the office.\tslack",
        f"{iso(5.0)}\treviewer runs the tests and starts a subagent: a worker walks in.\toffice",
        f"{iso(16.0)}\tThe reply lands in Slack and in the office chat under reviewer's name.\t",
        f"{(base + dt.timedelta(seconds=47)).strftime('%H:%M:%S')}\t@deployer is asked to ship to staging.\tslack",
        f"{iso(52.5)}\tdeployer needs an approval: its hand goes up in the office.\toffice",
        f"{iso(56.0)}\tApproved in Slack: the hand comes down and the deploy finishes.\tslack",
    ]
    marks = os.path.join(out, "marks.tsv")
    with open(marks, "w") as f:
        f.write("\n".join(rows) + "\n")
    return {
        "slack": n_slack,
        "office": n_office,
        "marks": marks,
        "start": base.isoformat(),
        "slack_size": f"{sw}x{sh}",
        "office_size": f"{ow}x{oh}",
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("out", help="folder to write slack/, office/ and marks.tsv into")
    ap.add_argument(
        "--scale",
        type=float,
        default=1.0,
        help="2 mimics a Retina screencast (frames at twice the viewport size)",
    )
    ap.add_argument("--start", help="wall-clock start (ISO); default five minutes ago")
    a = ap.parse_args(argv)
    res = generate(
        a.out, a.scale, dt.datetime.fromisoformat(a.start) if a.start else None
    )
    print(res)
    return 0


if __name__ == "__main__":
    sys.exit(main())
