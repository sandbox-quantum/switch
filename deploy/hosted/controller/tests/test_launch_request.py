import base64
import json
from pathlib import Path

from botocore.stub import Stubber
from test_controller import config, ec2_client, store_and_agent

from switch_hosted_controller.cloud import Ec2Cloud


def test_run_request_is_valid_and_user_data_contains_only_assignment_refs(tmp_path: Path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.record_volume(agent.agent_id, "vol-0123456789abcdef0", cfg.availability_zone)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    with Stubber(client) as stubber:
        stubber.add_response(
            "run_instances",
            {"Instances": [{"InstanceId": "i-0123456789abcdef0"}]},
        )
        assert cloud.run_instance(agent) == "i-0123456789abcdef0"

    user_data = cloud._user_data(agent)
    encoded = next(
        line.split("content: ", 1)[1] for line in user_data.splitlines() if "content: " in line
    )
    metadata = json.loads(base64.b64decode(encoded))
    assert metadata == {
        "version": 1,
        "installationId": cfg.installation_id,
        "agentId": agent.agent_id,
        "generation": 1,
        "assignmentSecretId": agent.assignment_secret_arn,
        "dataVolumeId": agent.volume_id,
        "dataDevice": "/dev/sdf",
        "mountPath": "/data",
    }
    store.close()
