from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from test_controller import config, ec2_client, instance, store_and_machine, volume

from switch_hosted_controller.cloud import Ec2Cloud
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler


def test_create_volume_error_is_recovered_by_tag_discovery(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    filters = cloud._resource_filters(machine, "data")

    with Stubber(client) as stubber:
        stubber.add_response("describe_volumes", {"Volumes": []}, {"Filters": filters})
        stubber.add_client_error("create_volume", service_error_code="RequestTimeout")
        Reconciler(store, cloud).reconcile_all()

    uncertain = store.get(machine.machine_id)
    assert uncertain.volume_create_intent
    assert uncertain.volume_create_issued
    assert uncertain.observed_state is ObservedState.NEEDS_ATTENTION

    owned_volume = volume(cfg, uncertain)
    with Stubber(client) as stubber:
        stubber.add_response("describe_volumes", {"Volumes": [owned_volume]}, {"Filters": filters})
        recovered = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert recovered.data_volume_id == owned_volume["VolumeId"]
    store.close()


def test_stop_cancels_queued_launch_before_any_api_write(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    store.mark_instance_launch_intent(machine)
    store.set_desired(machine.machine_id, DesiredState.STOPPED, None)

    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": []},
            {"Filters": cloud._resource_filters(machine, "worker")},
        )
        stopped = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert stopped.observed_state is ObservedState.STOPPED
    assert not stopped.instance_launch_intent
    assert not stopped.instance_launch_issued
    store.close()


def client_error(code: str, status: int, operation: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}, operation
    )


def ready_to_launch(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
    machine = store.require_bundle(machine.machine_id, 1, "bundle-1")
    machine = store.record_bundle(machine.machine_id, "bundle-1")
    cloud = Mock(spec=Ec2Cloud)
    cloud.get_volume.return_value = volume(cfg, machine)
    cloud.get_instance.return_value = None
    cloud.discover_instance.return_value = None
    cloud.find_launched_instance.return_value = None
    return cfg, store, machine, cloud


@pytest.mark.parametrize(
    ("code", "status", "cleared"),
    [
        ("InsufficientInstanceCapacity", 500, False),
        ("InsufficientInstanceCapacity", 400, True),
        ("InvalidParameterValue", 400, True),
        ("IdempotentParameterMismatch", 400, False),
        ("RequestTimeout", 400, False),
        ("InternalError", 500, False),
    ],
)
def test_definitely_rejected_launch_is_forgotten(tmp_path: Path, code, status, cleared):
    _, store, machine, cloud = ready_to_launch(tmp_path)
    cloud.run_instance.side_effect = client_error(code, status, "RunInstances")
    Reconciler(store, cloud).reconcile_all()

    failed = store.get(machine.machine_id)
    assert failed.observed_state is ObservedState.NEEDS_ATTENTION
    assert failed.instance_launch_issued is not cleared
    assert failed.instance_launch_intent

    store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    cloud.run_instance.reset_mock()
    retained = Reconciler(store, cloud).reconcile(machine.machine_id)
    expected = ObservedState.RETAINED if cleared else ObservedState.STOPPING
    assert retained.observed_state is expected
    assert retained.instance_launch_issued is not cleared
    cloud.run_instance.assert_not_called()
    store.close()


def test_ambiguous_launch_is_replayed_with_the_same_sequence(tmp_path: Path):
    _, store, machine, cloud = ready_to_launch(tmp_path)
    cloud.run_instance.side_effect = client_error("InternalError", 500, "RunInstances")
    Reconciler(store, cloud).reconcile_all()
    assert store.get(machine.machine_id).instance_launch_issued

    cloud.run_instance.side_effect = None
    cloud.run_instance.return_value = "i-0123456789abcdef0"
    launched = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert launched.instance_id == "i-0123456789abcdef0"
    assert launched.instance_seq == 0
    cloud.validate_image.assert_called_once()
    store.close()


def unresolved_launch(tmp_path: Path, desired: DesiredState, issued_ago: timedelta):
    _, store, machine, cloud = ready_to_launch(tmp_path)
    machine = store.mark_instance_launch_intent(machine)
    store.mark_instance_launch_issued(machine, datetime.now(UTC) - issued_ago)
    if desired is DesiredState.DELETED:
        machine = store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
        store.set_observed(machine, ObservedState.RETAINED, None)
    store.set_desired(machine.machine_id, desired, None)
    return store, machine, cloud


@pytest.mark.parametrize("desired", [DesiredState.RETAINED, DesiredState.DELETED])
def test_recent_unresolved_launch_is_not_forgotten(tmp_path: Path, desired):
    store, machine, cloud = unresolved_launch(tmp_path, desired, timedelta(minutes=1))
    busy = ObservedState.STOPPING if desired is DesiredState.RETAINED else ObservedState.DELETING

    waiting = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert waiting.observed_state is busy
    assert waiting.instance_launch_issued
    assert waiting.instance_launch_issued_at is not None
    cloud.delete_volume.assert_not_called()
    store.close()


@pytest.mark.parametrize("desired", [DesiredState.RETAINED, DesiredState.DELETED])
def test_old_unresolved_launch_is_forgotten(tmp_path: Path, desired):
    store, machine, cloud = unresolved_launch(tmp_path, desired, timedelta(minutes=20))

    forgotten = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert not forgotten.instance_launch_issued
    assert forgotten.instance_launch_issued_at is None
    if desired is DesiredState.RETAINED:
        assert forgotten.observed_state is ObservedState.RETAINED
    else:
        cloud.delete_volume.assert_called_once()
    store.close()


def test_retention_adopts_an_instance_found_by_launch_token(tmp_path: Path):
    cfg, store, machine, cloud = ready_to_launch(tmp_path)
    machine = store.mark_instance_launch_intent(machine)
    store.mark_instance_launch_issued(machine, datetime.now(UTC))
    store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    worker = instance(cfg, machine, "terminated")
    cloud.find_launched_instance.return_value = worker

    adopted = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert adopted.instance_id == worker["InstanceId"]
    assert adopted.instance_launch_issued
    store.close()


def test_definitely_rejected_volume_create_lets_retention_finish(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    cloud = Mock(spec=Ec2Cloud)
    cloud.get_volume.return_value = None
    cloud.create_volume.side_effect = client_error("VolumeLimitExceeded", 400, "CreateVolume")
    Reconciler(store, cloud).reconcile_all()
    failed = store.get(machine.machine_id)
    assert failed.observed_state is ObservedState.NEEDS_ATTENTION
    assert not failed.volume_create_issued

    store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    cloud.get_instance.return_value = None
    retained = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert retained.observed_state is ObservedState.RETAINED
    assert retained.error is None
    store.close()


def test_launch_token_lookup_filters_on_the_current_sequence(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    filters = [
        {"Name": "client-token", "Values": [cloud._token(machine, "instance-0")]},
        *cloud._resource_filters(machine, "worker"),
    ]
    with Stubber(client) as stubber:
        stubber.add_response("describe_instances", {"Reservations": []}, {"Filters": filters})
        assert cloud.find_launched_instance(machine) is None
        stubber.assert_no_pending_responses()
    store.close()


def launched_instance(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    cloud = Mock()
    cloud.get_volume.return_value = volume(cfg, machine)
    return cfg, store, machine, cloud


def test_controller_termination_is_not_a_recovery(tmp_path: Path):
    cfg, store, machine, cloud = launched_instance(tmp_path)
    store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    cloud.get_instance.return_value = instance(cfg, machine, "stopped")
    terminating = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert terminating.observed_state is ObservedState.STOPPING
    cloud.terminate_instance.assert_called_once()

    store.set_desired(machine.machine_id, DesiredState.RUNNING, None)
    cloud.get_instance.return_value = instance(cfg, machine, "terminated")
    replaced = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert replaced.instance_id is None
    assert replaced.instance_seq == 1
    assert replaced.recovery_count == 0
    store.close()


def test_recovery_limit_applies_per_operation(tmp_path: Path):
    cfg, store, machine, cloud = launched_instance(tmp_path)
    reconciler = Reconciler(store, cloud)
    cloud.get_instance.return_value = instance(cfg, machine, "terminated")
    for index in range(3):
        replaced = reconciler.reconcile(machine.machine_id)
        assert replaced.recovery_count == index + 1
        store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    reconciler.reconcile_all()
    assert store.get(machine.machine_id).observed_state is ObservedState.NEEDS_ATTENTION

    store.set_desired(machine.machine_id, DesiredState.STOPPED, None)
    assert reconciler.reconcile(machine.machine_id).observed_state is ObservedState.STOPPED
    store.set_desired(machine.machine_id, DesiredState.RUNNING, None)
    replaced = reconciler.reconcile(machine.machine_id)
    assert replaced.instance_id is None
    assert replaced.recovery_count == 0
    store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    assert reconciler.reconcile(machine.machine_id).recovery_count == 1
    store.close()
