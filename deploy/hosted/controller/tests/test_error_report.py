"""What the reconciler tells Core about its errors: fixed words and counts,
sent on observations, and kept until Core takes them."""

from pathlib import Path
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from botocore.stub import Stubber
from test_controller import (
    config,
    ec2_client,
    instance,
    store_and_machine,
)
from test_gateway import (
    core_fixture,
    core_machine,
    make_gateway,
    open_store,
    synced_from_core,
)

from switch_hosted_controller.cloud import CloudCapacityError, CloudResourceError, Ec2Cloud
from switch_hosted_controller.error_report import ErrorReport, cloud_error, error_kind
from switch_hosted_controller.gateway import CoreMachine, GatewayError
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler
from switch_hosted_controller.store import StoreError

CANARY = "credential-value-must-not-appear"


def aws(operation: str, code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": CANARY}}, operation)


@pytest.mark.parametrize(
    ("operation", "code", "expected"),
    [
        ("RunInstances", "InsufficientInstanceCapacity", ("launch", "capacity")),
        ("RunInstances", "VcpuLimitExceeded", ("launch", "capacity")),
        ("StartInstances", "RequestLimitExceeded", ("start", "throttled")),
        ("StopInstances", "UnauthorizedOperation", ("stop", "permission")),
        ("TerminateInstances", "IncorrectInstanceState", ("terminate", "other")),
        ("CreateVolume", "InsufficientVolumeCapacity", ("volume", "capacity")),
        ("AttachVolume", "Throttling", ("volume", "throttled")),
        ("ModifyInstanceAttribute", "AccessDenied", ("volume", "permission")),
        ("DescribeInstances", "AuthFailure", ("describe", "permission")),
        ("CreateTags", "InsufficientInstanceCapacity", ("other", "capacity")),
        ("RunInstances", f"Code: {CANARY}", ("launch", "other")),
    ],
)
def test_an_aws_error_becomes_a_fixed_call_and_kind(operation, code, expected):
    found = cloud_error(aws(operation, code))
    assert found == {"call": expected[0], "kind": expected[1]}
    assert CANARY not in str(found)


def test_the_installations_own_machine_limit_is_a_launch_capacity_error():
    assert cloud_error(CloudCapacityError("cloud instance capacity is exhausted")) == {
        "call": "launch",
        "kind": "capacity",
    }


@pytest.mark.parametrize(
    "error", [CloudResourceError("AMI missing"), GatewayError(503), ValueError(CANARY)]
)
def test_only_aws_errors_name_a_cloud_call(error):
    assert cloud_error(error) is None


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (aws("RunInstances", "InsufficientInstanceCapacity"), "cloud"),
        (EndpointConnectionError(endpoint_url="https://ec2.example.test"), "cloud"),
        (CloudResourceError("recorded volume lookup failed"), "cloud"),
        (GatewayError(503), "core_api"),
        (StoreError("terminal observation does not match"), "state"),
        (ValueError(CANARY), "other"),
    ],
)
def test_errors_are_counted_by_kind(error, kind):
    assert error_kind(error) == kind


@pytest.mark.parametrize(
    ("code", "kind"),
    [
        ("UnauthorizedOperation", "permission"),
        ("RequestLimitExceeded", "throttled"),
        ("InsufficientInstanceCapacity", "capacity"),
    ],
)
def test_a_failed_cloud_call_in_a_real_reconcile_is_counted(tmp_path: Path, code, kind):
    """Through the reconciler and the real EC2 wrapper, with a fake cloud that
    refuses the stop: the call is named from the operation that failed."""
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    machine = store.record_instance(machine.machine_id, "i-0123456789abcdef0", None)
    store.set_desired(machine.machine_id, DesiredState.STOPPED, None)
    client = ec2_client()
    errors = ErrorReport()
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": [{"Instances": [instance(cfg, machine, "running")]}]},
        )
        stubber.add_client_error("stop_instances", service_error_code=code, service_message=CANARY)
        Reconciler(store, Ec2Cloud(client, cfg), instance_type=None, errors=errors).reconcile_all()
    assert errors.fields() == {
        "cloud_errors": [{"call": "stop", "kind": kind, "count": 1}],
        "reconciler_errors": {"cloud": 1},
    }
    assert CANARY not in str(errors.fields())
    assert store.get(machine.machine_id).observed_state is ObservedState.NEEDS_ATTENTION
    store.close()


def test_every_failure_in_a_pass_is_counted():
    errors = ErrorReport()
    for _ in range(3):
        errors.record(aws("RunInstances", "InsufficientInstanceCapacity"))
    errors.record(aws("StopInstances", "Throttling"))
    assert errors.fields()["cloud_errors"] == [
        {"call": "launch", "kind": "capacity", "count": 3},
        {"call": "stop", "kind": "throttled", "count": 1},
    ]


def test_the_errors_ride_on_observations_and_match_cores_fixture(tmp_path):
    store, gateway, listed = synced_from_core(tmp_path)
    store.set_observed(store.get(listed["machine_id"]), ObservedState.NEEDS_ATTENTION, "x")
    gateway.errors = ErrorReport()
    gateway.errors.record(aws("RunInstances", "InsufficientInstanceCapacity"))
    gateway.errors.record(aws("DescribeVolumes", "RequestLimitExceeded"))
    gateway.errors.record(GatewayError(503))
    gateway.report_observations(gateway.machines())
    path, body = gateway.request.call_args_list[-1].args
    assert path == f"/machines/{listed['machine_id']}/observation"
    assert body == core_fixture("controller_observation_with_errors.json")
    # Taken by Core, so the next observation carries neither.
    gateway.request.reset_mock()
    store.set_observed(store.get(listed["machine_id"]), ObservedState.RUNNING, None)
    gateway.report_observations(gateway.machines())
    body = gateway.request.call_args_list[-1].args[1]
    assert "cloud_errors" not in body and "reconciler_errors" not in body
    store.close()


def test_counts_go_once_and_a_failed_post_keeps_them(tmp_path):
    store, gateway, listed = synced_from_core(tmp_path)
    store.set_observed(store.get(listed["machine_id"]), ObservedState.RUNNING, None)
    gateway.errors = ErrorReport()
    gateway.errors.record(StoreError("lost"))
    machines = gateway.machines()

    def refuse(path, body=None):
        if path == "/machines":
            return {"machines": machines}
        raise GatewayError(503)

    working = gateway.request
    gateway.request = Mock(side_effect=refuse)
    gateway.report_observations(machines)
    # Kept, with the failed post counted too.
    assert gateway.errors.fields() == {"reconciler_errors": {"core_api": 1, "state": 1}}
    gateway.request = working
    gateway.report_observations(machines)
    body = gateway.request.call_args_list[-1].args[1]
    assert body["reconciler_errors"] == {"core_api": 1, "state": 1}
    assert gateway.errors.fields() == {}
    store.close()


def test_errors_recorded_while_a_post_is_in_flight_are_kept():
    errors = ErrorReport()
    errors.record(GatewayError(503))
    errors.record(aws("StopInstances", "Throttling"))
    sent = errors.fields()
    errors.record(GatewayError(502))
    errors.record(aws("StopInstances", "Throttling"))
    errors.sent(sent)
    assert errors.fields() == {
        "cloud_errors": [{"call": "stop", "kind": "throttled", "count": 1}],
        "reconciler_errors": {"cloud": 1, "core_api": 1},
    }


def test_a_count_never_passes_cores_cap():
    errors = ErrorReport()
    errors._counts["other"] = 1_000_000
    errors._cloud[("launch", "capacity")] = 1_000_000
    errors.record(ValueError("again"))
    errors.record(aws("RunInstances", "InsufficientInstanceCapacity"))
    fields = errors.fields()
    assert fields["reconciler_errors"]["other"] == 1_000_000
    assert fields["cloud_errors"] == [{"call": "launch", "kind": "capacity", "count": 1_000_000}]


def test_a_failed_machine_preparation_is_counted(tmp_path):
    cfg = config(tmp_path)
    store = open_store(cfg)
    gateway = make_gateway(cfg, store)
    gateway.errors = ErrorReport()
    gateway._record_failure(
        CoreMachine.parse(core_machine(desired_state="stopped")), GatewayError(503)
    )
    assert gateway.errors.fields() == {"reconciler_errors": {"core_api": 1}}
    store.close()


def test_an_older_core_still_gets_its_observations_without_the_counts(
    tmp_path, caplog, monkeypatch
):
    """A Core older than the error fields refuses them as invalid (422): the
    observation goes again without them and the counts wait. They're left off
    for an hour, so each observation isn't posted twice, then tried again.
    It warns once."""
    clock = [1000.0]
    monkeypatch.setattr("switch_hosted_controller.gateway.monotonic", lambda: clock[0])
    store, gateway, listed = synced_from_core(tmp_path)
    store.set_observed(store.get(listed["machine_id"]), ObservedState.RUNNING, None)
    gateway.errors = ErrorReport()
    gateway.errors.record(aws("RunInstances", "InsufficientInstanceCapacity"))
    machines = gateway.machines()
    posted: list[bool] = []

    def older_core(path, body=None):
        if path == "/machines":
            return {"machines": machines}
        carries = "cloud_errors" in body or "reconciler_errors" in body
        posted.append(carries)
        if carries:
            raise GatewayError(422, "Extra inputs are not permitted")
        return {}

    gateway.request = Mock(side_effect=older_core)
    gateway.report_observations(machines)  # refused, then sent without
    clock[0] += 60
    gateway.report_observations(machines)  # resting: sent without, once
    clock[0] += 3600
    gateway.report_observations(machines)  # tried again, refused, sent without
    assert posted == [True, False, False, True, False]
    assert gateway.errors.fields() == {
        "cloud_errors": [{"call": "launch", "kind": "capacity", "count": 1}],
        "reconciler_errors": {"cloud": 1},
    }
    assert caplog.text.count("does not accept the reconciler's error counts") == 1
    store.close()


def test_a_refusal_of_the_observation_itself_is_not_retried(tmp_path):
    store, gateway, listed = synced_from_core(tmp_path)
    store.set_observed(store.get(listed["machine_id"]), ObservedState.RUNNING, None)
    gateway.errors = ErrorReport()
    machines = gateway.machines()
    calls: list[str] = []

    def refuse(path, body=None):
        if path == "/machines":
            return {"machines": machines}
        calls.append(path)
        raise GatewayError(422, "bad")

    gateway.request = Mock(side_effect=refuse)
    gateway.report_observations(machines)
    # No counts to drop, so one post, refused and counted.
    assert len(calls) == 1
    assert gateway.errors.fields() == {"reconciler_errors": {"core_api": 1}}
    store.close()
