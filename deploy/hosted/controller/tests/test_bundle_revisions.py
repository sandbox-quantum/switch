from __future__ import annotations

import json
from unittest.mock import patch
from uuid import UUID, uuid4, uuid5

import pytest
from botocore.exceptions import ClientError
from test_controller import config
from test_gateway import load_worker, prepared_launch

from switch_hosted_controller.gateway import Gateway, GatewayConfig, GatewayError
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler
from switch_hosted_controller.store import AgentStore

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
    """Core's controller routes: one launch, a revision, one capability per revision."""

    def __init__(self, request_id: str):
        self.request_id = request_id
        self.revision = 1
        self.desired_state = "running"
        self.capability_revision: int | None = None
        self.capability = ""
        self.prepared_revisions: list[int] = []
        self.observations: list[dict] = []
        self.prepare_failures = 0

    def job(self, revision: int | None = None) -> dict:
        return {
            "request_id": self.request_id,
            "agent_id": "agent-1",
            "state": "provisioning",
            "desired_state": self.desired_state,
            "revision": self.revision if revision is None else revision,
        }

    def request(self, path: str, body: dict | None = None):
        if path == "":
            return [self.job()]
        if path.endswith("/observation"):
            self.observations.append(body or {})
            return {}
        assert path == f"/{self.request_id}/prepare"
        if self.prepare_failures:
            self.prepare_failures -= 1
            raise GatewayError(503)
        if self.capability_revision != self.revision:
            self.capability_revision = self.revision
            self.capability = f"SYNTHETIC-CAPABILITY-REVISION-{self.revision:04d}"
        self.prepared_revisions.append(self.revision)
        return prepared_launch(revision=self.revision, worker_capability=self.capability)

    def sleep(self) -> None:
        self.revision += 1
        self.desired_state = "stopped"

    def wake(self) -> None:
        self.revision += 1
        self.desired_state = "running"


class FakeCloud:
    availability_zone = "us-east-1a"

    def __init__(self, store: AgentStore):
        self.store = store
        self.volume: dict | None = None
        self.instance: dict | None = None
        self.calls: list[str] = []
        self.bundles_at_boot: list[str | None] = []

    def get_volume(self, agent):
        return self.volume

    def create_volume(self, agent):
        self.calls.append("create_volume")
        self.volume = {
            "VolumeId": VOLUME_ID,
            "AvailabilityZone": self.availability_zone,
            "State": "available",
            "Attachments": [],
        }
        return VOLUME_ID

    def get_instance(self, agent):
        return self.instance

    def validate_image(self, agent):
        pass

    def validate_capacity(self):
        pass

    def _boot(self, agent) -> None:
        current = self.store.get(agent.agent_id)
        assert current.bundle_token == current.required_bundle_token
        self.bundles_at_boot.append(current.bundle_token)
        assert self.instance is not None and self.volume is not None
        self.instance["State"] = {"Name": "running"}
        self.volume["State"] = "in-use"
        self.volume["Attachments"] = [
            {"InstanceId": INSTANCE_ID, "Device": "/dev/sdf", "State": "attached"}
        ]

    def run_instance(self, agent):
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
        self._boot(agent)
        return INSTANCE_ID

    def start_instance(self, agent):
        self.calls.append("start_instance")
        self._boot(agent)

    def stop_instance(self, agent):
        self.calls.append("stop_instance")
        assert self.instance is not None
        self.instance["State"] = {"Name": "stopped"}


def token(request_id: str, revision: int) -> str:
    return str(uuid5(UUID(request_id), str(revision)))


def harness(tmp_path):
    cfg = config(tmp_path)
    store = AgentStore(cfg.state_db_path, cfg.fingerprint())
    secrets = FakeSecrets()
    core = FakeCore(str(uuid4()))
    gateway = Gateway(
        GatewayConfig("https://switch.example.com", "SYNTHETIC-CONTROLLER", "m6i.large"),
        cfg,
        store,
        secrets,
    )
    gateway.request = core.request
    return store, secrets, core, gateway


def launched(tmp_path, *, instance_launch_issued: bool = False):
    store, secrets, core, gateway = harness(tmp_path)
    gateway.accept_launch(core.job())
    store.record_volume("agent-1", VOLUME_ID, "us-east-1a")
    gateway.accept_launch(core.job())
    if instance_launch_issued:
        agent = store.mark_instance_launch_intent(store.get("agent-1"))
        agent = store.mark_instance_launch_issued(agent)
        store.record_instance("agent-1", INSTANCE_ID)
    assert store.get("agent-1").instance_launch_issued is instance_launch_issued
    return store, secrets, core, gateway


@pytest.mark.parametrize("instance_launch_issued", [False, True])
def test_new_revision_prepares_once_and_writes_one_current_version(
    tmp_path, instance_launch_issued
):
    store, secrets, core, gateway = launched(
        tmp_path, instance_launch_issued=instance_launch_issued
    )
    first = token(core.request_id, 1)
    assert core.prepared_revisions == [1]
    assert [put["token"] for put in secrets.puts] == [first]

    core.revision = 2
    gateway.accept_launch(core.job())
    gateway.accept_launch(core.job())

    second = token(core.request_id, 2)
    assert core.prepared_revisions == [1, 2]
    assert [put["token"] for put in secrets.puts] == [first, second]
    assert secrets.versions[second]["stages"] == {"AWSCURRENT"}
    assert secrets.versions[first]["stages"] == set()
    version_id, bundle = secrets.current()
    assert version_id == second
    assert bundle["deployment"]["revision"] == 2
    assert bundle["workerCapability"] == "SYNTHETIC-CAPABILITY-REVISION-0002"
    agent = store.get("agent-1")
    assert agent.required_bundle_token == agent.bundle_token == second
    assert agent.required_bundle_revision == 2
    store.close()


def test_older_revision_is_a_no_op(tmp_path):
    store, secrets, core, gateway = launched(tmp_path)
    core.revision = 2
    gateway.accept_launch(core.job())

    gateway.accept_launch(core.job(revision=1))

    assert core.prepared_revisions == [1, 2]
    assert len(secrets.puts) == 2
    assert secrets.promotions == []
    assert secrets.current()[0] == token(core.request_id, 2)
    agent = store.get("agent-1")
    assert agent.required_bundle_revision == 2
    assert agent.bundle_token == token(core.request_id, 2)
    store.close()


def test_revision_moved_before_prepare_writes_nothing(tmp_path):
    store, secrets, core, gateway = launched(tmp_path)
    core.revision = 3
    gateway.accept_launch(core.job(revision=2))
    assert len(secrets.puts) == 1
    assert secrets.current()[0] == token(core.request_id, 1)
    agent = store.get("agent-1")
    assert agent.bundle_token == token(core.request_id, 1)
    assert agent.required_bundle_token == token(core.request_id, 2)

    gateway.accept_launch(core.job())
    assert core.prepared_revisions == [1, 3, 3]
    assert secrets.current()[0] == token(core.request_id, 3)
    assert store.get("agent-1").bundle_token == token(core.request_id, 3)
    store.close()


def test_bundle_present_but_not_current_is_promoted(tmp_path):
    store, secrets, core, gateway = launched(tmp_path)
    second = token(core.request_id, 2)
    secrets.versions[second] = {"string": "{}", "stages": set()}
    core.revision = 2

    gateway.accept_launch(core.job())

    assert core.prepared_revisions == [1]
    assert secrets.promotions == [
        {"MoveToVersionId": second, "RemoveFromVersionId": token(core.request_id, 1)}
    ]
    assert secrets.current()[0] == second
    assert store.get("agent-1").bundle_token == second
    store.close()


def test_lost_put_response_and_resource_exists_retry_keep_one_version(tmp_path):
    store, secrets, core, gateway = launched(tmp_path)
    core.revision = 2
    secrets.lose_put_response = True
    with pytest.raises(ConnectionError):
        gateway.accept_launch(core.job())
    second = token(core.request_id, 2)
    assert store.get("agent-1").bundle_token == token(core.request_id, 1)

    original = secrets.describe_secret
    with patch.object(
        secrets, "describe_secret", side_effect=[{"VersionIdsToStages": {}}, original(SecretId="")]
    ):
        gateway.accept_launch(core.job())

    assert [put["token"] for put in secrets.puts].count(second) == 1
    assert secrets.current()[1]["workerCapability"] == "SYNTHETIC-CAPABILITY-REVISION-0002"
    assert store.get("agent-1").bundle_token == second
    store.close()


def test_sleep_wake_same_request_id_refreshes_bundle(tmp_path):
    store, secrets, core, gateway = harness(tmp_path)
    cloud = FakeCloud(store)
    reconciler = Reconciler(store, cloud)
    worker = load_worker()
    marker = tmp_path / "obsolete-bundle"
    worker_secrets = worker.SecretsManager("us-east-1", client=secrets)

    def poll() -> None:
        gateway.accept_launches()
        reconciler.reconcile_all()
        gateway.report_observations()

    for _ in range(4):
        poll()
    assert store.get("agent-1").observed_state is ObservedState.RUNNING
    first = token(core.request_id, 1)
    raw, booted = worker.await_current_bundle(worker_secrets, "assignment", marker)
    assert booted == first
    assert json.loads(raw)["workerCapability"] == "SYNTHETIC-CAPABILITY-REVISION-0001"

    core.sleep()
    poll()
    poll()
    assert store.get("agent-1").desired_state is DesiredState.STOPPED
    assert cloud.instance is not None and cloud.instance["State"]["Name"] == "stopped"

    core.wake()
    core.prepare_failures = 1
    poll()
    assert store.get("agent-1").desired_state is DesiredState.RUNNING
    assert cloud.calls.count("start_instance") == 0
    assert cloud.instance["State"]["Name"] == "stopped"
    assert core.observations[-1]["state"] == "provisioning"

    worker.record_obsolete_bundle(marker, booted)
    polls: list[float] = []

    def controller_poll_while_worker_waits(seconds: float) -> None:
        polls.append(seconds)
        poll()

    with patch.object(worker.time, "sleep", side_effect=controller_poll_while_worker_waits):
        raw, version_id = worker.await_current_bundle(worker_secrets, "assignment", marker)

    woken = token(core.request_id, 3)
    assert polls == [worker.OBSOLETE_POLL_SECONDS]
    assert version_id == woken
    assert json.loads(raw)["workerCapability"] == "SYNTHETIC-CAPABILITY-REVISION-0003"
    assert json.loads(raw)["deployment"]["revision"] == 3
    assert not marker.exists()
    assert core.prepared_revisions == [1, 3]
    assert [put["token"] for put in secrets.puts] == [first, woken]
    assert cloud.calls.count("start_instance") == 1
    assert cloud.bundles_at_boot == [first, woken]
    poll()
    agent = store.get("agent-1")
    assert agent.observed_state is ObservedState.RUNNING
    assert agent.instance_launch_issued
    store.close()
