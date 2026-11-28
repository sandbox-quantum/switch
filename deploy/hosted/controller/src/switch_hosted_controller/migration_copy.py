"""The v1 to v2 migration's copy program: one person's agents' work, from a volume restored from their v1 disk's
snapshot, into their box's `data-agents` disk.

It runs as the copy Job in the person's own box namespace, as two containers joined by a FIFO on a shared
memory-backed `emptyDir` (`migration-copy-design`, security's `migration-copy-job-threat-model`, and the tech lead's
decisions on the Job's shape):

- `read`: root holding only `DAC_OVERRIDE` (so it can read every seat), with only the restored volume (read-only) and
  the FIFO mounted. It makes every source-side check and streams what it would copy.
- `write`: the box's agents user with no capabilities, with only `data-agents` and the FIFO mounted. It owns what it
  writes, trusts nothing in the stream, and writes the report.

Each side refuses to start with any other identity. The source tree is treated as hostile:

- Only what Core's manifest names is copied: for each workspace, the seat its `seat_key` holds in the seat map (whose
  controller must be the one Core recorded), and for each agent the manifest lists there, that agent's `workspace/`
  folder in the slot the seat's controller store gives it (and that slot's marker must agree). Nothing else on the
  disk: never an agent's `home/` or `watcher/`, never a controller's data, never a set-aside agent.
- Every path is built from integers and from names Core gave; nothing read from the disk ever becomes a path.
- No link is ever followed. Symlinks are skipped and counted; hard links, devices, FIFOs, sockets and names it can't
  use are refused and counted.
- The caps (files, bytes, one file's size, depth) and the box disk's free space are checked before anything is
  written. Files are written with fixed modes, read back and checksummed.
- The report is counts only, never a file or agent name (`CopyReport` in Core). Its `source_volume_id` is null: the
  runner fills it from the bound volume. Agents with no slot on the v1 disk are named only in the reader's log.

A run that refuses writes nothing and reports its reason code. A second run clears the target folders it would write,
only when the runner says Core's step is `copy_failed`.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import sys
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: The seat map the v1 boot keeps on the data volume, root's own (`switch_machine_boot.py`).
SEAT_MAP = ".switch-controllers.json"
MAX_SEAT_MAP_BYTES = 64 * 1024
MAX_SEATS = 8
#: What the v1 controller writes in each agent user's folder to say which agent it holds (`systemd-runtime.ts`).
MARKER = ".switch-agent-id"
MAX_MARKER_BYTES = 1024
#: A seat's controller store (`store.ts`): its `meta.controller_id`, and `agent_users` (which agent each agent user
#: holds). Read as an untrusted file, inside the Job's sandbox (security's conditions on option b).
STORE = "controller.db"
MAX_STORE_BYTES = 64 * 1024 * 1024
MAX_SLOT = 99
#: The agent users' folders: `01`, `02`, … (`separate-users.ts`, `slotName`).
SLOT_FOLDER = re.compile(r"^[0-9]{2}$")
#: The only folder copied from a slot: the agent's working folder by default.
WORKSPACE = "workspace"
#: `safeId` in agent-providers: one path segment, no separator, no `..`.
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
#: A v1 seat's controller uid: 2000 for seat 0, 2000 + 200·k for seat k (the v1 machine's README).
V1_CONTROLLER_UID = 2000
V1_SEAT_UID_STEP = 200
#: Where the box keeps agents' default folders on `data-agents` (`agentWorkspace`, the box operator's flags).
BOX_WORKSPACES = "workspaces"
#: The box's agents user and group: every file written is theirs, whatever its v1 owner.
BOX_UID = 2000
BOX_GID = 2000
FILE_MODE = 0o640
DIR_MODE = 0o750
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_WORKSPACES = 64
MAX_AGENTS = 256
CHUNK = 1024 * 1024
#: The free space kept on the target beyond what the copy needs.
FREE_SPACE_MARGIN = 256 * 1024 * 1024
TERMINATION_LOG = Path("/dev/termination-log")


@dataclass(frozen=True)
class Owners:
    """Who must own what on the v1 disk: the seat map root's, and seat k's folders and store its controller's (2000 +
    200·k). Tests on a machine without those users give their own."""

    seat_map: int = 0
    seat_base: int = V1_CONTROLLER_UID
    seat_step: int = V1_SEAT_UID_STEP

    def seat(self, index: int) -> int:
        return self.seat_base + self.seat_step * index


@dataclass(frozen=True)
class Caps:
    files: int = 2_000_000
    bytes: int = 500 * 1024**3
    file_bytes: int = 50 * 1024**3
    depth: int = 64


class CopyRefused(Exception):
    """The whole copy is refused. `code` is a fixed word for the runner and Core; `detail` is for the operator's own
    output only (it may name an agent), never the report."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Agent:
    id: str
    name: str


@dataclass(frozen=True)
class Workspace:
    tenant_id: str
    seat_key: str
    v1_controller_id: str
    agents: tuple[Agent, ...]


@dataclass(frozen=True)
class Manifest:
    machine_id: str
    namespace: str
    workspaces: tuple[Workspace, ...]


@dataclass
class Counts:
    files: int = 0
    bytes: int = 0
    symlinks_skipped: int = 0
    refused: int = 0
    checksum_mismatches: int = 0


@dataclass
class _Plan:
    """What a copy would write, found before anything is written: per agent, the source folder (as a chain of names
    under the source root) and the target folder name, plus the counts."""

    moves: list[tuple[tuple[str, ...], str]] = field(default_factory=list)
    counts: Counts = field(default_factory=Counts)


# ---------------------------------------------------------------- the manifest


def _text(value: Any, what: str, limit: int = 200) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise CopyRefused("bad_manifest", f"{what} isn't valid text")
    return value


def read_manifest(raw: bytes) -> Manifest:
    """Core's `manifest` JSON, with each workspace's `seat_key` and `v1_controller_id`, and each agent's `id`, `name`
    and `directory` (which must be null: an agent that named its own folder isn't copied yet)."""
    if len(raw) > MAX_MANIFEST_BYTES:
        raise CopyRefused("bad_manifest", "the manifest is too large")
    try:
        body = json.loads(raw)
    except ValueError:
        raise CopyRefused("bad_manifest", "the manifest isn't JSON") from None
    if not isinstance(body, dict):
        raise CopyRefused("bad_manifest", "the manifest isn't an object")
    machine_id = _text(body.get("machine_id"), "machine_id")
    namespace = _text(body.get("namespace"), "namespace", 63)
    raw_workspaces = body.get("workspaces")
    if (
        not isinstance(raw_workspaces, list)
        or not raw_workspaces
        or len(raw_workspaces) > MAX_WORKSPACES
    ):
        raise CopyRefused("bad_manifest", "the manifest's workspaces aren't a short list")
    workspaces = []
    for entry in raw_workspaces:
        if not isinstance(entry, dict):
            raise CopyRefused("bad_manifest", "a workspace isn't an object")
        agents_raw = entry.get("agents")
        if not isinstance(agents_raw, list) or len(agents_raw) > MAX_AGENTS:
            raise CopyRefused("bad_manifest", "a workspace's agents aren't a short list")
        agents = []
        for agent in agents_raw:
            if not isinstance(agent, dict):
                raise CopyRefused("bad_manifest", "an agent isn't an object")
            agent_id = _text(agent.get("id"), "an agent id")
            name = _text(agent.get("name"), "an agent name")
            if not SAFE_ID.match(agent_id) or ".." in agent_id:
                raise CopyRefused("bad_manifest", "an agent id can't be checked against a marker")
            if not SAFE_ID.match(name) or ".." in name:
                raise CopyRefused("unsafe_name", f"agent {agent_id}'s name can't name a box folder")
            if agent.get("directory") is not None:
                raise CopyRefused(
                    "own_folder", f"agent {name} works in a folder of its own; it isn't copied yet"
                )
            agents.append(Agent(agent_id, name))
        workspaces.append(
            Workspace(
                tenant_id=_text(entry.get("tenant_id"), "tenant_id"),
                seat_key=_text(entry.get("seat_key"), "seat_key"),
                v1_controller_id=_text(entry.get("v1_controller_id"), "v1_controller_id"),
                agents=tuple(agents),
            )
        )
    tenants = [w.tenant_id for w in workspaces]
    keys = [w.seat_key for w in workspaces]
    ids = [a.id for w in workspaces for a in w.agents]
    names = [a.name for w in workspaces for a in w.agents]
    if len(set(tenants)) != len(tenants) or len(set(keys)) != len(keys):
        raise CopyRefused("bad_manifest", "a workspace or seat is named twice")
    if len(set(ids)) != len(ids):
        raise CopyRefused("bad_manifest", "an agent is named twice")
    if len(set(names)) != len(names):
        # The box keeps one folder per name, so two agents of one name would write one folder.
        raise CopyRefused("unsafe_name", "two agents share a name, so they'd share a box folder")
    return Manifest(machine_id=machine_id, namespace=namespace, workspaces=tuple(workspaces))


# ---------------------------------------------------------------- reading the source without following anything


def _open_dir(name: str, parent: int) -> int:
    """`name` under the directory `parent`, as a directory, never through a link."""
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)


def _open_chain(root: int, names: tuple[str, ...]) -> int:
    fd = os.dup(root)
    try:
        for name in names:
            child = _open_dir(name, fd)
            os.close(fd)
            fd = child
    except BaseException:
        os.close(fd)
        raise
    return fd


def _small_regular_file(name: str, parent: int, limit: int) -> tuple[os.stat_result, bytes]:
    """A regular file with one link, read whole, at most `limit` bytes; anything else raises `CopyRefused`."""
    try:
        fd = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent
        )
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise CopyRefused(
            "bad_source",
            f"{name} can't be opened as a plain file ({errno.errorcode.get(exc.errno)})",
        ) from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise CopyRefused("bad_source", f"{name} isn't a small plain file")
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise CopyRefused("bad_source", f"{name} is too large")
        return info, data
    finally:
        os.close(fd)


def read_seat_map(root: int, owners: Owners = Owners()) -> dict[str, int]:
    """The seat map: root's own regular file, mode 0600, exactly `{"version": 1, "controllers": {key: index}}`, each
    index 0 to 7 and none twice. Security's guards for matching seats by key alone."""
    try:
        info, data = _small_regular_file(SEAT_MAP, root, MAX_SEAT_MAP_BYTES)
    except FileNotFoundError:
        raise CopyRefused("bad_source", "the v1 disk has no seat map") from None
    if info.st_uid != owners.seat_map or stat.S_IMODE(info.st_mode) != 0o600:
        raise CopyRefused("bad_source", "the seat map isn't root's own, mode 0600")
    try:
        body = json.loads(data)
    except ValueError:
        raise CopyRefused("bad_source", "the seat map isn't JSON") from None
    if (
        not isinstance(body, dict)
        or set(body) != {"version", "controllers"}
        or body["version"] != 1
    ):
        raise CopyRefused("bad_source", "the seat map isn't version 1")
    controllers = body["controllers"]
    if not isinstance(controllers, dict) or len(controllers) > MAX_SEATS:
        raise CopyRefused("bad_source", "the seat map's controllers aren't a short object")
    seats: dict[str, int] = {}
    for key, index in controllers.items():
        if not isinstance(key, str) or isinstance(index, bool) or not isinstance(index, int):
            raise CopyRefused("bad_source", "a seat map entry isn't a key and an index")
        if not 0 <= index < MAX_SEATS:
            raise CopyRefused("bad_source", "a seat index is out of range")
        seats[key] = index
    if len(set(seats.values())) != len(seats):
        raise CopyRefused("bad_source", "two seats share an index")
    return seats


def _agents_folder(index: int) -> tuple[str, ...]:
    return ("agents",) if index == 0 else ("controllers", str(index), "agents")


def _seat_data(index: int) -> tuple[str, ...]:
    return (".switch-controller",) if index == 0 else ("controllers", str(index), "data")


def read_store(root: int, index: int, owners: Owners = Owners()) -> tuple[str, dict[str, int]]:
    """The seat's controller id and its agent users, from its `controller.db`: the seat's data folder and the file both
    its controller's own, a plain file under the size cap with no write-ahead log or journal beside it, opened
    read-only and immutable through the open file itself, with untrusted schema off, two fixed queries, and every value
    checked. Anything else refuses the whole copy."""
    uid = owners.seat(index)
    try:
        data = _open_chain(root, _seat_data(index))
    except OSError:
        raise CopyRefused("bad_source", f"seat {index} has no controller data folder") from None
    try:
        if os.fstat(data).st_uid != uid:
            raise CopyRefused("bad_source", f"seat {index}'s data folder isn't its controller's")
        for sidecar in (STORE + "-wal", STORE + "-journal"):
            if _exists(sidecar, data):
                raise CopyRefused(
                    "bad_source",
                    f"seat {index}'s store has a {sidecar.rsplit('-', 1)[1]} beside it",
                )
        try:
            fd = os.open(
                STORE, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=data
            )
        except OSError:
            raise CopyRefused("bad_source", f"seat {index} has no controller store") from None
    finally:
        os.close(data)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != uid
            or info.st_size > MAX_STORE_BYTES
        ):
            raise CopyRefused(
                "bad_source", f"seat {index}'s store isn't its controller's own small plain file"
            )
        try:
            db = sqlite3.connect(f"file:/proc/self/fd/{fd}?mode=ro&immutable=1", uri=True)
        except sqlite3.Error:
            raise CopyRefused("bad_source", f"seat {index}'s store can't be opened") from None
        try:
            if hasattr(db, "setconfig") and hasattr(sqlite3, "SQLITE_DBCONFIG_DEFENSIVE"):
                db.setconfig(sqlite3.SQLITE_DBCONFIG_DEFENSIVE, True)
            db.execute("PRAGMA trusted_schema=OFF")
            ids = db.execute("SELECT value FROM meta WHERE key = 'controller_id'").fetchall()
            users = db.execute("SELECT slot, agent_id FROM agent_users").fetchall()
        except sqlite3.Error:
            raise CopyRefused("bad_source", f"seat {index}'s store can't be read") from None
        finally:
            db.close()
    finally:
        os.close(fd)
    if len(ids) != 1 or not isinstance(ids[0][0], str) or not SAFE_ID.match(ids[0][0]):
        raise CopyRefused("bad_source", f"seat {index}'s store has no controller id")
    slots: dict[str, int] = {}
    for slot, agent_id in users:
        if (
            isinstance(slot, bool)
            or not isinstance(slot, int)
            or not 1 <= slot <= MAX_SLOT
            or not isinstance(agent_id, str)
            or not SAFE_ID.match(agent_id)
            or ".." in agent_id
        ):
            raise CopyRefused(
                "bad_source", f"seat {index}'s store has an agent user that isn't valid"
            )
        if agent_id in slots:
            raise CopyRefused(
                "slot_mismatch", f"seat {index}'s store gives agent {agent_id} two agent users"
            )
        slots[agent_id] = slot
    if len(set(slots.values())) != len(slots):
        raise CopyRefused(
            "slot_mismatch", f"seat {index}'s store gives one agent user to two agents"
        )
    return ids[0][0], slots


def find_slots(
    root: int, index: int, workspace: Workspace, owners: Owners = Owners()
) -> dict[str, str]:
    """For the workspace's seat at `index`: checks the seat's controller is the one Core recorded, then which slot
    folder holds each of the workspace's agents, from the store's agent users. Each slot's marker, when there is one,
    must name the same agent. A slot holding an agent the manifest doesn't list here is never copied; an agent with no
    slot (never run on v1) has none."""
    controller_id, users = read_store(root, index, owners)
    if controller_id != workspace.v1_controller_id:
        raise CopyRefused(
            "seat_mismatch",
            f"seat {index}'s controller isn't the one Core recorded for its workspace",
        )
    found: dict[str, str] = {}
    for agent in workspace.agents:
        slot = users.get(agent.id)
        if slot is None:
            continue
        name = f"{slot:02d}"
        try:
            folder = _open_chain(root, _agents_folder(index) + (name,))
        except FileNotFoundError:
            raise CopyRefused(
                "slot_mismatch",
                f"seat {index}'s store gives agent {agent.id} a slot that isn't on the disk",
            ) from None
        except OSError:
            raise CopyRefused(
                "bad_source", f"seat {index}'s slot {name} isn't a plain folder"
            ) from None
        try:
            if os.fstat(folder).st_uid != owners.seat(index):
                raise CopyRefused(
                    "bad_source", f"seat {index}'s slot {name} isn't its controller's"
                )
            try:
                info, data = _small_regular_file(MARKER, folder, MAX_MARKER_BYTES)
            except FileNotFoundError:
                pass
            else:
                if (
                    info.st_uid != owners.seat(index)
                    or data.decode("ascii", "replace").removesuffix("\n") != agent.id
                ):
                    raise CopyRefused(
                        "slot_mismatch", f"seat {index}'s slot {name} marker names another agent"
                    )
        finally:
            os.close(folder)
        found[agent.id] = name
    _check_markers(root, index, workspace, users)
    return found


def _check_markers(root: int, index: int, workspace: Workspace, users: dict[str, int]) -> None:
    """Every slot whose marker names one of this workspace's agents must be the slot the store gives that agent: a
    store that moved an agent's slot to someone else would otherwise leave that agent's work behind without a word."""
    wanted = {agent.id for agent in workspace.agents}
    try:
        folder = _open_chain(root, _agents_folder(index))
    except FileNotFoundError:
        return
    except OSError:
        raise CopyRefused(
            "bad_source", f"seat {index}'s agents folder isn't a plain folder"
        ) from None
    try:
        with os.scandir(folder) as entries:
            names = sorted(entry.name for entry in entries)
        for name in names:
            if not SLOT_FOLDER.match(name):
                continue  # `released/` and anything else: never copied, never trusted
            try:
                slot = _open_dir(name, folder)
            except OSError:
                continue
            try:
                try:
                    _, data = _small_regular_file(MARKER, slot, MAX_MARKER_BYTES)
                except (FileNotFoundError, CopyRefused):
                    continue
            finally:
                os.close(slot)
            holder = data.decode("ascii", "replace").removesuffix("\n")
            if holder in wanted and users.get(holder) != int(name):
                raise CopyRefused(
                    "slot_mismatch",
                    f"seat {index}'s slot {name} marker names agent {holder}, which the store puts elsewhere",
                )
    finally:
        os.close(folder)


# ---------------------------------------------------------------- walking a folder


@dataclass(frozen=True)
class _Entry:
    path: tuple[str, ...]  # under the folder copied
    kind: str  # "dir" or "file"
    size: int


def _usable_name(name: str) -> bool:
    """A name the copy writes as it is: valid UTF-8 (no surrogate escapes), no control characters, not `.` or `..`."""
    if name in (".", "..") or "/" in name or "\x00" in name:
        return False
    try:
        name.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return not any(ord(c) < 0x20 or ord(c) == 0x7F for c in name)


def walk(folder: int, caps: Caps, counts: Counts) -> Iterator[_Entry]:
    """Every directory and plain file under `folder`, depth first, never through a link. Symlinks are counted as
    skipped; anything else not a directory or a regular file with one link is counted as refused. Raises `CopyRefused`
    past a cap."""

    def visit(fd: int, prefix: tuple[str, ...]) -> Iterator[_Entry]:
        if len(prefix) > caps.depth:
            raise CopyRefused("copy_failed", "a folder is nested past the depth cap")
        with os.scandir(fd) as entries:
            names = sorted(entry.name for entry in entries)
        for name in names:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            mode = info.st_mode
            if stat.S_ISLNK(mode):
                counts.symlinks_skipped += 1
                continue
            if not _usable_name(name):
                counts.refused += 1
                continue
            path = prefix + (name,)
            if stat.S_ISDIR(mode):
                yield _Entry(path, "dir", 0)
                child = _open_dir(name, fd)
                try:
                    yield from visit(child, path)
                finally:
                    os.close(child)
            elif stat.S_ISREG(mode) and info.st_nlink == 1:
                if info.st_size > caps.file_bytes:
                    raise CopyRefused("copy_failed", "a file is larger than the per-file cap")
                yield _Entry(path, "file", info.st_size)
            else:
                # A hard link (it could be a file outside the roots), a device, a FIFO or a socket.
                counts.refused += 1

    yield from visit(folder, ())


def _plan(
    source: int, manifest: Manifest, caps: Caps, owners: Owners
) -> tuple[_Plan, dict[tuple[str, ...], list[_Entry]], list[str]]:
    seats = read_seat_map(source, owners)
    plan = _Plan()
    skipped: list[str] = []
    trees: dict[tuple[str, ...], list[_Entry]] = {}
    for workspace in manifest.workspaces:
        if workspace.seat_key not in seats:
            raise CopyRefused(
                "no_seat", f"workspace {workspace.tenant_id} has no seat on the v1 disk"
            )
        index = seats[workspace.seat_key]
        slots = find_slots(source, index, workspace, owners)
        for agent in workspace.agents:
            slot = slots.get(agent.id)
            if slot is None:
                skipped.append(agent.id)
                continue
            chain = _agents_folder(index) + (slot, WORKSPACE)
            try:
                folder = _open_chain(source, chain)
            except FileNotFoundError:
                continue
            except OSError:
                raise CopyRefused(
                    "bad_source", f"agent {agent.name}'s workspace isn't a plain folder"
                ) from None
            try:
                entries = list(walk(folder, caps, plan.counts))
            finally:
                os.close(folder)
            for entry in entries:
                if entry.kind == "file":
                    plan.counts.files += 1
                    plan.counts.bytes += entry.size
            if plan.counts.files > caps.files:
                raise CopyRefused("copy_failed", "more files than the cap")
            if plan.counts.bytes > caps.bytes:
                raise CopyRefused("copy_failed", "more bytes than the cap")
            plan.moves.append((chain, agent.name))
            trees[chain] = entries
    return plan, trees, skipped


# ---------------------------------------------------------------- the stream between the reader and the writer
#
# The reader (root, `DAC_OVERRIDE` only, the source read-only) and the writer (uid 2000, no capabilities, `data-agents`
# only) are two containers joined by a FIFO on a shared memory-backed `emptyDir`. Each frame is a 4-byte big-endian
# length and a small JSON header; a `file` frame's header is followed by exactly its `size` bytes and their sha256.
# The writer trusts none of it: it checks every name, depth, size and total against its own copy of the manifest and
# its own caps, and builds every path itself.

MAX_HEADER = 64 * 1024
DIGEST = 32
#: Effective capability bits (`/proc/self/status`, CapEff): `DAC_OVERRIDE` is bit 1.
CAP_DAC_OVERRIDE = 1 << 1


class StreamError(Exception):
    """The stream isn't what the protocol says: the copy fails."""


def _send(out: Any, header: dict[str, Any], body: bytes = b"") -> None:
    raw = json.dumps(header, separators=(",", ":")).encode()
    out.write(len(raw).to_bytes(4, "big") + raw + body)


def _read_exact(stream: Any, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(min(CHUNK, size - len(data)))
        if not chunk:
            raise StreamError("the stream ended early")
        data += chunk
    return bytes(data)


def _receive(stream: Any) -> dict[str, Any]:
    size = int.from_bytes(_read_exact(stream, 4), "big")
    if not 0 < size <= MAX_HEADER:
        raise StreamError("a header is out of bounds")
    try:
        header = json.loads(_read_exact(stream, size))
    except ValueError:
        raise StreamError("a header isn't JSON") from None
    if not isinstance(header, dict) or not isinstance(header.get("t"), str):
        raise StreamError("a header isn't a frame")
    return header


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise StreamError("a count isn't a count")
    return value


def read(
    manifest: Manifest,
    source_root: Path,
    out: Any,
    *,
    caps: Caps = Caps(),
    owners: Owners = Owners(),
    log: Callable[[str], None] = lambda line: print(line, file=sys.stderr),
) -> list[str]:
    """The reader: plans the copy from the source (every source-side check), then streams it, and returns the ids of
    the manifest's agents with no slot on the v1 disk (for the operator, never the report). A refusal is sent as a
    `refused` frame with its code, so the writer reports it, and re-raised."""
    source = os.open(source_root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        try:
            plan, trees, skipped = _plan(source, manifest, caps, owners)
        except CopyRefused as refused:
            _send(out, {"t": "refused", "code": refused.code})
            raise
        if skipped:
            # The operator's output only, never the report: agents with no slot on the v1 disk.
            log(
                f"agents with no slot on the v1 disk, not copied: {len(skipped)}: {', '.join(skipped)}"
            )
        _send(
            out,
            {
                "t": "totals",
                "files": plan.counts.files,
                "bytes": plan.counts.bytes,
                "symlinks_skipped": plan.counts.symlinks_skipped,
                "refused": plan.counts.refused,
            },
        )
        for chain, name in plan.moves:
            _send(out, {"t": "agent", "name": name})
            _stream_tree(source, chain, trees[chain], out)
        _send(out, {"t": "end"})
    finally:
        os.close(source)
    return skipped


def _stream_tree(source: int, chain: tuple[str, ...], entries: list[_Entry], out: Any) -> None:
    root = _open_chain(source, chain)
    open_dirs: dict[tuple[str, ...], int] = {(): root}
    try:
        for entry in entries:
            parent = open_dirs[entry.path[:-1]]
            leaf = entry.path[-1]
            if entry.kind == "dir":
                open_dirs[entry.path] = _open_dir(leaf, parent)
                _send(out, {"t": "dir", "path": list(entry.path)})
                continue
            src = os.open(
                leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent
            )
            try:
                info = os.fstat(src)
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1
                    or info.st_size != entry.size
                ):
                    raise CopyRefused("copy_failed", "a file changed under the copy")
                _send(out, {"t": "file", "path": list(entry.path), "size": entry.size})
                digest = hashlib.sha256()
                sent = 0
                while chunk := os.read(src, CHUNK):
                    sent += len(chunk)
                    if sent > entry.size:
                        raise CopyRefused("copy_failed", "a file grew under the copy")
                    digest.update(chunk)
                    out.write(chunk)
                if sent != entry.size:
                    raise CopyRefused("copy_failed", "a file shrank under the copy")
                out.write(digest.digest())
            finally:
                os.close(src)
    finally:
        for fd in open_dirs.values():
            os.close(fd)


# ---------------------------------------------------------------- writing the target


def _clear(target_workspaces: int, name: str) -> None:
    """Removes the target folder `name`, never through a link (`shutil.rmtree` is fd-based on Linux)."""
    try:
        info = os.stat(name, dir_fd=target_workspaces, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(info.st_mode):
        if not shutil.rmtree.avoids_symlink_attacks:  # type: ignore[attr-defined]
            raise CopyRefused("copy_failed", "this system can't clear a folder safely")
        shutil.rmtree(name, dir_fd=target_workspaces)
    else:
        os.unlink(name, dir_fd=target_workspaces)


def _make_dir(name: str, parent: int) -> int:
    os.mkdir(name, DIR_MODE, dir_fd=parent)
    fd = _open_dir(name, parent)
    os.fchmod(fd, DIR_MODE)
    return fd


def _free_bytes(fd: int) -> int:
    info = os.fstatvfs(fd)
    return info.f_bavail * info.f_frsize


def _exists(name: str, parent: int) -> bool:
    try:
        os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return False
    return True


def _box_disk(info: os.stat_result, box_uid: int, box_gid: int) -> bool:
    """The box's `data-agents` root: its agents user's own, or, as the box pod's `fsGroup` leaves a fresh volume
    (`root:2000`, group-writable), its agents group's to write."""
    if not stat.S_ISDIR(info.st_mode):
        return False
    return info.st_uid == box_uid or (info.st_gid == box_gid and bool(info.st_mode & stat.S_IWGRP))


def _path(value: Any, caps: Caps) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or len(value) > caps.depth + 1:
        raise StreamError("a path isn't a short list")
    if not all(isinstance(part, str) and _usable_name(part) for part in value):
        raise StreamError("a path segment isn't usable")
    return tuple(value)


def write(
    manifest: Manifest,
    target_root: Path,
    stream: Any,
    *,
    may_clear: bool,
    caps: Caps = Caps(),
    box_uid: int = BOX_UID,
    box_gid: int = BOX_GID,
    free_bytes: Callable[[int], int] = _free_bytes,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """The writer: checks the reader's totals against its own caps and the box disk's free space before writing
    anything, then writes what the stream carries under `workspaces/<name>` for the manifest's own names, reads each
    file back and compares checksums, and returns the `CopyReport` body (with `source_volume_id` null: the runner fills
    it from the bound volume)."""
    started = clock()
    names = {agent.name for workspace in manifest.workspaces for agent in workspace.agents}
    first = _receive(stream)
    if first["t"] == "refused":
        code = first.get("code")
        raise CopyRefused(
            code if isinstance(code, str) and SAFE_ID.match(code) else "copy_failed",
            "the reader refused",
        )
    if first["t"] != "totals":
        raise StreamError("the stream doesn't start with its totals")
    files, size = _count(first.get("files")), _count(first.get("bytes"))
    skipped, refused = _count(first.get("symlinks_skipped")), _count(first.get("refused"))
    if files > caps.files or size > caps.bytes:
        raise CopyRefused("copy_failed", "the copy is larger than the caps")
    target = os.open(target_root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        if not _box_disk(os.fstat(target), box_uid, box_gid):
            raise CopyRefused("target_mismatch", "the target isn't the box's agents disk")
        if free_bytes(target) < size + FREE_SPACE_MARGIN:
            raise CopyRefused("target_full", "the box's disk can't hold the copy")
        try:
            workspaces = _open_dir(BOX_WORKSPACES, target)
        except FileNotFoundError:
            workspaces = _make_dir(BOX_WORKSPACES, target)
        try:
            existing = [name for name in sorted(names) if _exists(name, workspaces)]
            if existing and not may_clear:
                raise CopyRefused(
                    "target_not_empty", "the box already holds some of these agents' folders"
                )
            for name in existing:
                _clear(workspaces, name)
            got_files, got_bytes, mismatches = _receive_trees(
                stream, workspaces, names, caps, files, size
            )
        finally:
            os.close(workspaces)
    finally:
        os.close(target)
    if (got_files, got_bytes) != (files, size):
        raise StreamError("the stream didn't carry what its totals said")
    return {
        "machine_id": manifest.machine_id,
        "workspaces": [w.tenant_id for w in manifest.workspaces],
        "files": got_files,
        "bytes": got_bytes,
        "symlinks_skipped": skipped,
        "refused": refused,
        "checksum_mismatches": mismatches,
        "source_volume_id": None,
        "seconds": max(0, int(clock() - started)),
    }


def _receive_trees(
    stream: Any, workspaces: int, names: set[str], caps: Caps, files: int, size: int
) -> tuple[int, int, int]:
    got_files = got_bytes = mismatches = 0
    seen: set[str] = set()
    open_dirs: dict[tuple[str, ...], int] = {}
    try:
        while True:
            header = _receive(stream)
            kind = header["t"]
            if kind == "end":
                return got_files, got_bytes, mismatches
            if kind == "agent":
                name = header.get("name")
                if not isinstance(name, str) or name not in names or name in seen:
                    raise StreamError("an agent folder isn't one the manifest names, once")
                seen.add(name)
                for fd in open_dirs.values():
                    os.close(fd)
                open_dirs = {(): _make_dir(name, workspaces)}
                continue
            if not open_dirs:
                raise StreamError("an entry came before its agent")
            path = _path(header.get("path"), caps)
            parent = open_dirs.get(path[:-1])
            if parent is None or path in open_dirs:
                raise StreamError("an entry's folder wasn't sent first, or came twice")
            if kind == "dir":
                if len(path) > caps.depth:
                    raise CopyRefused("copy_failed", "a folder is nested past the depth cap")
                open_dirs[path] = _make_dir(path[-1], parent)
            elif kind == "file":
                length = _count(header.get("size"))
                got_files += 1
                got_bytes += length
                if length > caps.file_bytes or got_files > files or got_bytes > size:
                    raise StreamError("a file is past its declared totals or the caps")
                if not _receive_file(stream, path[-1], parent, length):
                    mismatches += 1
            else:
                raise StreamError("a frame isn't one the protocol has")
    finally:
        for fd in open_dirs.values():
            os.close(fd)


def _receive_file(stream: Any, name: str, parent: int, length: int) -> bool:
    """Writes `length` bytes from the stream as a new file; whether the reader's checksum, the bytes received and the
    file read back all agree."""
    dst = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        FILE_MODE,
        dir_fd=parent,
    )
    digest = hashlib.sha256()
    try:
        left = length
        while left:
            chunk = _read_exact(stream, min(CHUNK, left))
            left -= len(chunk)
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(dst, view) :]
        os.fchmod(dst, FILE_MODE)
        os.fsync(dst)
    finally:
        os.close(dst)
    sent = _read_exact(stream, DIGEST)
    check = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        again = hashlib.sha256()
        while chunk := os.read(check, CHUNK):
            again.update(chunk)
    finally:
        os.close(check)
    return digest.digest() == sent == again.digest()


# ---------------------------------------------------------------- both halves in one process (tests, local runs)


def copy(
    manifest: Manifest,
    source_root: Path,
    target_root: Path,
    *,
    may_clear: bool,
    caps: Caps = Caps(),
    owners: Owners = Owners(),
    box_uid: int = BOX_UID,
    free_bytes: Callable[[int], int] = _free_bytes,
    log: Callable[[str], None] = lambda line: print(line, file=sys.stderr),
) -> dict[str, Any]:
    """The reader and the writer joined by a pipe, as the Job joins them by a FIFO. Raises the reader's refusal if it
    refused."""
    import threading

    read_end, write_end = os.pipe()
    errors: list[BaseException] = []

    def reader() -> None:
        try:
            with os.fdopen(write_end, "wb") as out:
                read(manifest, source_root, out, caps=caps, owners=owners, log=log)
        except BaseException as exc:  # noqa: BLE001 -- carried to the caller
            errors.append(exc)

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        with os.fdopen(read_end, "rb") as stream:
            try:
                return write(
                    manifest,
                    target_root,
                    stream,
                    may_clear=may_clear,
                    caps=caps,
                    box_uid=box_uid,
                    free_bytes=free_bytes,
                )
            except BaseException:
                # Let the reader finish writing into a closed pipe rather than block.
                stream.close()
                raise
    finally:
        thread.join()
        if errors and isinstance(errors[0], CopyRefused):
            raise errors[0]


# ---------------------------------------------------------------- the Job's entry points


def _capabilities() -> int:
    for line in Path("/proc/self/status").read_text().splitlines():
        if line.startswith("CapEff:"):
            return int(line.split()[1], 16)
    raise CopyRefused("copy_failed", "the process's capabilities can't be read")


def check_reader_identity() -> None:
    """The reader runs as root holding exactly `DAC_OVERRIDE`; a looser Job fails closed."""
    if os.geteuid() != 0 or _capabilities() != CAP_DAC_OVERRIDE:
        raise CopyRefused("bad_job", "the reader must run as root with only DAC_OVERRIDE")


def check_writer_identity(box_uid: int = BOX_UID) -> None:
    """The writer runs as the box's agents user with no capabilities."""
    if os.geteuid() != box_uid or os.getegid() != BOX_GID or _capabilities() != 0:
        raise CopyRefused(
            "bad_job", "the writer must run as the box's agents user with no capabilities"
        )


def _wait_for(path: Path, timeout: float = 300.0) -> None:
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() > deadline:
            raise CopyRefused("copy_failed", "the stream never appeared")
        time.sleep(0.2)


def main(
    argv: list[str] | None = None,
    termination_log: Path = TERMINATION_LOG,
    *,
    owners: Owners = Owners(),
    box_uid: int = BOX_UID,
    free_bytes: Callable[[int], int] = _free_bytes,
    check_identity: bool = True,
) -> int:
    parser = argparse.ArgumentParser(prog="switch-migration-copy")
    roles = parser.add_subparsers(dest="role", required=True)
    reader = roles.add_parser("read", help="the reader container: root, DAC_OVERRIDE only")
    reader.add_argument("--manifest", type=Path, required=True)
    reader.add_argument(
        "--source", type=Path, required=True, help="the restored volume, mounted read-only"
    )
    reader.add_argument("--stream", type=Path, required=True, help="the FIFO the writer makes")
    writer = roles.add_parser(
        "write", help="the writer container: the box's agents user, no capabilities"
    )
    writer.add_argument("--manifest", type=Path, required=True)
    writer.add_argument("--target", type=Path, required=True, help="the box's data-agents disk")
    writer.add_argument("--stream", type=Path, required=True, help="the FIFO to make and read")
    writer.add_argument(
        "--step",
        choices=("held", "copy_failed"),
        required=True,
        help="Core's step, from the runner",
    )
    args = parser.parse_args(argv)
    try:
        manifest = read_manifest(args.manifest.read_bytes())
        namespace = os.environ.get("POD_NAMESPACE")
        if namespace is not None and namespace != manifest.namespace:
            raise CopyRefused("target_mismatch", "the manifest is for another box's namespace")
        if args.role == "read":
            if check_identity:
                check_reader_identity()
            _wait_for(args.stream)
            with open(args.stream, "wb") as out:
                skipped = read(manifest, args.source, out, owners=owners)
            _report(termination_log, _read_done(skipped))
            return 0
        if check_identity:
            check_writer_identity(box_uid)
        if not args.stream.exists():
            os.mkfifo(args.stream, 0o600)
        with open(args.stream, "rb") as stream:
            report = write(
                manifest,
                args.target,
                stream,
                may_clear=args.step == "copy_failed",
                box_uid=box_uid,
                free_bytes=free_bytes,
            )
    except CopyRefused as refused:
        print(f"copy refused: {refused.code}: {refused.detail}", file=sys.stderr)
        _report(termination_log, {"refused": refused.code})
        return 1
    except (OSError, StreamError) as exc:
        detail = (
            errno.errorcode.get(getattr(exc, "errno", 0) or 0, "")
            if isinstance(exc, OSError)
            else str(exc)
        )
        print(f"copy failed: {type(exc).__name__} {detail}", file=sys.stderr)
        _report(termination_log, {"refused": "copy_failed"})
        return 1
    _report(termination_log, report)
    print(json.dumps(report))
    return 0


#: A pod's termination message holds 4 KB; the reader's keeps well inside it.
MAX_TERMINATION_BYTES = 3800


def _read_done(skipped: list[str]) -> dict[str, Any]:
    """The reader's termination message: the skipped agents' ids, as many as fit, and how many there were in all."""
    body: dict[str, Any] = {"read": "done", "skipped_agents": [], "skipped_total": len(skipped)}
    for agent_id in skipped:
        body["skipped_agents"].append(agent_id)
        if len(json.dumps(body, separators=(",", ":"))) > MAX_TERMINATION_BYTES:
            body["skipped_agents"].pop()
            break
    return body


def _report(path: Path, body: dict[str, Any]) -> None:
    try:
        path.write_text(json.dumps(body, separators=(",", ":")))
    except OSError:
        pass


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
