from __future__ import annotations

import copy
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from botocore.stub import Stubber
from test_controller import config, ec2_client, store_and_machine, volume, with_bundle

from switch_hosted_controller import reconciler as reconciler_module
from switch_hosted_controller.cloud import CloudResourceError, Ec2Cloud
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler
from switch_hosted_controller.store import MachineStore, StoreError


def terminal_instance(cloud: Ec2Cloud, machine) -> dict:
    return {
        "InstanceId": machine.instance_id,
        "ImageId": machine.image_id,
        "InstanceType": machine.instance_type,
        "Placement": {"AvailabilityZone": cloud._config.availability_zone},
        "State": {"Name": "terminated", "Code": 48},
        "Tags": cloud._tags(machine, "worker"),
    }


def record_compute(store: MachineStore, machine, availability_zone: str):
    machine = store.record_volume(machine.machine_id, "vol-0123456789abcdef0", availability_zone)
    return store.record_instance(machine.machine_id, "i-0123456789abcdef0", None)


def accept_delete(store: MachineStore, machine, retain_until: datetime | None):
    claim = store.set_desired(machine.machine_id, DesiredState.STOPPED, None)
    store.set_observed(claim, ObservedState.STOPPED)
    return store.set_desired(machine.machine_id, DesiredState.DELETED, retain_until)


def test_recorded_terminated_instance_accepts_sparse_aws_response(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", None)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    terminated = terminal_instance(cloud, machine)
    assert not {
        "IamInstanceProfile",
        "SubnetId",
        "SecurityGroups",
        "NetworkInterfaces",
        "MetadataOptions",
    }.intersection(terminated)

    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [terminated]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        assert cloud.get_instance(machine) == terminated
    store.close()


@pytest.mark.parametrize("corruption", ["instance-id", "ownership-tag"])
def test_recorded_terminated_instance_still_validates_identity(tmp_path: Path, corruption: str):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", None)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    terminated = terminal_instance(cloud, machine)
    if corruption == "instance-id":
        terminated["InstanceId"] = "i-fffffffffffffffff"
    else:
        terminated["Tags"] = copy.deepcopy(terminated["Tags"])
        next(tag for tag in terminated["Tags"] if tag["Key"] == "switch:machine-id")["Value"] = (
            "00000000-0000-4000-8000-00000000beef"
        )

    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [terminated]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        with pytest.raises(CloudResourceError):
            cloud.get_instance(machine)
    store.close()


def test_terminated_then_not_found_remains_safely_stopped_and_deletable(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", None)
    claim = store.set_desired(machine.machine_id, DesiredState.STOPPED, None)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)

    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [terminal_instance(cloud, claim)]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        first = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert first.instance_terminal_observed
    assert first.observed_state is ObservedState.STOPPED

    with Stubber(client) as stubber:
        stubber.add_client_error(
            "describe_instances",
            service_error_code="InvalidInstanceID.NotFound",
            expected_params={"InstanceIds": [machine.instance_id]},
        )
        second = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert second.observed_state is ObservedState.STOPPED
    assert second.observed_revision == second.desired_revision
    assert second.observed_operation_id == second.operation_id
    assert (
        store.set_desired(machine.machine_id, DesiredState.DELETED, None).desired_state
        is DesiredState.DELETED
    )
    store.close()


class StartRaceCloud:
    def __init__(self, database: Path, fingerprint: str, *, fail: bool):
        self.database = database
        self.fingerprint = fingerprint
        self.fail = fail
        self.delete_rejected = False
        self.start_calls = 0

    def get_volume(self, machine):
        return {
            "VolumeId": machine.data_volume_id,
            "State": "in-use",
            "Attachments": [
                {
                    "InstanceId": machine.instance_id,
                    "Device": "/dev/sdf",
                    "State": "attached",
                }
            ],
        }

    def get_instance(self, machine):
        return {"InstanceId": machine.instance_id, "State": {"Name": "stopped"}}

    def start_instance(self, machine):
        self.start_calls += 1
        concurrent = MachineStore(self.database, self.fingerprint)
        try:
            concurrent.set_desired(machine.machine_id, DesiredState.STOPPED, None)
            try:
                concurrent.set_desired(machine.machine_id, DesiredState.DELETED, None)
            except StoreError:
                self.delete_rejected = True
        finally:
            concurrent.close()
        if self.fail:
            raise CloudResourceError("synthetic start failure")


@pytest.mark.parametrize("start_fails", [False, True])
def test_start_callback_cannot_publish_stale_success_or_error(tmp_path: Path, start_fails: bool):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = record_compute(store, machine, cfg.availability_zone)
    with_bundle(store, machine.machine_id, 1)
    store.record_instance_bundle(machine.machine_id, machine.instance_id, "bundle-1")
    store.set_observed(machine, ObservedState.STOPPED)
    cloud = StartRaceCloud(cfg.state_db_path, cfg.fingerprint(), fail=start_fails)

    Reconciler(store, cloud).reconcile_all()

    current = store.get(machine.machine_id)
    assert cloud.start_calls == 1
    assert cloud.delete_rejected
    assert current.desired_state is DesiredState.STOPPED
    assert current.observed_state is ObservedState.PENDING
    assert current.observed_revision == current.desired_revision
    assert current.observed_operation_id == current.operation_id
    assert current.error is None
    store.close()


def test_delayed_old_stopped_observation_cannot_authorize_newer_stop(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    old_stop = store.set_desired(machine.machine_id, DesiredState.STOPPED, None)
    store.set_desired(machine.machine_id, DesiredState.RUNNING, None)
    new_stop = store.set_desired(machine.machine_id, DesiredState.STOPPED, None)

    current = store.set_observed(old_stop, ObservedState.STOPPED)

    assert current.operation_id == new_stop.operation_id
    assert current.observed_state is ObservedState.PENDING
    with pytest.raises(StoreError, match="freshly observed stopped"):
        store.set_desired(machine.machine_id, DesiredState.DELETED, None)
    store.close()


class DeletionCloud:
    def __init__(self, states: list[str | None]):
        self.states = iter(states)
        self.volume_exists = True
        self.calls: list[str] = []

    def get_instance(self, machine):
        state = next(self.states)
        if state is None:
            return None
        return {"InstanceId": machine.instance_id, "State": {"Name": state}}

    def stop_instance(self, _machine):
        self.calls.append("stop-instance")

    def terminate_instance(self, _machine):
        self.calls.append("terminate-instance")

    def get_volume(self, machine):
        self.calls.append("get-volume")
        if not self.volume_exists:
            return None
        return {"VolumeId": machine.data_volume_id, "State": "available", "Attachments": []}

    def delete_volume(self, _machine):
        self.calls.append("delete-volume")
        self.volume_exists = False


def test_retained_stops_running_before_termination_and_keeps_volume(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = record_compute(store, machine, cfg.availability_zone)
    store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    cloud = DeletionCloud(["running", "stopped", "terminated"])
    reconciler = Reconciler(store, cloud)

    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.STOPPING
    assert cloud.calls == ["stop-instance"]
    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.STOPPING
    assert cloud.calls == ["stop-instance", "terminate-instance"]
    retained = reconciler.reconcile(machine.machine_id)

    assert retained.observed_state is ObservedState.RETAINED
    assert retained.instance_id is None
    assert retained.previous_instance_id == "i-0123456789abcdef0"
    assert retained.instance_seq == 1
    assert retained.data_volume_id == "vol-0123456789abcdef0"
    assert cloud.calls == ["stop-instance", "terminate-instance", "get-volume"]
    assert cloud.volume_exists
    assert reconciler.reconcile(machine.machine_id) == retained
    store.close()


def test_retained_with_a_missing_volume_needs_attention(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = record_compute(store, machine, cfg.availability_zone)
    store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    cloud = DeletionCloud(["terminated"])
    cloud.volume_exists = False
    result = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert result.observed_state is ObservedState.NEEDS_ATTENTION
    assert result.error == "recorded data volume cannot be found"
    store.close()


class LaunchCloud:
    def __init__(self):
        self.launched = []

    def get_volume(self, machine):
        return {"VolumeId": machine.data_volume_id, "State": "available", "Attachments": []}

    def get_instance(self, machine):
        return None

    def validate_image(self, machine):
        pass

    def validate_capacity(self):
        pass

    def run_instance(self, machine):
        self.launched.append(machine)
        return "i-0000000000000000b"


def test_running_after_retained_launches_the_next_instance_on_the_kept_volume(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    first = record_compute(store, machine, cfg.availability_zone)
    store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    Reconciler(store, DeletionCloud(["terminated"])).reconcile(machine.machine_id)
    with_bundle(store, machine.machine_id, 2)
    store.set_desired(machine.machine_id, DesiredState.RUNNING, None)
    cloud = LaunchCloud()

    relaunched = Reconciler(store, cloud).reconcile(machine.machine_id)

    assert relaunched.instance_id == "i-0000000000000000b"
    assert relaunched.data_volume_id == first.data_volume_id
    assert relaunched.previous_instance_id == first.instance_id
    assert relaunched.instance_bundle_token == "bundle-2"
    [launched] = cloud.launched
    assert launched.instance_seq == 1
    assert launched.bundle == store.get(machine.machine_id).bundle
    tokens = Ec2Cloud(ec2_client(), cfg)
    assert tokens._token(launched, f"instance-{launched.instance_seq}") != tokens._token(
        first, f"instance-{first.instance_seq}"
    )
    assert tokens._token(launched, "data-volume") == tokens._token(first, "data-volume")
    store.close()


def test_deleted_keeps_the_volume_until_retain_until(tmp_path: Path, monkeypatch):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = record_compute(store, machine, cfg.availability_zone)
    retain_until = datetime(2026, 1, 8, tzinfo=UTC)
    accept_delete(store, machine, retain_until)
    cloud = DeletionCloud(["terminated", None, None, None])
    reconciler = Reconciler(store, cloud)

    monkeypatch.setattr(reconciler_module, "utcnow", lambda: retain_until - timedelta(seconds=1))
    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.DELETING
    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.DELETING
    assert "delete-volume" not in cloud.calls
    assert cloud.volume_exists

    monkeypatch.setattr(reconciler_module, "utcnow", lambda: retain_until)
    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.DELETING
    assert cloud.calls[-1] == "delete-volume"
    assert not cloud.volume_exists
    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.DELETED
    store.close()


def test_accepted_delete_waits_for_pending_and_deletes_volume_only_after_terminal(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = record_compute(store, machine, cfg.availability_zone)
    accept_delete(store, machine, None)
    cloud = DeletionCloud(["pending", "stopped", "terminated", None])
    reconciler = Reconciler(store, cloud)

    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.DELETING
    assert cloud.calls == []
    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.DELETING
    assert cloud.calls == ["terminate-instance"]
    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.DELETING
    assert cloud.calls == ["terminate-instance", "get-volume", "delete-volume"]
    assert not cloud.volume_exists
    deleted = reconciler.reconcile(machine.machine_id)

    assert deleted.observed_state is ObservedState.DELETED
    assert cloud.calls == ["terminate-instance", "get-volume", "delete-volume", "get-volume"]
    store.close()


def test_purged_recorded_instance_reads_as_not_found(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", None)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    terminated = terminal_instance(cloud, machine)

    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances", {"Reservations": []}, {"InstanceIds": [machine.instance_id]}
        )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [terminated, terminated]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        assert cloud.get_instance(machine) is None
        with pytest.raises(CloudResourceError, match="exactly one instance"):
            cloud.get_instance(machine)
    store.close()


def stuck_purged_deletion(tmp_path: Path, *, terminal_observed: bool):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = record_compute(store, machine, cfg.availability_zone)
    claim = accept_delete(store, machine, None)
    if terminal_observed:
        store.mark_instance_terminal_observed(machine.machine_id, machine.instance_id)
    store.set_observed(
        claim,
        ObservedState.NEEDS_ATTENTION,
        "recorded instance lookup did not return exactly one instance",
    )
    return cfg, store, store.get(machine.machine_id)


def test_deletion_completes_after_terminated_instance_is_purged(tmp_path: Path):
    cfg, store, machine = stuck_purged_deletion(tmp_path, terminal_observed=True)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)

    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances", {"Reservations": []}, {"InstanceIds": [machine.instance_id]}
        )
        stubber.add_response(
            "describe_volumes",
            {"Volumes": [volume(cfg, machine)]},
            {"VolumeIds": [machine.data_volume_id]},
        )
        stubber.add_response("delete_volume", {}, {"VolumeId": machine.data_volume_id})
        deleting = Reconciler(store, cloud).reconcile(machine.machine_id)
        stubber.add_response(
            "describe_instances", {"Reservations": []}, {"InstanceIds": [machine.instance_id]}
        )
        stubber.add_client_error(
            "describe_volumes",
            service_error_code="InvalidVolume.NotFound",
            expected_params={"VolumeIds": [machine.data_volume_id]},
        )
        deleted = Reconciler(store, cloud).reconcile(machine.machine_id)
        stubber.assert_no_pending_responses()
    assert deleting.observed_state is ObservedState.DELETING
    assert deleted.observed_state is ObservedState.DELETED
    assert deleted.error is None

    with Stubber(client):
        again = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert again.observed_state is ObservedState.DELETED
    store.close()


def test_purged_instance_without_terminal_evidence_needs_attention(tmp_path: Path):
    cfg, store, machine = stuck_purged_deletion(tmp_path, terminal_observed=False)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)

    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances", {"Reservations": []}, {"InstanceIds": [machine.instance_id]}
        )
        result = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert result.observed_state is ObservedState.NEEDS_ATTENTION
    assert result.error == "recorded instance state is unknown during deletion"
    store.close()


def test_completed_deletion_is_not_reconciled_again(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = record_compute(store, machine, cfg.availability_zone)
    accept_delete(store, machine, None)
    cloud = DeletionCloud(["terminated"])
    cloud.volume_exists = False
    reconciler = Reconciler(store, cloud)
    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.DELETED
    calls = list(cloud.calls)

    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.DELETED
    assert cloud.calls == calls
    store.close()
