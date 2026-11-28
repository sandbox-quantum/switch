"""`switch-hosted-migration-cloud`: the two steps of a v1-to-v2 move that act
on the v1 machine's cloud resources, which Core can't reach.

Run on an operator's machine with the migration role's AWS credentials, from
Core's own record of the move (`switch-hosted-migration record PERSON`, saved
as a file):

- `snapshot --record FILE --installation-id ID [--execute]`: once the move is
  `frozen`, snapshot the v1 machine's data disk, tagged as this person's
  migration copy, wait until the snapshot is complete, read it back and print
  its id for `switch-hosted-migration run PERSON --snapshot-id`.
- `clean-up --record FILE --installation-id ID [--execute]`: once Core records
  the move `cleaned` (the rollback window has passed), terminate the v1
  instance, delete its data disk and the migration snapshot, and read back that
  each is gone.

Every command is a dry run unless `--execute` is given: it reads and checks
everything and says what it would do. Before touching a resource, its own EC2
tags must name this installation, this machine and what it is for, every tag
present and matching; anything else is refused, so a wrong record, a wrong
environment or another person's disk is never acted on. Nothing here shares a
snapshot or deletes an untagged resource. Output names resource ids only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import boto3

#: The v1 hosted controller's own tag value on what it made.
V1_MANAGED_BY = "switch-hosted-controller"
#: What this tool writes on the snapshot it makes.
MIGRATION_MANAGED_BY = "switch-hosted-migration"
MIGRATION_PURPOSE = "migration-copy"

TAG_INSTALLATION = "switch:installation-id"
TAG_MACHINE = "switch:machine-id"
TAG_PURPOSE = "switch:purpose"
TAG_MANAGED_BY = "switch:managed-by"
TAG_OWNER = "switch:owner-keyed-id"
TAG_SOURCE_VOLUME = "switch:source-volume-id"

SNAPSHOT_ID = re.compile(r"^snap-[0-9a-f]{8,17}$")
VOLUME_ID = re.compile(r"^vol-[0-9a-f]{8,17}$")
INSTANCE_ID = re.compile(r"^i-[0-9a-f]{8,17}$")
INSTALLATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
#: Keyed ids are `<version>.<kind>.<digest>`-like text: short and plain.
KEYED_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")

#: The record `switch-hosted-migration record` prints, and nothing else.
RECORD_KEYS = frozenset(
    {
        "machine_id",
        "owner_keyed_id",
        "step",
        "v1_instance_id",
        "v1_data_volume_id",
        "snapshot_id",
        "done_at",
    }
)
MAX_RECORD_BYTES = 4096

#: How long `snapshot` waits for EC2 to finish the snapshot, and between reads.
SNAPSHOT_WAIT_SECONDS = 4 * 3600
TERMINATE_WAIT_SECONDS = 15 * 60
POLL_SECONDS = 15


class Refused(Exception):
    """Refused before or instead of acting; the message is for the operator."""


@dataclass(frozen=True)
class Record:
    machine_id: str
    owner_keyed_id: str | None
    step: str | None
    v1_instance_id: str | None
    v1_data_volume_id: str | None
    snapshot_id: str | None


def read_record(path: Path) -> Record:
    """Core's record of the move, exactly as `record` prints it."""
    raw = path.read_bytes()
    if len(raw) > MAX_RECORD_BYTES:
        raise Refused("The record is too large to be Core's record.")
    try:
        body = json.loads(raw)
    except ValueError:
        raise Refused("The record isn't JSON.") from None
    if not isinstance(body, dict) or set(body) != RECORD_KEYS:
        raise Refused(f"The record must have exactly {sorted(RECORD_KEYS)}.")
    for key in RECORD_KEYS:
        if body[key] is not None and not isinstance(body[key], str):
            raise Refused(f"The record's {key} isn't text.")
    if not body["machine_id"]:
        raise Refused("The record names no machine: the person has no move.")
    checks: list[tuple[str, re.Pattern[str]]] = [
        ("v1_instance_id", INSTANCE_ID),
        ("v1_data_volume_id", VOLUME_ID),
        ("snapshot_id", SNAPSHOT_ID),
        ("owner_keyed_id", KEYED_ID),
    ]
    for key, pattern in checks:
        if body[key] is not None and not pattern.match(body[key]):
            raise Refused(f"The record's {key} isn't a valid id.")
    return Record(
        machine_id=body["machine_id"],
        owner_keyed_id=body["owner_keyed_id"],
        step=body["step"],
        v1_instance_id=body["v1_instance_id"],
        v1_data_volume_id=body["v1_data_volume_id"],
        snapshot_id=body["snapshot_id"],
    )


def _tags(resource: dict[str, Any]) -> dict[str, str]:
    return {tag["Key"]: tag["Value"] for tag in resource.get("Tags") or []}


def require_tags(resource: dict[str, Any], expected: dict[str, str], what: str) -> None:
    """Every expected tag present with exactly its value; missing is refused too."""
    tags = _tags(resource)
    for key, value in expected.items():
        if key not in tags:
            raise Refused(f"The {what} has no {key} tag; refusing to touch it.")
        if tags[key] != value:
            raise Refused(f"The {what}'s {key} tag doesn't match; refusing to touch it.")


def _error_code(error: Exception) -> str | None:
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        return (response.get("Error") or {}).get("Code")
    return None


class MigrationCloud:
    """The EC2 side of a move, for one installation. `ec2` is a boto3 EC2
    client (or a stand-in with the same calls)."""

    def __init__(
        self,
        ec2: Any,
        installation_id: str,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        say: Callable[[str], None] = print,
    ) -> None:
        if not INSTALLATION_ID.match(installation_id):
            raise Refused("--installation-id isn't a valid installation id.")
        self._ec2 = ec2
        self._installation = installation_id
        self._sleep = sleep
        self._clock = clock
        self._say = say

    # ── the tags each kind of resource must carry ───────────────────────

    def _v1_tags(self, record: Record, purpose: str) -> dict[str, str]:
        return {
            TAG_INSTALLATION: self._installation,
            TAG_MACHINE: record.machine_id,
            TAG_PURPOSE: purpose,
            TAG_MANAGED_BY: V1_MANAGED_BY,
        }

    def _snapshot_tags(self, record: Record) -> dict[str, str]:
        assert record.owner_keyed_id is not None and record.v1_data_volume_id is not None
        return {
            TAG_INSTALLATION: self._installation,
            TAG_MACHINE: record.machine_id,
            TAG_OWNER: record.owner_keyed_id,
            TAG_PURPOSE: MIGRATION_PURPOSE,
            TAG_MANAGED_BY: MIGRATION_MANAGED_BY,
            TAG_SOURCE_VOLUME: record.v1_data_volume_id,
        }

    # ── reads ────────────────────────────────────────────────────────────

    def _volume(self, volume_id: str) -> dict[str, Any] | None:
        try:
            volumes = self._ec2.describe_volumes(VolumeIds=[volume_id])["Volumes"]
        except Exception as error:
            if _error_code(error) == "InvalidVolume.NotFound":
                return None
            raise
        if len(volumes) != 1 or volumes[0].get("VolumeId") != volume_id:
            raise Refused("EC2 didn't answer for exactly the volume asked about.")
        return volumes[0]

    def _instance(self, instance_id: str) -> dict[str, Any] | None:
        try:
            reservations = self._ec2.describe_instances(InstanceIds=[instance_id])["Reservations"]
        except Exception as error:
            if _error_code(error) == "InvalidInstanceID.NotFound":
                return None
            raise
        instances = [i for r in reservations for i in r.get("Instances", [])]
        if len(instances) != 1 or instances[0].get("InstanceId") != instance_id:
            raise Refused("EC2 didn't answer for exactly the instance asked about.")
        return instances[0]

    def _snapshot(self, snapshot_id: str) -> dict[str, Any] | None:
        try:
            snapshots = self._ec2.describe_snapshots(SnapshotIds=[snapshot_id])["Snapshots"]
        except Exception as error:
            if _error_code(error) == "InvalidSnapshot.NotFound":
                return None
            raise
        if len(snapshots) != 1 or snapshots[0].get("SnapshotId") != snapshot_id:
            raise Refused("EC2 didn't answer for exactly the snapshot asked about.")
        return snapshots[0]

    def _migration_snapshots(self, record: Record) -> list[dict[str, Any]]:
        """Snapshots this tool already made for this machine's disk."""
        filters = [
            {"Name": f"tag:{key}", "Values": [value]}
            for key, value in self._snapshot_tags(record).items()
        ]
        filters.append({"Name": "volume-id", "Values": [record.v1_data_volume_id]})
        snapshots = self._ec2.describe_snapshots(OwnerIds=["self"], Filters=filters)["Snapshots"]
        return [s for s in snapshots if s.get("State") != "error"]

    def _check_snapshot(self, snapshot: dict[str, Any], record: Record) -> None:
        if snapshot.get("VolumeId") != record.v1_data_volume_id:
            raise Refused("The snapshot isn't of the v1 disk Core recorded; refusing.")
        if snapshot.get("Encrypted") is not True:
            raise Refused("The snapshot isn't encrypted; refusing.")
        require_tags(snapshot, self._snapshot_tags(record), "snapshot")

    def _not_shared(self, snapshot_id: str) -> None:
        permissions = self._ec2.describe_snapshot_attribute(
            SnapshotId=snapshot_id, Attribute="createVolumePermission"
        ).get("CreateVolumePermissions", [])
        if permissions:
            raise Refused(
                "The snapshot is shared with another account or the public; refusing. "
                "Remove the sharing and tell security."
            )

    # ── snapshot ─────────────────────────────────────────────────────────

    def snapshot(self, record: Record, *, execute: bool) -> str | None:
        """Snapshot the v1 disk while the move is frozen. Returns the snapshot
        id once it's complete and read back, or None on a dry run."""
        if record.step != "frozen":
            raise Refused(
                f"The move is at {record.step or 'not started'}, not frozen: snapshot "
                "only once the v1 machine has stopped for the move."
            )
        if record.snapshot_id is not None:
            raise Refused("Core already recorded a snapshot for this move.")
        if record.owner_keyed_id is None:
            raise Refused("The record has no keyed id for the person (Core has no keyed-id key).")
        if record.v1_data_volume_id is None or record.v1_instance_id is None:
            raise Refused("The record names no v1 disk or instance.")

        volume = self._volume(record.v1_data_volume_id)
        if volume is None:
            raise Refused("The v1 disk Core recorded doesn't exist.")
        require_tags(volume, self._v1_tags(record, "data"), "v1 disk")
        if volume.get("Encrypted") is not True:
            raise Refused("The v1 disk isn't encrypted; refusing.")
        instance = self._instance(record.v1_instance_id)
        if instance is None:
            raise Refused("The v1 instance Core recorded doesn't exist.")
        require_tags(instance, self._v1_tags(record, "worker"), "v1 instance")
        if (instance.get("State") or {}).get("Name") != "stopped":
            raise Refused("The v1 instance isn't stopped; the disk could be changing.")

        existing = self._migration_snapshots(record)
        if len(existing) > 1:
            raise Refused(
                "More than one migration snapshot exists for this disk: "
                + ", ".join(s["SnapshotId"] for s in existing)
                + ". Keep one, delete the others, and run again."
            )
        if not execute:
            if existing:
                self._say(f"would wait for the existing snapshot {existing[0]['SnapshotId']}")
            else:
                self._say(
                    f"would snapshot {record.v1_data_volume_id} of machine "
                    f"{record.machine_id}, tagged {MIGRATION_PURPOSE}"
                )
            return None

        if existing:
            snapshot_id = existing[0]["SnapshotId"]
            self._say(f"carrying on with the existing snapshot {snapshot_id}")
        else:
            created = self._ec2.create_snapshot(
                VolumeId=record.v1_data_volume_id,
                Description="Switch hosted agents: v1 to v2 migration copy",
                TagSpecifications=[
                    {
                        "ResourceType": "snapshot",
                        "Tags": [
                            {"Key": key, "Value": value}
                            for key, value in self._snapshot_tags(record).items()
                        ],
                    }
                ],
            )
            snapshot_id = created["SnapshotId"]
            if not SNAPSHOT_ID.match(snapshot_id):
                raise Refused("EC2 returned something that isn't a snapshot id.")
            self._say(f"started snapshot {snapshot_id}")

        deadline = self._clock() + SNAPSHOT_WAIT_SECONDS
        while True:
            snapshot = self._snapshot(snapshot_id)
            if snapshot is None:
                raise Refused(f"The snapshot {snapshot_id} disappeared while it was made.")
            self._check_snapshot(snapshot, record)
            state = snapshot.get("State")
            if state == "completed":
                break
            if state == "error":
                raise Refused(f"EC2 failed the snapshot {snapshot_id}. Delete it and run again.")
            if self._clock() > deadline:
                raise Refused(
                    f"The snapshot {snapshot_id} isn't complete after the wait; run "
                    "again later, it carries on with the same snapshot."
                )
            self._say(f"snapshot {snapshot_id}: {state}, {snapshot.get('Progress', '?')}")
            self._sleep(POLL_SECONDS)
        self._not_shared(snapshot_id)
        self._say(f"snapshot {snapshot_id} is complete and read back")
        return snapshot_id

    # ── clean-up ─────────────────────────────────────────────────────────

    def clean_up(self, record: Record, *, execute: bool) -> list[str]:
        """After Core records the move `cleaned`: terminate the v1 instance,
        delete its data disk and the migration snapshot, each read back as gone.
        Returns what's left over that it wouldn't delete (none if clean)."""
        if record.step != "cleaned":
            raise Refused(
                f"The move is at {record.step or 'not started'}, not cleaned: the v1 "
                "resources stay until Core records the clean-up."
            )
        if record.v1_instance_id is None or record.v1_data_volume_id is None:
            raise Refused("The record names no v1 disk or instance.")
        if record.snapshot_id is None:
            raise Refused("The record names no snapshot.")
        if record.owner_keyed_id is None:
            raise Refused("The record has no keyed id for the person (Core has no keyed-id key).")

        # Check every resource before deleting any of them.
        instance = self._instance(record.v1_instance_id)
        instance_state = None
        other_volumes: list[str] = []
        if instance is not None:
            require_tags(instance, self._v1_tags(record, "worker"), "v1 instance")
            instance_state = (instance.get("State") or {}).get("Name")
            if instance_state not in ("stopped", "terminated", "shutting-down"):
                raise Refused(
                    f"The v1 instance is {instance_state}, not stopped: something "
                    "started it again. Refusing."
                )
            for mapping in instance.get("BlockDeviceMappings") or []:
                volume_id = (mapping.get("Ebs") or {}).get("VolumeId")
                if volume_id and volume_id != record.v1_data_volume_id:
                    other_volumes.append(volume_id)
        volume = self._volume(record.v1_data_volume_id)
        if volume is not None:
            require_tags(volume, self._v1_tags(record, "data"), "v1 disk")
        snapshot = self._snapshot(record.snapshot_id)
        if snapshot is not None:
            self._check_snapshot(snapshot, record)

        plan = [
            (
                f"terminate instance {record.v1_instance_id}"
                if instance is not None and instance_state != "terminated"
                else f"instance {record.v1_instance_id}: already gone"
            ),
            (
                f"delete disk {record.v1_data_volume_id}"
                if volume is not None
                else f"disk {record.v1_data_volume_id}: already gone"
            ),
            (
                f"delete snapshot {record.snapshot_id}"
                if snapshot is not None
                else f"snapshot {record.snapshot_id}: already gone"
            ),
        ]
        if not execute:
            for line in plan:
                self._say(f"would {line}" if "already gone" not in line else line)
            return []

        if instance is not None and instance_state != "terminated":
            self._ec2.terminate_instances(InstanceIds=[record.v1_instance_id])
            self._wait_terminated(record.v1_instance_id)
        self._say(f"instance {record.v1_instance_id}: terminated (read back)")

        if volume is not None:
            self._wait_detached(record.v1_data_volume_id)
            self._ec2.delete_volume(VolumeId=record.v1_data_volume_id)
            if not self._deleting(record.v1_data_volume_id):
                raise Refused(f"The disk {record.v1_data_volume_id} is still there.")
        self._say(f"disk {record.v1_data_volume_id}: deleted (read back)")

        if snapshot is not None:
            self._ec2.delete_snapshot(SnapshotId=record.snapshot_id)
            if self._snapshot(record.snapshot_id) is not None:
                raise Refused(f"The snapshot {record.snapshot_id} is still there.")
        self._say(f"snapshot {record.snapshot_id}: deleted (read back)")

        # The instance's other disks (its root) go with it when EC2 says so;
        # one that stayed is reported, never deleted here: it isn't tagged ours.
        leftovers = []
        for volume_id in other_volumes:
            left = self._volume(volume_id)
            if left is not None and left.get("State") not in ("deleting", "deleted"):
                leftovers.append(volume_id)
        return leftovers

    def _deleting(self, volume_id: str) -> bool:
        volume = self._volume(volume_id)
        return volume is None or volume.get("State") in ("deleting", "deleted")

    def _wait_terminated(self, instance_id: str) -> None:
        deadline = self._clock() + TERMINATE_WAIT_SECONDS
        while True:
            instance = self._instance(instance_id)
            if instance is None or (instance.get("State") or {}).get("Name") == "terminated":
                return
            if self._clock() > deadline:
                raise Refused(
                    f"The instance {instance_id} hasn't terminated after the wait; "
                    "run again, nothing else was deleted."
                )
            self._sleep(POLL_SECONDS)

    def _wait_detached(self, volume_id: str) -> None:
        deadline = self._clock() + TERMINATE_WAIT_SECONDS
        while True:
            volume = self._volume(volume_id)
            if volume is None or volume.get("State") == "available":
                return
            if self._clock() > deadline:
                raise Refused(f"The disk {volume_id} is still attached after the wait; run again.")
            self._sleep(POLL_SECONDS)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="switch-hosted-migration-cloud")
    commands = result.add_subparsers(dest="command", required=True)
    for name in ("snapshot", "clean-up"):
        command = commands.add_parser(name)
        command.add_argument("--record", required=True, type=Path)
        command.add_argument("--installation-id", required=True)
        command.add_argument("--region")
        command.add_argument("--execute", action="store_true")
    return result


def run(arguments: argparse.Namespace, ec2: Any) -> int:
    record = read_record(arguments.record)
    cloud = MigrationCloud(ec2, arguments.installation_id)
    execute = bool(arguments.execute)
    if arguments.command == "snapshot":
        snapshot_id = cloud.snapshot(record, execute=execute)
        if snapshot_id is None:
            print("dry run (pass --execute)")
        else:
            print(f"next: switch-hosted-migration run PERSON --snapshot-id {snapshot_id}")
        return 0
    leftovers = cloud.clean_up(record, execute=execute)
    if not execute:
        print("dry run (pass --execute)")
        return 0
    if leftovers:
        print(
            "done, but these volumes of the instance are still there and aren't tagged "
            "for this tool to delete: " + ", ".join(leftovers)
        )
        return 3
    print("done: every v1 resource of this move is gone")
    return 0


def main() -> None:
    arguments = parser().parse_args()
    ec2 = boto3.client("ec2", region_name=arguments.region)
    try:
        code = run(arguments, ec2)
    except Refused as refused:
        print(f"refused: {refused}", file=sys.stderr)
        code = 2
    raise SystemExit(code)
