#!/usr/bin/env python3
"""Self-check for the recording and video tooling, offline (no Chrome, Switch, Slack or office).

    uv run --with pillow --with websockets python scripts/office-view/selftest_video.py [--stills DIR]

Checks the pure helpers (time parsing, marks, the fast-forward timeline, window
placement), then builds real videos from synthetic frames (fake_frames.py):
the normal build, a rebuild with edited captions, and a build whose office
folder is empty. Each is checked with ffprobe: 1920x1080, H.264, yuv420p,
10 fps, and the expected length. --stills writes a few PNGs to look at.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile

import build_video as bv
import fake_frames
import windows

HERE = os.path.dirname(os.path.abspath(__file__))


def check_helpers() -> None:
    day = dt.date(2026, 11, 17)
    noon = int(dt.datetime(2026, 11, 17, 12, 0, 5).timestamp() * 1000)
    assert bv.parse_time("12:00:05", day) == noon
    assert bv.parse_time("12:00:05.5", day) == noon + 500
    assert bv.parse_time("2026-11-17T12:00:05", day) == noon
    assert bv.parse_time(str(noon), day) == noon
    assert bv.parse_time(f"{noon / 1000:.3f}", day) == noon
    assert bv.parse_time("2026-11-17T12:00:05Z", day) == int(
        dt.datetime(2026, 11, 17, 12, 0, 5, tzinfo=dt.UTC).timestamp() * 1000
    )

    with tempfile.NamedTemporaryFile("w", suffix=".tsv", delete=False) as f:
        f.write(
            "time\tcaption\ttag\n# a comment\n\n12:00:09\tsecond\\nline two\n12:00:05\tfirst\tslack\n"
        )
    marks = bv.read_marks(f.name, day)
    os.unlink(f.name)
    assert (
        [m.caption for m in marks] == ["first", "second\nline two"]
        and marks[0].tag == "slack"
        and marks[1].tag == ""
    )

    assert (
        bv.nice_speed(3, 64) == 4
        and bv.nice_speed(1000, 64) == 64
        and bv.nice_speed(0.5, 64) == 2
    )
    # activity at 0-2 s and 40 s: the 38 s gap is fast-forwarded, the edges stay real time
    segs = bv.plan_segments(
        0,
        42_000,
        [0, 1000, 2000, 40_000],
        idle_ms=4000,
        keep_ms=1000,
        target_ms=2000,
        max_speed=64,
    )
    assert [s.speed for s in segs] == [1, 32, 1], segs
    assert segs[1].a == 3000 and segs[1].b == 39_000
    times = bv.output_times(segs)
    ts = [t for t, _, _ in times]
    assert ts == sorted(ts) and ts[0] == 0 and ts[-1] < 42_000
    assert max(v for _, v, _ in times) <= 32 and min(v for _, v, _ in times) >= 1
    assert len(times) < 42_000 / 100 / 3  # much shorter than real time
    # no idle gap -> one real-time segment
    assert [
        s.speed for s in bv.plan_segments(0, 5000, [1000, 3000], 4000, 1000, 2000, 64)
    ] == [1]

    screen = {"sl": 0, "st": 25, "sw": 2560, "sh": 1415}
    assert windows.plan_bounds("left", (840, 900), (0, 87), screen) == {
        "left": 0,
        "top": 25,
        "width": 840,
        "height": 987,
    }
    assert windows.plan_bounds("right", (1080, 900), (0, 87), screen) == {
        "left": 1480,
        "top": 25,
        "width": 1080,
        "height": 987,
    }
    narrow = {
        "sl": 0,
        "st": 33,
        "sw": 1512,
        "sh": 949,
    }  # a laptop: the windows overlap but stay on screen
    assert windows.plan_bounds("right", (1080, 900), (0, 87), narrow)["left"] == 432
    assert windows.parse_size("1080x900") == (1080, 900)
    print("helpers ok")


def ffprobe(path: str) -> dict:
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            path,
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(out)


def check_video(path: str, min_s: float, max_s: float) -> dict:
    info = ffprobe(path)
    v = [s for s in info["streams"] if s["codec_type"] == "video"][0]
    dur = float(info["format"]["duration"])
    got = {
        "codec": v["codec_name"],
        "size": f"{v['width']}x{v['height']}",
        "pix_fmt": v["pix_fmt"],
        "fps": v["r_frame_rate"],
        "duration": dur,
    }
    assert (got["codec"], got["size"], got["pix_fmt"], got["fps"]) == (
        "h264",
        "1920x1080",
        "yuv420p",
        "10/1",
    ), got
    assert min_s <= dur <= max_s, got
    with open(path, "rb") as f:  # faststart: the moov atom comes before mdat
        head = f.read(65536)
    assert head.find(b"moov") != -1 and (
        head.find(b"mdat") == -1 or head.find(b"moov") < head.find(b"mdat")
    ), "not faststart"
    return got


def build(args: list[str]) -> None:
    subprocess.run(
        [sys.executable, os.path.join(HERE, "build_video.py"), *args], check=True
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--stills", help="also write stills from the built video into this folder"
    )
    ap.add_argument(
        "--keep", help="build in this folder and keep it (default: a temp folder)"
    )
    a = ap.parse_args()
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("ffmpeg and ffprobe must be on PATH")

    check_helpers()
    work = a.keep or tempfile.mkdtemp(prefix="office-view-selftest-")
    os.makedirs(work, exist_ok=True)
    fake = os.path.join(work, "fake")
    fake_frames.generate(fake, scale=1.0, start=dt.datetime(2026, 11, 17, 14, 0, 0))
    slack, office, marks = (
        os.path.join(fake, x) for x in ("slack", "office", "marks.tsv")
    )

    # the fake office is a 1056x682 frame centred in a 1080x900 page: auto-crop should find it
    office_src = bv.Source("right", office, "Claude Office", bv.OFFICE_ACCENT)
    crop = office_src.detect_crop()
    want = (12 / 1080, 109 / 900, 1068 / 1080, 791 / 900)
    assert crop and all(abs(c - w) < 0.01 for c, w in zip(crop, want)), crop
    assert bv.Source("left", slack, "Slack", bv.SLACK_ACCENT).detect_crop() is None
    lay = bv.Layout(False, 840, 1080, 840 / 900, 1056 / 682)
    L, R = lay.panes["left"], lay.panes["right"]
    assert L.x + L.w + lay.gap == R.x and L.x == bv.W - (R.x + R.w), (
        L,
        R,
    )  # constant gap, centred
    assert (
        abs(R.w / R.h - 1056 / 682) < 0.01
        and R.w > L.w
        and max(L.h, R.h) <= bv.H - bv.CAP_H - 70
    )
    print("crop and layout ok")

    out = os.path.join(work, "demo.mp4")
    build(["--left", slack, "--right", office, "--marks", marks, "--out", out])
    # ~62 s of walk with a ~27 s quiet stretch -> ~37 s of footage, plus 4 s title and 4 s outro
    print("build:", check_video(out, 38, 55))

    edited = os.path.join(work, "marks-edited.tsv")
    with open(marks) as src, open(edited, "w") as dst:
        dst.write(src.read().replace("the boss shouts", "EDITED: the boss shouts"))
    out2 = os.path.join(work, "demo-edited.mp4")
    build(
        [
            "--left",
            slack,
            "--right",
            office,
            "--marks",
            edited,
            "--out",
            out2,
            "--title",
            "",
        ]
    )
    print("rebuild with edited captions, no title card:", check_video(out2, 34, 51))

    empty = os.path.join(work, "empty")
    os.makedirs(empty, exist_ok=True)
    out3 = os.path.join(work, "demo-no-office.mp4")
    build(
        [
            "--left",
            slack,
            "--right",
            empty,
            "--marks",
            marks,
            "--out",
            out3,
            "--no-outro",
        ]
    )
    print("office folder empty (placeholder):", check_video(out3, 30, 55))

    if a.stills:
        os.makedirs(a.stills, exist_ok=True)
        for name, video, t in (
            ("title", out, 2.5),
            ("walk", out, 12),
            ("fast-forward", out, 23.5),
            ("approval", out, 33),
            ("outro", out, 43.5),
            ("placeholder", out3, 6),
        ):
            path = os.path.join(a.stills, f"{name}.png")
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-ss",
                    str(t),
                    "-i",
                    video,
                    "-frames:v",
                    "1",
                    path,
                ],
                check=True,
            )
            print("still:", path)
    if not a.keep:
        shutil.rmtree(work)
    print("all ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
