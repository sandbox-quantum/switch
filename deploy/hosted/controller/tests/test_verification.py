from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from test_controller import config

from switch_hosted_controller.verification import MANAGED_BY, VerificationWorkers


def setup(tmp_path):
    cfg = config(tmp_path)
    job = dict(id=str(uuid4()), state="queued", result=None, instance_id=None, deadline=9999999999)
    gateway = SimpleNamespace(
        settings=SimpleNamespace(origin="https://switch.example.com", instance_type="m6i.large"),
        request=Mock(
            side_effect=lambda path, body=None, **kwargs: (
                [job] if path == "" else {"token": "placeholder"}
            )
        ),
    )
    ec2 = SimpleNamespace(
        describe_instances=Mock(return_value={"Reservations": []}),
        run_instances=Mock(return_value={"Instances": [{"InstanceId": "i-0123456789abcdef0"}]}),
        terminate_instances=Mock(),
    )
    return VerificationWorkers(ec2, cfg, gateway), job


def instance(worker, job, state="running"):
    return {
        "InstanceId": "i-0123456789abcdef0",
        "State": {"Name": state},
        "Tags": [
            {"Key": key, "Value": value}
            for key, value in {
                "switch:managed-by": MANAGED_BY,
                "switch:installation-id": worker.config.installation_id,
                "switch:verification-id": job["id"],
                "switch:deadline": str(job["deadline"]),
            }.items()
        ],
    }


def page(item):
    return {"Reservations": [{"Instances": [item]}]}


def test_launch_has_no_iam_identity_or_persistent_disk(tmp_path):
    worker, job = setup(tmp_path)
    worker.reconcile()
    launch = worker.ec2.run_instances.call_args.kwargs
    assert "IamInstanceProfile" not in launch
    assert launch["InstanceInitiatedShutdownBehavior"] == "terminate"
    assert len(launch["BlockDeviceMappings"]) == 1
    disk = launch["BlockDeviceMappings"][0]["Ebs"]
    assert disk["Encrypted"] and disk["DeleteOnTermination"]
    assert launch["ClientToken"] == "switch-verify-" + job["id"]
    assert "--verify-credential" in launch["UserData"]
    assert len(launch["UserData"].encode()) < 16384
    assert launch["MetadataOptions"]["HttpTokens"] == "required"


def test_restart_finds_worker_and_waits_for_termination(tmp_path):
    worker, job = setup(tmp_path)
    job["result"] = True
    item = instance(worker, job)
    worker.ec2.describe_instances.return_value = page(item)
    worker.reconcile()
    worker.ec2.run_instances.assert_not_called()
    worker.ec2.terminate_instances.assert_called_once()
    assert worker.gateway.request.call_args.args[1]["terminated"] is False
    item["State"]["Name"] = "terminated"
    worker.reconcile()
    assert worker.gateway.request.call_args.args[1]["terminated"] is True


def test_expired_worker_is_reaped_even_when_gateway_is_down(tmp_path):
    worker, job = setup(tmp_path)
    job["deadline"] = 0
    worker.ec2.describe_instances.return_value = page(instance(worker, job))
    worker.gateway.request.side_effect = RuntimeError("Unavailable")
    with pytest.raises(RuntimeError, match="Unavailable"):
        worker.reconcile()
    worker.ec2.terminate_instances.assert_called_once()


def test_paginated_instances_prevent_duplicate_launch(tmp_path):
    worker, job = setup(tmp_path)
    worker.ec2.describe_instances.side_effect = [
        {"Reservations": [], "NextToken": "next"},
        page(instance(worker, job)),
    ]
    worker.reconcile()
    worker.ec2.run_instances.assert_not_called()
    assert worker.ec2.describe_instances.call_args.kwargs["NextToken"] == "next"


def test_recorded_instance_requires_matching_ownership(tmp_path, caplog):
    worker, job = setup(tmp_path)
    job["instance_id"] = "i-0123456789abcdef0"
    item = instance(worker, job)
    item["Tags"] = []
    worker.ec2.describe_instances.side_effect = [{"Reservations": []}, page(item)]
    worker.reconcile()
    assert "failed to reconcile" in caplog.text
    worker.ec2.terminate_instances.assert_not_called()


def test_cancelled_job_terminates_worker_without_relaunch(tmp_path):
    worker, job = setup(tmp_path)
    job["state"] = "cancelled"
    worker.ec2.describe_instances.return_value = page(instance(worker, job))
    worker.reconcile()
    worker.ec2.terminate_instances.assert_called_once()
    worker.ec2.run_instances.assert_not_called()


def test_uncertain_launch_does_not_exceed_capacity(tmp_path):
    worker, first = setup(tmp_path)
    jobs = [dict(first, id=str(uuid4())) for _ in range(3)]

    def request(path, body=None, **kwargs):
        if not path:
            return jobs
        if path.endswith("/prepare"):
            return {"token": "placeholder"}
        raise RuntimeError("Observation unavailable after launch")

    worker.gateway.request.side_effect = request
    worker.reconcile()
    assert worker.ec2.run_instances.call_count == 2
