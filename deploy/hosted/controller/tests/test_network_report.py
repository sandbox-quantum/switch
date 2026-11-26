"""The network reporter: squid's lines summed per box and host, one report a minute, and what happens when Core is
away."""

from __future__ import annotations

import json
import re
import threading
import time

from switch_hosted_controller.network_report import (
    MAX_HOSTS,
    Aggregator,
    HostIds,
    Reporter,
    follow,
    parse,
    report_body,
)

BOX = "box-k1-0123456789abcdef"
OLD = "k1-fedcba9876543210"


def line(
    login: str,
    host: str,
    status: str = "TCP_TUNNEL/200",
    up: int = 100,
    down: int = 1000,
    tag: str = "-",
) -> str:
    return f"1795680000.123 {login} {status} {host} 443 {up} {down} {tag}"


def test_a_line_names_its_box_by_either_login_and_counts_a_refusal() -> None:
    assert parse(line(f"box-{BOX}", "github.com"))[:2] == (BOX, "github.com:443")
    assert parse(line(f"box-{BOX}-ctl", "aiplatform.googleapis.com"))[0] == BOX
    assert parse(line(f"box-{OLD}", "registry.npmjs.org"))[0] == OLD
    box, _, one = parse(line("-", "example.com", status="TCP_DENIED/403"))
    assert box is None and one.denied == 1
    assert parse("not a squid line") is None
    assert parse(line(f"box-{BOX}", "bad host!")) is None


def test_a_window_sums_per_box_and_names_only_the_busiest_hosts() -> None:
    agg = Aggregator()
    ids = HostIds()
    for i in range(MAX_HOSTS + 5):
        agg.add_line(line(f"box-{BOX}", f"h{i:02d}.example", down=i))
    agg.add_line(line(f"box-{BOX}", "h00.example", up=0, down=0))
    agg.add_line(line(f"box-{BOX}-ctl", "big.example", down=10_000_000))
    agg.add_line(line("-", "example.com", status="TCP_DENIED/403"))
    body = report_body(agg.take(), 60, 0, ids)
    [box] = body["boxes"]
    assert box["box"] == BOX
    assert box["requests"] == MAX_HOSTS + 7
    assert box["distinct_hosts"] == MAX_HOSTS + 6
    assert len(box["hosts"]) == MAX_HOSTS
    assert box["hosts"][0]["host"] == ids.of("big.example:443")
    assert all(re.fullmatch(r"h-[0-9a-f]{8}", h["host"]) for h in box["hosts"])
    assert "example" not in json.dumps(body)  # no hostname, in any form
    assert body["unattributed_requests"] == 1
    assert report_body(agg.take(), 60, 0, ids)["boxes"] == []  # taken windows start empty


def test_one_report_per_window_and_nothing_sent_for_an_empty_one() -> None:
    sent: list[dict] = []
    agg = Aggregator()
    reporter = Reporter(agg, sent.append, clock=iter([0.0, 60.0, 120.0]).__next__)
    agg.add_line(line(f"box-{BOX}", "github.com"))
    assert reporter.tick() and len(sent) == 1
    assert reporter.tick() and len(sent) == 1  # nothing new: no request to Core


def test_a_window_core_missed_is_carried_once_then_dropped_and_counted() -> None:
    calls: list[dict] = []
    up = {"value": False}

    def send(body: dict) -> None:
        calls.append(body)
        if not up["value"]:
            raise OSError("down")

    agg = Aggregator()
    clock = iter([0.0, 60.0, 120.0, 180.0, 240.0]).__next__
    reporter = Reporter(agg, send, clock=clock)
    agg.add_line(line(f"box-{BOX}", "github.com"))
    assert not reporter.tick()  # carried
    agg.add_line(line(f"box-{BOX}", "github.com"))
    assert not reporter.tick()  # carried window dropped, this one too
    assert calls[1]["boxes"][0]["requests"] == 2  # the carried window was merged in
    up["value"] = True
    agg.add_line(line(f"box-{BOX}", "example.com"))
    assert reporter.tick()
    assert calls[-1]["dropped_windows"] == 1
    assert calls[-1]["boxes"][0]["requests"] == 1


def test_squids_lines_are_followed_from_the_file_which_is_kept_short(tmp_path) -> None:
    ids = HostIds()
    log = tmp_path / "box.log"
    log.write_text(
        line(f"box-{BOX}", "old.example") + "\n"
    )  # before the reporter started: not counted
    agg = Aggregator()
    stop = threading.Event()
    thread = threading.Thread(
        target=follow,
        args=(agg, log, stop),
        kwargs={"poll_s": 0.02, "truncate_at": 200},
        daemon=True,
    )
    thread.start()
    time.sleep(0.1)
    with log.open("a") as squid:
        for host in ("github.com", "example.com", "example.org"):
            squid.write(line(f"box-{BOX}", host) + "\n")
            squid.flush()
        half = line(f"box-{BOX}", "half.example")
        squid.write(half[:20])  # a line squid hasn't finished
        squid.flush()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and log.stat().st_size > 0:
        time.sleep(0.02)
    with log.open("a") as squid:
        squid.write(half[20:] + "\n")
    time.sleep(0.2)
    stop.set()
    thread.join(timeout=3)
    [box] = report_body(agg.take(), 60, 0, ids)["boxes"]
    hosts = {h["host"] for h in box["hosts"]}
    assert ids.of("old.example:443") not in hosts
    assert {
        ids.of(h)
        for h in ("github.com:443", "example.com:443", "example.org:443", "half.example:443")
    } <= hosts
    assert log.stat().st_size == 0  # read to its end past the limit, so emptied


def test_a_host_keeps_its_random_id_and_ids_never_repeat() -> None:
    tokens = iter(["0000aaaa", "0000aaaa", "0000bbbb"])
    ids = HostIds(token=lambda: next(tokens))
    first = ids.of("github.com:443")
    assert first == "h-0000aaaa" and ids.of("github.com:443") == first
    assert ids.of("example.com:443") == "h-0000bbbb"  # the colliding draw was redrawn


def test_a_proxy_login_challenge_is_not_a_refusal() -> None:
    _, _, challenge = parse(line(f"box-{BOX}", "github.com", status="TCP_DENIED/407"))
    _, _, refused = parse(line(f"box-{BOX}", "github.com", status="TCP_DENIED/403"))
    _, _, older = parse(line(f"box-{BOX}", "github.com", status="TCP_DENIED"))
    assert (challenge.denied, refused.denied, older.denied) == (0, 1, 1)


def test_a_deny_list_refusal_is_counted_for_its_box_and_host() -> None:
    agg = Aggregator()
    ids = HostIds()
    agg.add_line(
        line(f"box-{BOX}", "blocked.example", status="TCP_DENIED/403", up=0, down=0, tag="yes")
    )
    agg.add_line(line(f"box-{BOX}", "github.com"))
    [box] = report_body(agg.take(), 60, 0, ids)["boxes"]
    assert (box["requests"], box["denied"], box["denylisted"]) == (2, 1, 1)
    by_host = {h["host"]: h for h in box["hosts"]}
    assert by_host[ids.of("blocked.example:443")]["denylisted"] == 1
    assert by_host[ids.of("github.com:443")]["denylisted"] == 0
