from pathlib import Path

from botocore.stub import Stubber
from test_controller import config, ec2_client, store_and_machine

from switch_hosted_controller.cloud import Ec2Cloud


def test_data_volume_delete_on_termination_is_explicitly_disabled(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_volume(
        machine.machine_id, "vol-0123456789abcdef0", cfg.availability_zone
    )
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0")
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "modify_instance_attribute",
            {},
            {
                "InstanceId": machine.instance_id,
                "Attribute": "blockDeviceMapping",
                "BlockDeviceMappings": [
                    {
                        "DeviceName": "/dev/sdf",
                        "Ebs": {
                            "DeleteOnTermination": False,
                            "VolumeId": machine.data_volume_id,
                        },
                    }
                ],
            },
        )
        Ec2Cloud(client, cfg).enforce_data_retention(machine)
    store.close()
