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
from switch_hosted_controller.reconciler import Reconciler, needs_new_user_data
from switch_hosted_controller.store import (
    SLOT_ROWS_MESSAGE,
    CapacityError,
    MachineStore,
    StoreError,
)

MACHINE_ID = "3f1c2b4a-0000-4000-8000-000000000001"
INSTANCE_PROFILE_ARN = "arn:aws:iam::123456789012:instance-profile/switch-machine"


CORE_FIXTURES = (
    Path(__file__).parents[4] / "core" / "tests" / "switch_core" / "fixtures" / "hosted_machines"
)


def config(tmp_path: Path, *, max_machines: int = 1) -> ControllerConfig:
    return ControllerConfig.from_dict(config_dict(tmp_path, max_machines=max_machines))


def fixture_config(tmp_path: Path, instance_type: str) -> ControllerConfig:
    """The installation of the cross-stream fixtures: inst-test, with room for one machine."""
    raw = config_dict(tmp_path, max_machines=1)
    raw["installation_id"] = "inst-test"
    raw["allowed_instance_types"] = [instance_type]
    raw["instance_profile_arn"] = "arn:aws:iam::000000000000:instance-profile/switch-machine"
    return ControllerConfig.from_dict(raw)


def config_dict(tmp_path: Path, *, max_machines: int) -> dict:
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
        "instance_profile_arn": INSTANCE_PROFILE_ARN,
        "state_db_path": str(tmp_path / "state.db"),
        "lock_path": str(tmp_path / "controller.lock"),
        "poll_interval_seconds": 1,
    }


def insert_machine(store: MachineStore, cfg: ControllerConfig, machine_id: str) -> Machine:
    return store.insert(
        machine_id=machine_id,
        core_revision=1,
        instance_type="m6i.large",
        image_id=cfg.image_id,
        max_machines=cfg.max_machines,
    )


def bundle_json(machine_id: str, enrollment_code: str) -> str:
    return json.dumps(
        {
            "version": 4,
            "installationId": "test-installation",
            "machineId": machine_id,
            "dataVolumeId": "vol-0123456789abcdef0",
            "apiEndpoint": "https://switch.example.test/agent-api",
            "controller": {"id": None, "enrollmentCode": enrollment_code},
        },
        separators=(",", ":"),
    )


def with_bundle(store: MachineStore, machine_id: str, revision: int) -> Machine:
    token = f"bundle-{revision}"
    store.require_bundle(machine_id, revision, token)
    return store.record_bundle(
        machine_id, token, bundle_json(machine_id, f"swce_SyntheticCodeRevision{revision:04d}")
    )


def store_and_machine(cfg: ControllerConfig) -> tuple[MachineStore, Machine]:
    store = MachineStore(cfg.state_db_path, cfg.fingerprint())
    return store, insert_machine(store, cfg, MACHINE_ID)


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
        "IamInstanceProfile": {"Arn": cfg.instance_profile_arn, "Id": "AIPAEXAMPLE"},
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
    third_id = "3f1c2b4a-0000-4000-8000-000000000003"
    second = insert_machine(store, cfg, second_id)
    with pytest.raises(CapacityError):
        insert_machine(store, cfg, third_id)
    assert store.find(third_id) is None
    second = store.set_desired(second.machine_id, DesiredState.STOPPED, None)
    second = store.set_observed(second, ObservedState.STOPPED, None)
    store.set_desired(second.machine_id, DesiredState.DELETED, None)
    third = insert_machine(store, cfg, third_id)
    assert [machine.machine_id for machine in store.list()] == [
        first.machine_id,
        second_id,
        third.machine_id,
    ]
    store.close()


def test_machines_are_keyed_by_machine_id(tmp_path: Path):
    cfg = config(tmp_path, max_machines=2)
    store, machine = store_and_machine(cfg)
    other_id = "3f1c2b4a-0000-4000-8000-000000000002"
    assert store.find(MACHINE_ID) == machine
    assert store.find(other_id) is None
    machine = store.set_desired(machine.machine_id, DesiredState.STOPPED, None)
    machine = store.set_observed(machine, ObservedState.STOPPED, None)
    machine = store.set_desired(machine.machine_id, DesiredState.DELETED, None)
    store.set_observed(machine, ObservedState.DELETED, None)
    with pytest.raises(StoreError, match="already exists"):
        insert_machine(store, cfg, MACHINE_ID)
    other = insert_machine(store, cfg, other_id)
    assert store.find(other_id) == other
    cloud = Ec2Cloud(ec2_client(), cfg)
    assert cloud._token(machine, "data-volume") != cloud._token(other, "data-volume")
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
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", "bundle-1")
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
    assert machine.instance_bundle == "bundle-1"
    assert released.instance_bundle is None
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
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", None)
    foreign = instance(cfg, machine, "running")
    foreign["Tags"] = [
        {"Key": "switch:installation-id", "Value": "other-installation"},
        {"Key": "switch:machine-id", "Value": machine.machine_id},
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
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", None)
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


REVISION_1_BUNDLE = bundle_json(MACHINE_ID, "swce_SyntheticCodeRevision0001")
REVISION_2_BUNDLE = bundle_json(MACHINE_ID, "swce_SyntheticCodeRevision0002")


def stopped_instance_with_bundle(cfg: ControllerConfig, instance_bundle: str | None):
    store, machine = store_and_machine(cfg)
    store.record_volume(machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone)
    store.record_instance(machine.machine_id, "i-0123456789abcdef0", instance_bundle)
    return store, with_bundle(store, machine.machine_id, 2)


@pytest.mark.parametrize("instance_bundle", [REVISION_1_BUNDLE, None])
def test_an_instance_with_a_stale_bundle_makes_way_for_one_launched_with_the_new_one(
    tmp_path: Path, instance_bundle
):
    cfg = config(tmp_path)
    store, machine = stopped_instance_with_bundle(cfg, instance_bundle)
    attachment = {"InstanceId": machine.instance_id, "Device": "/dev/sdf", "State": "attached"}
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_volumes",
            {"Volumes": [volume(cfg, machine, state="in-use", attachments=[attachment])]},
            {"VolumeIds": [machine.data_volume_id]},
        )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [instance(cfg, machine, "stopped")]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        stubber.add_response(
            "terminate_instances",
            {"TerminatingInstances": []},
            {"InstanceIds": [machine.instance_id]},
        )
        result = Reconciler(store, Ec2Cloud(client, cfg)).reconcile(machine.machine_id)
        stubber.assert_no_pending_responses()
    assert result.observed_state is ObservedState.PROVISIONING
    assert result.instance_terminate_issued
    assert result.instance_id == "i-0123456789abcdef0"
    assert result.data_volume_id == "vol-0123456789abcdef0"
    store.close()


def test_starting_an_instance_with_the_current_bundle_only_starts_it(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = stopped_instance_with_bundle(cfg, REVISION_2_BUNDLE)
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_volumes",
            {"Volumes": [volume(cfg, machine)]},
            {"VolumeIds": [machine.data_volume_id]},
        )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [instance(cfg, machine, "stopped")]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        stubber.add_response(
            "start_instances", {"StartingInstances": []}, {"InstanceIds": [machine.instance_id]}
        )
        result = Reconciler(store, Ec2Cloud(client, cfg)).reconcile(machine.machine_id)
        stubber.assert_no_pending_responses()
    assert result.observed_state is ObservedState.PROVISIONING
    assert result.instance_bundle == REVISION_2_BUNDLE
    store.close()


def _with_controller(bundle: str, controller_id: str | None, enrollment_code: str | None) -> str:
    value = json.loads(bundle)
    value["controller"] = {"id": controller_id, "enrollmentCode": enrollment_code}
    return json.dumps(value, separators=(",", ":"))


CONTROLLER_A = "9a1c2b4a-0000-4000-8000-0000000000aa"
CONTROLLER_B = "9a1c2b4a-0000-4000-8000-0000000000bb"


@pytest.mark.parametrize(
    ("current", "wanted", "replaced"),
    [
        (None, REVISION_2_BUNDLE, True),
        (REVISION_2_BUNDLE, REVISION_2_BUNDLE, False),
        (REVISION_1_BUNDLE, REVISION_2_BUNDLE, True),
        (REVISION_1_BUNDLE, _with_controller(REVISION_1_BUNDLE, CONTROLLER_A, None), False),
        (
            _with_controller(REVISION_1_BUNDLE, CONTROLLER_A, None),
            _with_controller(REVISION_1_BUNDLE, CONTROLLER_A, None),
            False,
        ),
        (
            _with_controller(REVISION_1_BUNDLE, CONTROLLER_A, None),
            _with_controller(REVISION_1_BUNDLE, CONTROLLER_B, None),
            True,
        ),
        (_with_controller(REVISION_1_BUNDLE, CONTROLLER_A, None), REVISION_2_BUNDLE, True),
        (
            REVISION_1_BUNDLE,
            REVISION_1_BUNDLE.replace("switch.example.test", "other.example.test"),
            True,
        ),
        (
            REVISION_1_BUNDLE,
            _with_controller(
                REVISION_1_BUNDLE.replace("switch.example.test", "other.example.test"),
                CONTROLLER_A,
                None,
            ),
            True,
        ),
    ],
)
def test_user_data_is_replaced_only_when_the_boot_would_need_it(current, wanted, replaced):
    assert needs_new_user_data(current, wanted) is replaced


def test_starting_an_enrolled_instance_keeps_the_user_data_it_enrolled_with(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = stopped_instance_with_bundle(cfg, REVISION_1_BUNDLE)
    enrolled = _with_controller(REVISION_1_BUNDLE, CONTROLLER_A, None)
    store.require_bundle(machine.machine_id, 3, "bundle-3")
    machine = store.record_bundle(machine.machine_id, "bundle-3", enrolled)
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_volumes",
            {"Volumes": [volume(cfg, machine)]},
            {"VolumeIds": [machine.data_volume_id]},
        )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [instance(cfg, machine, "stopped")]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        stubber.add_response(
            "start_instances", {"StartingInstances": []}, {"InstanceIds": [machine.instance_id]}
        )
        result = Reconciler(store, Ec2Cloud(client, cfg)).reconcile(machine.machine_id)
        stubber.assert_no_pending_responses()
    assert result.instance_bundle == REVISION_1_BUNDLE
    store.close()


def config_raw(tmp_path: Path, **overrides) -> dict:
    return {**config_dict(tmp_path, max_machines=1), **overrides}


@pytest.mark.parametrize(
    "arn",
    [
        "arn:aws:iam::123456789012:role/switch-machine",
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:switch-machine",
        "arn:aws:iam::123456789012:instance-profile",
        "instance-profile/switch-machine",
        None,
    ],
)
def test_config_requires_an_instance_profile_arn(tmp_path: Path, arn):
    with pytest.raises(ConfigError, match="instance_profile_arn"):
        ControllerConfig.from_dict(config_raw(tmp_path, instance_profile_arn=arn))


def test_config_refuses_machine_slots(tmp_path: Path):
    raw = config_raw(tmp_path)
    del raw["instance_profile_arn"]
    raw["machine_slots"] = {
        "slot-a": {
            "instance_profile_arn": INSTANCE_PROFILE_ARN,
            "assignment_secret_arn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:a",
        }
    }
    with pytest.raises(
        ConfigError, match=r"missing=\['instance_profile_arn'\], unknown=\['machine_slots'\]"
    ):
        ControllerConfig.from_dict(raw)


@pytest.mark.parametrize(
    ("max_machines", "valid"), [(0, False), (1, True), (100, True), (101, False)]
)
def test_capacity_is_bounded_by_configuration_alone(tmp_path: Path, max_machines, valid):
    raw = config_raw(tmp_path, max_machines=max_machines)
    if valid:
        assert ControllerConfig.from_dict(raw).max_machines == max_machines
    else:
        with pytest.raises(ConfigError, match="max_machines"):
            ControllerConfig.from_dict(raw)


def test_recovery_requires_terminated_predecessor_and_retains_disk(tmp_path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    store.record_volume(machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", "bundle-1")
    with pytest.raises(StoreError, match="terminated"):
        store.replace_terminated(machine, unexpected=True)
    machine = store.mark_instance_terminal_observed(machine.machine_id, machine.instance_id)
    replacement = store.replace_terminated(machine, unexpected=True)
    assert replacement.instance_id is None
    assert replacement.previous_instance_id == "i-0123456789abcdef0"
    assert replacement.data_volume_id == "vol-0123456789abcdef0"
    assert replacement.recovery_count == 1
    assert replacement.instance_seq == 1
    assert replacement.instance_bundle is None
    assert not replacement.instance_launch_issued
    cloud = Ec2Cloud(ec2_client(), cfg)
    assert cloud._token(machine, "instance-0") != cloud._token(replacement, "instance-1")
    for index in range(2, 5):
        current = store.record_instance(machine.machine_id, f"i-{index:017x}", None)
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
    assert store.find(MACHINE_ID) == machine
    store.close()
    connection = sqlite3.connect(cfg.state_db_path)
    assert connection.execute("SELECT COUNT(*) FROM agents").fetchone()[0] == 2
    connection.close()


def slot_era_database(cfg: ControllerConfig, rows: list[tuple[str, str]]) -> None:
    cfg.state_db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(cfg.state_db_path)
    connection.executescript(
        """
        CREATE TABLE machines (
            machine_id TEXT NOT NULL UNIQUE,
            slot_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            desired_state TEXT NOT NULL,
            observed_state TEXT NOT NULL,
            assignment_secret_arn TEXT NOT NULL,
            instance_profile_arn TEXT NOT NULL,
            PRIMARY KEY (slot_id, generation)
        );
        CREATE UNIQUE INDEX machines_one_live_row_per_slot
            ON machines (slot_id) WHERE observed_state <> 'deleted';
        CREATE TABLE controller_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )
    connection.execute(
        "INSERT INTO controller_metadata VALUES ('controller_fingerprint', ?)",
        (cfg.fingerprint(),),
    )
    connection.executemany(
        "INSERT INTO machines VALUES (?, 'slot-a', ?, ?, ?, 'secret-arn', 'profile-arn')",
        [
            (f"3f1c2b4a-0000-4000-8000-0000000000{generation:02d}", generation, *row)
            for generation, row in enumerate(rows, start=1)
        ],
    )
    connection.commit()
    connection.close()


def test_slot_era_database_with_only_deleted_machines_is_reopened_clean(tmp_path):
    cfg = config(tmp_path)
    slot_era_database(cfg, [("deleted", "deleted"), ("deleted", "deleted")])
    store = MachineStore(cfg.state_db_path, cfg.fingerprint())
    assert store.list() == []
    machine = insert_machine(store, cfg, MACHINE_ID)
    assert store.list() == [machine]
    store.close()
    connection = sqlite3.connect(cfg.state_db_path)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(machines)")}
    indexes = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'machines_one_live_row_per_slot'"
    ).fetchall()
    connection.close()
    assert "slot_id" not in columns
    assert {"bundle", "instance_bundle"} <= columns
    assert "instance_bundle_token" not in columns
    assert indexes == []
    reopened = MachineStore(cfg.state_db_path, cfg.fingerprint())
    assert reopened.list() == [machine]
    reopened.close()
    with pytest.raises(StoreError, match="immutable configuration"):
        MachineStore(cfg.state_db_path, replace(cfg, installation_id="other").fingerprint())


@pytest.mark.parametrize(
    "row",
    [
        ("running", "running"),
        ("stopped", "stopped"),
        ("retained", "retained"),
        ("deleted", "deleting"),
        ("running", "needs_attention"),
    ],
)
def test_slot_era_database_with_a_live_machine_is_refused(tmp_path, row):
    cfg = config(tmp_path)
    slot_era_database(cfg, [("deleted", "deleted"), row])
    with pytest.raises(StoreError) as raised:
        MachineStore(cfg.state_db_path, cfg.fingerprint())
    assert str(raised.value) == SLOT_ROWS_MESSAGE
    connection = sqlite3.connect(cfg.state_db_path)
    assert connection.execute("SELECT COUNT(*) FROM machines").fetchone()[0] == 2
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
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", "bundle-1")
    with pytest.raises(StoreError, match="stopped"):
        store.upgrade_terminated(machine, "ami-11111111111111111")
    machine = store.set_desired(machine.machine_id, DesiredState.STOPPED, None)
    with pytest.raises(StoreError, match="terminated"):
        store.upgrade_terminated(machine, "ami-11111111111111111")
    machine = store.mark_instance_terminal_observed(machine.machine_id, machine.instance_id)
    upgraded = store.upgrade_terminated(machine, "ami-11111111111111111")
    assert upgraded.instance_id is None
    assert upgraded.previous_instance_id == machine.instance_id
    assert upgraded.data_volume_id == machine.data_volume_id
    assert upgraded.desired_state is DesiredState.STOPPED
    assert upgraded.image_id != machine.image_id
    assert upgraded.instance_bundle is None
    with pytest.raises(StoreError, match="changed"):
        store.upgrade_terminated(machine, "ami-11111111111111111")
    store.close()


@pytest.mark.parametrize("desired", [DesiredState.RUNNING, DesiredState.STOPPED])
def test_terminating_worker_waits_without_profile_or_replacement(tmp_path, desired):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", None)
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


@pytest.mark.parametrize("current", [True, False])
def test_a_database_that_kept_bundle_tokens_keeps_the_current_instance_bundle(
    tmp_path: Path, current: bool
):
    cfg = config(tmp_path)
    store, machine = stopped_instance_with_bundle(cfg, None)
    store.close()
    connection = sqlite3.connect(cfg.state_db_path)
    connection.executescript(
        """
        ALTER TABLE machines ADD COLUMN instance_bundle_token TEXT;
        ALTER TABLE machines DROP COLUMN instance_bundle;
        """
    )
    connection.execute(
        "UPDATE machines SET instance_bundle_token = ?",
        (machine.bundle_token if current else "bundle-1",),
    )
    connection.commit()
    connection.close()
    reopened = MachineStore(cfg.state_db_path, cfg.fingerprint())
    assert reopened.get(machine.machine_id).instance_bundle == (machine.bundle if current else None)
    reopened.close()
    connection = sqlite3.connect(cfg.state_db_path)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(machines)")}
    connection.close()
    assert "instance_bundle_token" not in columns
