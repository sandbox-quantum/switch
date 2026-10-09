import base64
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
)

from switch_hosted_controller.cloud import Ec2Cloud
from switch_hosted_controller.config import ConfigError, ControllerConfig

FIXTURES = Path(__file__).parent / "fixtures"


def assignment(user_data: str) -> str:
    encoded = next(
        line.split("content: ", 1)[1] for line in user_data.splitlines() if "content: " in line
    )
    return base64.b64decode(encoded).decode()


def test_run_request_is_valid_and_user_data_contains_only_assignment_refs(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
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
                "IamInstanceProfile": {"Arn": machine.instance_profile_arn},
                "Placement": ANY,
                "NetworkInterfaces": ANY,
                "MetadataOptions": ANY,
                "BlockDeviceMappings": ANY,
                "TagSpecifications": ANY,
                "UserData": cloud._user_data(machine),
            },
        )
        assert cloud.run_instance(machine) == "i-0123456789abcdef0"

    assert json.loads(assignment(cloud._user_data(machine))) == {
        "version": 2,
        "installationId": cfg.installation_id,
        "slotId": "slot-1",
        "generation": 1,
        "assignmentSecretId": machine.assignment_secret_arn,
        "dataVolumeId": machine.data_volume_id,
        "dataDevice": "/dev/sdf",
        "mountPath": "/data",
    }
    store.close()


def test_user_data_carries_the_predecessor_only_when_set(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    cloud = Ec2Cloud(ec2_client(), cfg)
    successor = replace(machine, previous_instance_id="i-0123456789abcdef0")
    metadata = json.loads(assignment(cloud._user_data(successor)))
    assert metadata["previousInstanceId"] == "i-0123456789abcdef0"
    assert "previousInstanceId" not in json.loads(assignment(cloud._user_data(machine)))
    store.close()


def test_tags_filters_and_tokens_use_the_real_generation(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = replace(machine, generation=3, instance_seq=2)
    cloud = Ec2Cloud(ec2_client(), cfg)
    assert cloud._tags(machine, "data") == [
        {"Key": "switch:installation-id", "Value": cfg.installation_id},
        {"Key": "switch:slot-id", "Value": "slot-1"},
        {"Key": "switch:generation", "Value": "3"},
        {"Key": "switch:machine-id", "Value": MACHINE_ID},
        {"Key": "switch:purpose", "Value": "data"},
        {"Key": "switch:managed-by", "Value": "switch-hosted-controller"},
    ]
    assert cloud._resource_filters(machine, "worker") == [
        {"Name": "tag:switch:installation-id", "Values": [cfg.installation_id]},
        {"Name": "tag:switch:slot-id", "Values": ["slot-1"]},
        {"Name": "tag:switch:generation", "Values": ["3"]},
        {"Name": "tag:switch:machine-id", "Values": [MACHINE_ID]},
        {"Name": "tag:switch:purpose", "Values": ["worker"]},
        {"Name": "tag:switch:managed-by", "Values": ["switch-hosted-controller"]},
    ]
    material = f"{cfg.installation_id}:slot-1:3:{MACHINE_ID}:instance-2"
    expected = "switch-m-" + hashlib.sha256(material.encode()).hexdigest()[:48]
    assert cloud._token(machine, "instance-2") == expected
    store.close()


@pytest.mark.parametrize("resource", ["data-volume", "instance-0", "instance-1"])
def test_machine_tokens_never_equal_per_agent_controller_tokens(tmp_path: Path, resource):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    token = Ec2Cloud(ec2_client(), cfg)._token(machine, resource)
    material = f"{cfg.installation_id}:{machine.slot_id}:{machine.generation}:{resource}"
    per_agent = "switch-" + hashlib.sha256(material.encode()).hexdigest()[:48]
    assert re.fullmatch(r"switch-m-[0-9a-f]{48}", token)
    assert len(token) <= 64
    assert re.fullmatch(r"switch-[0-9a-f]{48}", per_agent)
    assert token != per_agent
    store.close()


def test_packaged_controller_config_uses_machine_slots():
    cfg = ControllerConfig.load(FIXTURES / "controller.json")
    assert cfg.max_machines == 1
    assert list(cfg.machine_slots) == ["slot-a"]
    raw = json.loads((FIXTURES / "controller.json").read_text())
    with pytest.raises(ConfigError, match="max_machines"):
        ControllerConfig.from_dict({**raw, "max_machines": 2})


def test_a_new_database_reusing_the_installation_gets_tokens_and_lookups_of_its_own(
    tmp_path: Path,
):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    earlier = replace(machine, machine_id="00000000-0000-4000-8000-00000000beef")
    cloud = Ec2Cloud(ec2_client(), cfg)
    assert (machine.slot_id, machine.generation) == (earlier.slot_id, earlier.generation)
    assert cloud._token(machine, "data-volume") != cloud._token(earlier, "data-volume")
    assert cloud._launch_token(machine) != cloud._launch_token(earlier)
    assert cloud._resource_filters(machine, "data") != cloud._resource_filters(earlier, "data")
    store.close()
