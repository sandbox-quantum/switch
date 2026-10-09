import json
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from switch_hosted_controller import cli
from switch_hosted_controller.config import ControllerConfig
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.store import MachineStore

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    raw = json.loads((FIXTURES / "controller.json").read_text())
    raw["state_db_path"] = str(tmp_path / "state.db")
    raw["lock_path"] = str(tmp_path / "controller.lock")
    path = tmp_path / "controller.json"
    path.write_text(json.dumps(raw))
    return path


def run(capsys, config_path: Path, *argv: str) -> tuple[int, dict | list | None]:
    code = cli.main(["--config", str(config_path), *argv])
    captured = capsys.readouterr()
    output = captured.out if code == 0 else captured.err
    return code, json.loads(output) if output.strip() else None


def observe(config_path: Path, machine_id: str, observed: ObservedState) -> None:
    config = ControllerConfig.load(config_path)
    store = MachineStore(config.state_db_path, config.fingerprint())
    try:
        store.set_observed(store.get(machine_id), observed, None)
    finally:
        store.close()


def test_create_status_and_delete_are_keyed_by_machine_id(capsys, config_path):
    code, created = run(capsys, config_path, "create", "--instance-type", "m6i.large")
    assert code == 0
    machine_id = created["machine_id"]
    assert str(uuid.UUID(machine_id)) == machine_id
    assert created["desired_state"] == "running"
    assert created["retain_until"] is None
    assert set(created) == {
        "machine_id",
        "instance_type",
        "desired_state",
        "desired_revision",
        "observed_state",
        "instance_id",
        "instance_seq",
        "data_volume_id",
        "retain_until",
        "error",
    }
    assert run(capsys, config_path, "status", machine_id)[1] == created

    code, error = run(capsys, config_path, "create", "--instance-type", "m6i.large")
    assert code == 2
    assert "capacity" in error["error"]

    other_id = str(uuid.uuid4())
    code, error = run(
        capsys,
        config_path,
        "delete",
        machine_id,
        "--confirm-machine-id",
        other_id,
        "--retain-volume",
    )
    assert code == 2
    assert "confirm-machine-id" in error["error"]

    code, retained = run(
        capsys,
        config_path,
        "delete",
        machine_id,
        "--confirm-machine-id",
        machine_id,
        "--retain-volume",
    )
    assert code == 0
    assert retained["desired_state"] == "retained"
    observe(config_path, machine_id, ObservedState.RETAINED)
    code, deleted = run(
        capsys,
        config_path,
        "delete",
        machine_id,
        "--confirm-machine-id",
        machine_id,
        "--delete-volume",
    )
    assert code == 0
    assert deleted["desired_state"] == "deleted"

    code, replacement = run(capsys, config_path, "create", "--instance-type", "m6i.large")
    assert code == 0
    assert replacement["machine_id"] != machine_id
    assert run(capsys, config_path, "status", machine_id)[1]["desired_state"] == "deleted"
    assert run(capsys, config_path, "status", replacement["machine_id"])[1] == replacement
    code, listed = run(capsys, config_path, "list")
    assert sorted(item["machine_id"] for item in listed) == sorted(
        [machine_id, replacement["machine_id"]]
    )


@pytest.mark.parametrize(
    "argv",
    [
        ("create", "--instance-type", "m6i.xlarge"),
        ("status", "3f1c2b4a-0000-4000-8000-000000000001"),
        ("status", "not-a-uuid"),
    ],
)
def test_invalid_requests_exit_2(capsys, config_path, argv):
    code, error = run(capsys, config_path, *argv)
    assert code == 2
    assert error["error"]


def stopped_with_instance(config_path: Path, machine_id: str) -> None:
    config = ControllerConfig.load(config_path)
    store = MachineStore(config.state_db_path, config.fingerprint())
    try:
        store.record_volume(machine_id, "vol-0123456789abcdef0", config.availability_zone)
        store.record_instance(machine_id, "i-0123456789abcdef0", "bundle-1")
        store.set_desired(machine_id, DesiredState.STOPPED, None)
    finally:
        store.close()


def upgrade(capsys, config_path: Path, machine_id: str):
    return run(
        capsys,
        config_path,
        "upgrade",
        machine_id,
        "--confirm-instance-id",
        "i-0123456789abcdef0",
    )


def test_upgrade_moves_the_machine_onto_the_new_image(capsys, config_path):
    _, created = run(capsys, config_path, "create", "--instance-type", "m6i.large")
    stopped_with_instance(config_path, created["machine_id"])
    raw = json.loads(config_path.read_text())
    raw["image_id"] = "ami-11111111111111111"
    config_path.write_text(json.dumps(raw))
    with (
        patch("switch_hosted_controller.cli.boto3"),
        patch("switch_hosted_controller.cli.Ec2Cloud") as cloud,
    ):
        cloud.return_value.get_instance.return_value = {"State": {"Name": "terminated"}}
        cloud.return_value.get_volume.return_value = {"State": "available", "Attachments": []}
        code, upgraded = upgrade(capsys, config_path, created["machine_id"])
    assert code == 0
    assert upgraded["instance_id"] is None
    assert upgraded["instance_seq"] == created["instance_seq"] + 1
    config = ControllerConfig.load(config_path)
    store = MachineStore(config.state_db_path, config.fingerprint())
    try:
        machine = store.get(created["machine_id"])
    finally:
        store.close()
    assert machine.image_id == "ami-11111111111111111"
    assert machine.previous_instance_id == "i-0123456789abcdef0"
    assert machine.data_volume_id == "vol-0123456789abcdef0"
    assert machine.instance_bundle_token is None


class OneIteration:
    def __init__(self):
        self.checks = 0

    def is_set(self) -> bool:
        self.checks += 1
        return self.checks > 1

    def set(self) -> None:
        pass

    def wait(self, _timeout: float) -> None:
        pass


def test_serve_lists_core_machines_once_per_poll(tmp_path, config_path):
    gateway_path = tmp_path / "gateway.json"
    gateway_path.write_text(
        json.dumps(
            {
                "origin": "https://switch.example.test",
                "token": "SYNTHETIC-CONTROLLER-CREDENTIAL-0123456789",
                "instance_type": "m6i.large",
            }
        )
    )
    request = Mock(return_value={"machines": []})
    with (
        patch("switch_hosted_controller.cli.boto3"),
        patch("switch_hosted_controller.cli._touch_health"),
        patch("switch_hosted_controller.cli.signal.signal"),
        patch("switch_hosted_controller.cli.threading.Event", OneIteration),
        patch.object(cli.Gateway, "request", request),
    ):
        code = cli.main(
            ["--config", str(config_path), "--gateway-config", str(gateway_path), "serve"]
        )
    assert code == 0
    assert [call.args[0] for call in request.call_args_list] == ["/machines"]
