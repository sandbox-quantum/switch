from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from test_bundle_revisions import FakeSecrets, token
from test_controller import CORE_FIXTURES, MACHINE_ID, config_dict, ec2_client
from test_kms_grants import CONTEXT, KEY_ARN, FakeKms

from switch_hosted_controller.cloud import CloudResourceError, Ec2Cloud
from switch_hosted_controller.config import ConfigError, ControllerConfig
from switch_hosted_controller.gateway import CoreMachine, Gateway, GatewayConfig
from switch_hosted_controller.kms_grants import KmsGrants
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler
from switch_hosted_controller.store import MachineStore

CONTROLLER_IMAGE = "ami-0c0c0c0c0c0c0c0c0"
NEW_CONTROLLER_IMAGE = "ami-0d0d0d0d0d0d0d0d0"
CONTROLLER_ID = CONTEXT["switch:controller_id"]
CREDENTIAL = "swcc_SYNTHETIC-CONTROLLER-CREDENTIAL-0001"
VOLUME_ID = "vol-0123456789abcdef0"
ROLE_ARN = "arn:aws:iam::123456789012:role/worker-1"
CORE_PREPARE = json.loads((CORE_FIXTURES / "prepare_controller_response.json").read_text())


def controller_dict(tmp_path: Path, *, max_machines: int = 1) -> dict:
    raw = config_dict(tmp_path, max_machines=max_machines)
    raw["image_id"] = CONTROLLER_IMAGE
    return raw


def controller_config(tmp_path: Path) -> ControllerConfig:
    return ControllerConfig.from_dict(controller_dict(tmp_path))


class ImageGate:
    """The image lookup of Ec2Cloud: images tagged with their capabilities."""

    def __init__(self, events: list[str]):
        self.capabilities = {
            CONTROLLER_IMAGE: {"controller-v1"},
            NEW_CONTROLLER_IMAGE: {"controller-v1"},
        }
        self.calls: list[str] = []
        self.events = events

    def validate_image(self, image_id: str) -> None:
        self.calls.append(image_id)
        self.events.append("validate_image")
        if "controller-v1" not in self.capabilities.get(image_id, set()):
            raise CloudResourceError("configured AMI lacks capabilities")


class ControllerCore:
    """Core's prepare for one machine."""

    def __init__(self):
        self.revision = 1
        self.desired_state = "running"
        self.prepared: dict = {}

    def machine(self) -> dict:
        return {
            "machine_id": MACHINE_ID,
            "slot_id": "slot-1",
            "generation": 1,
            "state": "provisioning",
            "desired_state": self.desired_state,
            "revision": self.revision,
            "data_volume_id": VOLUME_ID,
            "retain_until": None,
        }

    def prepare(self) -> dict:
        prepared = {
            "machine_id": MACHINE_ID,
            "slot_id": "slot-1",
            "generation": 1,
            "revision": self.revision,
            "bundle_revision": self.revision,
            "api_endpoint": "https://switch.example.test/agent-api",
            "runtime": "controller",
            "controller": {"id": CONTROLLER_ID, "credential": CREDENTIAL},
            "kms": {"key_arn": KEY_ARN, "region": "us-east-1", "context": dict(CONTEXT)},
        }
        prepared.update(self.prepared)
        return prepared

    def request(self, path: str, body: dict | None = None):
        if path == "/machines":
            return {"machines": [self.machine()]}
        if path.endswith("/observation"):
            return {}
        assert path == f"/machines/{MACHINE_ID}/prepare"
        return self.prepare()


class Harness:
    def __init__(self, tmp_path: Path):
        self.cfg = controller_config(tmp_path)
        self.store = MachineStore(self.cfg.state_db_path, self.cfg.fingerprint())
        self.events: list[str] = []
        self.secrets = FakeSecrets()
        put = self.secrets.put_secret_value

        def recorded_put(**kwargs):
            self.events.append("put_secret_value")
            return put(**kwargs)

        self.secrets.put_secret_value = recorded_put
        self.kms = FakeKms()
        create = self.kms.create_grant

        def recorded_create(**kwargs):
            self.events.append("create_grant")
            return create(**kwargs)

        self.kms.create_grant = recorded_create
        self.images = ImageGate(self.events)
        self.core = ControllerCore()
        grants = KmsGrants(self.kms, KEY_ARN, self.store)
        self.gateway = Gateway(
            GatewayConfig("https://switch.example.test", "SYNTHETIC-CONTROLLER", "m6i.large"),
            self.cfg,
            self.store,
            self.secrets,
            self.images,
            grants,
        )
        self.gateway.request = self.core.request

    def sync(self) -> None:
        self.gateway.sync_machine(CoreMachine.parse(self.core.machine()))

    def bundle(self) -> dict:
        return self.secrets.current()[1]

    def configure(self, **changes) -> None:
        self.cfg = replace(self.cfg, **changes)
        self.gateway.config = self.cfg

    def close(self) -> None:
        self.store.close()


@pytest.fixture
def harness(tmp_path):
    result = Harness(tmp_path)
    yield result
    result.close()


def expected_bundle(grant_token: str) -> dict:
    return {
        "version": 3,
        "machineId": MACHINE_ID,
        "assignment": {
            "installationId": "test-installation",
            "slotId": "slot-1",
            "generation": 1,
            "dataVolumeId": VOLUME_ID,
        },
        "apiEndpoint": "https://switch.example.test/agent-api",
        "controller": {"id": CONTROLLER_ID, "credential": CREDENTIAL},
        "kms": {
            "keyArn": KEY_ARN,
            "region": "us-east-1",
            "grantTokens": [grant_token],
            "context": CONTEXT,
        },
    }


def test_prepare_writes_bundle_v3_after_the_grant(harness):
    harness.sync()

    [grant] = harness.kms.grants
    record = harness.store.grant("slot-1", 1)
    assert harness.bundle() == expected_bundle(record.grant_token)
    assert "machineCapability" not in harness.bundle()
    assert harness.events == ["validate_image", "create_grant", "put_secret_value"]
    assert harness.images.calls == [CONTROLLER_IMAGE]
    assert grant["GranteePrincipal"] == ROLE_ARN
    assert grant["Operations"] == ["Decrypt"]
    assert grant["Constraints"] == {"EncryptionContextSubset": CONTEXT}
    assert grant["Name"] == "switch-slot-1-g1"
    assert record.grant_id == grant["GrantId"]
    machine = harness.store.get(MACHINE_ID)
    assert machine.bundle_token == token(MACHINE_ID, 1)
    assert (machine.image_id, machine.target_image_id) == (CONTROLLER_IMAGE, None)


def _shape(value):
    if isinstance(value, dict):
        return {key: _shape(item) for key, item in value.items()}
    return type(value).__name__


def test_harness_serves_cores_prepare_shape(harness):
    assert _shape(harness.core.prepare()) == _shape(CORE_PREPARE)


def test_cores_prepare_response_makes_a_v3_bundle(harness):
    prepared = json.loads(json.dumps(CORE_PREPARE))
    prepared["slot_id"] = "slot-1"
    prepared["kms"]["key_arn"] = KEY_ARN
    harness.core.prepared = prepared

    harness.sync()

    record = harness.store.grant("slot-1", 1)
    assert harness.bundle() == {
        **expected_bundle(record.grant_token),
        "apiEndpoint": CORE_PREPARE["api_endpoint"],
        "controller": CORE_PREPARE["controller"],
        "kms": {
            "keyArn": KEY_ARN,
            "region": CORE_PREPARE["kms"]["region"],
            "grantTokens": [record.grant_token],
            "context": CORE_PREPARE["kms"]["context"],
        },
    }


def test_v3_is_refused_when_core_seals_logins_in_another_region(harness, caplog):
    harness.core.prepared = {
        "kms": {"key_arn": KEY_ARN, "region": "eu-west-1", "context": dict(CONTEXT)}
    }
    with caplog.at_level(logging.ERROR):
        harness.gateway.sync_machines([harness.core.machine()])
    assert "login key region other than the configured one" in caplog.text
    assert "create_grant" not in harness.events
    assert harness.secrets.puts == []


def test_v3_is_refused_unless_the_image_passes_the_capability_gate(harness):
    harness.images.capabilities[CONTROLLER_IMAGE] = set()
    with pytest.raises(CloudResourceError):
        harness.sync()
    assert harness.events == ["validate_image"]
    assert harness.kms.grants == []
    assert harness.secrets.puts == []
    machine = harness.store.get(MACHINE_ID)
    assert machine.bundle_token is None


@pytest.mark.parametrize(
    ("prepared", "message"),
    [
        (
            {
                "kms": {
                    "key_arn": KEY_ARN.replace("aa", "bb"),
                    "region": "us-east-1",
                    "context": CONTEXT,
                }
            },
            "login key",
        ),
        (
            {
                "kms": {
                    "key_arn": KEY_ARN,
                    "region": "us-east-1",
                    "context": {**CONTEXT, "switch:controller_id": "x"},
                }
            },
            "another controller",
        ),
        (
            {"kms": {"key_arn": KEY_ARN, "region": "us-east-1", "context": {**CONTEXT, "x": "x"}}},
            "context",
        ),
        ({"kms": {"key_arn": KEY_ARN, "region": "eu-west-1", "context": CONTEXT}}, "region"),
        ({"kms": {"key_arn": KEY_ARN, "context": CONTEXT}}, "login key"),
        (
            {"kms": {"key_arn": KEY_ARN, "region": "us-east-1", "context": CONTEXT, "x": "x"}},
            "login key",
        ),
        ({"kms": None}, "login key"),
        ({"controller": {"id": CONTROLLER_ID, "credential": "swct_" + "x" * 32}}, "credential"),
        ({"controller": {"id": CONTROLLER_ID, "credential": "swcc_short"}}, "credential"),
        ({"controller": {"id": "has space", "credential": CREDENTIAL}}, "controller id"),
        ({"controller": {"id": CONTROLLER_ID}}, "controller"),
        ({"api_endpoint": "http://switch.example.test"}, "API endpoint"),
        ({"runtime": "lambda"}, "runtime"),
        ({"runtime": "worker"}, "runtime"),
        ({"runtime": None}, "runtime"),
    ],
)
def test_invalid_controller_preparation_writes_nothing(harness, prepared, message):
    harness.core.prepared = prepared
    with pytest.raises(ConfigError, match=message):
        harness.sync()
    assert "create_grant" not in harness.events
    assert harness.secrets.puts == []


def test_lost_put_response_rewrites_the_identical_bundle(harness):
    harness.secrets.lose_put_response = True
    with pytest.raises(ConnectionError):
        harness.sync()
    first = harness.bundle()

    original = harness.secrets.describe_secret
    with patch.object(
        harness.secrets,
        "describe_secret",
        side_effect=[{"VersionIdsToStages": {}}, original(SecretId="")],
    ):
        harness.sync()

    assert len(harness.secrets.puts) == 1
    assert harness.bundle() == first
    assert len(harness.kms.grants) == 1
    assert harness.store.get(MACHINE_ID).bundle_token == token(MACHINE_ID, 1)


def test_new_revision_reuses_the_generation_grant(harness):
    harness.sync()
    first_grant = harness.store.grant("slot-1", 1)
    harness.core.revision = 2
    harness.sync()
    assert harness.events.count("create_grant") == 1
    assert len(harness.kms.grants) == 1
    assert harness.bundle()["kms"]["grantTokens"] == [first_grant.grant_token]
    assert harness.secrets.current()[0] == token(MACHINE_ID, 2)


@pytest.mark.parametrize("desired", ["retained", "deleted"])
def test_retain_or_delete_retires_the_generation_grant(harness, desired):
    harness.sync()
    [grant] = harness.kms.grants
    harness.core.revision = 2
    harness.core.desired_state = desired
    harness.sync()
    assert harness.kms.revoked == [grant["GrantId"]]
    assert harness.store.grant("slot-1", 1).retired
    harness.kms.calls.clear()
    harness.sync()
    assert harness.kms.calls == []


def test_failures_log_no_credential_or_grant_token(harness, caplog):
    def denied(**kwargs):
        raise ClientError({"Error": {"Code": "AccessDeniedException"}}, "PutSecretValue")

    harness.secrets.put_secret_value = denied
    with caplog.at_level(logging.DEBUG):
        harness.gateway.sync_machines([harness.core.machine()])
    record = harness.store.grant("slot-1", 1)
    assert "ClientError" in caplog.text
    assert CREDENTIAL not in caplog.text
    assert record.grant_token not in caplog.text


class Ec2:
    """An EC2 account holding one data volume and the instances launched on it."""

    def __init__(self, store: MachineStore, cfg: ControllerConfig):
        self.store = store
        self.cfg = cfg
        self.instances: dict[str, dict] = {}
        self.launched_images: list[str] = []
        self.validated: list[str] = []
        self.volume = {
            "VolumeId": VOLUME_ID,
            "AvailabilityZone": cfg.availability_zone,
            "State": "available",
            "Attachments": [],
        }
        self.availability_zone = cfg.availability_zone

    def get_volume(self, machine):
        return self.volume

    def get_instance(self, machine):
        return self.instances.get(machine.instance_id) if machine.instance_id else None

    def discover_instance(self, machine):
        return None

    def find_launched_instance(self, machine):
        return None

    def validate_image(self, image_id):
        self.validated.append(image_id)
        if image_id not in {CONTROLLER_IMAGE, NEW_CONTROLLER_IMAGE}:
            raise CloudResourceError("configured AMI lacks capabilities")

    def validate_capacity(self):
        pass

    def run_instance(self, machine):
        instance_id = f"i-{len(self.instances) + 1:017x}"
        self.launched_images.append(machine.image_id)
        self.instances[instance_id] = {
            "InstanceId": instance_id,
            "ImageId": machine.image_id,
            "State": {"Name": "running"},
            "BlockDeviceMappings": [],
        }
        return instance_id

    def attach_volume(self, machine):
        self.volume["State"] = "in-use"
        self.volume["Attachments"] = [
            {"InstanceId": machine.instance_id, "Device": "/dev/sdf", "State": "attached"}
        ]
        self.instances[machine.instance_id]["BlockDeviceMappings"] = [
            {"DeviceName": "/dev/sdf", "Ebs": {"VolumeId": VOLUME_ID, "DeleteOnTermination": True}}
        ]

    def enforce_data_retention(self, machine):
        [mapping] = self.instances[machine.instance_id]["BlockDeviceMappings"]
        mapping["Ebs"]["DeleteOnTermination"] = False

    def stop_instance(self, machine):
        self.instances[machine.instance_id]["State"] = {"Name": "stopped"}

    def start_instance(self, machine):
        self.instances[machine.instance_id]["State"] = {"Name": "running"}

    def terminate_instance(self, machine):
        self.instances[machine.instance_id]["State"] = {"Name": "terminated"}
        self.volume["State"] = "available"
        self.volume["Attachments"] = []


def poll_until_running(harness: Harness, reconciler: Reconciler) -> None:
    for _ in range(12):
        harness.sync()
        reconciler.reconcile_all()
        if harness.store.get(MACHINE_ID).observed_state is ObservedState.RUNNING:
            return
    raise AssertionError(f"machine never ran: {harness.store.get(MACHINE_ID)}")


def test_start_records_a_new_image(harness):
    ec2 = Ec2(harness.store, harness.cfg)
    poll_until_running(harness, Reconciler(harness.store, ec2))
    harness.configure(image_id=NEW_CONTROLLER_IMAGE)
    harness.core.revision = 2
    harness.sync()
    machine = harness.store.get(MACHINE_ID)
    assert (machine.image_id, machine.target_image_id) == (CONTROLLER_IMAGE, NEW_CONTROLLER_IMAGE)


def test_new_controller_image_replaces_the_instance_and_reattaches_the_volume(harness):
    ec2 = Ec2(harness.store, harness.cfg)
    reconciler = Reconciler(harness.store, ec2)
    poll_until_running(harness, reconciler)
    old = harness.store.get(MACHINE_ID)
    assert old.image_id == CONTROLLER_IMAGE

    harness.configure(image_id=NEW_CONTROLLER_IMAGE)
    harness.core.revision = 2
    poll_until_running(harness, reconciler)

    new = harness.store.get(MACHINE_ID)
    assert (new.image_id, new.target_image_id) == (NEW_CONTROLLER_IMAGE, None)
    assert new.previous_instance_id == old.instance_id
    assert new.instance_id != old.instance_id
    assert new.instance_seq == old.instance_seq + 1
    assert new.recovery_count == 0
    assert ec2.instances[old.instance_id]["State"]["Name"] == "terminated"
    assert ec2.launched_images == [CONTROLLER_IMAGE, NEW_CONTROLLER_IMAGE]
    assert ec2.validated[-1] == NEW_CONTROLLER_IMAGE
    assert ec2.volume["Attachments"] == [
        {"InstanceId": new.instance_id, "Device": "/dev/sdf", "State": "attached"}
    ]


def stopped_and_terminated(harness: Harness, ec2: Ec2):
    machine = harness.store.set_desired(MACHINE_ID, DesiredState.STOPPED, None)
    ec2.terminate_instance(machine)
    return harness.store.mark_instance_terminal_observed(MACHINE_ID, machine.instance_id)


def test_operator_upgrade_supersedes_a_pending_image(harness):
    ec2 = Ec2(harness.store, harness.cfg)
    poll_until_running(harness, Reconciler(harness.store, ec2))
    harness.store.request_image(MACHINE_ID, NEW_CONTROLLER_IMAGE)
    claim = stopped_and_terminated(harness, ec2)
    assert claim.target_image_id == NEW_CONTROLLER_IMAGE

    upgraded = harness.store.upgrade_terminated(claim, NEW_CONTROLLER_IMAGE, "sha256:" + "a" * 64)

    assert (upgraded.image_id, upgraded.target_image_id) == (NEW_CONTROLLER_IMAGE, None)


def test_new_machine_launches_from_the_configured_image(harness):
    ec2 = Ec2(harness.store, harness.cfg)
    poll_until_running(harness, Reconciler(harness.store, ec2))
    machine = harness.store.get(MACHINE_ID)
    assert machine.previous_instance_id is None
    assert ec2.launched_images == [CONTROLLER_IMAGE]


def image(tags: list[dict] | None) -> dict:
    result = {
        "ImageId": CONTROLLER_IMAGE,
        "State": "available",
        "Architecture": "x86_64",
        "VirtualizationType": "hvm",
        "RootDeviceType": "ebs",
        "RootDeviceName": "/dev/xvda",
        "BlockDeviceMappings": [{"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 20}}],
    }
    if tags is not None:
        result["Tags"] = tags
    return result


@pytest.mark.parametrize(
    ("tags", "accepted"),
    [
        ([{"Key": "switch:capabilities", "Value": "controller-v1"}], True),
        ([{"Key": "switch:capabilities", "Value": "worker-v2, controller-v1"}], True),
        ([{"Key": "switch:capabilities", "Value": "controller-v10"}], False),
        ([{"Key": "switch:capability", "Value": "controller-v1"}], False),
        ([{"Key": "Name", "Value": "controller-v1"}], False),
        (None, False),
    ],
)
def test_validate_image_requires_the_capability_tag(tmp_path, tags, accepted):
    cfg = controller_config(tmp_path)
    client = ec2_client()
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_images", {"Images": [image(tags)]}, {"ImageIds": [CONTROLLER_IMAGE]}
        )
        cloud = Ec2Cloud(client, cfg)
        if accepted:
            cloud.validate_image(CONTROLLER_IMAGE)
        else:
            with pytest.raises(CloudResourceError, match="switch:capabilities"):
                cloud.validate_image(CONTROLLER_IMAGE)
        stubber.assert_no_pending_responses()


def test_config_carries_the_image_login_key_and_slot_roles(tmp_path):
    cfg = controller_config(tmp_path)
    assert cfg.image_id == CONTROLLER_IMAGE
    assert cfg.login_kms_key_arn == KEY_ARN
    assert cfg.slot("slot-1").role_arn == ROLE_ARN
    other = ControllerConfig.from_dict(config_dict(tmp_path, max_machines=1))
    assert other.image_id != cfg.image_id
    assert cfg.fingerprint() == other.fingerprint()


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda raw: raw.pop("login_kms_key_arn"), "login_kms_key_arn"),
        (lambda raw: raw["machine_slots"]["slot-1"].pop("role_arn"), "role_arn"),
        (lambda raw: raw.update(controller_image_id=CONTROLLER_IMAGE), "controller_image_id"),
        (lambda raw: raw.update(image_id="ami-XYZ"), "image_id"),
        (
            lambda raw: raw.update(login_kms_key_arn=KEY_ARN.replace("us-east-1", "eu-west-1")),
            "configured region",
        ),
        (
            lambda raw: raw.update(login_kms_key_arn=KEY_ARN.replace(":key/", ":alias/")),
            "login_kms_key_arn",
        ),
        (
            lambda raw: raw["machine_slots"]["slot-1"].update(
                role_arn="arn:aws:iam::123456789012:instance-profile/worker-1"
            ),
            "role_arn",
        ),
        (
            lambda raw: raw["machine_slots"]["slot-1"].update(unexpected="x"),
            "and role_arn",
        ),
    ],
)
def test_config_rejects_an_incomplete_controller_config(tmp_path, change, message):
    raw = controller_dict(tmp_path)
    change(raw)
    with pytest.raises(ConfigError, match=message):
        ControllerConfig.from_dict(raw)


def test_config_rejects_duplicate_slot_roles(tmp_path):
    raw = controller_dict(tmp_path, max_machines=2)
    raw["machine_slots"]["slot-2"]["role_arn"] = raw["machine_slots"]["slot-1"]["role_arn"]
    with pytest.raises(ConfigError, match="roles must be unique"):
        ControllerConfig.from_dict(raw)


def test_gateway_requires_grants_on_the_configured_login_key(tmp_path):
    cfg = controller_config(tmp_path)
    store = MachineStore(cfg.state_db_path, cfg.fingerprint())
    settings = GatewayConfig("https://switch.example.test", "SYNTHETIC-CONTROLLER", "m6i.large")
    other = KmsGrants(FakeKms(), KEY_ARN.replace("aa", "bb"), store)
    with pytest.raises(ConfigError, match="login key"):
        Gateway(settings, cfg, store, FakeSecrets(), ImageGate([]), other)
    store.close()


def test_store_adds_missing_columns_to_an_existing_database(tmp_path):
    cfg = controller_config(tmp_path)
    store = MachineStore(cfg.state_db_path, cfg.fingerprint())
    store.close()
    connection = sqlite3.connect(cfg.state_db_path)
    for column in ("runtime", "target_runtime", "target_image_id"):
        connection.execute(f"ALTER TABLE machines DROP COLUMN {column}")
    connection.execute(
        """INSERT INTO machines (machine_id, slot_id, generation, desired_state, observed_state,
        core_revision, desired_revision, operation_id, instance_type, image_id,
        assignment_secret_arn, instance_profile_arn)
        VALUES (?, 'slot-1', 1, 'running', 'pending', 1, 1, 'op', 'm6i.large', ?, 'secret', 'profile')""",
        (MACHINE_ID, cfg.image_id),
    )
    connection.commit()
    connection.close()

    reopened = MachineStore(cfg.state_db_path, cfg.fingerprint())
    assert reopened.get(MACHINE_ID).target_image_id is None
    reopened.close()
    connection = sqlite3.connect(cfg.state_db_path)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(machines)")}
    connection.close()
    assert {"runtime", "target_runtime", "target_image_id"} <= columns
