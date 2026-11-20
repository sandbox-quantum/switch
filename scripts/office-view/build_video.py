#!/usr/bin/env python3
"""Compose the side-by-side office-view demo video from saved frames and a marks TSV.

    uv run --with pillow python scripts/office-view/build_video.py \\
        --left rec/slack --right rec/office --marks marks.tsv \\
        --title "Switch × Claude Office — agents at work" --out video/office-view.mp4

Inputs are only files: two folders of <epoch_ms>.jpg frames (rec.py writes them)
and a marks TSV, one caption per line:

    <time>  TAB  <caption>  [TAB <tag>]

<time> is an ISO timestamp (2026-11-17T14:02:31.250, local unless it has an
offset), epoch milliseconds or seconds, or HH:MM[:SS] on the recording's date.
Lines starting with # are skipped. A tag shows as a small label over the
caption; the tags slack/left and office/right also make that pane glow.
`\\n` in a caption breaks the line. Edit the TSV and rebuild: nothing else runs.

Output: 1920x1080, 10 fps, H.264 (yuv420p, faststart). Slack takes the left
pane and the office the right, in the width ratio 840:1080 by default (the
office draws a fixed ~1060x680 frame; its empty page margin is trimmed
automatically). Each source is scaled to fit its pane keeping its shape. Both
are aligned on the wall clock (each pane shows its newest frame at or before
that moment).
Stretches where neither pane changes and no caption starts for longer than
--idle seconds play fast, with a labelled speed pill; a pane that changes
visibly glows briefly. A pane with no frame yet shows a "waiting" placeholder.
"""

from __future__ import annotations

import argparse
import bisect
import datetime as dt
import functools
import os
import re
import subprocess
import sys
import time
from collections import deque
from dataclasses import dataclass, field

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 10
CAP_H = 150
STEP_MS = 1000 / FPS

SANS = "/System/Library/Fonts/SFNS.ttf"
MONO = "/System/Library/Fonts/SFNSMono.ttf"

BG_TOP, BG_BOTTOM = (17, 19, 27), (8, 9, 13)
PANE_BG = (22, 25, 34)
INK, INK_DIM, INK_FAINT = (238, 240, 245), (150, 157, 173), (92, 99, 116)
SLACK_ACCENT = (54, 197, 240)  # Slack's blue
OFFICE_ACCENT = (217, 119, 87)  # Claude's coral
FF_ACCENT = (245, 196, 92)

FRAME_RE = re.compile(r"^(\d{10,16})\.(jpe?g|png)$", re.I)
THUMB = (96, 93)


# --------------------------------------------------------------------------- fonts
_fonts: dict[tuple, ImageFont.FreeTypeFont] = {}
_font_warned = False


def font(size: int, weight: int = 400, mono: bool = False) -> ImageFont.ImageFont:
    global _font_warned
    key = (size, weight, mono)
    if key in _fonts:
        return _fonts[key]
    try:
        f = ImageFont.truetype(MONO if mono else SANS, size)
        if mono:
            names = {400: b"Regular", 500: b"Medium", 600: b"Semibold", 700: b"Bold"}
            f.set_variation_by_name(names.get(weight, b"Regular"))
        else:
            axes = []
            for ax in f.get_variation_axes():
                n = ax["name"]
                v = {
                    b"Weight": weight,
                    b"Optical Size": max(ax["minimum"], min(ax["maximum"], size)),
                    b"Width": 100,
                }.get(n, ax["default"])
                axes.append(v)
            f.set_variation_by_axes(axes)
    except OSError:
        if not _font_warned:
            print(
                f"warning: {SANS} / {MONO} not found; using Pillow's default font",
                file=sys.stderr,
            )
            _font_warned = True
        f = ImageFont.load_default(size)
    _fonts[key] = f
    return f


# --------------------------------------------------------------------------- inputs
@dataclass
class Mark:
    t: int
    caption: str
    tag: str


def parse_time(s: str, ref_date: dt.date) -> int:
    """Epoch ms from ISO, epoch ms/s, or HH:MM[:SS[.fff]] (local time on ref_date)."""
    s = s.strip()
    if re.fullmatch(r"\d{12,16}", s):
        return int(s)
    if re.fullmatch(r"\d{9,11}(\.\d+)?", s):
        return int(float(s) * 1000)
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?", s)
    if m:
        h, mi, sec, frac = int(m[1]), int(m[2]), int(m[3] or 0), float(m[4] or 0)
        d = dt.datetime.combine(ref_date, dt.time(h, mi, sec))
        return int((d.timestamp() + frac) * 1000)
    d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    return int(d.timestamp() * 1000)


def read_marks(path: str, ref_date: dt.date) -> list[Mark]:
    marks: list[Mark] = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            cols = line.split("\t")
            try:
                t = parse_time(cols[0], ref_date)
            except ValueError:
                if not marks and n <= 2:  # a header row
                    continue
                raise SystemExit(f"{path}:{n}: can't read the time {cols[0]!r}")
            if len(cols) < 2:
                raise SystemExit(
                    f"{path}:{n}: expected <time> TAB <caption> [TAB <tag>]"
                )
            marks.append(
                Mark(
                    t,
                    cols[1].replace("\\n", "\n").strip(),
                    cols[2].strip() if len(cols) > 2 else "",
                )
            )
    marks.sort(key=lambda m: m.t)
    return marks


Crop = tuple[
    float, float, float, float
]  # left, top, right, bottom as fractions of the frame


class Source:
    """One recorded window: frame timestamps, how much each frame changed, and fitted images."""

    def __init__(
        self, name: str, folder: str | None, label: str, accent: tuple[int, int, int]
    ):
        self.name, self.label, self.accent = name, label, accent
        self.folder = folder
        self.ts: list[int] = []
        self.paths: list[str] = []
        if folder:
            if not os.path.isdir(folder):
                raise SystemExit(f"{label}: no such folder {folder}")
            entries = sorted(
                (int(m[1]), f) for f in os.listdir(folder) if (m := FRAME_RE.match(f))
            )
            self.ts = [e[0] for e in entries]
            self.paths = [os.path.join(folder, e[1]) for e in entries]
        self.crop: Crop | None = None
        self.pane: tuple[int, int] = (0, 0)
        self.change: list[float] = []
        self._cache: dict[int, Image.Image] = {}

    def _sample(self, n: int) -> list[str]:
        if not self.paths:
            return []
        step = max(1, len(self.paths) // n)
        return self.paths[::step][:n] + [self.paths[-1]]

    def _cropped(self, im: Image.Image) -> Image.Image:
        if not self.crop:
            return im
        x0, t, r, b = self.crop
        return im.crop(
            (
                round(x0 * im.width),
                round(t * im.height),
                round(r * im.width),
                round(b * im.height),
            )
        )

    def detect_crop(self, tol: int = 7) -> Crop | None:
        """Bounding box of everything that isn't the page's flat background, over a sample of frames.

        The office draws a fixed-size frame in the middle of a plain page; cropping to it lets
        the pane show the office itself, not the empty page around it."""
        box: list[float] | None = None
        for p in self._sample(16):
            with Image.open(p) as im:
                im.draft("RGB", (im.width // 4, im.height // 4))
                im = im.convert("RGB")
                im.thumbnail((480, 480))
            corners = [
                im.getpixel(xy)
                for xy in (
                    (1, 1),
                    (im.width - 2, 1),
                    (1, im.height - 2),
                    (im.width - 2, im.height - 2),
                )
            ]
            bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
            r, g, b = ImageChops.difference(im, Image.new("RGB", im.size, bg)).split()
            diff = ImageChops.lighter(ImageChops.lighter(r, g), b).point(
                lambda v: 255 if v > tol else 0
            )
            bb = diff.getbbox()
            if not bb:
                continue
            f = (
                bb[0] / im.width,
                bb[1] / im.height,
                bb[2] / im.width,
                bb[3] / im.height,
            )
            box = (
                list(f)
                if box is None
                else [
                    min(box[0], f[0]),
                    min(box[1], f[1]),
                    max(box[2], f[2]),
                    max(box[3], f[3]),
                ]
            )
        if not box:
            return None
        if (box[2] - box[0]) * (box[3] - box[1]) > 0.92:
            return None
        return (box[0], box[1], box[2], box[3])

    def content_size(self) -> tuple[int, int] | None:
        """Size of the (cropped) frames, from the most common size in a sample."""
        sizes: dict[tuple[int, int], int] = {}
        for p in self._sample(8):
            with Image.open(p) as im:
                w, h = im.size
            if self.crop:
                x0, t, r, b = self.crop
                w, h = round((r - x0) * w), round((b - t) * h)
            sizes[(w, h)] = sizes.get((w, h), 0) + 1
        return max(sizes, key=lambda k: sizes[k]) if sizes else None

    def measure_changes(self, lag_ms: int = 1000) -> None:
        """For each frame, the fraction of a small greyscale thumbnail that differs from the page
        as it was lag_ms earlier. Comparing across a second, not frame to frame, lets slow steady
        motion (a sprite walking) count while a looping idle animation mostly cancels out."""
        window: deque[tuple[int, Image.Image]] = deque()
        ref: Image.Image | None = None
        for t, p in zip(self.ts, self.paths):
            with Image.open(p) as im:
                im.draft("L", (im.width // 4, im.height // 4))
                th = self._cropped(im.convert("L")).resize(THUMB, Image.BILINEAR)
            while window and window[0][0] <= t - lag_ms:
                ref = window.popleft()[1]
            base = ref if ref is not None else (window[0][1] if window else None)
            if base is None:
                self.change.append(1.0)
            else:
                hist = ImageChops.difference(th, base).histogram()
                self.change.append(sum(hist[20:]) / (THUMB[0] * THUMB[1]))
            window.append((t, th))

    def index_at(self, t: float) -> int:
        return bisect.bisect_right(self.ts, t) - 1

    def max_change(self, after: int, upto: int) -> float:
        if upto <= after:
            return 0.0
        return max(self.change[max(after + 1, 0) : upto + 1], default=0.0)

    def image(self, i: int) -> Image.Image:
        """Frame i cropped and scaled to fit the pane, keeping its aspect ratio (letterboxed if it differs)."""
        if i not in self._cache:
            if len(self._cache) > 6:
                self._cache.pop(next(iter(self._cache)))
            with Image.open(self.paths[i]) as im:
                im = self._cropped(im.convert("RGB"))
            pw, ph = self.pane
            if im.size != (pw, ph):
                sc = min(pw / im.width, ph / im.height)
                im = im.resize(
                    (max(1, round(im.width * sc)), max(1, round(im.height * sc))),
                    Image.LANCZOS,
                )
                if im.size != (pw, ph):
                    canvas = Image.new("RGB", (pw, ph), PANE_BG)
                    canvas.paste(im, ((pw - im.width) // 2, (ph - im.height) // 2))
                    im = canvas
            self._cache[i] = im
        return self._cache[i]


# --------------------------------------------------------------------------- timeline
@dataclass
class Segment:
    a: float
    b: float
    speed: int  # nominal; 1 = real time


def nice_speed(x: float, max_speed: int) -> int:
    s = 2
    while s < x and s < max_speed:
        s *= 2
    return min(s, max_speed)


def plan_segments(
    t0: float,
    t1: float,
    activity: list[float],
    idle_ms: float,
    keep_ms: float,
    target_ms: float,
    max_speed: int,
) -> list[Segment]:
    """Real time near activity; quiet gaps longer than idle_ms are fast-forwarded to ~target_ms."""
    pts = sorted({t0, t1, *[a for a in activity if t0 < a < t1]})
    segs: list[Segment] = []
    cur = t0
    for a, b in zip(pts, pts[1:]):
        if b - a <= idle_ms:
            continue
        s0, s1 = a + keep_ms, b - keep_ms
        if s1 - s0 <= 0:
            continue
        speed = nice_speed((s1 - s0) / target_ms, max_speed)
        if speed < 2:
            continue
        segs.append(Segment(cur, s0, 1))
        segs.append(Segment(s0, s1, speed))
        cur = s1
    segs.append(Segment(cur, t1, 1))
    return [s for s in segs if s.b > s.a]


def output_times(
    segs: list[Segment], ramp_s: float = 0.6
) -> list[tuple[float, float, int]]:
    """Wall-clock time, instantaneous speed and nominal speed for every output frame.

    Inside a fast segment the speed ramps up from and back down to 1x over ~ramp_s
    of output time, so the cut into and out of fast-forward is smooth.
    """
    out: list[tuple[float, float, int]] = []
    for s in segs:
        w = s.a
        if s.speed == 1:
            while w < s.b:
                out.append((w, 1.0, 1))
                w += STEP_MS
            continue
        ramp = (
            s.speed * STEP_MS * ramp_s * FPS / 2
        )  # wall distance covered while ramping
        ramp = min(ramp, (s.b - s.a) / 2)
        while w < s.b:
            edge = min(w - s.a, s.b - w)
            v = 1 + (s.speed - 1) * max(0.0, min(1.0, edge / ramp if ramp else 1.0))
            out.append((w, v, s.speed))
            w += v * STEP_MS
    return out


# --------------------------------------------------------------------------- drawing helpers
def ease_out(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return 1 - (1 - x) ** 3


def rounded_mask(size: tuple[int, int], radius: int, ss: int = 4) -> Image.Image:
    big = Image.new("L", (size[0] * ss, size[1] * ss), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        [0, 0, big.width - 1, big.height - 1], radius=radius * ss, fill=255
    )
    return big.resize(size, Image.LANCZOS)


def vgradient(
    size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]
) -> Image.Image:
    col = Image.new("RGB", (1, 256))
    for y in range(256):
        u = y / 255
        col.putpixel(
            (0, y), tuple(round(top[i] + (bottom[i] - top[i]) * u) for i in range(3))
        )
    return col.resize(size, Image.BICUBIC)


def dither(img: Image.Image, amount: float = 3.0) -> Image.Image:
    """Add faint noise so dark gradients don't band once encoded to 8-bit yuv420p."""
    noise = Image.effect_noise(img.size, 64).point(
        lambda v: 128 + (v - 128) * amount / 64
    )
    return ImageChops.add(img, Image.merge("RGB", [noise] * 3), 1.0, -128)


def glow_blob(
    base: Image.Image,
    center: tuple[int, int],
    radius: int,
    color: tuple[int, int, int],
    alpha: int,
) -> None:
    layer = Image.new("RGBA", (radius * 2, radius * 2), color + (0,))
    m = Image.new("L", (radius * 2, radius * 2), 0)
    ImageDraw.Draw(m).ellipse(
        [radius // 2, radius // 2, radius * 3 // 2, radius * 3 // 2], fill=alpha
    )
    layer.putalpha(m.filter(ImageFilter.GaussianBlur(radius // 3)))
    base.paste(layer, (center[0] - radius, center[1] - radius), layer)


def text_w(text: str, f: ImageFont.ImageFont) -> float:
    return ImageDraw.Draw(Image.new("L", (1, 1))).textlength(text, font=f)


def wrap_px(text: str, f: ImageFont.ImageFont, width: int) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        cur = ""
        for word in para.split():
            trial = f"{cur} {word}".strip()
            if text_w(trial, f) <= width or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines


@functools.lru_cache(maxsize=256)
def pill(
    text: str,
    f: ImageFont.ImageFont,
    dot: tuple[int, int, int] | None,
    fill=(30, 33, 44, 235),
    ink=INK,
    outline=(255, 255, 255, 26),
    h: int = 40,
    glow: float = 0.0,
    icon: str | None = None,
    icon_color: tuple[int, int, int] = INK,
    sub: str = "",
) -> Image.Image:
    """A rounded label, optionally with a coloured status dot (and halo) or a fast-forward icon."""
    pad, gap = 16, 10
    lead = 0
    if dot:
        lead = 10 + gap
    if icon == "ff":
        lead = 22 + gap
    tw = text_w(text, f)
    sub_gap = 14 if sub else 0
    w = int(pad * 2 + lead + tw + sub_gap + (text_w(sub, f) if sub else 0))
    ss = 3
    img = Image.new("RGBA", (w * ss, h * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(
        [0, 0, w * ss - 1, h * ss - 1],
        radius=h * ss // 2,
        fill=fill,
        outline=outline,
        width=ss,
    )
    cy = h * ss // 2
    if dot:
        x = pad * ss
        if glow > 0:
            halo = Image.new("RGBA", img.size, (0, 0, 0, 0))
            r = int((9 + 7 * glow) * ss)
            ImageDraw.Draw(halo).ellipse(
                [x + 5 * ss - r, cy - r, x + 5 * ss + r, cy + r],
                fill=dot + (int(120 * glow),),
            )
            img.alpha_composite(halo)
        d.ellipse([x, cy - 5 * ss, x + 10 * ss, cy + 5 * ss], fill=dot + (255,))
    if icon == "ff":
        x, hh = pad * ss, 7 * ss
        for k in (0, 11):
            d.polygon(
                [(x + k * ss, cy - hh), (x + (k + 11) * ss, cy), (x + k * ss, cy + hh)],
                fill=icon_color + (255,),
            )
    img = img.resize((w, h), Image.LANCZOS)
    d = ImageDraw.Draw(img)
    asc, desc = f.getmetrics()
    ty = (h - asc - desc) // 2 + 1
    d.text((pad + lead, ty), text, font=f, fill=ink)
    if sub:
        d.text((pad + lead + tw + sub_gap, ty), sub, font=f, fill=INK_DIM)
    return img


def paste_alpha(
    base: Image.Image, layer: Image.Image, xy: tuple[int, int], alpha: float = 1.0
) -> None:
    if alpha <= 0:
        return
    if alpha < 1:
        layer = layer.copy()
        layer.putalpha(layer.getchannel("A").point(lambda v: int(v * alpha)))
    base.paste(layer, xy, layer)


# --------------------------------------------------------------------------- composer
@dataclass
class Pane:
    x: int
    y: int
    w: int
    h: int


def fit(aspect: float, box_w: int, box_h: int) -> tuple[int, int]:
    if box_w / box_h > aspect:
        return round(box_h * aspect), box_h
    return box_w, round(box_w / aspect)


class Layout:
    """Where the two panes go.

    Framed (default): the panes share the width above the caption bar in the ratio
    left_w:right_w, each shrunk to its source's shape so the frame hugs the content,
    with a constant gap, rounded corners and shadows, and labels above them.
    Exact: panes of exactly left_w x 930 and right_w x 930 side by side, no frames,
    labels floating over the content; sources are letterboxed, never cropped.
    """

    def __init__(
        self,
        exact: bool,
        left_w: int,
        right_w: int,
        left_aspect: float | None,
        right_aspect: float | None,
    ):
        self.exact = exact
        top = H - CAP_H
        if exact:
            self.radius, self.gap = 0, 0
            x0 = max(0, (W - left_w - right_w) // 2)
            self.panes = {
                "left": Pane(x0, 0, left_w, top),
                "right": Pane(x0 + left_w, 0, right_w, top),
            }
            self.text_x = 48
            return
        self.radius, self.gap, margin = 14, 26, 44
        slot_top, slot_h = 70, top - 70 - 20
        avail = W - 2 * margin - self.gap
        lw = round(avail * left_w / (left_w + right_w))
        slots = {
            "left": (lw, left_aspect or left_w / 900),
            "right": (avail - lw, right_aspect or right_w / 900),
        }
        sizes = {k: fit(asp, sw, slot_h) for k, (sw, asp) in slots.items()}
        x = (W - sizes["left"][0] - self.gap - sizes["right"][0]) // 2
        self.panes = {}
        for k in ("left", "right"):
            w, h = sizes[k]
            self.panes[k] = Pane(x, slot_top + (slot_h - h) // 2, w, h)
            x += w + self.gap
        self.text_x = min(p.x for p in self.panes.values())


def tag_side(tag: str) -> str | None:
    t = tag.strip().lower()
    return (
        "left"
        if t in ("slack", "left")
        else "right"
        if t in ("office", "right", "claude office")
        else None
    )


@dataclass
class State:
    cap_idx: int = -1
    prev_cap_idx: int = -1
    cap_changed_at: int = -999
    pulse_at: dict[str, int] = field(
        default_factory=lambda: {"left": -999, "right": -999}
    )
    shown: dict[str, int] = field(default_factory=lambda: {"left": -1, "right": -1})
    ff_level: float = 0.0


class Composer:
    def __init__(
        self,
        left: Source,
        right: Source,
        marks: list[Mark],
        layout: Layout,
        t_first: float,
        t_last: float,
        pulse_threshold: float,
    ):
        self.src = {"left": left, "right": right}
        self.marks, self.lay = marks, layout
        self.t_first, self.t_last = t_first, t_last
        self.pulse_threshold = pulse_threshold
        self.mark_ts = [m.t for m in marks]
        self.f_cap = font(36, 500)
        self.f_cap_small = font(30, 500)
        self.f_tag = font(17, 650)
        self.f_pill = font(21, 600)
        self.f_clock = font(30, 500, mono=True)
        self.f_date = font(17, 500)
        for k, s in self.src.items():
            s.pane = (layout.panes[k].w, layout.panes[k].h)
        pane_sizes = {k: (p.w, p.h) for k, p in layout.panes.items()}
        self.masks = {
            k: rounded_mask(sz, layout.radius) if layout.radius else None
            for k, sz in pane_sizes.items()
        }
        self.overlays = {
            k: None if layout.exact else self._frame_overlay(sz)
            for k, sz in pane_sizes.items()
        }
        self.glows = {
            k: self._glow_layer(sz, self.src[k].accent) for k, sz in pane_sizes.items()
        }
        self.placeholders = {
            k: self._placeholder(sz, self.src[k]) for k, sz in pane_sizes.items()
        }
        self.base = self._background()
        self.cap_cache: dict[int, Image.Image] = {}
        self._track: Image.Image | None = None
        self.st = State()

    # static layers ---------------------------------------------------------
    def _background(self) -> Image.Image:
        lay = self.lay
        L, R = lay.panes["left"], lay.panes["right"]
        bg = vgradient((W, H), BG_TOP, BG_BOTTOM).convert("RGBA")
        glow_blob(bg, (L.x + L.w // 3, 120), 520, SLACK_ACCENT, 26)
        glow_blob(bg, (R.x + R.w * 2 // 3, 120), 520, OFFICE_ACCENT, 26)
        if not lay.exact:
            shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            d = ImageDraw.Draw(shadow)
            for p in (L, R):
                d.rounded_rectangle(
                    [p.x, p.y + 12, p.x + p.w, p.y + p.h + 12],
                    radius=lay.radius + 6,
                    fill=(0, 0, 0, 170),
                )
            bg.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22)))
        bar = vgradient((W, CAP_H), (19, 21, 29), (13, 14, 19)).convert("RGBA")
        bg.paste(bar, (0, H - CAP_H))
        bg = dither(bg.convert("RGB"))
        d = ImageDraw.Draw(bg, "RGBA")
        d.line([0, H - CAP_H, W, H - CAP_H], fill=(255, 255, 255, 22))
        if not lay.exact:  # the pane wells, seen only where a source is letterboxed
            for p in (L, R):
                d.rounded_rectangle(
                    [p.x, p.y, p.x + p.w - 1, p.y + p.h - 1],
                    radius=lay.radius,
                    fill=PANE_BG,
                )
        return bg

    def _frame_overlay(self, size: tuple[int, int]) -> Image.Image:
        ss, (w, h) = 3, size
        o = Image.new("RGBA", ((w + 2) * ss, (h + 2) * ss), (0, 0, 0, 0))
        ImageDraw.Draw(o).rounded_rectangle(
            [0, 0, o.width - 1, o.height - 1],
            radius=(self.lay.radius + 1) * ss,
            outline=(255, 255, 255, 34),
            width=ss,
        )
        return o.resize((w + 2, h + 2), Image.LANCZOS)

    def _glow_layer(
        self, size: tuple[int, int], color: tuple[int, int, int]
    ) -> Image.Image:
        pad, r = 28, self.lay.radius
        w, h = size[0] + pad * 2, size[1] + pad * 2
        g = Image.new("RGBA", (w, h), color + (0,))
        m = Image.new("L", (w, h), 0)
        ImageDraw.Draw(m).rounded_rectangle(
            [pad - 3, pad - 3, w - pad + 2, h - pad + 2],
            radius=r + 3,
            outline=255,
            width=5,
        )
        m = m.filter(ImageFilter.GaussianBlur(9))
        crisp = Image.new("L", (w, h), 0)
        ImageDraw.Draw(crisp).rounded_rectangle(
            [pad - 1, pad - 1, w - pad, h - pad], radius=r + 1, outline=200, width=2
        )
        g.putalpha(ImageChops.lighter(m, crisp))
        return g

    def _placeholder(self, size: tuple[int, int], src: Source) -> Image.Image:
        pw, ph = size
        img = vgradient((pw, ph), (26, 29, 39), (18, 20, 27))
        d = ImageDraw.Draw(img, "RGBA")
        cx, cy = pw // 2, ph // 2 - 30
        for r, a in ((54, 40), (36, 70), (12, 255)):
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=src.accent + (a,))
        t1 = f"Waiting for {src.label}…"
        t2 = (
            "no frame recorded yet at this moment"
            if src.ts
            else "no frames recorded for this pane"
        )
        f1, f2 = font(30, 600), font(20, 400)
        d.text((cx - text_w(t1, f1) / 2, cy + 84), t1, font=f1, fill=INK)
        d.text((cx - text_w(t2, f2) / 2, cy + 128), t2, font=f2, fill=INK_DIM)
        return img

    def _caption_layer(self, idx: int) -> Image.Image:
        if idx in self.cap_cache:
            return self.cap_cache[idx]
        m = self.marks[idx]
        lay = self.lay
        layer = Image.new("RGBA", (W - 520, CAP_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        width = layer.width - lay.text_x - 20
        f = self.f_cap
        lines = wrap_px(m.caption, f, width)
        if len(lines) > 2:
            f = self.f_cap_small
            lines = wrap_px(m.caption, f, width)[:3]
        lh = int(f.size * 1.28)
        tag_h = 26 if m.tag else 0
        block = tag_h + lh * len(lines)
        y = (CAP_H - block) // 2 + 2
        if m.tag:
            col = self._tag_color(m.tag)
            label = m.tag.upper()
            x = lay.text_x
            d.rounded_rectangle([x, y + 4, x + 4, y + 18], radius=2, fill=col + (255,))
            # letter-spaced small caps
            x += 14
            for ch in label:
                d.text((x, y), ch, font=self.f_tag, fill=col + (255,))
                x += text_w(ch, self.f_tag) + 2.2
            y += tag_h
        for ln in lines:
            d.text((lay.text_x, y), ln, font=f, fill=INK + (255,))
            y += lh
        self.cap_cache[idx] = layer
        return layer

    def _tag_color(self, tag: str) -> tuple[int, int, int]:
        return {"left": SLACK_ACCENT, "right": OFFICE_ACCENT}.get(
            tag_side(tag) or "", FF_ACCENT
        )

    # per frame ---------------------------------------------------------------
    def frame(
        self, k: int, t: float, v: float, nominal: int, progress: float
    ) -> Image.Image:
        st, lay = self.st, self.lay
        img = self.base.copy()

        ci = bisect.bisect_right(self.mark_ts, t) - 1
        if ci != st.cap_idx:
            st.prev_cap_idx, st.cap_idx, st.cap_changed_at = st.cap_idx, ci, k
            if ci >= 0:
                side = tag_side(self.marks[ci].tag)
                if side:
                    st.pulse_at[side] = k

        for side, src in self.src.items():
            p = lay.panes[side]
            i = src.index_at(t)
            if i != st.shown[side]:
                if (
                    v < 1.5
                    and i >= 0
                    and st.shown[side] >= 0
                    and src.max_change(st.shown[side], i) >= self.pulse_threshold
                ):
                    st.pulse_at[side] = k
                st.shown[side] = i
            content = src.image(i) if i >= 0 else self.placeholders[side]
            img.paste(content, (p.x, p.y), self.masks[side])
            ov = self.overlays[side]
            if ov is not None:
                img.paste(ov, (p.x - 1, p.y - 1), ov)
            age = k - st.pulse_at[side]
            pulse = max(0.0, 1 - age / 14) ** 2 if age >= 0 else 0.0
            if pulse > 0.02 and not lay.exact:
                paste_alpha(img, self.glows[side], (p.x - 28, p.y - 28), pulse * 0.9)
            label = pill(src.label, self.f_pill, src.accent, h=40, glow=round(pulse, 2))
            paste_alpha(
                img, label, (p.x + 16, 16) if lay.exact else (p.x + 2, p.y - 52)
            )

        # fast-forward pill, fading with the instantaneous speed
        st.ff_level += ((1.0 if v > 1.5 else 0.0) - st.ff_level) * 0.35
        if st.ff_level > 0.03 and nominal > 1:
            ff = pill(
                f"{nominal}×  quiet stretch",
                self.f_pill,
                None,
                fill=(48, 40, 22, 235),
                ink=FF_ACCENT,
                outline=FF_ACCENT + (90,),
                icon="ff",
                icon_color=FF_ACCENT,
            )
            R = lay.panes["right"]
            xy = (
                (R.x + R.w - ff.width - 16, 16)
                if lay.exact
                else (R.x + R.w - ff.width - 2, R.y - 52)
            )
            paste_alpha(img, ff, xy, st.ff_level)

        self._caption_bar(img, k, t, progress)
        return img

    def _caption_bar(self, img: Image.Image, k: int, t: float, progress: float) -> None:
        st, lay = self.st, self.lay
        y0 = H - CAP_H
        # progress track with mark ticks
        x0, x1 = lay.text_x, W - lay.text_x
        d = ImageDraw.Draw(img, "RGBA")
        d.rectangle([x0, y0 + 10, x1, y0 + 12], fill=(255, 255, 255, 18))
        px = x0 + (x1 - x0) * progress
        span = max(self.t_last - self.t_first, 1)
        if px > x0 + 1:
            if self._track is None:
                m = Image.linear_gradient("L").rotate(90).resize((x1 - x0, 3))
                self._track = Image.composite(
                    Image.new("RGB", m.size, OFFICE_ACCENT),
                    Image.new("RGB", m.size, SLACK_ACCENT),
                    m,
                )
            img.paste(self._track.crop((0, 0, int(px - x0), 3)), (x0, y0 + 10))
        for mt in self.mark_ts:
            mx = x0 + (x1 - x0) * min(max((mt - self.t_first) / span, 0), 1)
            on = mt <= t
            r = 3
            d.ellipse(
                [mx - r, y0 + 11 - r, mx + r, y0 + 11 + r],
                fill=(INK if on else INK_FAINT) + (255,),
            )

        # captions: cross-fade with a small rise
        fade = 5
        a = ease_out((k - st.cap_changed_at) / fade)
        if st.prev_cap_idx >= 0 and a < 1:
            paste_alpha(
                img, self._caption_layer(st.prev_cap_idx), (0, y0 - int(6 * a)), 1 - a
            )
        if st.cap_idx >= 0:
            paste_alpha(
                img, self._caption_layer(st.cap_idx), (0, y0 + int(8 * (1 - a))), a
            )

        # clock
        when = dt.datetime.fromtimestamp(t / 1000)
        clock = when.strftime("%H:%M:%S")
        date = (
            when.strftime("%-d %b %Y").upper()
            if sys.platform != "win32"
            else when.strftime("%d %b %Y")
        )
        cw = text_w(clock, self.f_clock)
        d.text((W - lay.text_x - cw, y0 + 46), clock, font=self.f_clock, fill=INK)
        dw = text_w(date, self.f_date)
        d.text((W - lay.text_x - dw, y0 + 88), date, font=self.f_date, fill=INK_FAINT)


# --------------------------------------------------------------------------- cards
def card_backdrop(lay: Layout) -> Image.Image:
    bg = vgradient((W, H), (16, 18, 26), (7, 8, 12)).convert("RGBA")
    glow_blob(bg, (560, 430), 760, SLACK_ACCENT, 34)
    glow_blob(bg, (1360, 650), 760, OFFICE_ACCENT, 34)
    # faint dot grid
    d = ImageDraw.Draw(bg)
    for x in range(40, W, 40):
        for y in range(40, H, 40):
            d.point((x, y), fill=(255, 255, 255, 14))
    return dither(bg.convert("RGB"))


def draw_title(
    d: ImageDraw.ImageDraw, text: str, f: ImageFont.ImageFont, y: int, alpha: float
) -> None:
    """Centred title with any " × " in a dimmer ink."""
    parts = re.split(r"(\s×\s)", text)
    x = (W - sum(text_w(p, f) for p in parts)) / 2
    for p in parts:
        col = INK_DIM if p.strip() == "×" else INK
        d.text((x, y), p, font=f, fill=col + (int(255 * alpha),))
        x += text_w(p, f)


def title_card(
    lay: Layout,
    title: str,
    subtitle: str,
    left_label: str,
    right_label: str,
    u: float,
    backdrop: Image.Image,
) -> Image.Image:
    """u in [0,1] across the card's duration: text rises and fades in, legend follows."""
    img = backdrop.copy()
    d = ImageDraw.Draw(img, "RGBA")
    main, _, tagline = title.partition(" — ")
    f_main, f_tag, f_sub = font(92, 700), font(44, 300), font(24, 500)
    a1 = ease_out(u / 0.28)
    a2 = ease_out((u - 0.12) / 0.3)
    a3 = ease_out((u - 0.25) / 0.3)
    cy = 400
    draw_title(d, main, f_main, cy - int(18 * (1 - a1)), a1)
    if tagline:
        tw = text_w(tagline, f_tag)
        d.text(
            ((W - tw) / 2, cy + 118 - int(14 * (1 - a2))),
            tagline,
            font=f_tag,
            fill=INK + (int(230 * a2),),
        )
    if subtitle:
        sub = subtitle.upper()
        sx = W / 2 - (sum(text_w(c, f_sub) + 3 for c in sub) - 3) / 2
        for c in sub:
            d.text((sx, cy - 64), c, font=f_sub, fill=INK_DIM + (int(255 * a2),))
            sx += text_w(c, f_sub) + 3
    # legend: which side is which
    f_leg = font(24, 600)
    pl = pill(left_label, f_leg, SLACK_ACCENT, h=48, sub="the conversation")
    pr = pill(right_label, f_leg, OFFICE_ACCENT, h=48, sub="the work behind it")
    gap = 24
    x = (W - pl.width - pr.width - gap) // 2
    y = cy + 250 + int(10 * (1 - a3))
    paste_alpha(img, pl, (x, y), a3)
    paste_alpha(img, pr, (x + pl.width + gap, y), a3)
    return img


def outro_card(
    lay: Layout, title: str, lines: list[str], u: float, backdrop: Image.Image
) -> Image.Image:
    img = backdrop.copy()
    d = ImageDraw.Draw(img, "RGBA")
    main = title.partition(" — ")[0]
    f_main, f_line = font(64, 700), font(28, 400)
    a = ease_out(u / 0.3)
    y = 420 - int(12 * (1 - a))
    draw_title(d, main, f_main, y, a)
    # accent rule
    rw = 120
    d.rounded_rectangle(
        [(W - rw) / 2, y + 100, (W + rw) / 2, y + 104],
        radius=2,
        fill=OFFICE_ACCENT + (int(255 * a),),
    )
    d.rounded_rectangle(
        [(W - rw) / 2, y + 100, W / 2, y + 104],
        radius=2,
        fill=SLACK_ACCENT + (int(255 * a),),
    )
    yy = y + 138
    for i, ln in enumerate(lines):
        ai = ease_out((u - 0.1 - 0.08 * i) / 0.3)
        lw = text_w(ln, f_line)
        d.text(((W - lw) / 2, yy), ln, font=f_line, fill=INK_DIM + (int(255 * ai),))
        yy += 44
    return img


# --------------------------------------------------------------------------- main
def fmt_dur(sec: float) -> str:
    sec = int(round(sec))
    if sec >= 3600:
        return f"{sec // 3600}h {sec % 3600 // 60:02d}m"
    if sec >= 60:
        return (
            f"{sec // 60} min {sec % 60:02d} s"
            if sec < 600
            else f"{round(sec / 60)} min"
        )
    return f"{sec} s"


def percentile(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[min(len(s) - 1, int(p * (len(s) - 1)))]


def parse_crop(spec: str, src: Source) -> Crop | None:
    spec = spec.strip().lower()
    if spec in ("", "none"):
        return None
    if spec == "auto":
        return src.detect_crop()
    try:
        x, y, w, h = (float(v) for v in spec.split(","))
    except ValueError:
        raise SystemExit(
            f"{src.label}: crop must be none, auto or x,y,w,h, not {spec!r}"
        )
    with Image.open(src.paths[0]) as im:
        fw, fh = im.size
    return (x / fw, y / fh, min(1.0, (x + w) / fw), min(1.0, (y + h) / fh))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--left", help="left frame folder (Slack)")
    ap.add_argument("--right", help="right frame folder (Claude Office)")
    ap.add_argument("--marks", help="captions TSV: <time> TAB <caption> [TAB <tag>]")
    ap.add_argument("--out", required=True, help="output .mp4")
    ap.add_argument(
        "--title",
        default="Switch × Claude Office — agents at work",
        help="title card text; ' — ' splits title and tagline ('' for no title card)",
    )
    ap.add_argument(
        "--subtitle", help="small line over the title (default: the recording's date)"
    )
    ap.add_argument(
        "--outro",
        action="append",
        default=None,
        help="outro line (repeatable); default: recording stats",
    )
    ap.add_argument("--no-outro", action="store_true")
    ap.add_argument("--left-label", default="Slack")
    ap.add_argument("--right-label", default="Claude Office")
    ap.add_argument(
        "--start", help="first wall-clock moment to show (same formats as marks)"
    )
    ap.add_argument("--end", help="last wall-clock moment to show")
    ap.add_argument(
        "--idle",
        type=float,
        default=4.0,
        help="seconds without change or caption before speeding up (default 4)",
    )
    ap.add_argument(
        "--keep",
        type=float,
        default=1.2,
        help="real-time seconds kept either side of activity (default 1.2)",
    )
    ap.add_argument(
        "--ff-target",
        type=float,
        default=2.0,
        help="aim for this many output seconds per quiet stretch (default 2)",
    )
    ap.add_argument("--max-speed", type=int, default=64)
    ap.add_argument(
        "--activity-threshold",
        type=float,
        default=0.004,
        help="fraction of a frame that must change to count as activity (default 0.004); "
        "raise it if an always-animating pane never lets the video speed up",
    )
    ap.add_argument(
        "--pulse-threshold",
        type=float,
        default=0.02,
        help="fraction of a frame that must change to make the pane glow",
    )
    ap.add_argument("--title-seconds", type=float, default=4.0)
    ap.add_argument("--outro-seconds", type=float, default=4.0)
    ap.add_argument(
        "--left-width",
        type=int,
        default=840,
        help="left pane width (default 840; a ratio unless --exact)",
    )
    ap.add_argument(
        "--right-width", type=int, default=1080, help="right pane width (default 1080)"
    )
    ap.add_argument(
        "--left-crop",
        default="none",
        help="none | auto | x,y,w,h in frame pixels (default none)",
    )
    ap.add_argument(
        "--right-crop",
        default="auto",
        help="none | auto | x,y,w,h in frame pixels (default auto: trim the office page's empty margin)",
    )
    ap.add_argument(
        "--exact",
        action="store_true",
        help="panes of exactly --left-width/--right-width x 930 px, no frames or shadows",
    )
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument(
        "--preview",
        type=float,
        metavar="SECONDS",
        help="write a single PNG of the output at this second (next to --out) instead of a video",
    )
    a = ap.parse_args(argv)

    left = Source("left", a.left, a.left_label, SLACK_ACCENT)
    right = Source("right", a.right, a.right_label, OFFICE_ACCENT)
    for s, spec in ((left, a.left_crop), (right, a.right_crop)):
        if not s.ts:
            print(
                f"warning: {s.label}: no frames ({s.folder or 'no folder given'}); the pane shows a placeholder",
                file=sys.stderr,
            )
            continue
        s.crop = parse_crop(spec, s)
        if s.crop:
            print(
                f"{s.label}: cropping frames to {', '.join(f'{v:.3f}' for v in s.crop)} (left, top, right, bottom)",
                file=sys.stderr,
            )
    aspects = {}
    for k, s in (("left", left), ("right", right)):
        size = s.content_size()
        aspects[k] = size[0] / size[1] if size else None
    lay = Layout(
        a.exact, a.left_width, a.right_width, aspects["left"], aspects["right"]
    )
    first = min([s.ts[0] for s in (left, right) if s.ts], default=None)
    ref_date = dt.date.fromtimestamp(first / 1000) if first else dt.date.today()
    marks = read_marks(a.marks, ref_date) if a.marks else []
    if first is None and not marks:
        raise SystemExit("nothing to show: no frames in either folder and no marks")

    t_frames0 = [s.ts[0] for s in (left, right) if s.ts]
    t_frames1 = [s.ts[-1] for s in (left, right) if s.ts]
    t0 = (
        parse_time(a.start, ref_date)
        if a.start
        else min(t_frames0 + [m.t for m in marks])
    )
    t1 = (
        parse_time(a.end, ref_date)
        if a.end
        else max(t_frames1 + [m.t for m in marks]) + 2000
    )
    if t1 <= t0:
        raise SystemExit("--end must be after --start")

    tic = time.time()
    activity: list[float] = [m.t for m in marks]
    for s in (left, right):
        s.measure_changes()
        act = [t for t, c in zip(s.ts, s.change) if c >= a.activity_threshold]
        activity += act
        if s.ts:
            print(
                f"{s.label}: {len(s.ts)} frames, {len(act)} count as activity; change p50 {percentile(s.change[1:], 0.5):.4f}"
                f" p90 {percentile(s.change[1:], 0.9):.4f}",
                file=sys.stderr,
            )
    segs = plan_segments(
        t0, t1, activity, a.idle * 1000, a.keep * 1000, a.ff_target * 1000, a.max_speed
    )
    times = output_times(segs)
    fast = [s for s in segs if s.speed > 1]
    print(
        f"timeline: {fmt_dur((t1 - t0) / 1000)} of wall clock -> {fmt_dur(len(times) / FPS)} of footage; "
        f"{len(fast)} quiet stretch(es) sped up: "
        + ", ".join(f"{fmt_dur((s.b - s.a) / 1000)} at {s.speed}x" for s in fast),
        file=sys.stderr,
    )

    comp = Composer(left, right, marks, lay, t0, t1, a.pulse_threshold)
    when0 = dt.datetime.fromtimestamp(t0 / 1000)
    subtitle = a.subtitle if a.subtitle is not None else when0.strftime("%-d %B %Y")
    n_title = int(a.title_seconds * FPS) if a.title else 0
    n_outro = 0 if a.no_outro else int(a.outro_seconds * FPS)
    outro_lines = (
        a.outro
        if a.outro is not None
        else [
            f"Recorded {when0.strftime('%-d %b %Y')}, {when0.strftime('%H:%M')}–{dt.datetime.fromtimestamp(t1 / 1000).strftime('%H:%M')}",
            f"{fmt_dur((t1 - t0) / 1000)} of real time in {fmt_dur(len(times) / FPS)}; quiet stretches sped up and labelled",
        ]
    )
    backdrop = card_backdrop(lay)
    xfade = int(0.6 * FPS)
    total = n_title + len(times) + n_outro

    def frames():
        main_first = None
        for k in range(n_title):
            u = k / max(n_title - 1, 1)
            im = title_card(
                lay,
                a.title,
                subtitle,
                a.left_label,
                a.right_label,
                u * a.title_seconds / 3.0,
                backdrop,
            )
            if k < 5:
                im = Image.blend(Image.new("RGB", (W, H)), im, (k + 1) / 6)
            if k >= n_title - xfade:  # cross-fade into the first frame of the walk
                if main_first is None:
                    main_first = comp.frame(0, *(times[0][:1]), 1.0, 1, 0.0).copy()
                    comp.st = State()
                im = Image.blend(
                    im, main_first, (k - (n_title - xfade) + 1) / (xfade + 1)
                )
            yield im
        last = None
        for k, (t, v, nominal) in enumerate(times):
            last = comp.frame(k, t, v, nominal, (t - t0) / (t1 - t0))
            yield last
        for k in range(n_outro):
            u = k / max(n_outro - 1, 1)
            im = outro_card(
                lay,
                a.title or "Switch × Claude Office",
                outro_lines,
                u * a.outro_seconds / 3.0,
                backdrop,
            )
            if k < xfade and last is not None:
                im = Image.blend(last, im, (k + 1) / (xfade + 1))
            if k >= n_outro - 6:
                im = Image.blend(
                    im, Image.new("RGB", (W, H)), (k - (n_outro - 6) + 1) / 6
                )
            yield im

    if a.preview is not None:
        want = int(a.preview * FPS)
        for k, im in enumerate(frames()):
            if k == want:
                path = os.path.splitext(a.out)[0] + f"-preview-{a.preview:g}s.png"
                im.save(path)
                print(path)
                return 0
        raise SystemExit(f"--preview {a.preview}s is past the end ({total / FPS:.1f}s)")

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{W}x{H}",
        "-r",
        str(FPS),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        str(a.crf),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        a.out,
    ]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert p.stdin is not None
    try:
        for k, im in enumerate(frames()):
            p.stdin.write(im.tobytes())
            if k % 100 == 0:
                print(f"\r{k}/{total} frames", end="", file=sys.stderr, flush=True)
    except BrokenPipeError:
        pass
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit(f"ffmpeg failed ({p.returncode})")
    print(
        f"\r{total}/{total} frames in {time.time() - tic:.0f}s -> {a.out} ({total / FPS:.1f}s)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
