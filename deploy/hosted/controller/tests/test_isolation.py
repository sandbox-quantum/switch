"""An operator isolates a machine by moving its instance onto a security group
that is not in the controller's configuration. The controller must then leave
the instance alone, whatever Core or an operator command asks of it, and keep
its data volume."""

from pathlib import Path

import pytest
from botocore.stub import Stubber
from test_controller import (
    MACHINE_ID,
    REVISION_1_BUNDLE,
    config,
    ec2_client,
    instance,
    store_and_machine,
    volume,
    with_bundle,
)

from switch_hosted_controller.cloud import CloudResourceError, Ec2Cloud
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler

ISOLATION_GROUP = {"GroupId": "sg-0fedcba9876543210", "GroupName": "isolation"}


def isolated(worker: dict) -> dict:
    """The instance after `modify-instance-attribute --groups <isolation group>`."""
    worker["SecurityGroups"] = [ISOLATION_GROUP]
    for interface in worker["NetworkInterfaces"]:
        interface["Groups"] = [ISOLATION_GROUP]
    return worker


def isolated_machine(tmp_path: Path, desired: DesiredState):
    """A machine whose recorded instance enrolled with revision 1's bundle while
    Core already wants revision 2's: unisolated, the controller would stop,
    terminate or relaunch it."""
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", REVISION_1_BUNDLE)
    machine = with_bundle(store, machine.machine_id, 2)
    machine = store.set_desired(machine.machine_id, desired, None)
    return cfg, store, machine


@pytest.mark.parametrize(
    "desired", [DesiredState.RUNNING, DesiredState.STOPPED, DesiredState.RETAINED]
)
@pytest.mark.parametrize("state", ["running", "stopped", "stopping", "pending"])
def test_an_isolated_instance_is_left_alone(tmp_path: Path, desired: DesiredState, state: str):
    cfg, store, machine = isolated_machine(tmp_path, desired)
    worker = isolated(instance(cfg, machine, state))
    client = ec2_client()
    with Stubber(client) as stubber:
        if desired is DesiredState.RUNNING:
            stubber.add_response(
                "describe_volumes",
                {"Volumes": [volume(cfg, machine, state="in-use")]},
                {"VolumeIds": [machine.data_volume_id]},
            )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [worker]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        # The Stubber refuses any call not queued above, so a start, stop,
        # terminate, launch or volume change would fail with another error.
        with pytest.raises(CloudResourceError, match="security groups"):
            Reconciler(store, Ec2Cloud(client, cfg), instance_type=None).reconcile(MACHINE_ID)
        stubber.assert_no_pending_responses()
    store.close()


def test_an_isolated_machine_being_deleted_keeps_its_instance_and_disk(tmp_path: Path):
    cfg, store, machine = isolated_machine(tmp_path, DesiredState.STOPPED)
    machine = store.set_observed(machine, ObservedState.STOPPED, None)
    machine = store.set_desired(machine.machine_id, DesiredState.RETAINED, None)
    machine = store.set_observed(machine, ObservedState.RETAINED, None)
    machine = store.set_desired(machine.machine_id, DesiredState.DELETED, None)
    worker = isolated(instance(cfg, machine, "stopped"))
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [worker]}]},
            {"InstanceIds": [machine.instance_id]},
        )
        with pytest.raises(CloudResourceError, match="security groups"):
            Reconciler(store, Ec2Cloud(client, cfg), instance_type=None).reconcile(MACHINE_ID)
        stubber.assert_no_pending_responses()
    store.close()


def test_an_isolated_machine_needs_attention_on_every_pass(tmp_path: Path):
    cfg, store, machine = isolated_machine(tmp_path, DesiredState.RUNNING)
    worker = isolated(instance(cfg, machine, "stopped"))
    client = ec2_client()
    reconciler = Reconciler(store, Ec2Cloud(client, cfg), instance_type=None)
    with Stubber(client) as stubber:
        for _ in range(2):
            stubber.add_response(
                "describe_volumes",
                {"Volumes": [volume(cfg, machine, state="in-use")]},
                {"VolumeIds": [machine.data_volume_id]},
            )
            stubber.add_response(
                "describe_instances",
                {"Reservations": [{"Instances": [worker]}]},
                {"InstanceIds": [machine.instance_id]},
            )
        reconciler.reconcile_all()
        first = store.get(MACHINE_ID)
        assert first.observed_state is ObservedState.NEEDS_ATTENTION
        assert first.error == "instance security groups differ from immutable spec"
        # An operator `start`, or Core asking for the machine again, changes
        # nothing: the next pass reaches the same check before any action.
        store.set_desired(MACHINE_ID, DesiredState.RUNNING, None)
        reconciler.reconcile_all()
        stubber.assert_no_pending_responses()
    after = store.get(MACHINE_ID)
    assert after.observed_state is ObservedState.NEEDS_ATTENTION
    assert after.instance_id == machine.instance_id
    assert after.data_volume_id == machine.data_volume_id
    store.close()


def test_a_terminated_isolated_instance_is_replaced(tmp_path: Path):
    """Why the isolation runbook stops the instance and never terminates it:
    a terminated instance is not checked for its security groups, and the
    controller recovers the machine onto a new instance with the configured ones."""
    cfg, store, machine = isolated_machine(tmp_path, DesiredState.RUNNING)
    worker = isolated(instance(cfg, machine, "terminated"))
    client = ec2_client()
    with Stubber(client) as stubber:
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
        replaced = Reconciler(store, Ec2Cloud(client, cfg), instance_type=None).reconcile(
            MACHINE_ID
        )
        stubber.assert_no_pending_responses()
    assert replaced.instance_id is None
    assert replaced.recovery_count == 1
    store.close()
