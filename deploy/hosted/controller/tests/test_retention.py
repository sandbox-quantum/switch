from pathlib import Path

from botocore.stub import Stubber
from test_controller import config, ec2_client, store_and_agent

from switch_hosted_controller.cloud import Ec2Cloud


def test_data_volume_delete_on_termination_is_explicitly_disabled(tmp_path: Path):
    cfg = config(tmp_path)
    store, agent = store_and_agent(cfg)
    agent = store.record_volume(agent.agent_id, "vol-0123456789abcdef0", cfg.availability_zone)
    agent = store.record_instance(agent.agent_id, "i-0123456789abcdef0")
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "modify_instance_attribute",
            {},
            {
                "InstanceId": agent.instance_id,
                "Attribute": "blockDeviceMapping",
                "BlockDeviceMappings": [
                    {
                        "DeviceName": "/dev/sdf",
                        "Ebs": {
                            "DeleteOnTermination": False,
                            "VolumeId": agent.volume_id,
                        },
                    }
                ],
            },
        )
        Ec2Cloud(client, cfg).enforce_data_retention(agent)
    store.close()
