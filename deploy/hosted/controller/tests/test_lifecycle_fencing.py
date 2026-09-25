from __future__ import annotations

import copy
import sqlite3
from pathlib import Path

import pytest
from botocore.stub import Stubber
from test_controller import config, ec2_client, store_and_agent

from switch_hosted_controller.cloud import CloudResourceError, Ec2Cloud
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler
from switch_hosted_controller.store import AgentStore, StoreError


def terminal_instance(cloud: Ec2Cloud, agent) -> dict:
    return {
        "InstanceId": agent.instance_id,
        "ImageId": agent.image_id,
        "InstanceType": agent.instance_type,
        "Placement": {"AvailabilityZone": cloud._config.availability_zone},
        "State": {"Name": "terminated", "Code": 48},
        "Tags": cloud._tags(agent, "worker"),
    }


def record_compute(store: AgentStore, agent, availability_zone: str):
    agent = store.record_volume(agent.agent_id, "vol-0123456789abcdef0", availability_zone)
    return store.record_instance(agent.agent_id, "i-0123456789abcdef0")


def accept_delete(store: AgentStore, agent, *, delete_volume: bool):
    claim = store.set_desired(agent.agent_id, DesiredState.STOPPED)
    store.set_observed(claim, ObservedState.STOPPED)
    return store.set_desired(agent.agent_id, DesiredState.DELETED, delete_volume=delete_volume)


def test_recorded_terminated_instance_accepts_sparse_aws_response(tmp_path: Path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.record_instance(agent.agent_id, "i-0123456789abcdef0")
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    terminated = terminal_instance(cloud, agent)
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
            {"InstanceIds": [agent.instance_id]},
        )
        assert cloud.get_instance(agent) == terminated
    store.close()


@pytest.mark.parametrize("corruption", ["instance-id", "ownership-tag"])
def test_recorded_terminated_instance_still_validates_identity(tmp_path: Path, corruption: str):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.record_instance(agent.agent_id, "i-0123456789abcdef0")
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    terminated = terminal_instance(cloud, agent)
    if corruption == "instance-id":
        terminated["InstanceId"] = "i-fffffffffffffffff"
    else:
        terminated["Tags"] = copy.deepcopy(terminated["Tags"])
        next(tag for tag in terminated["Tags"] if tag["Key"] == "switch:agent-id")["Value"] = (
            "agent-foreign"
        )

    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [terminated]}]},
            {"InstanceIds": [agent.instance_id]},
        )
        with pytest.raises(CloudResourceError):
            cloud.get_instance(agent)
    store.close()


def test_terminated_then_not_found_remains_safely_stopped_and_deletable(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.record_instance(agent.agent_id, "i-0123456789abcdef0")
    claim = store.set_desired(agent.agent_id, DesiredState.STOPPED)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)

    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [terminal_instance(cloud, claim)]}]},
            {"InstanceIds": [agent.instance_id]},
        )
        first = Reconciler(store, cloud).reconcile(agent.agent_id)
    assert first.instance_terminal_observed
    assert first.observed_state is ObservedState.STOPPED

    with Stubber(client) as stubber:
        stubber.add_client_error(
            "describe_instances",
            service_error_code="InvalidInstanceID.NotFound",
            expected_params={"InstanceIds": [agent.instance_id]},
        )
        second = Reconciler(store, cloud).reconcile(agent.agent_id)
    assert second.observed_state is ObservedState.STOPPED
    assert second.observed_revision == second.desired_revision
    assert second.observed_operation_id == second.operation_id
    assert (
        store.set_desired(agent.agent_id, DesiredState.DELETED).desired_state
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

    def get_volume(self, agent):
        return {
            "VolumeId": agent.volume_id,
            "State": "in-use",
            "Attachments": [
                {
                    "InstanceId": agent.instance_id,
                    "Device": "/dev/sdf",
                    "State": "attached",
                }
            ],
        }

    def get_instance(self, agent):
        return {"InstanceId": agent.instance_id, "State": {"Name": "stopped"}}

    def start_instance(self, agent):
        self.start_calls += 1
        concurrent = AgentStore(self.database, self.fingerprint)
        try:
            concurrent.set_desired(agent.agent_id, DesiredState.STOPPED)
            try:
                concurrent.set_desired(agent.agent_id, DesiredState.DELETED)
            except StoreError:
                self.delete_rejected = True
        finally:
            concurrent.close()
        if self.fail:
            raise CloudResourceError("synthetic start failure")


@pytest.mark.parametrize("start_fails", [False, True])
def test_start_callback_cannot_publish_stale_success_or_error(tmp_path: Path, start_fails: bool):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = record_compute(store, agent, cfg.availability_zone)
    store.set_observed(agent, ObservedState.STOPPED)
    cloud = StartRaceCloud(cfg.state_db_path, cfg.fingerprint(), fail=start_fails)

    Reconciler(store, cloud).reconcile_all()

    current = store.get(agent.agent_id)
    assert cloud.start_calls == 1
    assert cloud.delete_rejected
    assert current.desired_state is DesiredState.STOPPED
    assert current.observed_state is ObservedState.PENDING
    assert current.observed_revision == current.desired_revision
    assert current.observed_operation_id == current.operation_id
    assert current.last_error is None
    store.close()


def test_delayed_old_stopped_observation_cannot_authorize_newer_stop(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    old_stop = store.set_desired(agent.agent_id, DesiredState.STOPPED)
    store.set_desired(agent.agent_id, DesiredState.RUNNING)
    new_stop = store.set_desired(agent.agent_id, DesiredState.STOPPED)

    current = store.set_observed(old_stop, ObservedState.STOPPED)

    assert current.operation_id == new_stop.operation_id
    assert current.observed_state is ObservedState.PENDING
    with pytest.raises(StoreError, match="freshly observed stopped"):
        store.set_desired(agent.agent_id, DesiredState.DELETED)
    store.close()


class DeletionCloud:
    def __init__(self, states: list[str | None]):
        self.states = iter(states)
        self.volume_exists = True
        self.calls: list[str] = []

    def get_instance(self, agent):
        state = next(self.states)
        if state is None:
            return None
        return {"InstanceId": agent.instance_id, "State": {"Name": state}}

    def stop_instance(self, _agent):
        self.calls.append("stop-instance")

    def terminate_instance(self, _agent):
        self.calls.append("terminate-instance")

    def get_volume(self, agent):
        self.calls.append("get-volume")
        if not self.volume_exists:
            return None
        return {"VolumeId": agent.volume_id, "State": "available", "Attachments": []}

    def delete_volume(self, _agent):
        self.calls.append("delete-volume")
        self.volume_exists = False


def test_accepted_delete_stops_running_before_termination_and_retains_volume(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = record_compute(store, agent, cfg.availability_zone)
    accept_delete(store, agent, delete_volume=False)
    cloud = DeletionCloud(["running", "stopped", "terminated"])
    reconciler = Reconciler(store, cloud)

    assert reconciler.reconcile(agent.agent_id).observed_state is ObservedState.DELETING
    assert cloud.calls == ["stop-instance"]
    assert reconciler.reconcile(agent.agent_id).observed_state is ObservedState.DELETING
    assert cloud.calls == ["stop-instance", "terminate-instance"]
    deleted = reconciler.reconcile(agent.agent_id)

    assert deleted.observed_state is ObservedState.DELETED
    assert deleted.instance_terminal_observed
    assert cloud.calls == ["stop-instance", "terminate-instance", "get-volume"]
    assert cloud.volume_exists
    store.close()


def test_accepted_delete_waits_for_pending_and_deletes_volume_only_after_terminal(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = record_compute(store, agent, cfg.availability_zone)
    accept_delete(store, agent, delete_volume=True)
    cloud = DeletionCloud(["pending", "stopped", "terminated", None])
    reconciler = Reconciler(store, cloud)

    assert reconciler.reconcile(agent.agent_id).observed_state is ObservedState.DELETING
    assert cloud.calls == []
    assert reconciler.reconcile(agent.agent_id).observed_state is ObservedState.DELETING
    assert cloud.calls == ["terminate-instance"]
    assert reconciler.reconcile(agent.agent_id).observed_state is ObservedState.DELETING
    assert cloud.calls == ["terminate-instance", "get-volume", "delete-volume"]
    assert not cloud.volume_exists
    deleted = reconciler.reconcile(agent.agent_id)

    assert deleted.observed_state is ObservedState.DELETED
    assert cloud.calls == ["terminate-instance", "get-volume", "delete-volume", "get-volume"]
    store.close()


def test_migrated_stopped_observation_requires_refresh_before_delete(tmp_path: Path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    claim = store.set_desired(agent.agent_id, DesiredState.STOPPED)
    store.set_observed(claim, ObservedState.STOPPED)
    store.close()

    with sqlite3.connect(cfg.state_db_path) as connection:
        connection.execute("ALTER TABLE agents DROP COLUMN observed_revision")
        connection.execute("ALTER TABLE agents DROP COLUMN observed_operation_id")

    migrated = AgentStore(cfg.state_db_path, cfg.fingerprint())
    stale = migrated.get(agent.agent_id)
    assert stale.observed_state is ObservedState.STOPPED
    assert stale.observed_revision == 0
    assert stale.observed_operation_id is None
    with pytest.raises(StoreError, match="freshly observed stopped"):
        migrated.set_desired(agent.agent_id, DesiredState.DELETED)

    refreshed = migrated.set_observed(stale, ObservedState.STOPPED)
    assert refreshed.observed_revision == refreshed.desired_revision
    assert refreshed.observed_operation_id == refreshed.operation_id
    assert (
        migrated.set_desired(agent.agent_id, DesiredState.DELETED).desired_state
        is DesiredState.DELETED
    )
    migrated.close()
