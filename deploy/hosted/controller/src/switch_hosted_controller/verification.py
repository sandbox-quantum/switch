from __future__ import annotations

import json
import logging
import time
from typing import Any
from uuid import UUID

from .config import ControllerConfig
from .gateway import Gateway

MANAGED_BY = "switch-provider-verification"


def user_data(origin: str, job_id: str, token: str) -> str:
    # The bootstrap token can retrieve only this short-lived check's credential.
    config = json.dumps(
        {"url": origin + "/gateway/provider-verifications/" + str(UUID(job_id)), "token": token}
    )
    return (
        """#!/bin/bash
set -eu
systemctl stop switch-hosted-worker.service || true
shutdown -P +8 >/dev/null 2>&1
trap 'shutdown -P now' EXIT
python3 - <<'PYTHON'
import json, os, pwd, subprocess, urllib.request
from pathlib import Path
"""
        + "config = "
        + repr(json.loads(config))
        + """
def request(suffix, data=None):
    req = urllib.request.Request(config['url'] + suffix,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)
result = {'succeeded': False}
try:
    credential = request('/credential')
    runtime = json.loads(Path('/etc/switch-hosted/runtime.json').read_text())
    account = pwd.getpwnam(runtime['agentUser'])
    home = Path('/run/switch-verification')
    home.mkdir(mode=0o700)
    os.chown(home, account.pw_uid, account.pw_gid)
    provider = credential['provider']
    binary = runtime['providerBinaryPath'] if provider == 'claude' else runtime['providers'][provider]['path']
    process = subprocess.run(
        ['setpriv', '--reuid=' + str(account.pw_uid), '--regid=' + str(account.pw_gid), '--clear-groups',
         runtime['nodePath'], runtime['bootstrapPath'], '--verify-credential'],
        input=json.dumps({**credential, 'binaryPath': binary, 'home': str(home)}),
        text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120,
        env={'HOME': str(home), 'PATH': runtime['path']}, cwd=home)
    if process.returncode == 0:
        result = json.loads(process.stdout.splitlines()[-1])
except Exception:
    result = {'succeeded': False}
try:
    request('/result', result)
finally:
    subprocess.run(['shutdown', '-P', 'now'], check=False)
PYTHON
"""
    )


class VerificationWorkers:
    def __init__(self, ec2: Any, config: ControllerConfig, gateway: Gateway):
        self.ec2 = ec2
        self.config = config
        self.gateway = gateway

    def request(self, path: str, body: dict | None = None) -> Any:
        return self.gateway.request(path, body, prefix="/gateway/provider-verifications")

    def reconcile(self) -> None:
        filters = [
            {"Name": "tag:switch:managed-by", "Values": [MANAGED_BY]},
            {"Name": "tag:switch:installation-id", "Values": [self.config.installation_id]},
        ]
        instances = []
        page = self.ec2.describe_instances(Filters=filters)
        while True:
            instances.extend(
                item for group in page.get("Reservations", []) for item in group["Instances"]
            )
            if not page.get("NextToken"):
                break
            page = self.ec2.describe_instances(Filters=filters, NextToken=page["NextToken"])
        now = time.time()
        by_job: dict[str, dict] = {}
        active = 0
        for instance in instances:
            tags = {tag["Key"]: tag["Value"] for tag in instance.get("Tags", [])}
            job_id = str(UUID(tags["switch:verification-id"]))
            if instance["State"]["Name"] != "terminated":
                active += 1
                if now >= float(tags["switch:deadline"]):
                    self.ec2.terminate_instances(InstanceIds=[instance["InstanceId"]])
            if job_id in by_job and by_job[job_id]["InstanceId"] != instance["InstanceId"]:
                raise RuntimeError("Multiple instances found for one connection check.")
            by_job[job_id] = instance
        for job in self.request(""):
            try:
                active = self.reconcile_job(job, by_job, now, active)
            except Exception as error:
                # A launch may have succeeded before its receipt failed.
                active += 1
                logging.error(
                    "Connection check %s failed to reconcile (%s)", job["id"], type(error).__name__
                )

    def reconcile_job(self, job: dict, by_job: dict[str, dict], now: float, active: int) -> int:
        job_id = str(UUID(job["id"]))
        instance = by_job.get(job_id)
        if instance is None and job["instance_id"]:
            found = self.ec2.describe_instances(InstanceIds=[job["instance_id"]]).get(
                "Reservations", []
            )
            exact = [item for group in found for item in group["Instances"]]
            if len(exact) != 1:
                raise RuntimeError("Could not confirm verification instance cleanup.")
            instance = exact[0]
        if instance is not None:
            tags = {tag["Key"]: tag["Value"] for tag in instance.get("Tags", [])}
            if (
                tags.get("switch:managed-by") != MANAGED_BY
                or tags.get("switch:installation-id") != self.config.installation_id
                or tags.get("switch:verification-id") != job_id
            ):
                raise RuntimeError("Connection check instance ownership mismatch.")
            instance_id = instance["InstanceId"]
            if job["instance_id"] and job["instance_id"] != instance_id:
                raise RuntimeError("Connection check instance identity mismatch.")
            terminated = instance["State"]["Name"] == "terminated"
            if not terminated and (
                job["result"] is not None or job["state"] == "cancelled" or now >= job["deadline"]
            ):
                self.ec2.terminate_instances(InstanceIds=[instance_id])
            self.request(
                "/" + job_id + "/observe",
                {"instance_id": instance_id, "terminated": terminated},
            )
        elif job["instance_id"] or now >= job["deadline"] or job["state"] == "cancelled":
            self.request(
                "/" + job_id + "/observe",
                {"instance_id": job["instance_id"], "terminated": True},
            )
        elif active < 2:
            prepared = self.request("/" + job_id + "/prepare", {})
            tags = [
                {"Key": "switch:managed-by", "Value": MANAGED_BY},
                {"Key": "switch:installation-id", "Value": self.config.installation_id},
                {"Key": "switch:verification-id", "Value": job_id},
                {"Key": "switch:deadline", "Value": str(job["deadline"])},
            ]
            response = self.ec2.run_instances(
                ImageId=self.config.image_id,
                InstanceType=self.gateway.settings.instance_type,
                MinCount=1,
                MaxCount=1,
                ClientToken="switch-verify-" + job_id,
                SubnetId=self.config.subnet_id,
                SecurityGroupIds=list(self.config.security_group_ids),
                InstanceInitiatedShutdownBehavior="terminate",
                MetadataOptions={
                    "HttpEndpoint": "enabled",
                    "HttpTokens": "required",
                    "HttpPutResponseHopLimit": 1,
                },
                BlockDeviceMappings=[
                    {
                        "DeviceName": self.config.root_device_name,
                        "Ebs": {
                            "Encrypted": True,
                            "DeleteOnTermination": True,
                            "VolumeType": "gp3",
                            "VolumeSize": self.config.root_volume_gib,
                        },
                    }
                ],
                TagSpecifications=[
                    {"ResourceType": kind, "Tags": tags}
                    for kind in ("instance", "volume", "network-interface")
                ],
                UserData=user_data(self.gateway.settings.origin, job_id, prepared["token"]),
            )
            instance_id = response["Instances"][0]["InstanceId"]
            self.request(
                "/" + job_id + "/observe", {"instance_id": instance_id, "terminated": False}
            )
            active += 1
        return active
