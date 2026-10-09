from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid5

import pytest
from test_controller import MACHINE_ID, config

from switch_hosted_controller.gateway import CoreMachine, Gateway, GatewayConfig, GatewayError
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler
from switch_hosted_controller.store import MachineStore

VOLUME_ID = "vol-0123456789abcdef0"
INSTANCE_ID = "i-0123456789abcdef0"


def code(revision: int) -> str:
    return f"swce_SyntheticCodeRevision{revision:04d}"


class FakeCore:
    """Core's controller routes: one machine, a revision, one enrollment code per revision."""

    def __init__(self, machine_id: str):
        self.machine_id = machine_id
        self.state = "provisioning"
        self.revision = 1
        self.desired_state = "running"
        self.retain_until: str | None = None
        self.code_revision: int | None = None
        self.code = ""
        self.prepared_revisions: list[int] = []
        self.observations: list[dict] = []
        self.prepare_failures = 0

    def machine(self, revision: int | None = None) -> dict:
        return {
            "machine_id": self.machine_id,
            "state": self.state,
            "desired_state": self.desired_state,
            "revision": self.revision if revision is None else revision,
            "data_volume_id": None,
            "retain_until": self.retain_until,
            "bundle_revision": self.code_revision,
            "owner_hint": "ignored by the controller",
        }

    def request(self, path: str, body: dict | None = None):
        if path == "/machines":
            return {"machines": [self.machine()], "cursor": "ignored"}
        if path == f"/machines/{self.machine_id}/observation":
            self.observations.append(body or {})
            return {}
        assert path == f"/machines/{self.machine_id}/prepare"
        assert body == {}
        if self.prepare_failures:
            self.prepare_failures -= 1
            raise GatewayError(503)
        if self.code_revision != self.revision:
            self.code_revision = self.revision
            self.code = code(self.revision)
        self.prepared_revisions.append(self.revision)
        return {
            "machine_id": self.machine_id,
            "revision": self.revision,
            "bundle_revision": self.code_revision,
            "api_endpoint": "https://switch.example.test/agent-api",
            "controller": {"id": None, "enrollment_code": self.code},
            "extra": "ignored",
        }

    def sleep(self) -> None:
        self.revision += 1
        self.desired_state = "stopped"

    def wake(self) -> None:
        self.revision += 1
        self.desired_state = "running"


class FakeCloud:
    availability_zone = "us-east-1a"

    def __init__(self, store: MachineStore):
        self.store = store
        self.volume: dict | None = None
        self.instance: dict | None = None
        self.user_data: str | None = None
        self.calls: list[str] = []
        self.codes_at_boot: list[str] = []

    def get_volume(self, machine):
        return self.volume

    def create_volume(self, machine):
        self.calls.append("create_volume")
        self.volume = {
            "VolumeId": VOLUME_ID,
            "AvailabilityZone": self.availability_zone,
            "State": "available",
            "Attachments": [],
        }
        return VOLUME_ID

    def get_instance(self, machine):
        return self.instance

    def validate_image(self, machine):
        pass

    def validate_capacity(self):
        pass

    def _boot(self) -> None:
        assert self.instance is not None and self.volume is not None
        assert self.user_data is not None
        self.codes_at_boot.append(json.loads(self.user_data)["controller"]["enrollmentCode"])
        self.instance["State"] = {"Name": "running"}
        self.volume["State"] = "in-use"
        self.volume["Attachments"] = [
            {"InstanceId": INSTANCE_ID, "Device": "/dev/sdf", "State": "attached"}
        ]

    def run_instance(self, machine):
        self.calls.append("run_instance")
        self.user_data = machine.bundle
        self.instance = {
            "InstanceId": INSTANCE_ID,
            "BlockDeviceMappings": [
                {
                    "DeviceName": "/dev/sdf",
                    "Ebs": {"VolumeId": VOLUME_ID, "DeleteOnTermination": False},
                }
            ],
        }
        self._boot()
        return INSTANCE_ID

    def replace_user_data(self, machine):
        self.calls.append("replace_user_data")
        assert self.instance is not None and self.instance["State"]["Name"] == "stopped"
        self.user_data = machine.bundle

    def start_instance(self, machine):
        self.calls.append("start_instance")
        self._boot()

    def stop_instance(self, machine):
        self.calls.append("stop_instance")
        assert self.instance is not None
        self.instance["State"] = {"Name": "stopped"}


def token(machine_id: str, revision: int) -> str:
    return str(uuid5(NAMESPACE_URL, f"{machine_id}:{revision}"))


def harness(tmp_path):
    cfg = config(tmp_path)
    store = MachineStore(cfg.state_db_path, cfg.fingerprint())
    core = FakeCore(MACHINE_ID)
    gateway = Gateway(
        GatewayConfig("https://switch.example.com", "SYNTHETIC-CONTROLLER", "m6i.large"),
        cfg,
        store,
    )
    gateway.request = core.request
    return store, core, gateway


def sync(gateway: Gateway, core: FakeCore, revision: int | None = None) -> None:
    gateway.sync_machine(CoreMachine.parse(core.machine(revision)))


def stored_bundle(store: MachineStore) -> dict:
    bundle = store.get(MACHINE_ID).bundle
    assert bundle is not None
    return json.loads(bundle)


def launched(tmp_path, *, instance_launch_issued: bool = False):
    store, core, gateway = harness(tmp_path)
    sync(gateway, core)
    store.record_volume(MACHINE_ID, VOLUME_ID, "us-east-1a")
    sync(gateway, core)
    if instance_launch_issued:
        machine = store.mark_instance_launch_intent(store.get(MACHINE_ID))
        machine = store.mark_instance_launch_issued(machine, datetime.now(UTC))
        store.record_instance(MACHINE_ID, INSTANCE_ID, machine.bundle_token)
    assert store.get(MACHINE_ID).instance_launch_issued is instance_launch_issued
    return store, core, gateway


@pytest.mark.parametrize("instance_launch_issued", [False, True])
def test_new_revision_prepares_once_and_records_its_bundle(tmp_path, instance_launch_issued):
    store, core, gateway = launched(tmp_path, instance_launch_issued=instance_launch_issued)
    first = token(core.machine_id, 1)
    assert core.prepared_revisions == [1]
    assert store.get(MACHINE_ID).bundle_token == first
    assert stored_bundle(store)["controller"]["enrollmentCode"] == code(1)

    core.revision = 2
    sync(gateway, core)
    sync(gateway, core)

    second = token(core.machine_id, 2)
    assert core.prepared_revisions == [1, 2]
    bundle = stored_bundle(store)
    assert bundle == {
        "version": 4,
        "installationId": "test-installation",
        "machineId": MACHINE_ID,
        "dataVolumeId": VOLUME_ID,
        "apiEndpoint": "https://switch.example.test/agent-api",
        "controller": {"id": None, "enrollmentCode": code(2)},
    }
    machine = store.get(MACHINE_ID)
    assert machine.required_bundle_token == machine.bundle_token == second
    assert machine.required_bundle_revision == 2
    assert machine.instance_bundle_token == (first if instance_launch_issued else None)
    store.close()


def test_older_revision_is_a_no_op(tmp_path):
    store, core, gateway = launched(tmp_path)
    core.revision = 2
    sync(gateway, core)

    sync(gateway, core, 1)

    assert core.prepared_revisions == [1, 2]
    machine = store.get(MACHINE_ID)
    assert machine.required_bundle_revision == 2
    assert machine.bundle_token == token(core.machine_id, 2)
    assert stored_bundle(store)["controller"]["enrollmentCode"] == code(2)
    store.close()


def test_revision_moved_before_prepare_writes_nothing(tmp_path):
    store, core, gateway = launched(tmp_path)
    core.revision = 3
    sync(gateway, core, 2)
    machine = store.get(MACHINE_ID)
    assert machine.bundle_token == token(core.machine_id, 1)
    assert machine.required_bundle_token == token(core.machine_id, 2)
    assert stored_bundle(store)["controller"]["enrollmentCode"] == code(1)

    sync(gateway, core)
    assert core.prepared_revisions == [1, 3, 3]
    assert store.get(MACHINE_ID).bundle_token == token(core.machine_id, 3)
    assert stored_bundle(store)["controller"]["enrollmentCode"] == code(3)
    store.close()


def test_failed_prepare_keeps_the_previous_bundle_until_a_retry_succeeds(tmp_path):
    store, core, gateway = launched(tmp_path)
    core.revision = 2
    core.prepare_failures = 1
    with pytest.raises(GatewayError):
        sync(gateway, core)
    machine = store.get(MACHINE_ID)
    assert machine.required_bundle_token == token(core.machine_id, 2)
    assert machine.bundle_token == token(core.machine_id, 1)
    assert stored_bundle(store)["controller"]["enrollmentCode"] == code(1)

    sync(gateway, core)
    assert core.prepared_revisions == [1, 2]
    assert store.get(MACHINE_ID).bundle_token == token(core.machine_id, 2)
    assert stored_bundle(store)["controller"]["enrollmentCode"] == code(2)
    store.close()


def test_a_bundle_for_a_superseded_revision_is_not_recorded(tmp_path):
    store, core, gateway = launched(tmp_path)
    store.require_bundle(MACHINE_ID, 2, token(core.machine_id, 2))
    store.record_bundle(MACHINE_ID, token(core.machine_id, 1), '{"stale":true}')
    machine = store.get(MACHINE_ID)
    assert machine.bundle_token == token(core.machine_id, 1)
    assert stored_bundle(store)["controller"]["enrollmentCode"] == code(1)
    store.close()


def test_sleep_wake_refreshes_the_bundle_before_the_instance_starts(tmp_path):
    store, core, gateway = harness(tmp_path)
    cloud = FakeCloud(store)
    reconciler = Reconciler(store, cloud)

    def poll() -> None:
        gateway.sync_machines(gateway.machines())
        reconciler.reconcile_all()
        gateway.report_observations(gateway.machines())

    for _ in range(4):
        poll()
    first = token(core.machine_id, 1)
    machine = store.get(MACHINE_ID)
    assert machine.observed_state is ObservedState.RUNNING
    assert machine.instance_bundle_token == first
    assert cloud.codes_at_boot == [code(1)]
    assert core.observations[-1] == {
        "state": "running",
        "revision": 1,
        "error": None,
        "error_code": None,
        "data_volume_id": VOLUME_ID,
        "instance_id": INSTANCE_ID,
        "instance_type": "m6i.large",
    }

    core.sleep()
    poll()
    poll()
    assert store.get(MACHINE_ID).desired_state is DesiredState.STOPPED
    assert cloud.instance is not None and cloud.instance["State"]["Name"] == "stopped"
    assert core.observations[-1]["state"] == "stopped"
    assert core.observations[-1]["revision"] == 2

    core.wake()
    core.prepare_failures = 1
    poll()
    assert store.get(MACHINE_ID).desired_state is DesiredState.RUNNING
    assert "replace_user_data" not in cloud.calls
    assert cloud.calls.count("start_instance") == 0
    assert cloud.instance["State"]["Name"] == "stopped"
    assert core.observations[-1]["state"] == "provisioning"
    assert store.get(MACHINE_ID).bundle_token == first

    poll()
    woken = token(core.machine_id, 3)
    assert core.prepared_revisions == [1, 3]
    assert cloud.calls[-2:] == ["replace_user_data", "start_instance"]
    assert cloud.codes_at_boot == [code(1), code(3)]
    assert json.loads(cloud.user_data) == stored_bundle(store)
    assert store.get(MACHINE_ID).instance_bundle_token == woken
    poll()
    machine = store.get(MACHINE_ID)
    assert machine.observed_state is ObservedState.RUNNING
    assert machine.instance_launch_issued
    assert cloud.calls.count("replace_user_data") == 1
    store.close()
