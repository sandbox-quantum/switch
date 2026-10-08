from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import boto3
import pytest
from botocore.stub import Stubber

from switch_hosted_controller.cloud import CloudCapacityError, CloudResourceError, Ec2Cloud
from switch_hosted_controller.config import ConfigError, ControllerConfig
from switch_hosted_controller.model import DesiredState, Machine, ObservedState
from switch_hosted_controller.reconciler import Reconciler
from switch_hosted_controller.store import CapacityError, MachineStore, SlotInUseError, StoreError

MACHINE_ID = "3f1c2b4a-0000-4000-8000-000000000001"


WORKER_TESTDATA = Path(__file__).parents[2] / "worker" / "testdata"
CORE_FIXTURES = (
    Path(__file__).parents[4] / "core" / "tests" / "switch_core" / "fixtures" / "hosted_machines"
)
FIXTURE_SECRET_ARN = (
    "arn:aws:secretsmanager:us-east-1:000000000000:secret:switch-hosted/inst-test/slot-a"
)


def config(tmp_path: Path, *, max_machines: int = 1) -> ControllerConfig:
    return ControllerConfig.from_dict(config_dict(tmp_path, max_machines=max_machines))


def fixture_config(tmp_path: Path, instance_type: str) -> ControllerConfig:
    """The installation of the cross-stream fixtures: inst-test with the one slot slot-a."""
    raw = config_dict(tmp_path, max_machines=1)
    raw["installation_id"] = "inst-test"
    raw["allowed_instance_types"] = [instance_type]
    raw["machine_slots"] = {
        "slot-a": {
            "instance_profile_arn": "arn:aws:iam::000000000000:instance-profile/slot-a",
            "assignment_secret_arn": FIXTURE_SECRET_ARN,
        }
    }
    return ControllerConfig.from_dict(raw)


def fixture_machine(
    tmp_path: Path, instance_type: str
) -> tuple[ControllerConfig, MachineStore, Machine]:
    """The machine Core lists in its fixture, with its volume."""
    [listed] = json.loads((CORE_FIXTURES / "machines_response.json").read_text())["machines"]
    cfg = fixture_config(tmp_path, instance_type)
    store = MachineStore(cfg.state_db_path, cfg.fingerprint())
    slot = cfg.slot(listed["slot_id"])
    store.insert(
        machine_id=listed["machine_id"],
        slot_id=listed["slot_id"],
        generation=listed["generation"],
        core_revision=listed["revision"],
        instance_type=instance_type,
        image_id=cfg.image_id,
        assignment_secret_arn=slot.assignment_secret_arn,
        instance_profile_arn=slot.instance_profile_arn,
        max_machines=cfg.max_machines,
    )
    machine = store.record_volume(
        listed["machine_id"], listed["data_volume_id"], cfg.availability_zone
    )
    return cfg, store, machine


def config_dict(tmp_path: Path, *, max_machines: int) -> dict:
    slots = {
        f"slot-{number}": {
            "instance_profile_arn": f"arn:aws:iam::123456789012:instance-profile/worker-{number}",
            "assignment_secret_arn": f"arn:aws:secretsmanager:us-east-1:123456789012:secret:slot-{number}",
        }
        for number in range(1, max_machines + 1)
    }
    return {
        "installation_id": "test-installation",
        "region": "us-east-1",
        "availability_zone": "us-east-1a",
        "subnet_id": "subnet-0123456789abcdef0",
        "security_group_ids": ["sg-0123456789abcdef0"],
        "image_id": "ami-0123456789abcdef0",
        "root_device_name": "/dev/xvda",
        "allowed_instance_types": ["m6i.large"],
        "max_machines": max_machines,
        "root_volume_gib": 20,
        "data_volume_gib": 40,
        "machine_slots": slots,
        "state_db_path": str(tmp_path / "state.db"),
        "lock_path": str(tmp_path / "controller.lock"),
        "poll_interval_seconds": 1,
    }


def insert_machine(
    store: MachineStore, cfg: ControllerConfig, slot_id: str, generation: int, machine_id: str
) -> Machine:
    slot = cfg.slot(slot_id)
    return store.insert(
        machine_id=machine_id,
        slot_id=slot_id,
        generation=generation,
        core_revision=1,
        instance_type="m6i.large",
        image_id=cfg.image_id,
        assignment_secret_arn=slot.assignment_secret_arn,
        instance_profile_arn=slot.instance_profile_arn,
        max_machines=cfg.max_machines,
    )


def store_and_machine(cfg: ControllerConfig) -> tuple[MachineStore, Machine]:
    store = MachineStore(cfg.state_db_path, cfg.fingerprint())
    return store, insert_machine(store, cfg, "slot-1", 1, MACHINE_ID)


def ec2_client():
    return boto3.client(
        "ec2",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        aws_session_token="test",
    )


def volume(cfg: ControllerConfig, machine, *, state: str = "available", attachments=None):
    return {
        "VolumeId": "vol-0123456789abcdef0",
        "AvailabilityZone": cfg.availability_zone,
        "Encrypted": True,
        "KmsKeyId": "arn:aws:kms:us-east-1:123456789012:key/example",
        "Size": cfg.data_volume_gib,
        "VolumeType": "gp3",
        "Iops": 3000,
        "Throughput": 125,
        "State": state,
        "Attachments": attachments or [],
        "Tags": Ec2Cloud(ec2_client(), cfg)._tags(machine, "data"),
    }


def instance(cfg: ControllerConfig, machine, state: str):
    return {
        "InstanceId": "i-0123456789abcdef0",
        "ImageId": cfg.image_id,
        "InstanceType": machine.instance_type,
        "State": {"Name": state, "Code": 16 if state == "running" else 80},
        "IamInstanceProfile": {"Arn": machine.instance_profile_arn, "Id": "AIPAEXAMPLE"},
        "Placement": {"AvailabilityZone": cfg.availability_zone},
        "SubnetId": cfg.subnet_id,
        "SecurityGroups": [{"GroupId": cfg.security_group_ids[0], "GroupName": "worker"}],
        "NetworkInterfaces": [
            {
                "NetworkInterfaceId": "eni-0123456789abcdef0",
                "SubnetId": cfg.subnet_id,
                "Groups": [{"GroupId": cfg.security_group_ids[0], "GroupName": "worker"}],
                "Attachment": {"DeviceIndex": 0, "DeleteOnTermination": True},
            }
        ],
        "MetadataOptions": {
            "State": "applied",
            "HttpEndpoint": "enabled",
            "HttpTokens": "required",
            "HttpPutResponseHopLimit": 1,
            "InstanceMetadataTags": "disabled",
        },
        "Tags": Ec2Cloud(ec2_client(), cfg)._tags(machine, "worker"),
    }


def test_store_persists_intent_and_rejects_changed_deployment(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.mark_volume_create_intent(machine)
    store.mark_instance_launch_intent(machine)
    store.close()

    restarted = MachineStore(cfg.state_db_path, cfg.fingerprint())
    assert restarted.get(MACHINE_ID).volume_create_intent
    assert restarted.get(MACHINE_ID).instance_launch_intent
    restarted.close()

    changed = replace(cfg, installation_id="different-installation")
    with pytest.raises(StoreError, match="immutable configuration"):
        MachineStore(cfg.state_db_path, changed.fingerprint())


def test_capacity_counts_machines_not_deleted(tmp_path: Path):
    cfg = config(tmp_path, max_machines=2)
    store, first = store_and_machine(cfg)
    second_id = "3f1c2b4a-0000-4000-8000-000000000002"
    second = insert_machine(store, cfg, "slot-2", 1, second_id)
    with pytest.raises(CapacityError):
        store.insert(
            machine_id="3f1c2b4a-0000-4000-8000-000000000003",
            slot_id="slot-3",
            generation=1,
            core_revision=1,
            instance_type="m6i.large",
            image_id=cfg.image_id,
            assignment_secret_arn="arn:aws:secretsmanager:us-east-1:123456789012:secret:other",
            instance_profile_arn="arn:aws:iam::123456789012:instance-profile/other",
            max_machines=2,
        )
    second = store.set_desired(second.machine_id, DesiredState.STOPPED, None)
    second = store.set_observed(second, ObservedState.STOPPED, None)
    store.set_desired(second.machine_id, DesiredState.DELETED, None)
    third = store.insert(
        machine_id="3f1c2b4a-0000-4000-8000-000000000003",
        slot_id="slot-3",
        generation=1,
        core_revision=1,
        instance_type="m6i.large",
        image_id=cfg.image_id,
        assignment_secret_arn="arn:aws:secretsmanager:us-east-1:123456789012:secret:other",
        instance_profile_arn="arn:aws:iam::123456789012:instance-profile/other",
        max_machines=2,
    )
    assert [machine.machine_id for machine in store.list()] == [
        first.machine_id,
        second_id,
        third.machine_id,
    ]
    store.close()


def test_slot_reuse_needs_a_newer_generation_after_the_old_one_is_deleted(tmp_path: Path):
    cfg = config(tmp_path)
    store, old = store_and_machine(cfg)
    reuse_id = "3f1c2b4a-0000-4000-8000-000000000002"
    old = store.set_desired(old.machine_id, DesiredState.STOPPED, None)
    old = store.set_observed(old, ObservedState.STOPPED, None)
    old = store.set_desired(old.machine_id, DesiredState.DELETED, None)
    with pytest.raises(SlotInUseError, match="generation 1"):
        insert_machine(store, cfg, "slot-1", 2, reuse_id)
    store.set_observed(old, ObservedState.DELETED, None)
    with pytest.raises(StoreError, match="not newer"):
        insert_machine(store, cfg, "slot-1", 1, reuse_id)
    with pytest.raises(StoreError, match="already exists"):
        insert_machine(store, cfg, "slot-1", 2, old.machine_id)
    assert store.next_generation("slot-1") == 2
    reused = insert_machine(store, cfg, "slot-1", 2, reuse_id)
    assert store.latest("slot-1") == reused
    assert store.find("slot-1", 1).machine_id == old.machine_id
    cloud = Ec2Cloud(ec2_client(), cfg)
    assert cloud._token(old, "data-volume") != cloud._token(reused, "data-volume")
    store.close()


def test_deleted_machine_keeps_the_latest_retention_deadline(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    with pytest.raises(StoreError, match="freshly observed"):
        store.set_desired(machine.machine_id, DesiredState.DELETED, None)
    machine = store.set_observed(machine, ObservedState.RETAINED, None)
    later = datetime(2026, 1, 8, tzinfo=UTC)
    earlier = datetime(2026, 1, 1, tzinfo=UTC)
    machine = store.set_desired(machine.machine_id, DesiredState.DELETED, later)
    assert (
        store.set_desired(machine.machine_id, DesiredState.DELETED, earlier).retain_until == later
    )
    assert store.set_desired(machine.machine_id, DesiredState.DELETED, None).retain_until == later
    with pytest.raises(StoreError, match="cannot be restarted"):
        store.set_desired(machine.machine_id, DesiredState.RUNNING, None)
    store.close()


def test_retained_release_starts_the_next_instance_sequence(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    store.record_volume(machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    machine = store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    with pytest.raises(StoreError, match="terminated"):
        store.release_terminated(machine)
    machine = store.mark_instance_terminal_observed(machine.machine_id, machine.instance_id)
    released = store.release_terminated(machine)
    assert released.instance_id is None
    assert released.previous_instance_id == "i-0123456789abcdef0"
    assert released.data_volume_id == "vol-0123456789abcdef0"
    assert released.instance_seq == machine.instance_seq + 1
    assert released.recovery_count == 0
    store.close()


def test_uncertain_launch_then_stop_waits_for_late_instance(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.mark_volume_create_intent(machine)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
    machine = store.mark_instance_launch_intent(machine)
    store.mark_instance_launch_issued(machine, datetime.now(UTC))
    store.set_desired(machine.machine_id, DesiredState.STOPPED, None)

    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    filters = cloud._resource_filters(machine, "worker")
    worker = instance(cfg, store.get(machine.machine_id), "running")
    stopped_worker = {**worker, "State": {"Name": "stopped", "Code": 80}}
    with Stubber(client) as stubber:
        stubber.add_response("describe_instances", {"Reservations": []}, {"Filters": filters})
        stubber.add_response(
            "describe_instances", {"Reservations": [{"Instances": [worker]}]}, {"Filters": filters}
        )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [worker]}]},
            {"InstanceIds": [worker["InstanceId"]]},
        )
        stubber.add_response(
            "stop_instances",
            {"StoppingInstances": []},
            {"InstanceIds": [worker["InstanceId"]], "Force": False},
        )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [stopped_worker]}]},
            {"InstanceIds": [worker["InstanceId"]]},
        )

        reconciler = Reconciler(store, cloud)
        assert (
            reconciler.reconcile(machine.machine_id).observed_state is ObservedState.NEEDS_ATTENTION
        )
        adopted = reconciler.reconcile(machine.machine_id)
        assert adopted.instance_id == worker["InstanceId"]
        assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.STOPPING
        assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.STOPPED
    store.close()


def test_cloud_capacity_counts_all_pages(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    expected_filters = [
        {"Name": "tag:switch:installation-id", "Values": [cfg.installation_id]},
        {"Name": "tag:switch:managed-by", "Values": ["switch-hosted-controller"]},
        {
            "Name": "instance-state-name",
            "Values": ["pending", "running", "stopping", "stopped", "shutting-down"],
        },
    ]
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [], "NextToken": "page-2"},
            {"Filters": expected_filters},
        )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [{"InstanceId": "i-foreign"}]}]},
            {"Filters": expected_filters, "NextToken": "page-2"},
        )
        with pytest.raises(CloudCapacityError):
            cloud.validate_capacity()
    store.close()


def test_foreign_recorded_instance_fails_closed(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    foreign = instance(cfg, machine, "running")
    foreign["Tags"] = [
        {"Key": "switch:installation-id", "Value": "other-installation"},
        {"Key": "switch:slot-id", "Value": machine.slot_id},
    ]
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [foreign]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        with pytest.raises(CloudResourceError, match="ownership tag"):
            Ec2Cloud(client, cfg).get_instance(machine)
    store.close()


def test_stop_and_start_use_only_recorded_instance(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "stop_instances",
            {"StoppingInstances": []},
            {"InstanceIds": [machine.instance_id], "Force": False},
        )
        stubber.add_response(
            "start_instances", {"StartingInstances": []}, {"InstanceIds": [machine.instance_id]}
        )
        cloud = Ec2Cloud(client, cfg)
        cloud.stop_instance(machine)
        cloud.start_instance(machine)
    store.close()


def test_config_rejects_duplicate_assignment_credentials(tmp_path: Path):
    cfg = config(tmp_path, max_machines=2)
    raw = {
        **cfg.__dict__,
        "security_group_ids": list(cfg.security_group_ids),
        "allowed_instance_types": list(cfg.allowed_instance_types),
        "state_db_path": str(cfg.state_db_path),
        "lock_path": str(cfg.lock_path),
        "machine_slots": {
            slot_id: {
                "instance_profile_arn": slot.instance_profile_arn,
                "assignment_secret_arn": cfg.slot("slot-1").assignment_secret_arn,
            }
            for slot_id, slot in cfg.machine_slots.items()
        },
    }
    with pytest.raises(ConfigError, match="secrets must be unique"):
        ControllerConfig.from_dict(raw)


def test_recovery_requires_terminated_predecessor_and_retains_disk(tmp_path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    store.record_volume(machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    with pytest.raises(StoreError, match="terminated"):
        store.replace_terminated(machine, unexpected=True)
    machine = store.mark_instance_terminal_observed(machine.machine_id, machine.instance_id)
    replacement = store.replace_terminated(machine, unexpected=True)
    assert replacement.instance_id is None
    assert replacement.previous_instance_id == "i-0123456789abcdef0"
    assert replacement.data_volume_id == "vol-0123456789abcdef0"
    assert replacement.recovery_count == 1
    assert replacement.instance_seq == 1
    assert not replacement.instance_launch_issued
    cloud = Ec2Cloud(ec2_client(), cfg)
    assert cloud._token(machine, "instance-0") != cloud._token(replacement, "instance-1")
    for index in range(2, 5):
        current = store.record_instance(machine.machine_id, f"i-{index:017x}")
        current = store.mark_instance_terminal_observed(machine.machine_id, current.instance_id)
        if index == 4:
            with pytest.raises(StoreError, match="limit"):
                store.replace_terminated(current, unexpected=True)
        else:
            store.replace_terminated(current, unexpected=True)
    store.close()


def legacy_database(path: Path, rows: list[tuple[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, desired_state TEXT, observed_state TEXT)"
    )
    connection.executemany(
        "INSERT INTO agents VALUES (?, ?, ?)",
        [(f"agent-{index}", *row) for index, row in enumerate(rows)],
    )
    connection.commit()
    connection.close()


@pytest.mark.parametrize(
    "row", [("running", "running"), ("deleted", "deleting"), ("stopped", "deleted")]
)
def test_store_refuses_live_legacy_agent_rows(tmp_path, row):
    cfg = config(tmp_path)
    legacy_database(cfg.state_db_path, [("deleted", "deleted"), row])
    with pytest.raises(StoreError) as raised:
        MachineStore(cfg.state_db_path, cfg.fingerprint())
    assert str(raised.value) == (
        "legacy per-agent rows present; see 'Moving to one machine per user' in deploy/hosted/README.md"
    )


def test_store_opens_beside_deleted_legacy_rows_and_keeps_them(tmp_path):
    cfg = config(tmp_path)
    legacy_database(cfg.state_db_path, [("deleted", "deleted"), ("deleted", "deleted")])
    store, machine = store_and_machine(cfg)
    assert machine.generation == 1
    store.close()
    connection = sqlite3.connect(cfg.state_db_path)
    assert connection.execute("SELECT COUNT(*) FROM agents").fetchone()[0] == 2
    connection.close()


def test_capacity_and_image_can_change_but_placement_cannot(tmp_path):
    cfg = config(tmp_path)
    MachineStore(cfg.state_db_path, cfg.fingerprint()).close()
    expanded = config(tmp_path, max_machines=2)
    current = MachineStore(expanded.state_db_path, expanded.fingerprint())
    current.close()
    new_image = replace(expanded, image_id="ami-11111111111111111")
    MachineStore(new_image.state_db_path, new_image.fingerprint()).close()
    incompatible = replace(expanded, subnet_id="subnet-11111111111111111")
    with pytest.raises(StoreError, match="immutable"):
        MachineStore(incompatible.state_db_path, incompatible.fingerprint())


def test_image_upgrade_requires_stopped_terminal_claim_and_preserves_disk(tmp_path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    store.record_volume(machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    with pytest.raises(StoreError, match="stopped"):
        store.upgrade_terminated(machine, "ami-11111111111111111", "sha256:" + "a" * 64)
    machine = store.set_desired(machine.machine_id, DesiredState.STOPPED, None)
    with pytest.raises(StoreError, match="terminated"):
        store.upgrade_terminated(machine, "ami-11111111111111111", "sha256:" + "a" * 64)
    machine = store.mark_instance_terminal_observed(machine.machine_id, machine.instance_id)
    upgraded = store.upgrade_terminated(machine, "ami-11111111111111111", "sha256:" + "a" * 64)
    assert upgraded.instance_id is None
    assert upgraded.previous_instance_id == machine.instance_id
    assert upgraded.data_volume_id == machine.data_volume_id
    assert upgraded.previous_runtime_fingerprint == "sha256:" + "a" * 64
    assert upgraded.desired_state is DesiredState.STOPPED
    assert upgraded.image_id != machine.image_id
    with pytest.raises(StoreError, match="changed"):
        store.upgrade_terminated(machine, "ami-11111111111111111", "sha256:" + "a" * 64)
    store.close()


@pytest.mark.parametrize("desired", [DesiredState.RUNNING, DesiredState.STOPPED])
def test_terminating_worker_waits_without_profile_or_replacement(tmp_path, desired):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    machine = store.set_desired(machine.machine_id, desired, None)
    worker = instance(cfg, machine, "shutting-down")
    worker.pop("IamInstanceProfile")
    worker.pop("NetworkInterfaces")
    client = ec2_client()
    with Stubber(client) as stubber:
        if desired is DesiredState.RUNNING:
            stubber.add_response(
                "describe_volumes",
                {"Volumes": [volume(cfg, machine)]},
                {"VolumeIds": [machine.data_volume_id]},
            )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [worker]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        result = Reconciler(store, Ec2Cloud(client, cfg)).reconcile(machine.machine_id)
        expected = (
            ObservedState.PROVISIONING
            if desired is DesiredState.RUNNING
            else ObservedState.STOPPING
        )
        assert result.observed_state is expected
        assert result.instance_id == machine.instance_id
        assert result.error is None
        stubber.assert_no_pending_responses()
    store.close()
