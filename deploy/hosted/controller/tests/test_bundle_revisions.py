from __future__ import annotations

import json
from datetime import UTC, datetime
from unittest.mock import patch
from uuid import NAMESPACE_URL, uuid5

import pytest
from botocore.exceptions import ClientError
from test_controller import MACHINE_ID, config

from switch_hosted_controller.config import ConfigError
from switch_hosted_controller.gateway import CoreMachine, Gateway, GatewayConfig, GatewayError
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler
from switch_hosted_controller.store import MachineStore

VOLUME_ID = "vol-0123456789abcdef0"
INSTANCE_ID = "i-0123456789abcdef0"


class FakeSecrets:
    def __init__(self):
        self.versions: dict[str, dict] = {}
        self.puts: list[dict] = []
        self.promotions: list[dict] = []
        self.lose_put_response = False

    def describe_secret(self, SecretId):
        return {
            "VersionIdsToStages": {
                token: list(version["stages"]) for token, version in self.versions.items()
            }
        }

    def put_secret_value(self, SecretId, ClientRequestToken, SecretString):
        existing = self.versions.get(ClientRequestToken)
        if existing is not None:
            if existing["string"] != SecretString:
                raise ClientError({"Error": {"Code": "ResourceExistsException"}}, "PutSecretValue")
            return {"VersionId": ClientRequestToken}
        self.puts.append({"token": ClientRequestToken, "string": SecretString})
        for version in self.versions.values():
            version["stages"].discard("AWSCURRENT")
        self.versions[ClientRequestToken] = {"string": SecretString, "stages": {"AWSCURRENT"}}
        if self.lose_put_response:
            self.lose_put_response = False
            raise ConnectionError("Simulated lost PutSecretValue response")
        return {"VersionId": ClientRequestToken}

    def update_secret_version_stage(self, SecretId, VersionStage, MoveToVersionId, **kwargs):
        self.promotions.append({"MoveToVersionId": MoveToVersionId, **kwargs})
        for version in self.versions.values():
            version["stages"].discard(VersionStage)
        self.versions[MoveToVersionId]["stages"].add(VersionStage)

    def get_secret_value(self, SecretId, VersionStage):
        for token, version in self.versions.items():
            if VersionStage in version["stages"]:
                return {"SecretString": version["string"], "VersionId": token}
        raise ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "GetSecretValue")

    def current(self) -> tuple[str, dict]:
        response = self.get_secret_value(SecretId="assignment", VersionStage="AWSCURRENT")
        return response["VersionId"], json.loads(response["SecretString"])


class FakeCore:
    """Core's controller routes: one machine, a revision, one capability per revision."""

    def __init__(self, machine_id: str):
        self.machine_id = machine_id
        self.slot_id = "slot-1"
        self.generation = 1
        self.state = "provisioning"
        self.revision = 1
        self.desired_state = "running"
        self.retain_until: str | None = None
        self.capability_revision: int | None = None
        self.capability = ""
        self.prepared_revisions: list[int] = []
        self.observations: list[dict] = []
        self.prepare_failures = 0

    def machine(self, revision: int | None = None) -> dict:
        return {
            "machine_id": self.machine_id,
            "slot_id": self.slot_id,
            "generation": self.generation,
            "state": self.state,
            "desired_state": self.desired_state,
            "revision": self.revision if revision is None else revision,
            "data_volume_id": None,
            "retain_until": self.retain_until,
            "bundle_revision": self.capability_revision,
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
        if self.capability_revision != self.revision:
            self.capability_revision = self.revision
            self.capability = f"SYNTHETIC-CAPABILITY-REVISION-{self.revision:04d}"
        self.prepared_revisions.append(self.revision)
        return {
            "machine_id": self.machine_id,
            "slot_id": self.slot_id,
            "generation": self.generation,
            "revision": self.revision,
            "bundle_revision": self.capability_revision,
            "machine_capability": self.capability,
            "api_endpoint": "https://switch.example.test/agent-api",
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
        self.calls: list[str] = []
        self.bundles_at_boot: list[str | None] = []

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

    def _boot(self, machine) -> None:
        current = self.store.get(machine.machine_id)
        assert current.bundle_token == current.required_bundle_token
        self.bundles_at_boot.append(current.bundle_token)
        assert self.instance is not None and self.volume is not None
        self.instance["State"] = {"Name": "running"}
        self.volume["State"] = "in-use"
        self.volume["Attachments"] = [
            {"InstanceId": INSTANCE_ID, "Device": "/dev/sdf", "State": "attached"}
        ]

    def run_instance(self, machine):
        self.calls.append("run_instance")
        self.instance = {
            "InstanceId": INSTANCE_ID,
            "BlockDeviceMappings": [
                {
                    "DeviceName": "/dev/sdf",
                    "Ebs": {"VolumeId": VOLUME_ID, "DeleteOnTermination": False},
                }
            ],
        }
        self._boot(machine)
        return INSTANCE_ID

    def start_instance(self, machine):
        self.calls.append("start_instance")
        self._boot(machine)

    def stop_instance(self, machine):
        self.calls.append("stop_instance")
        assert self.instance is not None
        self.instance["State"] = {"Name": "stopped"}


def token(machine_id: str, revision: int) -> str:
    return str(uuid5(NAMESPACE_URL, f"{machine_id}:{revision}"))


def harness(tmp_path):
    cfg = config(tmp_path)
    store = MachineStore(cfg.state_db_path, cfg.fingerprint())
    secrets = FakeSecrets()
    core = FakeCore(MACHINE_ID)
    gateway = Gateway(
        GatewayConfig("https://switch.example.com", "SYNTHETIC-CONTROLLER", "m6i.large"),
        cfg,
        store,
        secrets,
    )
    gateway.request = core.request
    return store, secrets, core, gateway


def sync(gateway: Gateway, core: FakeCore, revision: int | None = None) -> None:
    gateway.sync_machine(CoreMachine.parse(core.machine(revision)))


def launched(tmp_path, *, instance_launch_issued: bool = False):
    store, secrets, core, gateway = harness(tmp_path)
    sync(gateway, core)
    store.record_volume(MACHINE_ID, VOLUME_ID, "us-east-1a")
    sync(gateway, core)
    if instance_launch_issued:
        machine = store.mark_instance_launch_intent(store.get(MACHINE_ID))
        machine = store.mark_instance_launch_issued(machine, datetime.now(UTC))
        store.record_instance(MACHINE_ID, INSTANCE_ID)
    assert store.get(MACHINE_ID).instance_launch_issued is instance_launch_issued
    return store, secrets, core, gateway


@pytest.mark.parametrize("instance_launch_issued", [False, True])
def test_new_revision_prepares_once_and_writes_one_current_version(
    tmp_path, instance_launch_issued
):
    store, secrets, core, gateway = launched(
        tmp_path, instance_launch_issued=instance_launch_issued
    )
    first = token(core.machine_id, 1)
    assert core.prepared_revisions == [1]
    assert [put["token"] for put in secrets.puts] == [first]

    core.revision = 2
    sync(gateway, core)
    sync(gateway, core)

    second = token(core.machine_id, 2)
    assert core.prepared_revisions == [1, 2]
    assert [put["token"] for put in secrets.puts] == [first, second]
    assert secrets.versions[second]["stages"] == {"AWSCURRENT"}
    assert secrets.versions[first]["stages"] == set()
    version_id, bundle = secrets.current()
    assert version_id == second
    assert bundle["machineCapability"] == "SYNTHETIC-CAPABILITY-REVISION-0002"
    assert bundle["assignment"]["dataVolumeId"] == VOLUME_ID
    machine = store.get(MACHINE_ID)
    assert machine.required_bundle_token == machine.bundle_token == second
    assert machine.required_bundle_revision == 2
    store.close()


def test_older_revision_is_a_no_op(tmp_path):
    store, secrets, core, gateway = launched(tmp_path)
    core.revision = 2
    sync(gateway, core)

    sync(gateway, core, 1)

    assert core.prepared_revisions == [1, 2]
    assert len(secrets.puts) == 2
    assert secrets.promotions == []
    assert secrets.current()[0] == token(core.machine_id, 2)
    machine = store.get(MACHINE_ID)
    assert machine.required_bundle_revision == 2
    assert machine.bundle_token == token(core.machine_id, 2)
    store.close()


def test_revision_moved_before_prepare_writes_nothing(tmp_path):
    store, secrets, core, gateway = launched(tmp_path)
    core.revision = 3
    sync(gateway, core, 2)
    assert len(secrets.puts) == 1
    assert secrets.current()[0] == token(core.machine_id, 1)
    machine = store.get(MACHINE_ID)
    assert machine.bundle_token == token(core.machine_id, 1)
    assert machine.required_bundle_token == token(core.machine_id, 2)

    sync(gateway, core)
    assert core.prepared_revisions == [1, 3, 3]
    assert secrets.current()[0] == token(core.machine_id, 3)
    assert store.get(MACHINE_ID).bundle_token == token(core.machine_id, 3)
    store.close()


def test_bundle_present_but_not_current_is_promoted(tmp_path):
    store, secrets, core, gateway = launched(tmp_path)
    second = token(core.machine_id, 2)
    secrets.versions[second] = {"string": "{}", "stages": set()}
    core.revision = 2

    sync(gateway, core)

    assert core.prepared_revisions == [1]
    assert secrets.promotions == [
        {"MoveToVersionId": second, "RemoveFromVersionId": token(core.machine_id, 1)}
    ]
    assert secrets.current()[0] == second
    assert store.get(MACHINE_ID).bundle_token == second
    store.close()


def test_lost_put_response_and_resource_exists_retry_keep_one_version(tmp_path):
    store, secrets, core, gateway = launched(tmp_path)
    core.revision = 2
    secrets.lose_put_response = True
    with pytest.raises(ConnectionError):
        sync(gateway, core)
    second = token(core.machine_id, 2)
    assert store.get(MACHINE_ID).bundle_token == token(core.machine_id, 1)

    original = secrets.describe_secret
    with patch.object(
        secrets, "describe_secret", side_effect=[{"VersionIdsToStages": {}}, original(SecretId="")]
    ):
        sync(gateway, core)

    assert [put["token"] for put in secrets.puts].count(second) == 1
    assert secrets.current()[1]["machineCapability"] == "SYNTHETIC-CAPABILITY-REVISION-0002"
    assert store.get(MACHINE_ID).bundle_token == second
    store.close()


def test_sleep_wake_refreshes_the_bundle_before_the_instance_starts(tmp_path):
    store, secrets, core, gateway = harness(tmp_path)
    cloud = FakeCloud(store)
    reconciler = Reconciler(store, cloud)

    def poll() -> None:
        gateway.sync_machines(gateway.machines())
        reconciler.reconcile_all()
        gateway.report_observations(gateway.machines())

    for _ in range(4):
        poll()
    assert store.get(MACHINE_ID).observed_state is ObservedState.RUNNING
    first = token(core.machine_id, 1)
    booted, bundle = secrets.current()
    assert booted == first
    assert bundle["machineCapability"] == "SYNTHETIC-CAPABILITY-REVISION-0001"
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
    assert cloud.calls.count("start_instance") == 0
    assert cloud.instance["State"]["Name"] == "stopped"
    assert core.observations[-1]["state"] == "provisioning"
    assert secrets.current()[0] == first

    poll()
    woken = token(core.machine_id, 3)
    version_id, bundle = secrets.current()
    assert version_id == woken
    assert bundle["machineCapability"] == "SYNTHETIC-CAPABILITY-REVISION-0003"
    assert core.prepared_revisions == [1, 3]
    assert [put["token"] for put in secrets.puts] == [first, woken]
    assert cloud.calls.count("start_instance") == 1
    assert cloud.bundles_at_boot == [first, woken]
    poll()
    machine = store.get(MACHINE_ID)
    assert machine.observed_state is ObservedState.RUNNING
    assert machine.instance_launch_issued
    store.close()


def test_existing_bundle_version_with_different_content_fails_loud(tmp_path):
    store, secrets, core, gateway = harness(tmp_path)
    sync(gateway, core)
    store.record_volume(MACHINE_ID, VOLUME_ID, "us-east-1a")
    first = token(core.machine_id, 1)
    secrets.versions["older"] = {"string": '{"stale":true}', "stages": {"AWSCURRENT"}}
    describe = secrets.describe_secret

    def describe_before_the_racing_write(SecretId):
        response = describe(SecretId=SecretId)
        secrets.versions[first] = {"string": '{"conflicting":true}', "stages": set()}
        return response

    secrets.describe_secret = describe_before_the_racing_write
    with pytest.raises(ConfigError, match="different bundle"):
        sync(gateway, core)
    assert secrets.promotions == []
    assert secrets.current()[0] == "older"
    assert store.get(MACHINE_ID).bundle_token is None
    store.close()
