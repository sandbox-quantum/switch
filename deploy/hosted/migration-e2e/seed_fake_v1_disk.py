#!/usr/bin/env python3
"""Seed a fake v1 data disk for the migration copy job's end-to-end run.

It writes the v1 layout the migration-copy design fixes, into an empty
directory (a mounted test volume, or a plain directory for a quick run):

- `/.switch-controllers.json`: the seat map, `{"version": 1, "controllers":
  {seat key: index}}`, as the v1 boot writes it.
- Seat 0: its agents in `agents/`, its controller's state in
  `.switch-controller/`. Seat k: `controllers/<k>/agents/` and
  `controllers/<k>/data/`.
- In each seat's agents directory, one directory per agent user slot
  (`01`, `02`, ...): `workspace/` (the only part that moves, to
  `workspaces/<agent name>/` on the box), `home/` (provider state and
  logins), `watcher/` (the controller's), and the `.switch-agent-id` marker.
  Agents no longer on the controller sit under `released/<agent id>/`.
- In each seat's controller state, `controller.db` as the v1 controller
  keeps it (SQLite): `meta.controller_id` and `agent_users` (slot, agent id),
  which the job checks against Core's manifest. Owners follow the v1 image
  (seat k's controller uid 2000 + 200k) when run as root.

Then the things the copy must never move or must refuse, each counted in the
expectations it prints:

- secrets: a fake controller credential in each seat's state, fake provider
  logins in each slot's `home/`, a watcher login, and a symlink to one;
- a hostile subtree in the first moving agent's workspace: symlinks out of the root and to a sibling, a
  hard link to a file outside the roots, a FIFO, a Unix socket, a device node
  (only when run as root), a setuid file, odd but usable names, names that
  aren't (not UTF-8, a newline), and a great many tiny files; with
  `--cap-trap`, a path past the depth cap or a sparse file past the
  single-file cap, which must fail the copy;
- a seat with no workspace in the manifest, whose files must not be copied.

All content is made up. `--bulk-bytes` adds ordinary data (about 6 GB for the
realistic run) in a few large files of random bytes, so checksums are real.

`--spec FILE` gives the seats' keys, controller ids, tenants and agents
(ids and names, from the test Core, so its manifest matches the disk);
without it they're made up. `--trap NAME` seeds one wrong-seat case the job
must refuse whole, nothing written (see `TRAPS`).

It prints the expectations as JSON on stdout: the seat keys, which tenant
each seat is for (so the run can build the manifest), and what a correct copy
reports. Nothing here reads or writes outside the target directory.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
import stat
import sys
import uuid
from pathlib import Path

SEAT_MAP = ".switch-controllers.json"
#: The copy program's caps (`migration_copy.Caps`), for --cap-trap.
DEPTH_CAP = 64
FILE_CAP_BYTES = 50 * 1024**3
CHUNK = 4 * 1024 * 1024


def seat_dirs(root: Path, index: int) -> tuple[Path, Path]:
    """(agents directory, controller state directory) of seat `index`."""
    if index == 0:
        return root / "agents", root / ".switch-controller"
    home = root / "controllers" / str(index)
    return home / "agents", home / "data"


def _write(path: Path, data: bytes, mode: int = 0o640) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(mode)


def _random_file(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as out:
        left = size
        while left > 0:
            step = min(CHUNK, left)
            out.write(os.urandom(step))
            left -= step


class Counts:
    def __init__(self) -> None:
        self.files = 0
        self.bytes = 0
        self.symlinks = 0
        self.refused = 0

    def ordinary(self, path: Path, data: bytes) -> None:
        _write(path, data)
        self.files += 1
        self.bytes += len(data)


TRAPS = (
    # The seat map.
    "swapped-indexes",  # two workspaces' seats swapped: caught by controller.db's controller id
    "index-out-of-range",
    "duplicate-index",
    "seat-map-symlink",
    "seat-map-extra-key",
    # The seat's controller.db (security's conditions, 28 Nov).
    "wrong-controller-id",
    "missing-db",
    "db-symlink",
    "db-with-wal",
    "db-too-large",  # sparse, past the job's size cap
    # agent_users gives a manifest agent's slot to an agent the manifest doesn't
    # list, while the slot's marker still names the manifest agent: its files
    # must not be skipped quietly.
    "slot-of-another-agent",
    "two-slots-one-agent",  # slot 02's marker names slot 01's agent
    "duplicate-slot",  # a crafted store gives two agents one slot (no PRIMARY KEY on slot)
    "store-slot-missing",  # the store gives an agent a slot whose folder isn't there
    "db-owned-by-agent-user",  # only when run as root (it needs chown)
)
#: Past any size cap the job could set for controller.db (sparse: no disk).
DB_TOO_LARGE = 1024**3
#: The v1 image's ids: seat k's controller user is 2000 + 200 * k, and its
#: agent users follow it (`switch_machine_boot.py`, `separate-users.ts`).
FIRST_CONTROLLER_UID = 2000
UID_STRIDE = 200
AGENT_ID_MARKER = ".switch-agent-id"


def made_up_spec(seats: int, tenants: list[str]) -> list[dict]:
    """Seats with made-up ids; the first `len(tenants)` are the manifest's."""
    if not 1 <= seats <= 8 or len(tenants) > seats:
        raise SystemExit("1 to 8 seats, and no more tenants than seats")
    return [
        {
            "seat_key": str(uuid.uuid4()),
            "v1_controller_id": str(uuid.uuid4()),
            "tenant_id": tenants[i] if i < len(tenants) else None,
            "agents": [
                {"id": str(uuid.uuid4()), "name": f"agent-{i}-{n}"} for n in (1, 2)
            ],
        }
        for i in range(seats)
    ]


def _controller_db(
    path: Path, controller_id: str, agent_ids: list[str], *, duplicate_slot: bool = False
) -> None:
    """The v1 controller's store, as `agent-controller/src/store.ts` makes it:
    the two tables the copy job reads (`meta.controller_id`, `agent_users`)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
            + (
                # A crafted store: no key on slot, so two rows can share one.
                "CREATE TABLE agent_users (slot INTEGER, agent_id TEXT, claimed_at TEXT);"
                if duplicate_slot
                else "CREATE TABLE agent_users (slot INTEGER PRIMARY KEY,"
                " agent_id TEXT NOT NULL UNIQUE, claimed_at TEXT NOT NULL);"
            )
        )
        db.executemany(
            "INSERT INTO meta VALUES (?, ?)",
            [("controller_id", controller_id), ("server", "https://switch.example.net"), ("name", "fake v1")],
        )
        db.executemany(
            "INSERT INTO agent_users VALUES (?, ?, '2026-11-01T00:00:00Z')",
            [(1 if duplicate_slot else slot, agent) for slot, agent in enumerate(agent_ids, start=1)],
        )
    path.chmod(0o600)


def _own(path: Path, uid: int, as_root: bool) -> None:
    if as_root:
        os.lchown(path, uid, uid)


def seed(
    root: Path,
    *,
    spec: list[dict],
    bulk_bytes: int,
    tiny_files: int,
    depth_cap: int,
    file_cap: int,
    trap: str | None = None,
    cap_trap: str | None = None,
) -> dict:
    if any(root.iterdir()):
        raise SystemExit(f"{root} isn't empty")
    if not 1 <= len(spec) <= 8:
        raise SystemExit("1 to 8 seats")
    if trap is not None and trap not in TRAPS:
        raise SystemExit(f"--trap is one of {', '.join(TRAPS)}")
    as_root = os.geteuid() == 0
    if trap == "db-owned-by-agent-user" and not as_root:
        raise SystemExit("--trap db-owned-by-agent-user needs root (chown)")
    in_manifest = [i for i, seat in enumerate(spec) if seat.get("tenant_id")]
    if not in_manifest:
        raise SystemExit("at least one seat needs a tenant_id (the manifest's)")
    if trap in ("swapped-indexes", "duplicate-index") and len(in_manifest) < 2:
        raise SystemExit(f"--trap {trap} needs two manifest seats")

    # The seat map: root's, 0600, exactly {"version": 1, "controllers": {key: index}}.
    indexes: dict[str, int] = {seat["seat_key"]: i for i, seat in enumerate(spec)}
    if trap == "swapped-indexes":
        a, b = (spec[i]["seat_key"] for i in in_manifest[:2])
        indexes[a], indexes[b] = indexes[b], indexes[a]
    elif trap == "duplicate-index":
        a, b = (spec[i]["seat_key"] for i in in_manifest[:2])
        indexes[b] = indexes[a]
    elif trap == "index-out-of-range":
        indexes[spec[in_manifest[0]]["seat_key"]] = 8
    body: dict = {"version": 1, "controllers": indexes}
    if trap == "seat-map-extra-key":
        body["paths"] = {"agents": "/etc"}
    seat_map = root / SEAT_MAP
    if trap == "seat-map-symlink":
        real = root / ".seat-map-elsewhere.json"
        real.write_text(json.dumps(body))
        seat_map.symlink_to(real.name)
    else:
        seat_map.write_text(json.dumps(body))
        seat_map.chmod(0o600)
        _own(seat_map, 0, as_root)

    copied = Counts()  # what a correct copy of the manifest's agents reports
    secrets: list[str] = []
    not_copied: list[str] = []
    targets: list[str] = []
    first_slot: Path | None = None
    for index, seat in enumerate(spec):
        agents_dir, state = seat_dirs(root, index)
        controller_uid = FIRST_CONTROLLER_UID + UID_STRIDE * index
        moves = index in in_manifest
        agents = seat["agents"]
        first_seat = moves and index == in_manifest[0]
        db = state / "controller.db"
        controller_id = seat["v1_controller_id"]
        slot_ids = [a["id"] for a in agents]
        if first_seat and trap == "wrong-controller-id":
            controller_id = str(uuid.uuid4())
        if first_seat and trap == "slot-of-another-agent":
            slot_ids[0] = str(uuid.uuid4())
        if first_seat and trap == "missing-db":
            state.mkdir(parents=True, exist_ok=True)
        elif first_seat and trap == "db-symlink":
            _controller_db(state / ".elsewhere.db", controller_id, slot_ids)
            db.symlink_to(".elsewhere.db")
        elif first_seat and trap == "db-too-large":
            _controller_db(db, controller_id, slot_ids)
            with db.open("r+b") as grow:
                grow.truncate(DB_TOO_LARGE)
        else:
            _controller_db(
                db, controller_id, slot_ids, duplicate_slot=first_seat and trap == "duplicate-slot"
            )
            if first_seat and trap == "db-with-wal":
                _write(state / "controller.db-wal", b"\0" * 32, 0o600)
        _own(state, controller_uid, as_root)
        if db.exists() and not db.is_symlink():
            owner = controller_uid + 101 if (first_seat and trap == "db-owned-by-agent-user") else controller_uid
            _own(db, owner, as_root)
        _write(state / "secrets" / "credential", b"swc_fake_v1_controller_credential", 0o600)
        secrets.append(str((state / "secrets" / "credential").relative_to(root)))
        for slot, agent in enumerate(agents, start=1):
            if trap == "store-slot-missing" and first_seat and slot == 2:
                continue  # the store still gives this agent slot 02
            home = agents_dir / f"{slot:02d}"
            agent_uid = controller_uid + 100 + slot
            counts = copied if moves else Counts()
            # Only `workspace/` moves, to `workspaces/<name>/` on the box.
            counts.ordinary(home / "workspace" / "README.md", f"{agent['name']}\n".encode())
            counts.ordinary(home / "workspace" / "src" / "main.py", b"print('hello')\n")
            if moves:
                targets.append(f"workspaces/{agent['name']}")
            if first_slot is None and moves:
                first_slot = home
            # HOME (provider state and logins) and the controller's watcher: never.
            _write(home / "home" / ".claude" / ".credentials.json", b'{"fake": "claude login"}', 0o600)
            _write(home / "home" / ".codex" / "auth.json", b'{"fake": "codex login"}', 0o600)
            _write(home / "home" / "sessions" / "s1.jsonl", b"{}\n")
            _write(home / "watcher" / "login.json", b'{"fake": "watcher login"}', 0o600)
            secrets += [
                str((home / "home" / ".claude" / ".credentials.json").relative_to(root)),
                str((home / "home" / ".codex" / "auth.json").relative_to(root)),
                str((home / "watcher" / "login.json").relative_to(root)),
            ]
            not_copied.append(str((home / "home" / "sessions" / "s1.jsonl").relative_to(root)))
            # As a v1 machine has them: each slot private to its agent user.
            for path in [home, *home.rglob("*")]:
                if path.is_symlink():
                    continue
                if path.parent.name == "watcher" or path.name == "watcher":
                    _own(path, controller_uid, as_root)
                else:
                    _own(path, agent_uid, as_root)
            for path in (home, home / "home", home / "watcher"):
                path.chmod(0o700)
            # The slot's agent-id marker, as the controller writes it.
            marker = home / AGENT_ID_MARKER
            # two-slots-one-agent: slot 02's marker names the agent of slot 01.
            two = trap == "two-slots-one-agent" and moves and index == in_manifest[0] and slot == 2
            marker.write_text(agents[0]["id"] if two else agent["id"])
            marker.chmod(0o640)
            _own(marker, controller_uid, as_root)
        # An agent no longer on the controller: set aside, never copied.
        released = agents_dir / "released" / str(uuid.uuid4()) / "workspace" / "old.txt"
        _write(released, b"released agent\n")
        not_copied.append(str(released.relative_to(root)))
        # The seat's agents directory: its controller's, 0700 (`separate-users.ts`).
        agents_dir.chmod(0o700)
        _own(agents_dir, controller_uid, as_root)

    assert first_slot is not None
    # The bulk data, in the first moving agent's workspace.
    bulk_root = first_slot / "workspace" / "data"
    left, n = bulk_bytes, 0
    while left > 0:
        size = min(left, 1024**3)
        _random_file(bulk_root / f"blob-{n:03d}.bin", size)
        copied.files += 1
        copied.bytes += size
        left -= size
        n += 1

    # The hostile subtree, in the same workspace.
    hostile = first_slot / "workspace" / "hostile"
    hostile.mkdir(parents=True)
    outside = root / "outside-the-roots.txt"  # on the disk, not under any agents dir
    outside.write_text("not for copying\n")
    (hostile / "to-etc-shadow").symlink_to("/etc/shadow")
    (hostile / "up-and-out").symlink_to("../../../../../../outside-the-roots.txt")
    (hostile / "to-sibling").symlink_to("../README.md")
    (hostile / "to-the-login").symlink_to("../../home/.claude/.credentials.json")
    (hostile / "dangling").symlink_to("nowhere/at/all")
    copied.symlinks += 5
    os.link(outside, hostile / "hard-link-out")
    copied.refused += 1  # nlink > 1 (and the original isn't copied: it's outside)
    os.mkfifo(hostile / "a-fifo")
    copied.refused += 1
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(str(hostile / "a-socket"))
    copied.refused += 1
    device_made = False
    if os.geteuid() == 0:
        os.mknod(hostile / "a-device", 0o600 | stat.S_IFCHR, os.makedev(1, 3))
        copied.refused += 1
        device_made = True
    setuid = hostile / "setuid-tool"
    _write(setuid, b"#!/bin/sh\necho hi\n", 0o755)
    try:
        setuid.chmod(0o4755)
        setuid_made = True
    except PermissionError:  # a sandbox that forbids setuid bits: the file stays plain
        setuid_made = False
    copied.files += 1  # copied, but never with its setuid bit
    copied.bytes += setuid.stat().st_size
    # Odd but usable names are copied as they are; names the box can't hold
    # as written (not UTF-8, a control character) are refused and counted.
    for name in (b"..dots", b"name with spaces", b"-starts-with-dash", "caf\u00e9".encode()):
        path = Path(os.fsdecode(bytes(hostile) + b"/" + name))
        path.write_bytes(b"x")
        copied.files += 1
        copied.bytes += 1
    for name in (b"\xff\xfe-not-utf8", b"new\nline"):
        Path(os.fsdecode(bytes(hostile) + b"/" + name)).write_bytes(b"x")
        copied.refused += 1
    # The caps: opt in. A correct job stops at either with `copy_failed`.
    if cap_trap == "depth":
        deep = hostile / "deep"
        for level in range(depth_cap + 2):
            deep = deep / f"d{level}"
        deep.mkdir(parents=True)
        (deep / "too-deep.txt").write_text("past the depth cap\n")
    elif cap_trap == "file-size":
        with (hostile / "huge.bin").open("wb") as out:
            out.truncate(file_cap + 1)  # sparse: no real disk used
    tiny_root = hostile / "tiny"
    for i in range(tiny_files):
        _write(tiny_root / f"{i // 1000:04d}" / f"{i:07d}", b"t")
    copied.files += tiny_files
    copied.bytes += tiny_files
    # What was added to the first moving slot belongs to its agent user too.
    first_uid = FIRST_CONTROLLER_UID + UID_STRIDE * in_manifest[0] + 101
    for path in first_slot.joinpath("workspace").rglob("*"):
        if path != outside:
            _own(path, first_uid, as_root)

    return {
        "seat_map": SEAT_MAP,
        "seats": [
            {"index": i, **{k: seat.get(k) for k in ("seat_key", "v1_controller_id", "tenant_id", "agents")}}
            for i, seat in enumerate(spec)
        ],
        "ran_as_root": as_root,
        "box_targets": targets,
        "never_copied": not_copied,
        "trap": trap,
        # With a trap the whole copy must be refused: nothing written, no report.
        "cap_trap": cap_trap,
        "expect": "refused" if trap else ("copy_failed" if cap_trap else "copied"),
        "secrets_never_copied": secrets,
        "outside_never_copied": [str(outside.relative_to(root))],
        "device_node_made": device_made,
        "setuid_made": setuid_made,
        # What a full, correct copy reports (without a trap or cap trap).
        "expected_report": {
            "files": copied.files,
            "bytes": copied.bytes,
            "symlinks_skipped": copied.symlinks,
            "refused": copied.refused,
            "checksum_mismatches": 0,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("target", type=Path, help="an empty directory: the fake v1 disk's root")
    parser.add_argument("--spec", type=Path, help="JSON list of seats: seat_key, v1_controller_id, tenant_id, agents [{id, name}]")
    parser.add_argument("--seats", type=int, default=3, help="without --spec: how many made-up seats")
    parser.add_argument(
        "--tenant",
        action="append",
        default=[],
        help="without --spec: a manifest workspace's tenant id, one per seat in order",
    )
    parser.add_argument("--bulk-bytes", type=int, default=16 * 1024**2)
    parser.add_argument("--tiny-files", type=int, default=2000)
    parser.add_argument("--cap-trap", choices=("depth", "file-size"), help="seed one past the job's cap")
    parser.add_argument("--depth-cap", type=int, default=DEPTH_CAP, help="the job's depth cap")
    parser.add_argument("--file-cap", type=int, default=FILE_CAP_BYTES, help="the job's single-file cap")
    parser.add_argument("--trap", choices=TRAPS)
    args = parser.parse_args(argv)
    if not args.target.is_dir():
        raise SystemExit(f"{args.target} isn't a directory")
    spec = (
        json.loads(args.spec.read_text())
        if args.spec
        else made_up_spec(args.seats, args.tenant or ["tenant-a", "tenant-b"])
    )
    print(
        json.dumps(
            seed(
                args.target,
                spec=spec,
                bulk_bytes=args.bulk_bytes,
                tiny_files=args.tiny_files,
                depth_cap=args.depth_cap,
                file_cap=args.file_cap,
                trap=args.trap,
                cap_trap=args.cap_trap,
            ),
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
