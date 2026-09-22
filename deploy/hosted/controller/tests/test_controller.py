from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import boto3
import pytest
from botocore.stub import Stubber

from switch_hosted_controller.cloud import CloudCapacityError, CloudResourceError, Ec2Cloud
from switch_hosted_controller.config import ConfigError, ControllerConfig
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler
from switch_hosted_controller.store import AgentStore, CapacityError, StoreError


def config(tmp_path: Path, *, max_agents: int = 1) -> ControllerConfig:
    assignments = {
        f"agent-{number}": {
            "instance_profile_arn": f"arn:aws:iam::123456789012:instance-profile/worker-{number}",
            "assignment_secret_arn": f"arn:aws:secretsmanager:us-east-1:123456789012:secret:agent-{number}",
        }
        for number in range(1, max_agents + 1)
    }
    return ControllerConfig.from_dict(
        {
            "installation_id": "test-installation",
            "region": "us-east-1",
            "availability_zone": "us-east-1a",
            "subnet_id": "subnet-0123456789abcdef0",
            "security_group_ids": ["sg-0123456789abcdef0"],
            "image_id": "ami-0123456789abcdef0",
            "root_device_name": "/dev/xvda",
            "allowed_instance_types": ["m6i.large"],
            "max_agents": max_agents,
            "root_volume_gib": 20,
            "data_volume_gib": 40,
            "worker_assignments": assignments,
            "state_db_path": str(tmp_path / "state.db"),
            "lock_path": str(tmp_path / "controller.lock"),
            "poll_interval_seconds": 1,
        }
    )


def store_and_agent(cfg: ControllerConfig) -> tuple[AgentStore, object]:
    store = AgentStore(cfg.state_db_path, cfg.fingerprint())
    assignment = cfg.assignment("agent-1")
    agent = store.reserve_create(
        agent_id="agent-1",
        instance_type="m6i.large",
        image_id=cfg.image_id,
        assignment_secret_arn=assignment.assignment_secret_arn,
        instance_profile_arn=assignment.instance_profile_arn,
        max_agents=cfg.max_agents,
    )
    return store, agent


def ec2_client():
    return boto3.client(
        "ec2",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        aws_session_token="test",
    )


def volume(cfg: ControllerConfig, agent, *, state: str = "available", attachments=None):
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
        "Tags": Ec2Cloud(ec2_client(), cfg)._tags(agent, "data"),
    }


def instance(cfg: ControllerConfig, agent, state: str):
    return {
        "InstanceId": "i-0123456789abcdef0",
        "ImageId": cfg.image_id,
        "InstanceType": agent.instance_type,
        "State": {"Name": state, "Code": 16 if state == "running" else 80},
        "IamInstanceProfile": {"Arn": agent.instance_profile_arn, "Id": "AIPAEXAMPLE"},
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
        "Tags": Ec2Cloud(ec2_client(), cfg)._tags(agent, "worker"),
    }


def test_store_persists_intent_and_rejects_changed_deployment(tmp_path: Path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.mark_volume_create_intent(agent)
    store.mark_instance_launch_intent(agent)
    store.close()

    restarted = AgentStore(cfg.state_db_path, cfg.fingerprint())
    assert restarted.get("agent-1").volume_create_intent
    assert restarted.get("agent-1").instance_launch_intent
    restarted.close()

    changed = replace(cfg, installation_id="different-installation")
    with pytest.raises(StoreError, match="immutable configuration"):
        AgentStore(cfg.state_db_path, changed.fingerprint())


def test_capacity_and_immutable_spec_are_enforced(tmp_path: Path):
    cfg = config(tmp_path)
    store, _ = store_and_agent(cfg)
    with pytest.raises(CapacityError):
        store.reserve_create(
            agent_id="agent-2",
            instance_type="m6i.large",
            image_id=cfg.image_id,
            assignment_secret_arn="arn:aws:secretsmanager:us-east-1:123456789012:secret:other",
            instance_profile_arn="arn:aws:iam::123456789012:instance-profile/other",
            max_agents=1,
        )
    with pytest.raises(StoreError, match="immutable"):
        store.reserve_create(
            agent_id="agent-1",
            instance_type="m6i.xlarge",
            image_id=cfg.image_id,
            assignment_secret_arn=cfg.assignment("agent-1").assignment_secret_arn,
            instance_profile_arn=cfg.assignment("agent-1").instance_profile_arn,
            max_agents=1,
        )
    store.close()


def test_uncertain_launch_then_stop_waits_for_late_instance(tmp_path: Path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.mark_volume_create_intent(agent)
    agent = store.record_volume(agent.agent_id, "vol-0123456789abcdef0", cfg.availability_zone)
    agent = store.mark_instance_launch_intent(agent)
    store.mark_instance_launch_issued(agent)
    store.set_desired(agent.agent_id, DesiredState.STOPPED)

    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    filters = cloud._resource_filters(agent.agent_id, "worker")
    worker = instance(cfg, store.get(agent.agent_id), "running")
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
        assert reconciler.reconcile(agent.agent_id).observed_state is ObservedState.NEEDS_ATTENTION
        adopted = reconciler.reconcile(agent.agent_id)
        assert adopted.instance_id == worker["InstanceId"]
        assert reconciler.reconcile(agent.agent_id).observed_state is ObservedState.STOPPING
        assert reconciler.reconcile(agent.agent_id).observed_state is ObservedState.STOPPED
    store.close()


def test_cloud_capacity_counts_all_pages(tmp_path: Path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.record_volume(agent.agent_id, "vol-0123456789abcdef0", cfg.availability_zone)
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
    store, agent = store_and_agent(cfg)
    agent = store.record_instance(agent.agent_id, "i-0123456789abcdef0")
    foreign = instance(cfg, agent, "running")
    foreign["Tags"] = [
        {"Key": "switch:installation-id", "Value": "other-installation"},
        {"Key": "switch:agent-id", "Value": agent.agent_id},
    ]
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [foreign]}]},
            {"InstanceIds": [agent.instance_id]},
        )
        with pytest.raises(CloudResourceError, match="ownership tag"):
            Ec2Cloud(client, cfg).get_instance(agent)
    store.close()


def test_stop_and_start_use_only_recorded_instance(tmp_path: Path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.record_instance(agent.agent_id, "i-0123456789abcdef0")
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "stop_instances",
            {"StoppingInstances": []},
            {"InstanceIds": [agent.instance_id], "Force": False},
        )
        stubber.add_response(
            "start_instances", {"StartingInstances": []}, {"InstanceIds": [agent.instance_id]}
        )
        cloud = Ec2Cloud(client, cfg)
        cloud.stop_instance(agent)
        cloud.start_instance(agent)
    store.close()


def test_config_rejects_duplicate_assignment_credentials(tmp_path: Path):
    cfg = config(tmp_path, max_agents=2)
    raw = {
        **cfg.__dict__,
        "security_group_ids": list(cfg.security_group_ids),
        "allowed_instance_types": list(cfg.allowed_instance_types),
        "state_db_path": str(cfg.state_db_path),
        "lock_path": str(cfg.lock_path),
        "worker_assignments": {
            agent_id: {
                "instance_profile_arn": assignment.instance_profile_arn,
                "assignment_secret_arn": cfg.assignment("agent-1").assignment_secret_arn,
            }
            for agent_id, assignment in cfg.worker_assignments.items()
        },
    }
    with pytest.raises(ConfigError, match="secrets must be unique"):
        ControllerConfig.from_dict(raw)


def test_recovery_requires_terminated_predecessor_and_retains_disk(tmp_path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    store.record_volume(agent.agent_id, "vol-0123456789abcdef0", cfg.availability_zone)
    agent = store.record_instance(agent.agent_id, "i-0123456789abcdef0")
    with pytest.raises(StoreError, match="terminated"):
        store.replace_terminated(agent)
    agent = store.mark_instance_terminal_observed(agent.agent_id, agent.instance_id)
    replacement = store.replace_terminated(agent)
    assert replacement.instance_id is None
    assert replacement.previous_instance_id == "i-0123456789abcdef0"
    assert replacement.volume_id == "vol-0123456789abcdef0"
    assert replacement.recovery_count == 1
    assert not replacement.instance_launch_issued
    cloud = Ec2Cloud(ec2_client(), cfg)
    assert cloud._token(agent, "instance-0") != cloud._token(replacement, "instance-1")
    for index in range(2, 5):
        current = store.record_instance(agent.agent_id, f"i-{index:017x}")
        current = store.mark_instance_terminal_observed(agent.agent_id, current.instance_id)
        if index == 4:
            with pytest.raises(StoreError, match="limit"):
                store.replace_terminated(current)
        else:
            store.replace_terminated(current)
    store.close()


def test_capacity_and_image_can_change_after_verified_legacy_migration(tmp_path):
    cfg = config(tmp_path)
    old = AgentStore(cfg.state_db_path, cfg.fingerprint(legacy=True))
    old.close()
    migrated = AgentStore(
        cfg.state_db_path, cfg.fingerprint(), legacy_fingerprint=cfg.fingerprint(legacy=True)
    )
    migrated.close()
    expanded = config(tmp_path, max_agents=2)
    current = AgentStore(expanded.state_db_path, expanded.fingerprint())
    current.close()
    incompatible = replace(expanded, subnet_id="subnet-11111111111111111")
    with pytest.raises(StoreError, match="immutable"):
        AgentStore(incompatible.state_db_path, incompatible.fingerprint())


def test_image_upgrade_requires_stopped_terminal_claim_and_preserves_disk(tmp_path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    store.record_volume(agent.agent_id, "vol-0123456789abcdef0", cfg.availability_zone)
    agent = store.record_instance(agent.agent_id, "i-0123456789abcdef0")
    with pytest.raises(StoreError, match="stopped"):
        store.upgrade_terminated(agent, "ami-11111111111111111", "a" * 64)
    agent = store.set_desired(agent.agent_id, DesiredState.STOPPED)
    with pytest.raises(StoreError, match="terminated"):
        store.upgrade_terminated(agent, "ami-11111111111111111", "a" * 64)
    agent = store.mark_instance_terminal_observed(agent.agent_id, agent.instance_id)
    upgraded = store.upgrade_terminated(agent, "ami-11111111111111111", "a" * 64)
    assert upgraded.instance_id is None
    assert upgraded.previous_instance_id == agent.instance_id
    assert upgraded.volume_id == agent.volume_id
    assert upgraded.previous_runtime_fingerprint == "a" * 64
    assert upgraded.desired_state is DesiredState.STOPPED
    assert upgraded.image_id != agent.image_id
    with pytest.raises(StoreError, match="changed"):
        store.upgrade_terminated(agent, "ami-11111111111111111", "a" * 64)
    store.close()


@pytest.mark.parametrize("desired", [DesiredState.RUNNING, DesiredState.STOPPED])
def test_terminating_worker_waits_without_profile_or_replacement(tmp_path, desired):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.record_volume(agent.agent_id, "vol-0123456789abcdef0", cfg.availability_zone)
    agent = store.record_instance(agent.agent_id, "i-0123456789abcdef0")
    agent = store.set_desired(agent.agent_id, desired)
    worker = instance(cfg, agent, "shutting-down")
    worker.pop("IamInstanceProfile")
    worker.pop("NetworkInterfaces")
    client = ec2_client()
    with Stubber(client) as stubber:
        if desired is DesiredState.RUNNING:
            stubber.add_response(
                "describe_volumes",
                {"Volumes": [volume(cfg, agent)]},
                {"VolumeIds": [agent.volume_id]},
            )
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [worker]}]},
            {"InstanceIds": [agent.instance_id]},
        )
        result = Reconciler(store, Ec2Cloud(client, cfg)).reconcile(agent.agent_id)
        expected = (
            ObservedState.PROVISIONING
            if desired is DesiredState.RUNNING
            else ObservedState.STOPPING
        )
        assert result.observed_state is expected
        assert result.instance_id == agent.instance_id
        assert result.last_error is None
        stubber.assert_no_pending_responses()
    store.close()
