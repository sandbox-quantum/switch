"""`switch-network-report`: where each box connects, summed per minute and sent to Core.

Runs beside squid, in squid's pod. squid writes one line per request it handles to a file in the pod's own log
folder (`access_log stdio:/var/log/squid/box.log logformat=switch_box`, flushed per line), and this follows it,
keeping the file short: past `TRUNCATE_AT` bytes, read to the end, it empties the file (squid appends, so its next
line starts at the top again). Not squid's UDP log module: that holds lines until about 1400 bytes have built up,
whatever `buffered_logs` says, so a quiet box's requests would arrive minutes late.

Every `WINDOW_S` this sends Core one report for the whole cluster (`POST /gateway/hosted-network/report`, on its own
bearer): per box, its totals, how many distinct hosts it reached and its `MAX_HOSTS` busiest hosts by bytes. Core
turns each box's entry into one security log line, so the box cluster costs Core one small request a minute and the
log one line per box per minute.

No hostname leaves this process, not even hashed: a host is named in the report by a random id (`h-` and 8 hex
digits) this process gives it the first time it sees it and keeps only in memory (`HostIds`), so the same host keeps
its id while this process runs and gets a new one after a restart. Another squid replica's reporter has its own ids.

squid's line (`switch_box`): `<epoch> <login> <squid status>/<http status> <host> <port> <bytes up> <bytes down>
<category>`. A refusal is squid's `TCP_DENIED` other than a 407: a 407 asks the client for its proxy login, which it
then sends. `<category>` is the request's host category and what the operator's policy gave it (squid's
`switch_category` note, from `squid-categories`), `<policy>:<category>` with the policy `block`, `watch` or `allow`,
or `-` for none; each category is counted per box and host, with its policy (`categories`). A box's
agents log in as `box-<id>` and its controller as `box-<id>-ctl` (`egress_lists.BoxEgress`); both count for the box.
A line without a box login (refused before any box's rule) is counted as unattributed.

If Core can't be reached, the window's sums are kept and merged into the next one, and older ones beyond that are
dropped and counted (`dropped_windows`), so a long outage costs memory for one window, not one per minute.

Settings (its container):

- `SWITCH_NETWORK_REPORT_CORE_URL`: Core, https only.
- `SWITCH_NETWORK_REPORT_TOKEN_FILE`: the reporter's own Core credential (`network_report_token`), read on every call.
- `SWITCH_NETWORK_REPORT_CORE_CA`: when set, the only CA trusted for Core.
- `SWITCH_NETWORK_REPORT_FILE`: the file squid writes the lines to (default `/var/log/squid/box.log`).

Neither the credential nor the Core URL is ever logged, and no host either: only counts.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import signal
import ssl
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.request import Request

from .box_operator_main import opener, read_token
from .workers_main import WorkersConfigError, check_core_url

logger = logging.getLogger(__name__)

PREFIX = "SWITCH_NETWORK_REPORT_"
WINDOW_S = 60.0
MAX_HOSTS = 10  # Core's own limit per box
MAX_HOST_IDS = 100_000  # past it, every host gets a new id
MAX_BOXES = 2000
MAX_HOSTS_TRACKED = 5000  # per box per window; beyond it, a new host counts but isn't kept
CALL_TIMEOUT_S = 10.0
DEFAULT_FILE = "/var/log/squid/box.log"
TRUNCATE_AT = 8 * 1024 * 1024
POLL_S = 1.0

# `box-<id>` and `box-<id>-ctl`, where <id> is `box-k1-<16 hex>` (box-keyed) or `k1-<16 hex>` (person-keyed).
LOGIN_RE = re.compile(r"^box-((?:box-)?k1-[0-9a-f]{16})(?:-ctl)?$")
HOST_RE = re.compile(r"^[A-Za-z0-9.:\[\]_-]{1,253}$")
# A host category and its action, as squid's reload wrapper tags a request with them.
CATEGORY_RE = re.compile(r"^(block|watch|allow):([a-z0-9][a-z0-9-]{0,31})$")


@dataclass
class Totals:
    requests: int = 0
    denied: int = 0
    bytes_up: int = 0
    bytes_down: int = 0
    # Requests by host category, each with the category's policy: {"malware": {"requests": 2, "policy": "block"}}.
    categories: dict[str, dict[str, Any]] = field(default_factory=dict)

    def add(self, other: Totals) -> None:
        self.requests += other.requests
        self.denied += other.denied
        self.bytes_up += other.bytes_up
        self.bytes_down += other.bytes_down
        for name, entry in other.categories.items():
            mine = self.categories.setdefault(name, {"requests": 0, "policy": entry["policy"]})
            mine["requests"] += entry["requests"]
            mine["policy"] = entry["policy"]  # the latest, should the policy change mid-window


@dataclass
class BoxWindow:
    totals: Totals = field(default_factory=Totals)
    hosts: dict[str, Totals] = field(default_factory=dict)
    # Hosts seen past MAX_HOSTS_TRACKED: counted in `distinct`, not kept.
    untracked_hosts: int = 0

    @property
    def distinct(self) -> int:
        return len(self.hosts) + self.untracked_hosts


@dataclass
class Window:
    boxes: dict[str, BoxWindow] = field(default_factory=dict)
    unattributed: int = 0
    lines: int = 0
    # Lines that weren't a `switch_box` line, by how many fields they had: a squid whose format changed shows up
    # in the reporter's log (counts only, never a line's content).
    unreadable: dict[int, int] = field(default_factory=dict)

    def empty(self) -> bool:
        return not self.boxes and not self.unattributed


def parse(line: str) -> tuple[str | None, str, Totals] | None:
    """(box id or None, host:port, one request's totals) from one `switch_box` line; None for a line that isn't
    one."""
    parts = line.split()
    if len(parts) != 8:
        return None
    _, login, status, host, port, up, down, category = parts
    try:
        bytes_up, bytes_down = int(up), int(down)
    except ValueError:
        return None
    if not HOST_RE.fullmatch(host) or not port.isdigit():
        return None
    matched = LOGIN_RE.fullmatch(login)
    code, _, http = status.partition("/")
    denied = (code == "TCP_DENIED" and http != "407") or code == "NONE_NONE"
    tagged = CATEGORY_RE.fullmatch(category)
    return (
        matched.group(1) if matched else None,
        f"{host}:{port}",
        Totals(
            1,
            1 if denied else 0,
            max(bytes_up, 0),
            max(bytes_down, 0),
            {tagged.group(2): {"requests": 1, "policy": tagged.group(1)}} if tagged else {},
        ),
    )


class Aggregator:
    """The open window, safe to add to from the reading thread while the sender takes it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._window = Window()

    def add_line(self, line: str) -> None:
        parsed = parse(line)
        with self._lock:
            self._window.lines += 1
            if parsed is None:
                fields = len(line.split())
                self._window.unreadable[fields] = self._window.unreadable.get(fields, 0) + 1
                return
            box, host, one = parsed
            if box is None:
                self._window.unattributed += 1
                return
            if box not in self._window.boxes and len(self._window.boxes) >= MAX_BOXES:
                self._window.unattributed += 1
                return
            entry = self._window.boxes.setdefault(box, BoxWindow())
            entry.totals.add(one)
            if host in entry.hosts:
                entry.hosts[host].add(one)
            elif len(entry.hosts) < MAX_HOSTS_TRACKED:
                entry.hosts[host] = one
            else:
                entry.untracked_hosts += 1

    def take(self) -> Window:
        with self._lock:
            taken, self._window = self._window, Window()
        return taken


def merge(into: Window, other: Window) -> None:
    """`other`'s sums added to `into`'s: an unsent window carried into the next."""
    into.unattributed += other.unattributed
    into.lines += other.lines
    for fields, count in other.unreadable.items():
        into.unreadable[fields] = into.unreadable.get(fields, 0) + count
    for box, theirs in other.boxes.items():
        ours = into.boxes.setdefault(box, BoxWindow())
        ours.totals.add(theirs.totals)
        ours.untracked_hosts += theirs.untracked_hosts
        for host, totals in theirs.hosts.items():
            if host in ours.hosts:
                ours.hosts[host].add(totals)
            else:
                ours.hosts[host] = totals


class HostIds:
    """A random id per host, for as long as this process runs; nothing derived from the name."""

    def __init__(self, token: Callable[[], str] = lambda: secrets.token_hex(4)):
        self._ids: dict[str, str] = {}
        self._token = token

    def of(self, host: str) -> str:
        found = self._ids.get(host)
        if found is not None:
            return found
        if len(self._ids) >= MAX_HOST_IDS:
            self._ids.clear()
        taken = set(self._ids.values())
        new = "h-" + self._token()
        while new in taken:
            new = "h-" + self._token()
        self._ids[host] = new
        return new


def report_body(
    window: Window, window_s: float, dropped_windows: int, ids: HostIds
) -> dict[str, Any]:
    boxes = []
    for box, entry in sorted(window.boxes.items()):
        busiest = sorted(
            entry.hosts.items(), key=lambda kv: (-(kv[1].bytes_up + kv[1].bytes_down), kv[0])
        )[:MAX_HOSTS]
        boxes.append(
            {
                "box": box,
                **vars(entry.totals),
                "distinct_hosts": entry.distinct,
                "hosts": [{"host": ids.of(host), **vars(totals)} for host, totals in busiest],
            }
        )
    return {
        "window_seconds": max(1, min(3600, round(window_s))),
        "boxes": boxes,
        "unattributed_requests": window.unattributed,
        "dropped_windows": dropped_windows,
    }


class CoreApi:
    def __init__(self, url: str, token_file: Path, context: ssl.SSLContext | None = None):
        self._url = check_core_url(url).rstrip("/") + "/gateway/hosted-network/report"
        self._token_file = token_file
        self._ctx = context or ssl.create_default_context()

    def send(self, body: Mapping[str, Any]) -> None:
        req = Request(
            self._url,
            method="POST",
            data=json.dumps(body, separators=(",", ":")).encode(),
            headers={
                "Authorization": "Bearer " + read_token(self._token_file),
                "Content-Type": "application/json",
            },
        )
        with opener(self._ctx).open(req, timeout=CALL_TIMEOUT_S) as r:
            r.read()


class Reporter:
    """Sends a window every `window_s`; a window Core didn't take is merged into the next, once."""

    def __init__(
        self,
        aggregator: Aggregator,
        send: Callable[[Mapping[str, Any]], None],
        clock: Callable[[], float] = time.monotonic,
    ):
        self._aggregator = aggregator
        self._send = send
        self._clock = clock
        self._carried: Window | None = None
        self._carried_s = 0.0
        self._dropped = 0
        self._last = clock()
        self._ids = HostIds()

    def tick(self) -> bool:
        """Takes the window and sends it with whatever was carried. True when Core took it."""
        now = self._clock()
        window = self._aggregator.take()
        window_s = now - self._last
        self._last = now
        if self._carried is not None:
            merge(window, self._carried)
            window_s += self._carried_s
        if window.unreadable:
            logger.warning(
                "Network lines not read: %s (fields: lines)",
                ", ".join(f"{n}: {c}" for n, c in sorted(window.unreadable.items())),
            )
        if window.empty() and not self._dropped:
            self._carried = None
            return True
        try:
            self._send(report_body(window, window_s, self._dropped, self._ids))
        except Exception as error:
            if self._carried is not None:
                # Already carried once: this window goes, and is counted.
                self._dropped += 1
                self._carried, self._carried_s = None, 0.0
            else:
                self._carried, self._carried_s = window, window_s
            logger.warning(
                "Network report not sent (%s); %d window(s) dropped so far.",
                type(error).__name__,
                self._dropped,
            )
            return False
        logger.info(
            "Network report sent: boxes=%d lines=%d unattributed=%d",
            len(window.boxes),
            window.lines,
            window.unattributed,
        )
        self._carried, self._carried_s, self._dropped = None, 0.0, 0
        return True


def follow(
    aggregator: Aggregator,
    path: Path,
    stop: threading.Event,
    poll_s: float = POLL_S,
    truncate_at: int = TRUNCATE_AT,
) -> None:
    """squid's lines as they're appended to `path`, from where the file ends when this starts. A file that got
    shorter (emptied by this, or by anyone) is read again from its start; one not there yet is waited for."""
    offset: int | None = None
    partial = b""
    while not stop.is_set():
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            offset, partial = 0, b""
            stop.wait(poll_s)
            continue
        if offset is None:
            offset = size
        if size < offset:
            offset, partial = 0, b""
        if size > offset:
            with path.open("rb") as f:
                f.seek(offset)
                data = f.read(size - offset)
            offset += len(data)
            *lines, partial = (partial + data).split(b"\n")
            for raw in lines:
                aggregator.add_line(raw.decode("utf-8", "replace"))
            if offset >= truncate_at and not partial:
                # Everything up to here is read. A line squid appends between the read and this is lost.
                with path.open("r+b") as f:
                    f.truncate(0)
                offset = 0
            continue
        stop.wait(poll_s)


def main(environ: Mapping[str, str] | None = None) -> int:
    env = dict(os.environ if environ is None else environ)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        url = env[PREFIX + "CORE_URL"]
        token_file = Path(env[PREFIX + "TOKEN_FILE"])
        check_core_url(url)
        path = Path(env.get(PREFIX + "FILE", DEFAULT_FILE))
    except (KeyError, ValueError, WorkersConfigError) as error:
        logger.error("Network reporter not started: bad setting (%s).", type(error).__name__)
        return 2
    ca = env.get(PREFIX + "CORE_CA")
    context = ssl.create_default_context(cafile=ca) if ca else None
    aggregator = Aggregator()
    reporter = Reporter(aggregator, CoreApi(url, token_file, context).send)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    threading.Thread(target=follow, args=(aggregator, path, stop), daemon=True).start()
    logger.info(
        "Network reporter on: following squid's box lines, a report every %ds", int(WINDOW_S)
    )
    while not stop.wait(WINDOW_S):
        reporter.tick()
    reporter.tick()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
