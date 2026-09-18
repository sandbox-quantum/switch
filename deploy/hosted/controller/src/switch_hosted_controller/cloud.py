from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

from botocore.exceptions import ClientError

from .config import ControllerConfig
from .model import Agent

MANAGED_BY = "switch-hosted-controller"
DATA_DEVICE = "/dev/sdf"


class CloudResourceError(RuntimeError):
    pass


class CloudCapacityError(CloudResourceError):
    pass


class Ec2Cloud:
    def __init__(self, ec2: Any, config: ControllerConfig):
        self._ec2 = ec2
        self._config = config

    @property
    def availability_zone(self) -> str:
        return self._config.availability_zone

    def validate_image(self) -> None:
        images = self._ec2.describe_images(ImageIds=[self._config.image_id]).get("Images", [])
        if len(images) != 1:
            raise CloudResourceError("configured AMI lookup did not return exactly one image")
        image = images[0]
        if image.get("State") != "available":
            raise CloudResourceError("configured AMI is not available")
        if image.get("Architecture") != "x86_64" or image.get("VirtualizationType") != "hvm":
            raise CloudResourceError("configured AMI must be x86_64 HVM")
        if image.get("RootDeviceType") != "ebs":
            raise CloudResourceError("configured AMI must use an EBS root")
        if image.get("RootDeviceName") != self._config.root_device_name:
            raise CloudResourceError("configured root_device_name differs from the AMI")
        mappings = image.get("BlockDeviceMappings", [])
        if len(mappings) != 1 or mappings[0].get("DeviceName") != self._config.root_device_name:
            raise CloudResourceError("configured AMI must define exactly one root block device")
        if not mappings[0].get("Ebs") or mappings[0].get("NoDevice"):
            raise CloudResourceError("configured AMI root mapping is not an EBS device")

    def discover_volume(self, agent: Agent) -> dict[str, Any] | None:
        volumes = self._describe_volumes(Filters=self._resource_filters(agent.agent_id, "data"))
        if len(volumes) > 1:
            raise CloudResourceError("multiple controller-owned data volumes exist for agent")
        if not volumes:
            return None
        self._validate_volume(volumes[0], agent)
        return volumes[0]

    def get_volume(self, agent: Agent) -> dict[str, Any] | None:
        if agent.volume_id is None:
            return self.discover_volume(agent)
        try:
            volumes = self._describe_volumes(VolumeIds=[agent.volume_id])
        except ClientError as exc:
            if _error_code(exc) == "InvalidVolume.NotFound":
                return None
            raise
        if len(volumes) != 1:
            raise CloudResourceError("recorded volume lookup did not return exactly one volume")
        self._validate_volume(volumes[0], agent)
        return volumes[0]

    def create_volume(self, agent: Agent) -> str:
        response = self._ec2.create_volume(
            AvailabilityZone=self._config.availability_zone,
            Encrypted=True,
            VolumeType="gp3",
            KmsKeyId="alias/aws/ebs",
            Iops=3000,
            Throughput=125,
            Size=self._config.data_volume_gib,
            ClientToken=self._token(agent, "data-volume"),
            TagSpecifications=[{"ResourceType": "volume", "Tags": self._tags(agent, "data")}],
        )
        return response["VolumeId"]

    def discover_instance(self, agent: Agent) -> dict[str, Any] | None:
        instances = self._describe_instances(
            Filters=self._resource_filters(agent.agent_id, "worker")
        )
        active = [instance for instance in instances if instance["State"]["Name"] != "terminated"]
        if len(active) > 1:
            raise CloudResourceError("multiple controller-owned instances exist for agent")
        if not active:
            return None
        self._validate_instance(active[0], agent)
        return active[0]

    def get_instance(self, agent: Agent) -> dict[str, Any] | None:
        if agent.instance_id is None:
            return self.discover_instance(agent)
        try:
            instances = self._describe_instances(InstanceIds=[agent.instance_id])
        except ClientError as exc:
            if _error_code(exc) == "InvalidInstanceID.NotFound":
                return None
            raise
        if len(instances) != 1:
            raise CloudResourceError("recorded instance lookup did not return exactly one instance")
        self._validate_instance(instances[0], agent)
        return instances[0]

    def validate_capacity(self) -> None:
        active = self._describe_instances(
            Filters=[
                {"Name": "tag:switch:installation-id", "Values": [self._config.installation_id]},
                {"Name": "tag:switch:managed-by", "Values": [MANAGED_BY]},
                {
                    "Name": "instance-state-name",
                    "Values": ["pending", "running", "stopping", "stopped", "shutting-down"],
                },
            ]
        )
        if len(active) >= self._config.max_agents:
            raise CloudCapacityError("cloud instance capacity is exhausted")

    def run_instance(self, agent: Agent) -> str:
        if agent.volume_id is None:
            raise CloudResourceError("cannot launch without a recorded data volume")
        response = self._ec2.run_instances(
            ImageId=agent.image_id,
            InstanceType=agent.instance_type,
            MinCount=1,
            MaxCount=1,
            ClientToken=self._token(agent, "instance"),
            IamInstanceProfile={"Arn": agent.instance_profile_arn},
            Placement={"AvailabilityZone": self._config.availability_zone},
            NetworkInterfaces=[
                {
                    "DeviceIndex": 0,
                    "SubnetId": self._config.subnet_id,
                    "Groups": list(self._config.security_group_ids),
                    "AssociatePublicIpAddress": False,
                    "DeleteOnTermination": True,
                }
            ],
            MetadataOptions={
                "HttpEndpoint": "enabled",
                "HttpTokens": "required",
                "HttpPutResponseHopLimit": 1,
                "InstanceMetadataTags": "disabled",
            },
            BlockDeviceMappings=[
                {
                    "DeviceName": self._config.root_device_name,
                    "Ebs": {
                        "DeleteOnTermination": True,
                        "Encrypted": True,
                        "KmsKeyId": "alias/aws/ebs",
                        "Iops": 3000,
                        "Throughput": 125,
                        "VolumeSize": self._config.root_volume_gib,
                        "VolumeType": "gp3",
                    },
                }
            ],
            TagSpecifications=[
                {"ResourceType": "instance", "Tags": self._tags(agent, "worker")},
                {"ResourceType": "volume", "Tags": self._tags(agent, "root")},
                {"ResourceType": "network-interface", "Tags": self._tags(agent, "network")},
            ],
            UserData=self._user_data(agent),
        )
        instances = response.get("Instances", [])
        if len(instances) != 1:
            raise CloudResourceError("RunInstances did not return exactly one instance")
        return instances[0]["InstanceId"]

    def attach_volume(self, agent: Agent) -> None:
        if agent.instance_id is None or agent.volume_id is None:
            raise CloudResourceError("cannot attach without recorded instance and volume")
        self._ec2.attach_volume(
            Device=DATA_DEVICE, InstanceId=agent.instance_id, VolumeId=agent.volume_id
        )

    def enforce_data_retention(self, agent: Agent) -> None:
        if agent.instance_id is None or agent.volume_id is None:
            raise CloudResourceError("cannot set retention without recorded instance and volume")
        self._ec2.modify_instance_attribute(
            InstanceId=agent.instance_id,
            Attribute="blockDeviceMapping",
            BlockDeviceMappings=[
                {
                    "DeviceName": DATA_DEVICE,
                    "Ebs": {"DeleteOnTermination": False, "VolumeId": agent.volume_id},
                }
            ],
        )

    def start_instance(self, agent: Agent) -> None:
        if agent.instance_id is None:
            raise CloudResourceError("cannot start without a recorded instance")
        self._ec2.start_instances(InstanceIds=[agent.instance_id])

    def stop_instance(self, agent: Agent) -> None:
        if agent.instance_id is None:
            raise CloudResourceError("cannot stop without a recorded instance")
        self._ec2.stop_instances(InstanceIds=[agent.instance_id], Force=False)

    def terminate_instance(self, agent: Agent) -> None:
        if agent.instance_id is None:
            raise CloudResourceError("cannot terminate without a recorded instance")
        self._ec2.terminate_instances(InstanceIds=[agent.instance_id])

    def delete_volume(self, agent: Agent) -> None:
        if agent.volume_id is None:
            raise CloudResourceError("cannot delete without a recorded volume")
        self._ec2.delete_volume(VolumeId=agent.volume_id)

    def _validate_volume(self, volume: dict[str, Any], agent: Agent) -> None:
        self._validate_tags(volume, agent, "data")
        if volume.get("AvailabilityZone") != self._config.availability_zone:
            raise CloudResourceError("data volume is in the wrong availability zone")
        if volume.get("Encrypted") is not True:
            raise CloudResourceError("data volume is not encrypted")
        if volume.get("Size") != self._config.data_volume_gib:
            raise CloudResourceError("data volume size differs from immutable spec")
        if volume.get("VolumeType") != "gp3":
            raise CloudResourceError("data volume type differs from immutable spec")
        if volume.get("Iops") != 3000 or volume.get("Throughput") != 125:
            raise CloudResourceError("data volume performance differs from immutable spec")
        if not volume.get("KmsKeyId"):
            raise CloudResourceError("data volume has no KMS key identity")

    def _validate_instance(self, instance: dict[str, Any], agent: Agent) -> None:
        self._validate_tags(instance, agent, "worker")
        if instance.get("ImageId") != agent.image_id:
            raise CloudResourceError("instance image differs from immutable spec")
        if instance.get("InstanceType") != agent.instance_type:
            raise CloudResourceError("instance type differs from immutable spec")
        profile = instance.get("IamInstanceProfile") or {}
        if profile.get("Arn") != agent.instance_profile_arn:
            raise CloudResourceError("instance profile differs from immutable spec")
        placement = instance.get("Placement") or {}
        if placement.get("AvailabilityZone") != self._config.availability_zone:
            raise CloudResourceError("instance is in the wrong availability zone")
        if instance.get("SubnetId") != self._config.subnet_id:
            raise CloudResourceError("instance is in the wrong subnet")
        actual_groups = {group["GroupId"] for group in instance.get("SecurityGroups", [])}
        if actual_groups != set(self._config.security_group_ids):
            raise CloudResourceError("instance security groups differ from immutable spec")
        if instance.get("PublicIpAddress"):
            raise CloudResourceError("instance unexpectedly has a public IP address")
        interfaces = instance.get("NetworkInterfaces", [])
        if len(interfaces) != 1:
            raise CloudResourceError("instance must have exactly one network interface")
        interface = interfaces[0]
        if interface.get("SubnetId") != self._config.subnet_id:
            raise CloudResourceError("instance network interface is in the wrong subnet")
        interface_groups = {group["GroupId"] for group in interface.get("Groups", [])}
        if interface_groups != set(self._config.security_group_ids):
            raise CloudResourceError("network interface security groups differ from spec")
        attachment = interface.get("Attachment") or {}
        if attachment.get("DeviceIndex") != 0 or attachment.get("DeleteOnTermination") is not True:
            raise CloudResourceError("network interface attachment differs from spec")
        if interface.get("Association", {}).get("PublicIp"):
            raise CloudResourceError("instance network interface has a public IP address")
        metadata = instance.get("MetadataOptions") or {}
        expected_metadata = {
            "HttpEndpoint": "enabled",
            "HttpTokens": "required",
            "HttpPutResponseHopLimit": 1,
            "InstanceMetadataTags": "disabled",
        }
        for key, expected in expected_metadata.items():
            if metadata.get(key) != expected:
                raise CloudResourceError(f"instance metadata option {key} differs from spec")

    def _validate_tags(self, resource: dict[str, Any], agent: Agent, purpose: str) -> None:
        tags = {tag["Key"]: tag["Value"] for tag in resource.get("Tags", [])}
        required = {tag["Key"]: tag["Value"] for tag in self._tags(agent, purpose)}
        for key, expected in required.items():
            if tags.get(key) != expected:
                raise CloudResourceError(f"resource ownership tag {key!r} is missing or incorrect")

    def _tags(self, agent: Agent, purpose: str) -> list[dict[str, str]]:
        return [
            {"Key": "switch:installation-id", "Value": self._config.installation_id},
            {"Key": "switch:agent-id", "Value": agent.agent_id},
            {"Key": "switch:generation", "Value": str(agent.generation)},
            {"Key": "switch:purpose", "Value": purpose},
            {"Key": "switch:managed-by", "Value": MANAGED_BY},
        ]

    def _resource_filters(self, agent_id: str, purpose: str) -> list[dict[str, Any]]:
        return [
            {"Name": "tag:switch:installation-id", "Values": [self._config.installation_id]},
            {"Name": "tag:switch:agent-id", "Values": [agent_id]},
            {"Name": "tag:switch:generation", "Values": ["1"]},
            {"Name": "tag:switch:purpose", "Values": [purpose]},
            {"Name": "tag:switch:managed-by", "Values": [MANAGED_BY]},
        ]

    def _token(self, agent: Agent, resource: str) -> str:
        material = f"{self._config.installation_id}:{agent.agent_id}:{agent.generation}:{resource}"
        return f"switch-{hashlib.sha256(material.encode()).hexdigest()[:48]}"

    def _user_data(self, agent: Agent) -> str:
        metadata = {
            "version": 1,
            "installationId": self._config.installation_id,
            "agentId": agent.agent_id,
            "generation": agent.generation,
            "assignmentSecretId": agent.assignment_secret_arn,
            "dataVolumeId": agent.volume_id,
            "dataDevice": DATA_DEVICE,
            "mountPath": "/data",
        }
        encoded = base64.b64encode(
            json.dumps(metadata, separators=(",", ":"), sort_keys=True).encode()
        ).decode()
        return "\n".join(
            [
                "#cloud-config",
                "write_files:",
                "  - path: /etc/switch-hosted/assignment.json",
                "    owner: root:root",
                "    permissions: '0600'",
                "    encoding: b64",
                f"    content: {encoded}",
                "",
            ]
        )

    def _describe_instances(self, **kwargs: Any) -> list[dict[str, Any]]:
        instances: list[dict[str, Any]] = []
        request = dict(kwargs)
        while True:
            response = self._ec2.describe_instances(**request)
            instances.extend(
                instance
                for reservation in response.get("Reservations", [])
                for instance in reservation["Instances"]
            )
            token = response.get("NextToken")
            if not token:
                return instances
            request["NextToken"] = token

    def _describe_volumes(self, **kwargs: Any) -> list[dict[str, Any]]:
        volumes: list[dict[str, Any]] = []
        request = dict(kwargs)
        while True:
            response = self._ec2.describe_volumes(**request)
            volumes.extend(response.get("Volumes", []))
            token = response.get("NextToken")
            if not token:
                return volumes
            request["NextToken"] = token


def _error_code(exc: ClientError) -> str:
    return exc.response.get("Error", {}).get("Code", "")
