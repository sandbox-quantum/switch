"""`switch-hosted-migration-cloud`: the snapshot and the clean-up of a move,
against a stand-in for EC2 that keeps state, refuses unknown ids the way EC2
does, and records every call that changes anything."""

from __future__ import annotations

import argparse
import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from switch_hosted_controller import migration_cloud as mc

INSTALLATION = "test-installation"
MACHINE = "m-11111111"
OTHER_MACHINE = "m-22222222"
OWNER = "k1.user.aaaa"
INSTANCE = "i-0123456789abcdef0"
VOLUME = "vol-0123456789abcdef0"
ROOT = "vol-0aaaaaaaaaaaaaaa0"
SNAPSHOT = "snap-0123456789abcdef0"
NOW = datetime(2026, 12, 1, 12, 0, tzinfo=UTC)
DONE = NOW - timedelta(days=8)


def _tags(**tags: str) -> list[dict[str, str]]:
    return [{"Key": key, "Value": value} for key, value in tags.items()]


def v1_tags(purpose: str, machine: str = MACHINE, installation: str = INSTALLATION):
    return _tags(
        **{
            mc.TAG_INSTALLATION: installation,
            mc.TAG_MACHINE: machine,
            mc.TAG_PURPOSE: purpose,
            mc.TAG_MANAGED_BY: mc.V1_MANAGED_BY,
        }
    )


def snapshot_tags(machine: str = MACHINE, owner: str = OWNER) -> list[dict[str, str]]:
    return _tags(
        **{
            mc.TAG_INSTALLATION: INSTALLATION,
            mc.TAG_MACHINE: machine,
            mc.TAG_OWNER: owner,
            mc.TAG_PURPOSE: mc.MIGRATION_PURPOSE,
            mc.TAG_MANAGED_BY: mc.MIGRATION_MANAGED_BY,
            mc.TAG_SOURCE_VOLUME: VOLUME,
        }
    )


def _missing(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "not found"}}, "Describe")


class FakeEc2:
    def __init__(self) -> None:
        self.volumes: dict[str, dict[str, Any]] = {
            VOLUME: {
                "VolumeId": VOLUME,
                "Encrypted": True,
                "State": "in-use",
                "Tags": v1_tags("data"),
            },
            ROOT: {"VolumeId": ROOT, "Encrypted": True, "State": "in-use", "Tags": []},
        }
        self.instances: dict[str, dict[str, Any]] = {
            INSTANCE: {
                "InstanceId": INSTANCE,
                "State": {"Name": "stopped"},
                "Tags": v1_tags("worker"),
                "BlockDeviceMappings": [
                    {"DeviceName": "/dev/xvda", "Ebs": {"VolumeId": ROOT}},
                    {"DeviceName": "/dev/sdf", "Ebs": {"VolumeId": VOLUME}},
                ],
            }
        }
        self.snapshots: dict[str, dict[str, Any]] = {}
        self.shared: dict[str, list[dict[str, str]]] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        #: Reads a new snapshot stays pending before it completes.
        self.pending_reads = 2
        self.root_deleted_on_termination = True

    def describe_volumes(self, VolumeIds: list[str]) -> dict[str, Any]:
        [volume_id] = VolumeIds
        if volume_id not in self.volumes:
            raise _missing("InvalidVolume.NotFound")
        return {"Volumes": [deepcopy(self.volumes[volume_id])]}

    def describe_instances(self, InstanceIds: list[str]) -> dict[str, Any]:
        [instance_id] = InstanceIds
        if instance_id not in self.instances:
            raise _missing("InvalidInstanceID.NotFound")
        return {"Reservations": [{"Instances": [deepcopy(self.instances[instance_id])]}]}

    def describe_snapshots(self, **kwargs: Any) -> dict[str, Any]:
        if "SnapshotIds" in kwargs:
            [snapshot_id] = kwargs["SnapshotIds"]
            if snapshot_id not in self.snapshots:
                raise _missing("InvalidSnapshot.NotFound")
            snapshot = self.snapshots[snapshot_id]
            if snapshot["State"] == "pending":
                self.pending_reads -= 1
                if self.pending_reads <= 0:
                    snapshot["State"] = "completed"
            return {"Snapshots": [deepcopy(snapshot)]}
        assert kwargs["OwnerIds"] == ["self"]
        found = []
        for snapshot in self.snapshots.values():
            tags = {t["Key"]: t["Value"] for t in snapshot["Tags"]}
            ok = True
            for flt in kwargs["Filters"]:
                if flt["Name"] == "volume-id":
                    ok &= snapshot["VolumeId"] in flt["Values"]
                else:
                    ok &= tags.get(flt["Name"][len("tag:") :]) in flt["Values"]
            if ok:
                found.append(deepcopy(snapshot))
        return {"Snapshots": found}

    def describe_snapshot_attribute(self, SnapshotId: str, Attribute: str) -> dict[str, Any]:
        assert Attribute == "createVolumePermission"
        return {"CreateVolumePermissions": self.shared.get(SnapshotId, [])}

    def create_snapshot(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("create_snapshot", kwargs))
        snapshot_id = f"snap-{len(self.snapshots) + 1:017x}"
        self.snapshots[snapshot_id] = {
            "SnapshotId": snapshot_id,
            "VolumeId": kwargs["VolumeId"],
            "Encrypted": self.volumes[kwargs["VolumeId"]]["Encrypted"],
            "State": "pending",
            "Progress": "0%",
            "Tags": kwargs["TagSpecifications"][0]["Tags"],
        }
        return {"SnapshotId": snapshot_id}

    def terminate_instances(self, InstanceIds: list[str]) -> dict[str, Any]:
        self.calls.append(("terminate_instances", {"InstanceIds": InstanceIds}))
        for instance_id in InstanceIds:
            self.instances[instance_id]["State"] = {"Name": "terminated"}
            for mapping in self.instances[instance_id]["BlockDeviceMappings"]:
                volume_id = mapping["Ebs"]["VolumeId"]
                if volume_id == ROOT and self.root_deleted_on_termination:
                    self.volumes.pop(volume_id, None)
                elif volume_id in self.volumes:
                    self.volumes[volume_id]["State"] = "available"
        return {}

    def delete_volume(self, VolumeId: str) -> dict[str, Any]:
        self.calls.append(("delete_volume", {"VolumeId": VolumeId}))
        assert self.volumes[VolumeId]["State"] == "available"
        del self.volumes[VolumeId]
        return {}

    def delete_snapshot(self, SnapshotId: str) -> dict[str, Any]:
        self.calls.append(("delete_snapshot", {"SnapshotId": SnapshotId}))
        del self.snapshots[SnapshotId]
        return {}

    def add_snapshot(self, snapshot_id: str = SNAPSHOT, **overrides: Any) -> None:
        snapshot = {
            "SnapshotId": snapshot_id,
            "VolumeId": VOLUME,
            "Encrypted": True,
            "State": "completed",
            "Tags": snapshot_tags(),
        }
        snapshot.update(overrides)
        self.snapshots[snapshot_id] = snapshot


def record(**overrides: Any) -> mc.Record:
    fields: dict[str, Any] = {
        "machine_id": MACHINE,
        "owner_keyed_id": OWNER,
        "step": "frozen",
        "v1_instance_id": INSTANCE,
        "v1_data_volume_id": VOLUME,
        "snapshot_id": None,
        "done_at": None,
    }
    fields.update(overrides)
    return mc.Record(**fields)


def cleaned(**overrides: Any) -> mc.Record:
    return record(**{"step": "cleaned", "snapshot_id": SNAPSHOT, "done_at": DONE, **overrides})


def cloud(ec2: FakeEc2, said: list[str] | None = None) -> mc.MigrationCloud:
    ticks = iter(range(0, 10**6, 15))
    return mc.MigrationCloud(
        ec2,
        INSTALLATION,
        sleep=lambda _s: None,
        clock=lambda: float(next(ticks)),
        say=(said.append if said is not None else lambda _l: None),
        now=lambda: NOW,
    )


# ── the record ───────────────────────────────────────────────────────────


def _record_file(tmp_path: Path, body: object) -> Path:
    path = tmp_path / "record.json"
    path.write_text(json.dumps(body))
    return path


def _body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "machine_id": MACHINE,
        "owner_keyed_id": OWNER,
        "step": "frozen",
        "v1_instance_id": INSTANCE,
        "v1_data_volume_id": VOLUME,
        "snapshot_id": None,
        "done_at": None,
    }
    body.update(overrides)
    return body


def test_the_record_is_read_exactly_as_core_prints_it(tmp_path: Path) -> None:
    assert mc.read_record(_record_file(tmp_path, _body())) == record()


@pytest.mark.parametrize(
    "body",
    [
        {k: v for k, v in _body().items() if k != "done_at"},
        {**_body(), "extra": 1},
        _body(machine_id=None),
        _body(v1_data_volume_id="vol-../../x"),
        _body(snapshot_id="snapshot"),
        _body(v1_instance_id=7),
        _body(done_at="yesterday"),
        _body(done_at="2026-11-20T12:00:00"),
        ["m-1"],
    ],
)
def test_anything_else_is_refused(tmp_path: Path, body: object) -> None:
    with pytest.raises(mc.Refused):
        mc.read_record(_record_file(tmp_path, body))


def test_the_record_carries_its_done_time(tmp_path: Path) -> None:
    body = _body(step="cleaned", done_at=DONE.isoformat())
    assert mc.read_record(_record_file(tmp_path, body)).done_at == DONE


def test_the_record_can_be_piped_in(monkeypatch) -> None:
    import io

    raw = json.dumps(_body()).encode()
    monkeypatch.setattr(mc.sys, "stdin", type("In", (), {"buffer": io.BytesIO(raw)})())
    assert mc.read_record(Path("-")) == record()


def test_a_record_too_large_to_be_cores_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "record.json"
    path.write_text(" " * (mc.MAX_RECORD_BYTES + 1))
    with pytest.raises(mc.Refused, match="too large"):
        mc.read_record(path)


def test_the_installation_id_is_checked() -> None:
    with pytest.raises(mc.Refused):
        mc.MigrationCloud(FakeEc2(), "")


# ── snapshot ─────────────────────────────────────────────────────────────


def test_a_dry_run_checks_everything_and_changes_nothing() -> None:
    ec2, said = FakeEc2(), []
    assert cloud(ec2, said).snapshot(record(), execute=False) is None
    assert ec2.calls == []
    assert said == [f"would snapshot {VOLUME} of machine {MACHINE}, tagged migration-copy"]


def test_the_snapshot_is_tagged_waited_for_and_read_back() -> None:
    ec2 = FakeEc2()
    snapshot_id = cloud(ec2).snapshot(record(), execute=True)

    [(call, args)] = ec2.calls
    assert call == "create_snapshot" and args["VolumeId"] == VOLUME
    tags = {t["Key"]: t["Value"] for t in args["TagSpecifications"][0]["Tags"]}
    assert tags == {t["Key"]: t["Value"] for t in snapshot_tags()}
    assert ec2.snapshots[snapshot_id]["State"] == "completed"
    assert "Description" in args and MACHINE not in args["Description"]


def test_a_second_run_carries_on_with_the_same_snapshot() -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot(State="pending")
    assert cloud(ec2).snapshot(record(), execute=True) == SNAPSHOT
    assert ec2.calls == []


def test_two_migration_snapshots_for_one_disk_are_refused() -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    ec2.add_snapshot("snap-0fedcba9876543210")
    with pytest.raises(mc.Refused, match="More than one"):
        cloud(ec2).snapshot(record(), execute=True)


@pytest.mark.parametrize("step", [None, "freezing", "snapshot", "held", "done", "cleaned"])
def test_only_a_frozen_move_is_snapshotted(step: str | None) -> None:
    ec2 = FakeEc2()
    with pytest.raises(mc.Refused, match="not frozen"):
        cloud(ec2).snapshot(record(step=step), execute=True)
    assert ec2.calls == []


def test_a_move_with_a_snapshot_already_recorded_is_refused() -> None:
    with pytest.raises(mc.Refused, match="already recorded"):
        cloud(FakeEc2()).snapshot(record(snapshot_id=SNAPSHOT), execute=True)


def test_without_the_persons_keyed_id_nothing_is_snapshotted() -> None:
    with pytest.raises(mc.Refused, match="keyed id"):
        cloud(FakeEc2()).snapshot(record(owner_keyed_id=None), execute=True)


@pytest.mark.parametrize(
    "tags",
    [
        v1_tags("data", machine=OTHER_MACHINE),  # another person's disk
        v1_tags("data", installation="another-environment"),
        v1_tags("worker"),  # not a data disk
        v1_tags("data")[:3],  # a tag missing, not just wrong
        [],
    ],
)
def test_a_disk_not_tagged_as_this_machines_is_refused(tags: list[dict[str, str]]) -> None:
    ec2 = FakeEc2()
    ec2.volumes[VOLUME]["Tags"] = tags
    with pytest.raises(mc.Refused, match="v1 disk"):
        cloud(ec2).snapshot(record(), execute=True)
    assert ec2.calls == []


def test_an_instance_not_tagged_as_this_machines_is_refused() -> None:
    ec2 = FakeEc2()
    ec2.instances[INSTANCE]["Tags"] = v1_tags("worker", machine=OTHER_MACHINE)
    with pytest.raises(mc.Refused, match="v1 instance"):
        cloud(ec2).snapshot(record(), execute=True)


@pytest.mark.parametrize("state", ["running", "pending", "stopping"])
def test_a_disk_whose_instance_is_not_stopped_is_not_snapshotted(state: str) -> None:
    ec2 = FakeEc2()
    ec2.instances[INSTANCE]["State"] = {"Name": state}
    with pytest.raises(mc.Refused, match="isn't stopped"):
        cloud(ec2).snapshot(record(), execute=True)
    assert ec2.calls == []


def test_an_unencrypted_disk_is_refused() -> None:
    ec2 = FakeEc2()
    ec2.volumes[VOLUME]["Encrypted"] = False
    with pytest.raises(mc.Refused, match="encrypted"):
        cloud(ec2).snapshot(record(), execute=True)


def test_a_missing_disk_is_refused() -> None:
    ec2 = FakeEc2()
    del ec2.volumes[VOLUME]
    with pytest.raises(mc.Refused, match="doesn't exist"):
        cloud(ec2).snapshot(record(), execute=True)


def test_a_shared_snapshot_is_refused_when_read_back() -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    ec2.shared[SNAPSHOT] = [{"Group": "all"}]
    with pytest.raises(mc.Refused, match="shared"):
        cloud(ec2).snapshot(record(), execute=True)


def test_a_snapshot_ec2_failed_is_refused() -> None:
    class FailingEc2(FakeEc2):
        def create_snapshot(self, **kwargs: Any) -> dict[str, Any]:
            created = super().create_snapshot(**kwargs)
            self.snapshots[created["SnapshotId"]]["State"] = "error"
            return created

    with pytest.raises(mc.Refused, match="failed"):
        cloud(FailingEc2()).snapshot(record(), execute=True)


def test_a_snapshot_still_pending_after_the_wait_says_to_run_again() -> None:
    ec2 = FakeEc2()
    ec2.pending_reads = 10**9
    with pytest.raises(mc.Refused, match="run again later"):
        cloud(ec2).snapshot(record(), execute=True)


# ── clean-up ─────────────────────────────────────────────────────────────


def test_clean_up_dry_run_says_what_goes_and_changes_nothing() -> None:
    ec2, said = FakeEc2(), []
    ec2.add_snapshot()
    assert cloud(ec2, said).clean_up(cleaned(), execute=False) == []
    assert ec2.calls == []
    assert said == [
        f"would terminate instance {INSTANCE}",
        f"would delete disk {VOLUME}",
        f"would delete snapshot {SNAPSHOT}",
    ]


def test_clean_up_terminates_deletes_and_reads_each_back() -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    assert cloud(ec2).clean_up(cleaned(), execute=True) == []
    assert [call for call, _ in ec2.calls] == [
        "terminate_instances",
        "delete_volume",
        "delete_snapshot",
    ]
    assert ec2.instances[INSTANCE]["State"]["Name"] == "terminated"
    assert VOLUME not in ec2.volumes and SNAPSHOT not in ec2.snapshots


def test_clean_up_run_again_finds_everything_already_gone() -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    cloud(ec2).clean_up(cleaned(), execute=True)
    ec2.calls.clear()
    assert cloud(ec2).clean_up(cleaned(), execute=True) == []
    assert ec2.calls == []


def test_a_root_disk_that_stayed_is_reported_never_deleted() -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    ec2.root_deleted_on_termination = False
    assert cloud(ec2).clean_up(cleaned(), execute=True) == [ROOT]
    assert ROOT in ec2.volumes
    assert ("delete_volume", {"VolumeId": ROOT}) not in ec2.calls


@pytest.mark.parametrize("step", [None, "frozen", "held", "done", "rolled_back"])
def test_only_a_cleaned_move_is_cleaned_up(step: str | None) -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    with pytest.raises(mc.Refused, match="not cleaned"):
        cloud(ec2).clean_up(cleaned(step=step), execute=True)
    assert ec2.calls == []


@pytest.mark.parametrize(
    "done_at", [None, NOW - timedelta(days=6, hours=23), NOW + timedelta(days=1)]
)
def test_clean_up_refuses_inside_the_rollback_window_whatever_the_step_says(
    done_at: datetime | None,
) -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    with pytest.raises(mc.Refused, match="rollback window"):
        cloud(ec2).clean_up(cleaned(done_at=done_at), execute=True)
    assert ec2.calls == []


def test_one_wrong_resource_stops_the_clean_up_before_anything_is_deleted() -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot(Tags=snapshot_tags(machine=OTHER_MACHINE))
    with pytest.raises(mc.Refused, match="snapshot"):
        cloud(ec2).clean_up(cleaned(), execute=True)
    assert ec2.calls == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"VolumeId": "vol-0fedcba9876543210"},  # not of the recorded disk
        {"Encrypted": False},
        {"Tags": snapshot_tags(owner="k1.user.someone-else")},
        {"Tags": snapshot_tags()[:-1]},  # a tag missing
    ],
)
def test_a_snapshot_not_of_this_move_is_refused(overrides: dict[str, Any]) -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot(**overrides)
    with pytest.raises(mc.Refused):
        cloud(ec2).clean_up(cleaned(), execute=True)
    assert ec2.calls == []


def test_a_disk_of_another_machine_is_never_deleted() -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    ec2.volumes[VOLUME]["Tags"] = v1_tags("data", machine=OTHER_MACHINE)
    with pytest.raises(mc.Refused, match="v1 disk"):
        cloud(ec2).clean_up(cleaned(), execute=True)
    assert ec2.calls == []


def test_an_instance_started_again_is_not_terminated() -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    ec2.instances[INSTANCE]["State"] = {"Name": "running"}
    with pytest.raises(mc.Refused, match="started it again"):
        cloud(ec2).clean_up(cleaned(), execute=True)
    assert ec2.calls == []


# ── the command ──────────────────────────────────────────────────────────


def _arguments(tmp_path: Path, command: str, body: dict[str, Any], execute: bool):
    return argparse.Namespace(
        command=command,
        record=_record_file(tmp_path, body),
        installation_id=INSTALLATION,
        region=None,
        execute=execute,
    )


def test_the_command_prints_the_next_step(tmp_path: Path, capsys, monkeypatch) -> None:
    monkeypatch.setattr(mc, "POLL_SECONDS", 0)
    ec2 = FakeEc2()
    ec2.add_snapshot()
    assert mc.run(_arguments(tmp_path, "snapshot", _body(), True), ec2) == 0
    assert f"--snapshot-id {SNAPSHOT}" in capsys.readouterr().out


def test_the_clean_up_command_fails_on_a_leftover(tmp_path: Path, capsys) -> None:
    ec2 = FakeEc2()
    ec2.add_snapshot()
    ec2.root_deleted_on_termination = False
    done = datetime.now(UTC) - timedelta(days=8)
    body = _body(step="cleaned", snapshot_id=SNAPSHOT, done_at=done.isoformat())
    assert mc.run(_arguments(tmp_path, "clean-up", body, True), ec2) == 3
    assert ROOT in capsys.readouterr().out


def test_the_parser_requires_the_record_and_installation() -> None:
    with pytest.raises(SystemExit):
        mc.parser().parse_args(["snapshot", "--record", "r.json"])
    arguments = mc.parser().parse_args(
        ["clean-up", "--record", "r.json", "--installation-id", INSTALLATION]
    )
    assert not arguments.execute
