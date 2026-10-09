import hashlib
import json
import re
from dataclasses import replace
from pathlib import Path

import pytest
from botocore.stub import ANY, Stubber
from test_controller import (
    MACHINE_ID,
    config,
    ec2_client,
    store_and_machine,
    with_bundle,
)

from switch_hosted_controller.cloud import CloudResourceError, Ec2Cloud
from switch_hosted_controller.config import ConfigError, ControllerConfig

FIXTURES = Path(__file__).parent / "fixtures"


def test_run_request_boots_from_the_stored_bundle_with_the_shared_profile(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    store.record_volume(machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone)
    machine = with_bundle(store, machine.machine_id, 1)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    with Stubber(client) as stubber:
        stubber.add_response(
            "run_instances",
            {"Instances": [{"InstanceId": "i-0123456789abcdef0"}]},
            {
                "ImageId": cfg.image_id,
                "InstanceType": machine.instance_type,
                "MinCount": 1,
                "MaxCount": 1,
                "ClientToken": cloud._token(machine, "instance-0"),
                "IamInstanceProfile": {"Arn": cfg.instance_profile_arn},
                "Placement": ANY,
                "NetworkInterfaces": ANY,
                "MetadataOptions": ANY,
                "BlockDeviceMappings": ANY,
                "TagSpecifications": ANY,
                "UserData": machine.bundle,
            },
        )
        assert cloud.run_instance(machine) == "i-0123456789abcdef0"

    bundle = json.loads(machine.bundle)
    assert bundle["version"] == 5
    assert bundle["machineId"] == MACHINE_ID
    assert not {"slotId", "generation", "assignment", "assignmentSecretId"} & set(bundle)
    store.close()


def test_run_request_refuses_a_machine_without_a_bundle(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
    client = ec2_client()
    with Stubber(client) as stubber:
        with pytest.raises(CloudResourceError, match="prepared bundle"):
            Ec2Cloud(client, cfg).run_instance(machine)
        stubber.assert_no_pending_responses()
    store.close()


def test_tags_filters_and_tokens_are_keyed_by_machine(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = replace(machine, instance_seq=2)
    cloud = Ec2Cloud(ec2_client(), cfg)
    assert cloud._tags(machine, "data") == [
        {"Key": "switch:installation-id", "Value": cfg.installation_id},
        {"Key": "switch:machine-id", "Value": MACHINE_ID},
        {"Key": "switch:purpose", "Value": "data"},
        {"Key": "switch:managed-by", "Value": "switch-hosted-controller"},
    ]
    assert cloud._resource_filters(machine, "worker") == [
        {"Name": "tag:switch:installation-id", "Values": [cfg.installation_id]},
        {"Name": "tag:switch:machine-id", "Values": [MACHINE_ID]},
        {"Name": "tag:switch:purpose", "Values": ["worker"]},
        {"Name": "tag:switch:managed-by", "Values": ["switch-hosted-controller"]},
    ]
    material = f"{cfg.installation_id}:{MACHINE_ID}:instance-2"
    expected = "switch-m-" + hashlib.sha256(material.encode()).hexdigest()[:48]
    assert cloud._token(machine, "instance-2") == expected
    assert cloud._launch_token(machine) == expected
    store.close()


@pytest.mark.parametrize("resource", ["data-volume", "instance-0", "instance-1"])
def test_machine_tokens_never_equal_per_agent_controller_tokens(tmp_path: Path, resource):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    token = Ec2Cloud(ec2_client(), cfg)._token(machine, resource)
    material = f"{cfg.installation_id}:{machine.machine_id}:{resource}"
    per_agent = "switch-" + hashlib.sha256(material.encode()).hexdigest()[:48]
    assert re.fullmatch(r"switch-m-[0-9a-f]{48}", token)
    assert len(token) <= 64
    assert re.fullmatch(r"switch-[0-9a-f]{48}", per_agent)
    assert token != per_agent
    store.close()


def test_packaged_controller_config_uses_one_instance_profile():
    cfg = ControllerConfig.load(FIXTURES / "controller.json")
    assert cfg.max_machines == 1
    assert cfg.instance_profile_arn == "arn:aws:iam::123456789012:instance-profile/test-worker"
    raw = json.loads((FIXTURES / "controller.json").read_text())
    assert ControllerConfig.from_dict({**raw, "max_machines": 2}).max_machines == 2
    with pytest.raises(ConfigError, match="max_machines"):
        ControllerConfig.from_dict({**raw, "max_machines": 101})


def test_a_new_database_reusing_the_installation_gets_tokens_and_lookups_of_its_own(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    earlier = replace(machine, machine_id="00000000-0000-4000-8000-00000000beef")
    cloud = Ec2Cloud(ec2_client(), cfg)
    assert cloud._token(machine, "data-volume") != cloud._token(earlier, "data-volume")
    assert cloud._launch_token(machine) != cloud._launch_token(earlier)
    assert cloud._resource_filters(machine, "data") != cloud._resource_filters(earlier, "data")
    store.close()
