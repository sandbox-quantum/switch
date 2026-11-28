"""`switch-hosted-migration` end to end, through its command line, against
Postgres: the commands an operator types, in the order the runbook gives
them, with the copy job between `manifest` and `run --copy-report`.

The copy job here is a stand-in that keeps to the fixed interfaces of the
migration-copy design: it reads exactly the `manifest` command's JSON, and
writes exactly the `CopyReport` fields as JSON, counts only. The v1 machine,
the box and their controllers are outside Core, so their reports are written
to the row as they would write them (`World`, shared with the service tests).

What this adds to the service tests (`visibility/test_hosted_migration.py`):
the argument parsing, the manifest as the job sees it, the report file as the
operator hands it in, what the operator reads back, and the exit codes, for
the full sequence and for each failure the design names: a copy failing
halfway then a rollback, a full disk, a hostile tree, a wrong namespace and a
report naming the wrong box.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import hosted_migration_cli as cli
from switch_core.db.models import User
from switch_core.visibility.hosted_migration import (
    ROLLBACK_WINDOW,
    MigrationRefused,
)
from tests.switch_core.management.harness import TENANT_ZERO_ID, add_member
from tests.switch_core.visibility.test_hosted_migration import (
    INSTANCE,
    SNAPSHOT,
    VOLUME,
    World,
)

pytestmark = pytest.mark.usefixtures("hosted_v2_on")

#: The volume the runner restores from the snapshot: never the v1 disk.
RESTORED = "vol-0fedcba9876543210"
#: Exactly the keys the job reads (the `manifest` command's JSON).
MANIFEST_KEYS = {"machine_id", "person", "namespace", "snapshot_id", "workspaces"}
#: Exactly the keys the job writes (`CopyReport`).
REPORT_KEYS = {
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


@dataclass
class Ran:
    code: int
    out: str
    err: str


class Cli:
    """The command line, run as `main` runs it, against the test's database.

    `main` opens its own engine from `SwitchConfig`; here the engine is the
    test's and the migrations are `World`'s (its clock, its stand-in revoke).
    Everything from the arguments to the exit code is the real code."""

    def __init__(
        self,
        world: World,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
        operators: list[str],
    ) -> None:
        self.tmp = tmp_path
        self._capsys = capsys
        listed = tmp_path / "operators.json"
        listed.write_text(json.dumps({"operators": operators}))
        listed.chmod(0o600)
        self.config = SimpleNamespace(
            hosted_box_provisioning=True, visibility_operators_path=str(listed)
        )

        class Engine:
            async def dispose(self) -> None:
                return None

        monkeypatch.setattr(cli, "create_engine_from_config", lambda _c: Engine())
        monkeypatch.setattr(cli, "create_session_factory", lambda _e: world.factory)
        monkeypatch.setattr(cli, "_migrations", lambda _c, _f: world.migrations)

    async def __call__(self, *argv: str) -> Ran:
        """One command; its exit code and what it printed. The refusals are
        mapped as `main` maps them (its own test below holds it to that)."""
        self._capsys.readouterr()
        try:
            code = await cli._run(self.config, cli._parser().parse_args(list(argv)))  # type: ignore[arg-type]
        except MigrationRefused as refused:
            print(f"refused ({refused.code}): {refused}", file=sys.stderr)
            code = 2
        except cli.CommandError as error:
            print(f"refused: {error}", file=sys.stderr)
            code = 2
        captured = self._capsys.readouterr()
        return Ran(code, captured.out, captured.err)

    async def manifest(self, person: User) -> dict[str, Any]:
        ran = await self("manifest", person.id)
        assert ran.code == 0, ran.err
        return json.loads(ran.out)

    def report_file(self, report: dict[str, Any], name: str = "report.json") -> str:
        path = self.tmp / name
        path.write_text(json.dumps(report))
        return str(path)


def copy_job(
    manifest: dict[str, Any],
    *,
    namespace: str,
    files: int = 120,
    size: int = 6 * 1024**3,
    symlinks_skipped: int = 0,
    refused: int = 0,
    checksum_mismatches: int = 0,
    source_volume_id: str = RESTORED,
    seconds: int = 95,
) -> dict[str, Any]:
    """The copy job, as the interfaces fix it: the manifest in, the report out.

    It refuses a manifest for another namespace before reading anything (the
    design's machine-id check against the namespace's annotation), as the
    real job must. The counts stand for the walk it would do."""
    assert set(manifest) == MANIFEST_KEYS
    if manifest["namespace"] != namespace:
        raise PermissionError("the manifest isn't for this namespace")
    return {
        "machine_id": manifest["machine_id"],
        "workspaces": [w["tenant_id"] for w in manifest["workspaces"]],
        "files": files,
        "bytes": size,
        "symlinks_skipped": symlinks_skipped,
        "refused": refused,
        "checksum_mismatches": checksum_mismatches,
        "source_volume_id": source_volume_id,
        "seconds": seconds,
    }


@pytest.fixture
async def people(session_factory: async_sessionmaker[AsyncSession]) -> dict[str, User]:
    return {
        "ada": await add_member(session_factory, "ada"),
        "bob": await add_member(session_factory, "bob"),
        "op": await add_member(session_factory, "op"),
    }


@pytest.fixture
def world(session_factory: async_sessionmaker[AsyncSession]) -> World:
    return World(session_factory)


@pytest.fixture
def run(
    world: World,
    people: dict[str, User],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> Cli:
    return Cli(world, tmp_path, capsys, monkeypatch, operators=[people["op"].id])


async def _to_held(
    run: Cli, world: World, person: User, op: str, machine_id: str
) -> None:
    """Freeze to held, as the operator types it."""
    assert (await run("run", person.id, "--operator", op, "--execute")).code == 0
    await world.reports(machine_id, "stopped")  # the v1 machine stops
    assert (
        "-> frozen" in (await run("run", person.id, "--operator", op, "--execute")).out
    )
    ran = await run(
        "run", person.id, "--operator", op, "--execute", "--snapshot-id", SNAPSHOT
    )
    assert "-> snapshot" in ran.out
    assert (
        "-> flipped" in (await run("run", person.id, "--operator", op, "--execute")).out
    )
    await world.box_enrols(machine_id, person)  # the box's first start
    await world.reports(machine_id, "ready")
    assert (
        "-> holding" in (await run("run", person.id, "--operator", op, "--execute")).out
    )
    await world.reports(machine_id, "stopped")
    assert "-> held" in (await run("run", person.id, "--operator", op, "--execute")).out


async def _step(world: World, person: User) -> str | None:
    return (await world.record(person)).step


# ── the full sequence ────────────────────────────────────────────────────


async def test_the_whole_move_from_plan_to_clean_up(
    run: Cli, world: World, people: dict[str, User]
) -> None:
    ada, op = people["ada"], people["op"].id
    machine_id, v1_controller, agent_id = await world.v1_machine(ada)
    seat_key = (await world.workspace(machine_id)).id

    # plan: read only.
    planned = await run("plan", ada.id)
    assert planned.code == 0
    assert f"agent {agent_id}  reviewer" in planned.out
    assert "next: Freeze" in planned.out
    # Without --execute nothing changes, and it says so.
    dry = await run("run", ada.id, "--operator", op)
    assert dry.code == 0 and dry.out.startswith("dry run (pass --execute)")
    assert (await world.machine(machine_id)).stop_reason is None

    # No manifest before the box is held for the copy.
    early = await run("manifest", ada.id)
    assert early.code == 2 and "refused (not_held)" in early.err

    await _to_held(run, world, ada, op, machine_id)

    # The manifest, as the job reads it: exactly its keys, ids only.
    manifest = await run.manifest(ada)
    assert set(manifest) == MANIFEST_KEYS
    assert manifest["machine_id"] == machine_id
    assert manifest["snapshot_id"] == SNAPSHOT
    assert manifest["namespace"].startswith("agents-user-")
    assert ada.id not in json.dumps(manifest)  # the person only keyed
    # Each workspace's v1 seat and controller, from Core's rows: the job
    # matches them against the disk's seat map and the seat's store.
    assert manifest["workspaces"] == [
        {
            "tenant_id": TENANT_ZERO_ID,
            "seat_key": seat_key,
            "v1_controller_id": v1_controller,
            "agent_ids": [agent_id],
            "agents": [{"id": agent_id, "name": "reviewer", "directory": None}],
        }
    ]

    report = copy_job(manifest, namespace=manifest["namespace"])
    assert set(report) == REPORT_KEYS
    copied = await run(
        "run",
        ada.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(report),
    )
    assert copied.code == 0 and "held -> copied" in copied.out
    record = await world.record(ada)
    assert (record.files_copied, record.bytes_copied) == (120, 6 * 1024**3)
    assert record.copy_source_volume_id == RESTORED

    assert (
        "-> released" in (await run("run", ada.id, "--operator", op, "--execute")).out
    )
    waiting = await run("run", ada.id, "--operator", op, "--execute")
    assert "released -> released" in waiting.out and "enrol" in waiting.out
    await world.reports(machine_id, "ready")
    await world.box_enrols(machine_id, ada)
    assert "-> done" in (await run("run", ada.id, "--operator", op, "--execute")).out
    again = await run("run", ada.id, "--operator", op, "--execute")
    assert again.code == 0 and "Nothing to do" in again.out

    # Clean-up only after the rollback window, and it names the v1 resources.
    early_clean = await run("clean-up", ada.id, "--operator", op, "--execute")
    assert early_clean.code == 2 and "refused (window_open)" in early_clean.err
    world.clock.now += ROLLBACK_WINDOW + timedelta(minutes=1)
    dry_clean = await run("clean-up", ada.id, "--operator", op)
    assert dry_clean.code == 0 and "dry run" in dry_clean.out
    listed = json.loads(dry_clean.out.splitlines()[0].split(": ", 1)[1])
    assert listed == {
        "instance_id": INSTANCE,
        "data_volume_id": VOLUME,
        "snapshot_id": SNAPSHOT,
    }
    assert await _step(world, ada) == "done"
    cleaned = await run("clean-up", ada.id, "--operator", op, "--execute")
    assert cleaned.code == 0 and "done -> cleaned" in cleaned.out
    # Nothing to undo once cleaned.
    late = await run("rollback", ada.id, "--operator", op, "--execute")
    assert late.code == 2 and "refused (nothing_to_undo)" in late.err


# ── the failures the design names ────────────────────────────────────────


async def test_a_copy_failing_halfway_is_recorded_then_rolled_back(
    run: Cli, world: World, people: dict[str, User]
) -> None:
    """The job dies mid-copy: no report. The operator records the failure,
    the box stays held, and the rollback gives the person their v1 machine
    back on its own disk."""
    ada, op = people["ada"], people["op"].id
    machine_id, v1_controller, _agent = await world.v1_machine(ada)
    await _to_held(run, world, ada, op, machine_id)

    # A half-written report file (the job was killed while writing it).
    half = run.tmp / "half.json"
    half.write_text('{"machine_id": "' + machine_id + '", "files": 12')
    broken = await run(
        "run", ada.id, "--operator", op, "--execute", "--copy-report", str(half)
    )
    assert broken.code == 2 and "isn't JSON" in broken.err
    assert await _step(world, ada) == "held"

    failed = await run("run", ada.id, "--operator", op, "--execute", "--copy-failed")
    assert failed.code == 0 and "held -> copy_failed" in failed.out
    machine = await world.machine(machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "migration")
    # Release refuses: there's no verified copy.
    refused = await run("run", ada.id, "--operator", op, "--execute")
    assert refused.code == 2 and "refused (copy_needed)" in refused.err

    dry = await run("rollback", ada.id, "--operator", op)
    assert dry.code == 0 and "dry run" in dry.out
    assert (await world.machine(machine_id)).backend == "box"
    undone = await run("rollback", ada.id, "--operator", op, "--execute")
    assert undone.code == 0 and "copy_failed -> rolled_back" in undone.out
    machine = await world.machine(machine_id)
    assert (machine.backend, machine.instance_id, machine.data_volume_id) == (
        "vm",
        INSTANCE,
        VOLUME,
    )
    assert machine.stop_reason is None
    # The v1 controller stays revoked: the snapshot holds a copy of its
    # credential (Finding 46), so the v1 machine enrols again afresh.
    assert v1_controller in world.revoked()
    # A move can start again after a rollback.
    planned = await run("plan", ada.id)
    assert "next: Freeze again" in planned.out


async def test_a_full_disk_fails_the_copy_and_a_second_run_completes_it(
    run: Cli, world: World, people: dict[str, User]
) -> None:
    """The job checks free space first and refuses before writing: the
    operator records `--copy-failed`, the disk is grown, and the job runs
    again into the same held box."""
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await _to_held(run, world, ada, op, machine_id)

    assert (
        await run("run", ada.id, "--operator", op, "--execute", "--copy-failed")
    ).code == 0
    assert await _step(world, ada) == "copy_failed"
    # The manifest is still served for the second run, unchanged.
    manifest = await run.manifest(ada)
    assert manifest["machine_id"] == machine_id

    report = copy_job(manifest, namespace=manifest["namespace"])
    second = await run(
        "run",
        ada.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(report),
    )
    assert second.code == 0 and "copy_failed -> copied" in second.out


async def test_a_hostile_tree_s_report_counts_what_was_refused_and_names_nothing(
    run: Cli, world: World, people: dict[str, User]
) -> None:
    """Symlinks skipped and devices, FIFOs, hard links and escapes refused
    are counts on the record; a report that carries file names, or anything
    beyond its counts, is refused before Core reads it."""
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await _to_held(run, world, ada, op, machine_id)
    manifest = await run.manifest(ada)
    report = copy_job(
        manifest, namespace=manifest["namespace"], symlinks_skipped=7, refused=5
    )

    named = {**report, "refused_paths": ["agents/a/../../etc/shadow"]}
    ran = await run(
        "run",
        ada.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(named, "named.json"),
    )
    assert ran.code == 2 and "must have exactly" in ran.err
    assert "shadow" not in ran.err
    padded = run.tmp / "padded.json"
    padded.write_text(json.dumps(report) + " " * cli.MAX_REPORT_BYTES)
    ran = await run(
        "run", ada.id, "--operator", op, "--execute", "--copy-report", str(padded)
    )
    assert ran.code == 2 and "too large" in ran.err
    assert await _step(world, ada) == "held"

    ran = await run(
        "run",
        ada.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(report),
    )
    assert ran.code == 0
    record = await world.record(ada)
    assert (record.symlinks_skipped, record.copy_refused) == (7, 5)


async def test_a_manifest_for_another_namespace_is_refused_by_the_job(
    run: Cli, world: World, people: dict[str, User]
) -> None:
    """Two people held at once: each manifest names its own box and
    namespace, and the job refuses one for a namespace it isn't running in."""
    ada, bob, op = people["ada"], people["bob"], people["op"].id
    ada_machine, _c, _a = await world.v1_machine(ada)
    bob_machine, _c2, _a2 = await world.v1_machine(bob, "bobs-agent")
    await _to_held(run, world, ada, op, ada_machine)
    await _to_held(run, world, bob, op, bob_machine)

    ada_manifest = await run.manifest(ada)
    bob_manifest = await run.manifest(bob)
    assert ada_manifest["namespace"] != bob_manifest["namespace"]
    assert ada_manifest["machine_id"] != bob_manifest["machine_id"]
    with pytest.raises(PermissionError):
        copy_job(ada_manifest, namespace=bob_manifest["namespace"])


async def test_a_report_naming_the_wrong_box_is_refused(
    run: Cli, world: World, people: dict[str, User]
) -> None:
    """Ada's report handed in for Bob, or a report naming a box that isn't
    the move's: refused, and Bob's box stays held with nothing recorded."""
    ada, bob, op = people["ada"], people["bob"], people["op"].id
    ada_machine, _c, _a = await world.v1_machine(ada)
    bob_machine, _c2, _a2 = await world.v1_machine(bob, "bobs-agent")
    await _to_held(run, world, ada, op, ada_machine)
    await _to_held(run, world, bob, op, bob_machine)
    ada_manifest = await run.manifest(ada)
    ada_report = copy_job(ada_manifest, namespace=ada_manifest["namespace"])

    ran = await run(
        "run",
        bob.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(ada_report),
    )
    assert ran.code == 2 and "refused (target_mismatch)" in ran.err
    record = await world.record(bob)
    assert record.step == "held" and record.files_copied is None
    # The right box but a workspace the manifest didn't name.
    bob_manifest = await run.manifest(bob)
    extra = copy_job(bob_manifest, namespace=bob_manifest["namespace"])
    extra["workspaces"] = [*extra["workspaces"], "another-tenant"]
    ran = await run(
        "run",
        bob.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(extra, "extra.json"),
    )
    assert ran.code == 2 and "refused (target_mismatch)" in ran.err
    assert await _step(world, bob) == "held"
    # Ada's own report still goes in for Ada.
    ran = await run(
        "run",
        ada.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(ada_report),
    )
    assert ran.code == 0 and "held -> copied" in ran.out


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({"checksum_mismatches": 1}, "checksum_mismatch"),
        ({"source_volume_id": VOLUME}, "bad_report"),  # the v1 disk itself
        ({"source_volume_id": "vol-$(id)"}, "bad_report"),
        ({"files": -1}, "bad_report"),
        ({"bytes": True}, "bad_report"),
    ],
)
async def test_a_report_that_doesn_t_verify_is_refused(
    run: Cli,
    world: World,
    people: dict[str, User],
    change: dict[str, Any],
    code: str,
) -> None:
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await _to_held(run, world, ada, op, machine_id)
    manifest = await run.manifest(ada)
    report = {**copy_job(manifest, namespace=manifest["namespace"]), **change}

    ran = await run(
        "run",
        ada.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(report),
    )
    assert ran.code == 2 and f"refused ({code})" in ran.err
    assert await _step(world, ada) == "held"


async def test_a_report_before_the_box_is_held_is_refused(
    run: Cli, world: World, people: dict[str, User]
) -> None:
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    assert (await run("run", ada.id, "--operator", op, "--execute")).code == 0
    report = {
        "machine_id": machine_id,
        "workspaces": [TENANT_ZERO_ID],
        "files": 1,
        "bytes": 1,
        "symlinks_skipped": 0,
        "refused": 0,
        "checksum_mismatches": 0,
        "source_volume_id": RESTORED,
        "seconds": 1,
    }
    ran = await run(
        "run",
        ada.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(report),
    )
    assert ran.code == 2 and "refused (not_held)" in ran.err
    assert await _step(world, ada) == "freezing"


async def test_an_operator_not_on_the_list_changes_nothing(
    run: Cli, world: World, people: dict[str, User]
) -> None:
    ada, bob = people["ada"], people["bob"]
    machine_id, _controller, _agent = await world.v1_machine(ada)
    for argv in (
        ("run", ada.id, "--operator", bob.id, "--execute"),
        ("rollback", ada.id, "--operator", bob.id, "--execute"),
        ("clean-up", ada.id, "--operator", bob.id, "--execute"),
    ):
        ran = await run(*argv)
        assert ran.code == 2 and "operators list" in ran.err
    assert (await world.machine(machine_id)).stop_reason is None


# ── rollback from each step ──────────────────────────────────────────────


async def _to(
    run: Cli, world: World, person: User, op: str, machine_id: str, step: str
) -> None:
    """Drive the move to `step` through the command line."""
    order = [
        "freezing",
        "frozen",
        "snapshot",
        "flipped",
        "held",
        "copy_failed",
        "copied",
        "released",
        "done",
    ]
    target = order.index(step)
    assert (await run("run", person.id, "--operator", op, "--execute")).code == 0
    if target == 0:
        return
    await world.reports(machine_id, "stopped")
    await run("run", person.id, "--operator", op, "--execute")
    if target == 1:
        return
    await run(
        "run", person.id, "--operator", op, "--execute", "--snapshot-id", SNAPSHOT
    )
    if target == 2:
        return
    await run("run", person.id, "--operator", op, "--execute")
    if target == 3:
        return
    await world.box_enrols(machine_id, person)
    await world.reports(machine_id, "ready")
    await run("run", person.id, "--operator", op, "--execute")
    await world.reports(machine_id, "stopped")
    await run("run", person.id, "--operator", op, "--execute")
    if step == "held":
        return
    if step == "copy_failed":
        await run("run", person.id, "--operator", op, "--execute", "--copy-failed")
        return
    manifest = await run.manifest(person)
    report = copy_job(manifest, namespace=manifest["namespace"])
    await run(
        "run",
        person.id,
        "--operator",
        op,
        "--execute",
        "--copy-report",
        run.report_file(report),
    )
    if step == "copied":
        return
    await run("run", person.id, "--operator", op, "--execute")
    if step == "released":
        return
    await world.reports(machine_id, "ready")
    await world.box_enrols(machine_id, person)
    await run("run", person.id, "--operator", op, "--execute")


@pytest.mark.parametrize(
    "step",
    [
        "freezing",
        "frozen",
        "snapshot",
        "flipped",
        "held",
        "copy_failed",
        "copied",
        "released",
        "done",
    ],
)
async def test_a_rollback_from_each_step_gives_the_v1_machine_back(
    run: Cli, world: World, people: dict[str, User], step: str
) -> None:
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await _to(run, world, ada, op, machine_id, step)
    assert await _step(world, ada) == step

    ran = await run("rollback", ada.id, "--operator", op, "--execute")
    assert ran.code == 0, ran.err
    if "Stopping the box first" in ran.out:
        # A box that's running is stopped first, then turned back.
        assert step in ("flipped", "released", "done")
        await world.reports(machine_id, "stopped")
        ran = await run("rollback", ada.id, "--operator", op, "--execute")
        assert ran.code == 0, ran.err
    assert f"{step} -> rolled_back" in ran.out
    machine = await world.machine(machine_id)
    assert machine.backend == "vm" and machine.stop_reason is None
    assert (machine.instance_id, machine.data_volume_id) == (INSTANCE, VOLUME)
    # The same person can be moved again from the start.
    assert "next: Freeze again" in (await run("plan", ada.id)).out


# ── main itself ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raised", "printed"),
    [
        (
            MigrationRefused("not_held", "The move isn't at the copy step."),
            "refused (not_held)",
        ),
        (
            cli.CommandError("The copy report isn't JSON."),
            "refused: The copy report isn't JSON.",
        ),
    ],
)
def test_main_exits_2_with_the_refusal_on_stderr(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    raised: Exception,
    printed: str,
) -> None:
    """What `Cli` mirrors: a refusal is exit code 2 and one line on stderr,
    nothing on stdout, so a runner script can stop on it."""

    async def refuse(_config: Any, _arguments: argparse.Namespace) -> int:
        raise raised

    monkeypatch.setattr(cli, "_run", refuse)
    monkeypatch.setattr(cli, "SwitchConfig", lambda: SimpleNamespace())
    monkeypatch.setattr(sys, "argv", ["switch-hosted-migration", "plan", "u-1"])
    with pytest.raises(SystemExit) as exited:
        cli.main()
    assert exited.value.code == 2
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err.strip() == printed + (
        "" if printed.startswith("refused:") else ": " + str(raised)
    )
