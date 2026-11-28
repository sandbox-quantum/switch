"""The migration copy program against a fake v1 disk: what it copies, what it refuses, and that a refusal writes
nothing (`migration_copy.py`, security's `migration-copy-job-threat-model`)."""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import stat
from pathlib import Path

import pytest

from switch_hosted_controller import migration_copy
from switch_hosted_controller.migration_copy import Caps, CopyRefused, Owners, copy, read_manifest

ME = os.getuid()
OWNERS = Owners(seat_map=ME, seat_base=ME, seat_step=0)
VOLUME = "vol-0123456789abcdef0"
MACHINE = "00000000-0000-4000-8000-0000000000aa"
NAMESPACE = "agents-user-k1-00000000000000aa"


def _store(
    path: Path, controller_id: str, users: list[tuple[int, str]], unique: bool = True
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute(
        "CREATE TABLE agent_users (slot INTEGER PRIMARY KEY, agent_id TEXT NOT NULL"
        + (" UNIQUE" if unique else "")
        + ", claimed_at TEXT NOT NULL)"
    )
    db.execute("INSERT INTO meta VALUES ('controller_id', ?)", (controller_id,))
    db.executemany("INSERT INTO agent_users VALUES (?, ?, 'then')", users)
    db.commit()
    db.close()


def _slot(agents: Path, slot: int, agent_id: str) -> Path:
    root = agents / f"{slot:02d}"
    (root / "workspace").mkdir(parents=True)
    (root / ".switch-agent-id").write_text(agent_id + "\n")
    (root / "home" / ".claude").mkdir(parents=True)
    (root / "home" / ".claude" / ".credentials.json").write_text('{"fake": "provider login"}')
    (root / "watcher").mkdir()
    (root / "watcher" / "login.json").write_text('{"fake": "login"}')
    return root / "workspace"


@pytest.fixture
def disk(tmp_path: Path) -> dict:
    """A v1 disk with two seats: seat 0 for workspace t-a (agents a1 and a2, a2 never run), seat 1 for t-b (agent b1),
    a set-aside agent, a controller credential file, and a box target."""
    source = tmp_path / "source"
    source.mkdir()
    seat_map = source / ".switch-controllers.json"
    seat_map.write_text(json.dumps({"version": 1, "controllers": {"key-a": 0, "key-b": 1}}))
    seat_map.chmod(0o600)
    _store(source / ".switch-controller" / "controller.db", "ctl-a", [(1, "a1")])
    (source / ".switch-controller" / "credential.json").write_text(
        '{"fake": "v1 controller credential"}'
    )
    _store(source / "controllers" / "1" / "data" / "controller.db", "ctl-b", [(1, "b1")])
    a1 = _slot(source / "agents", 1, "a1")
    (a1 / "README.md").write_text("hello from a1\n")
    (a1 / "src").mkdir()
    (a1 / "src" / "main.py").write_text("print('a1')\n")
    b1 = _slot(source / "controllers" / "1" / "agents", 1, "b1")
    (b1 / "notes.txt").write_text("b1's notes\n")
    released = source / "agents" / "released" / "gone" / "workspace"
    released.mkdir(parents=True)
    (released / "old.txt").write_text("not to be copied\n")
    target = tmp_path / "target"
    target.mkdir()
    manifest = {
        "machine_id": MACHINE,
        "person": "k1-00000000000000aa",
        "namespace": NAMESPACE,
        "snapshot_id": "snap-0123456789abcdef0",
        "workspaces": [
            {
                "tenant_id": "t-a",
                "seat_key": "key-a",
                "v1_controller_id": "ctl-a",
                "agents": [
                    {"id": "a1", "name": "alpha", "directory": None},
                    {"id": "a2", "name": "never-run", "directory": None},
                ],
            },
            {
                "tenant_id": "t-b",
                "seat_key": "key-b",
                "v1_controller_id": "ctl-b",
                "agents": [{"id": "b1", "name": "bravo", "directory": None}],
            },
        ],
    }
    return {"source": source, "target": target, "manifest": manifest, "a1": a1, "tmp": tmp_path}


def _run(disk: dict, *, may_clear: bool = False, caps: Caps = Caps(), free: int = 1 << 50) -> dict:
    return copy(
        read_manifest(json.dumps(disk["manifest"]).encode()),
        disk["source"],
        disk["target"],
        source_volume_id=VOLUME,
        may_clear=may_clear,
        caps=caps,
        owners=OWNERS,
        free_bytes=lambda _fd: free,
    )


def _written(disk: dict) -> set[str]:
    root = disk["target"]
    return {str(p.relative_to(root)) for p in root.rglob("*")}


def _refused(disk: dict, code: str, **kwargs) -> None:
    before = _written(disk)
    with pytest.raises(CopyRefused) as refused:
        _run(disk, **kwargs)
    assert refused.value.code == code
    # A refusal writes nothing (the workspaces folder itself may be made first).
    assert _written(disk) - before <= {"workspaces"}


# ---------------------------------------------------------------- what is copied


def test_only_each_agents_workspace_is_copied_into_its_box_folder(disk: dict) -> None:
    report = _run(disk)
    assert _written(disk) == {
        "workspaces",
        "workspaces/alpha",
        "workspaces/alpha/README.md",
        "workspaces/alpha/src",
        "workspaces/alpha/src/main.py",
        "workspaces/bravo",
        "workspaces/bravo/notes.txt",
    }
    target = disk["target"] / "workspaces"
    assert (target / "alpha" / "src" / "main.py").read_text() == "print('a1')\n"
    assert report == {
        "machine_id": MACHINE,
        "workspaces": ["t-a", "t-b"],
        "files": 3,
        "bytes": len("hello from a1\n") + len("print('a1')\n") + len("b1's notes\n"),
        "symlinks_skipped": 0,
        "refused": 0,
        "checksum_mismatches": 0,
        "source_volume_id": VOLUME,
        "seconds": report["seconds"],
    }


def test_no_login_credential_or_set_aside_agent_moves(disk: dict) -> None:
    """The allow-list: never an agent's home or watcher, a controller's data, or a released agent."""
    _run(disk)
    everything = "\n".join(p.read_text() for p in disk["target"].rglob("*") if p.is_file())
    for secret in ("provider login", '"login"', "v1 controller credential", "not to be copied"):
        assert secret not in everything


def test_files_get_fixed_modes_and_lose_setuid(disk: dict) -> None:
    script = disk["a1"] / "run.sh"
    script.write_text("#!/bin/sh\n")
    try:
        script.chmod(0o4755)
    except (
        PermissionError
    ):  # a sandbox that refuses setuid: a world-writable file shows the same rule
        script.chmod(0o777)
    _run(disk)
    copied = disk["target"] / "workspaces" / "alpha" / "run.sh"
    assert stat.S_IMODE(copied.stat().st_mode) == migration_copy.FILE_MODE
    assert (
        stat.S_IMODE((disk["target"] / "workspaces" / "alpha").stat().st_mode)
        == migration_copy.DIR_MODE
    )


def test_the_report_names_no_file_folder_or_agent(disk: dict) -> None:
    report = json.dumps(_run(disk))
    for name in ("README", "main.py", "src", "alpha", "bravo", "a1", "b1", "notes"):
        assert name not in report


# ---------------------------------------------------------------- a hostile tree


def test_a_hostile_tree_is_skipped_or_refused_and_nothing_outside_is_touched(disk: dict) -> None:
    a1, tmp = disk["a1"], disk["tmp"]
    outside = tmp / "outside.txt"
    outside.write_text("someone else's\n")
    (a1 / "escape").symlink_to(outside)
    (a1 / "escape-dir").symlink_to(tmp)
    (a1 / "abs").symlink_to("/etc/passwd")
    (a1 / "hard").hardlink_to(disk["source"] / ".switch-controller" / "credential.json")
    os.mkfifo(a1 / "fifo")
    sock = socket.socket(socket.AF_UNIX)
    sock.bind(str(a1 / "sock"))
    os.makedirs(a1 / os.fsdecode(b"bad-\xff-name"))
    (a1 / "new\nline").write_text("x")
    report = _run(disk)
    sock.close()
    assert report["symlinks_skipped"] == 3
    assert report["refused"] == 5  # the hard link, the FIFO, the socket, two unusable names
    copied = disk["target"] / "workspaces" / "alpha"
    assert sorted(p.name for p in copied.iterdir()) == ["README.md", "src"]
    assert outside.read_text() == "someone else's\n"
    everything = "\n".join(p.read_text() for p in disk["target"].rglob("*") if p.is_file())
    assert "v1 controller credential" not in everything


@pytest.mark.skipif(os.geteuid() != 0, reason="making a device node needs root")
def test_a_device_node_is_refused(disk: dict) -> None:
    os.mknod(disk["a1"] / "dev", stat.S_IFCHR | 0o600, os.makedev(1, 3))
    assert _run(disk)["refused"] == 1


def test_a_folder_past_the_depth_cap_refuses_the_copy(disk: dict) -> None:
    deep = disk["a1"]
    for i in range(6):
        deep = deep / f"d{i}"
    deep.mkdir(parents=True)
    _refused(disk, "copy_failed", caps=Caps(depth=4))


def test_too_many_files_refuses_the_copy(disk: dict) -> None:
    for i in range(20):
        (disk["a1"] / f"tiny-{i}").write_text("x")
    _refused(disk, "copy_failed", caps=Caps(files=10))


def test_a_huge_file_refuses_the_copy(disk: dict) -> None:
    with open(disk["a1"] / "huge.bin", "wb") as huge:
        huge.truncate(10 * 1024**3)  # sparse: no disk used
    _refused(disk, "copy_failed", caps=Caps(file_bytes=1024**3))


def test_too_many_bytes_refuses_the_copy(disk: dict) -> None:
    (disk["a1"] / "big").write_bytes(b"x" * 4096)
    _refused(disk, "copy_failed", caps=Caps(bytes=1024))


def test_a_target_too_full_refuses_before_writing(disk: dict) -> None:
    _refused(disk, "target_full", free=1024)


# ---------------------------------------------------------------- re-runs


def test_a_second_run_clears_only_its_folders_when_the_step_allows(disk: dict) -> None:
    first = _run(disk)
    other = disk["target"] / "workspaces" / "someone-else"
    other.mkdir()
    (other / "keep.txt").write_text("kept\n")
    _refused(disk, "target_not_empty")
    # A link planted in a target folder is removed, never followed.
    victim = disk["tmp"] / "victim"
    victim.mkdir()
    (victim / "precious").write_text("still here\n")
    (disk["target"] / "workspaces" / "alpha" / "link").symlink_to(victim)
    again = _run(disk, may_clear=True)
    assert {k: v for k, v in again.items() if k != "seconds"} == {
        k: v for k, v in first.items() if k != "seconds"
    }
    assert (victim / "precious").read_text() == "still here\n"
    assert (other / "keep.txt").read_text() == "kept\n"
    assert not (disk["target"] / "workspaces" / "alpha" / "link").exists()


# ---------------------------------------------------------------- the wrong person's or the wrong seat's files


def test_a_workspace_with_no_seat_refuses_the_copy(disk: dict) -> None:
    disk["manifest"]["workspaces"][1]["seat_key"] = "key-elsewhere"
    _refused(disk, "no_seat")


def test_swapped_seats_are_caught_by_the_controller_id(disk: dict) -> None:
    seat_map = disk["source"] / ".switch-controllers.json"
    seat_map.write_text(json.dumps({"version": 1, "controllers": {"key-a": 1, "key-b": 0}}))
    _refused(disk, "seat_mismatch")


@pytest.mark.parametrize(
    "body",
    [
        {"version": 2, "controllers": {"key-a": 0, "key-b": 1}},
        {"version": 1, "controllers": {"key-a": 0, "key-b": 8}},
        {"version": 1, "controllers": {"key-a": 0, "key-b": 0}},
        {"version": 1, "controllers": {"key-a": 0, "key-b": True}},
        {"version": 1, "controllers": {"key-a": 0, "key-b": 1}, "extra": 1},
    ],
)
def test_a_seat_map_out_of_form_refuses_the_copy(disk: dict, body: dict) -> None:
    (disk["source"] / ".switch-controllers.json").write_text(json.dumps(body))
    _refused(disk, "bad_source")


def test_a_seat_map_open_to_others_or_a_link_refuses_the_copy(disk: dict) -> None:
    seat_map = disk["source"] / ".switch-controllers.json"
    seat_map.chmod(0o644)
    _refused(disk, "bad_source")
    seat_map.rename(disk["tmp"] / "map.json")
    seat_map.symlink_to(disk["tmp"] / "map.json")
    _refused(disk, "bad_source")


def test_a_seat_owned_by_someone_else_refuses_the_copy(disk: dict) -> None:
    _refused_with_owners(disk, Owners(seat_map=ME, seat_base=ME + 1, seat_step=0), "bad_source")


def _refused_with_owners(disk: dict, owners: Owners, code: str) -> None:
    with pytest.raises(CopyRefused) as refused:
        copy(
            read_manifest(json.dumps(disk["manifest"]).encode()),
            disk["source"],
            disk["target"],
            source_volume_id=VOLUME,
            may_clear=False,
            owners=owners,
            free_bytes=lambda _fd: 1 << 50,
        )
    assert refused.value.code == code
    assert not (disk["target"] / "workspaces" / "alpha").exists()


def test_a_missing_controller_store_refuses_the_copy(disk: dict) -> None:
    (disk["source"] / "controllers" / "1" / "data" / "controller.db").unlink()
    _refused(disk, "bad_source")


def test_a_store_with_a_journal_beside_it_refuses_the_copy(disk: dict) -> None:
    (disk["source"] / ".switch-controller" / "controller.db-wal").write_bytes(b"")
    _refused(disk, "bad_source")


def test_a_store_that_isnt_sqlite_refuses_the_copy(disk: dict) -> None:
    (disk["source"] / ".switch-controller" / "controller.db").write_bytes(b"not a database" * 100)
    _refused(disk, "bad_source")


def test_a_store_giving_one_agent_two_slots_refuses_the_copy(disk: dict) -> None:
    path = disk["source"] / ".switch-controller" / "controller.db"
    path.unlink()
    _store(path, "ctl-a", [(1, "a1"), (2, "a1")], unique=False)
    _refused(disk, "slot_mismatch")


def test_a_slot_marker_naming_another_agent_refuses_the_copy(disk: dict) -> None:
    (disk["source"] / "agents" / "01" / ".switch-agent-id").write_text("b1\n")
    _refused(disk, "slot_mismatch")


def test_a_store_giving_an_agents_slot_to_someone_else_refuses_the_copy(disk: dict) -> None:
    """Agent a1's slot 01, by its marker, handed to an agent the manifest doesn't list: a1's work isn't skipped."""
    path = disk["source"] / ".switch-controller" / "controller.db"
    path.unlink()
    _store(path, "ctl-a", [(1, "stranger")])
    _refused(disk, "slot_mismatch")


# ---------------------------------------------------------------- the manifest


def test_an_agent_with_its_own_folder_refuses_the_copy(disk: dict) -> None:
    disk["manifest"]["workspaces"][0]["agents"][0]["directory"] = "/data/agents/agent/elsewhere"
    _refused(disk, "own_folder")


@pytest.mark.parametrize("name", ["../up", "a/b", ".hidden", "x..y", "", "a b"])
def test_an_agent_name_that_cant_name_a_folder_refuses_the_copy(disk: dict, name: str) -> None:
    disk["manifest"]["workspaces"][0]["agents"][0]["name"] = name
    with pytest.raises(CopyRefused) as refused:
        read_manifest(json.dumps(disk["manifest"]).encode())
    assert refused.value.code in ("unsafe_name", "bad_manifest")


def test_two_agents_of_one_name_refuse_the_copy(disk: dict) -> None:
    disk["manifest"]["workspaces"][1]["agents"][0]["name"] = "alpha"
    with pytest.raises(CopyRefused) as refused:
        read_manifest(json.dumps(disk["manifest"]).encode())
    assert refused.value.code == "unsafe_name"


# ---------------------------------------------------------------- the Job's entry point


def _main(disk: dict, monkeypatch: pytest.MonkeyPatch, step: str = "held") -> tuple[int, Path]:
    manifest = disk["tmp"] / "manifest.json"
    manifest.write_text(json.dumps(disk["manifest"]))
    log = disk["tmp"] / "termination-log"
    code = migration_copy.main(
        [
            "--manifest",
            str(manifest),
            "--source",
            str(disk["source"]),
            "--target",
            str(disk["target"]),
            "--source-volume-id",
            VOLUME,
            "--step",
            step,
        ],
        termination_log=log,
        owners=OWNERS,
        free_bytes=lambda _fd: 1 << 50,
    )
    return code, log


def test_the_job_writes_its_report_to_the_termination_log(
    disk: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("POD_NAMESPACE", NAMESPACE)
    code, log = _main(disk, monkeypatch)
    assert code == 0
    body = json.loads(log.read_text())
    assert set(body) == {
        "machine_id",
        "workspaces",
        "files",
        "bytes",
        "symlinks_skipped",
        "refused",
        "checksum_mismatches",
        "source_volume_id",
        "seconds",
    }


def test_the_job_refuses_another_boxs_manifest(disk: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POD_NAMESPACE", "agents-user-k1-00000000000000bb")
    code, log = _main(disk, monkeypatch)
    assert code == 1
    assert json.loads(log.read_text()) == {"refused": "target_mismatch"}
    assert not (disk["target"] / "workspaces").exists()
