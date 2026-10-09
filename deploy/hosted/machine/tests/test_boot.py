"""The boot of a Switch cloud machine that runs the agents controller."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "switch_machine_boot.py"
spec = importlib.util.spec_from_file_location("switch_machine_boot", SCRIPT)
assert spec is not None and spec.loader is not None
boot = importlib.util.module_from_spec(spec)
sys.modules["switch_machine_boot"] = boot
spec.loader.exec_module(boot)

MACHINE_ID = "3f1c2b4a-0000-4000-8000-000000000001"
CONTROLLER_ID = "9a1c2b4a-0000-4000-8000-0000000000aa"
CODE = "swce_SyntheticEnrollmentCode0000"
VOLUME_ID = "vol-0123456789abcdef0"
CONFIG = boot.MachineConfig(
    controller_user="switch-controller",
    node="/opt/switch/node/bin/node",
    cli="/opt/switch/controller/bin/switch-agent-controller",
    path="/opt/switch/node/bin:/usr/bin:/bin",
    agent_users=16,
)


def bundle(**controller) -> str:
    return json.dumps(
        {
            "version": 4,
            "installationId": "inst-test",
            "machineId": MACHINE_ID,
            "dataVolumeId": VOLUME_ID,
            "apiEndpoint": "https://switch.example.test/agent-api",
            "controller": {"id": None, "enrollmentCode": CODE, **controller},
        }
    )


class FakeCommands:
    """Answers host commands from a table, and records them."""

    def __init__(self, answers: dict[str, list[tuple[int, str]]] | None = None) -> None:
        self.calls: list[list[str]] = []
        self.answers = answers or {}

    def result(self, arguments, *, env=None):
        self.calls.append(arguments)
        key = next((name for name in self.answers if name in " ".join(arguments)), None)
        code, out = (0, "")
        if key is not None and self.answers[key]:
            code, out = self.answers[key][0]
            if len(self.answers[key]) > 1:
                self.answers[key].pop(0)
        return subprocess.CompletedProcess(arguments, code, out, "")

    def run(self, arguments, *, env=None):
        completed = self.result(arguments, env=env)
        if completed.returncode != 0:
            raise boot.BootError(f"{arguments[0]} failed")
        return completed.stdout

    def ran(self, word: str) -> list[list[str]]:
        return [call for call in self.calls if word in call]


def test_the_bundle_is_read_strictly():
    parsed = boot.parse_bundle(bundle())
    assert parsed == boot.Bundle(
        installation_id="inst-test",
        machine_id=MACHINE_ID,
        volume_id=VOLUME_ID,
        api_endpoint="https://switch.example.test/agent-api",
        controller_id=None,
        enrollment_code=CODE,
    )
    enrolled = boot.parse_bundle(bundle(id=CONTROLLER_ID, enrollmentCode=None))
    assert (enrolled.controller_id, enrolled.enrollment_code) == (CONTROLLER_ID, None)


@pytest.mark.parametrize(
    "raw",
    [
        bundle(enrollmentCode=None),
        bundle(enrollmentCode="swcc_a-long-lived-credential-00"),
        bundle(id=CONTROLLER_ID),
        bundle().replace('"version": 4', '"version": 3'),
        bundle().replace(VOLUME_ID, "vol-nope"),
        bundle().replace("https://", "http://"),
        json.dumps({**json.loads(bundle()), "slotId": "slot-a"}),
    ],
)
def test_a_bundle_this_image_does_not_read_is_refused(raw):
    with pytest.raises(boot.BootError):
        boot.parse_bundle(raw)


def test_user_data_that_is_not_a_bundle_is_not_a_cloud_machine():
    with pytest.raises(boot.NoBundle, match="not a machine bundle"):
        boot.parse_bundle("#cloud-config\nruncmd: []\n")


class FakeMetadata:
    """Instance metadata (IMDSv2), answering from a list of user data answers."""

    def __init__(self, *answers) -> None:
        self.answers = list(answers)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        if request.full_url.endswith("/api/token"):
            assert request.get_method() == "PUT"
            return io.BytesIO(b"metadata-token")
        assert request.get_header("X-aws-ec2-metadata-token") == "metadata-token"
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return io.BytesIO(answer.encode())


def test_the_bundle_is_read_from_the_instance_user_data_once_metadata_answers():
    metadata = FakeMetadata(OSError("connection refused"), bundle())
    waits = []
    read = boot.read_bundle(metadata, sleep=waits.append, wait_seconds=60)
    assert read.machine_id == MACHINE_ID
    assert waits == [5]
    assert [request.full_url for request in metadata.requests] == [
        f"{boot.METADATA_URL}/api/token",
        f"{boot.METADATA_URL}/user-data",
        f"{boot.METADATA_URL}/api/token",
        f"{boot.METADATA_URL}/user-data",
    ]


def test_an_instance_without_user_data_is_not_waited_for():
    missing = HTTPError(f"{boot.METADATA_URL}/user-data", 404, "Not Found", {}, None)
    with pytest.raises(boot.NoBundle, match="hosted controller"):
        boot.read_bundle(FakeMetadata(missing), sleep=pytest.fail, wait_seconds=60)


def test_metadata_that_never_answers_fails_the_boot():
    with pytest.raises(boot.BootError, match="cannot be read"):
        boot.read_bundle(
            FakeMetadata(OSError("unreachable")), sleep=lambda _: None, wait_seconds=-1
        )


LSBLK_BLANK = json.dumps(
    {
        "blockdevices": [
            {"path": "/dev/nvme0n1", "type": "disk", "serial": "vol0aaaaaaaaaaaaaaaa"},
            {"path": "/dev/nvme1n1", "type": "disk", "serial": "vol0123456789abcdef0"},
        ]
    }
)
LSBLK_EXT4 = json.dumps(
    {
        "blockdevices": [
            {
                "path": "/dev/nvme1n1",
                "type": "disk",
                "serial": "vol0123456789abcdef0",
                "fstype": "ext4",
                "uuid": "1111",
            }
        ]
    }
)


def test_a_blank_volume_is_formatted_and_mounted(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path / "data")
    commands = FakeCommands(
        {
            "lsblk": [(0, LSBLK_BLANK), (0, LSBLK_EXT4)],
            "wipefs": [(0, '{"signatures": []}')],
            "findmnt": [(1, "")],
        }
    )
    boot.prepare_storage(commands, VOLUME_ID, sleep=lambda _: None)
    assert commands.ran("/usr/sbin/mkfs.ext4")[0][-1] == "/dev/nvme1n1"
    assert commands.ran(boot.SYSTEMD_MOUNT)[0][-2:] == [
        "/dev/nvme1n1",
        str(tmp_path / "data"),
    ]


def test_a_volume_attached_late_is_waited_for_and_a_formatted_one_kept(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path / "data")
    commands = FakeCommands(
        {
            "lsblk": [(0, json.dumps({"blockdevices": []})), (0, LSBLK_EXT4)],
            "findmnt": [(1, "")],
        }
    )
    boot.prepare_storage(commands, VOLUME_ID, sleep=lambda _: None)
    assert commands.ran("/usr/sbin/mkfs.ext4") == []
    assert len(commands.ran(boot.SYSTEMD_MOUNT)) == 1


def test_a_disk_with_unknown_contents_is_never_formatted(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path / "data")
    commands = FakeCommands(
        {
            "lsblk": [(0, LSBLK_BLANK)],
            "wipefs": [(0, '{"signatures": [{"type": "xfs"}]}')],
        }
    )
    with pytest.raises(boot.BootError, match="not blank"):
        boot.prepare_storage(commands, VOLUME_ID, sleep=lambda _: None)
    assert commands.ran("/usr/sbin/mkfs.ext4") == []


def test_the_volume_marker_refuses_another_machines_disk(tmp_path):
    boot.reconcile_marker(tmp_path, boot.parse_bundle(bundle()))
    boot.reconcile_marker(
        tmp_path, boot.parse_bundle(bundle(id=CONTROLLER_ID, enrollmentCode=None))
    )
    other = bundle().replace(MACHINE_ID, "3f1c2b4a-0000-4000-8000-000000000002")
    with pytest.raises(boot.BootError, match="another machine"):
        boot.reconcile_marker(tmp_path, boot.parse_bundle(other))


def test_a_fresh_machine_enrolls_then_runs_its_agents_as_users_of_their_own(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path)
    commands = FakeCommands({" status ": [(1, "Not enrolled.")]})
    boot.start_controller(commands, CONFIG, boot.parse_bundle(bundle()))
    [enroll] = commands.ran("enroll")
    assert enroll[:6] == [
        "/usr/sbin/runuser",
        "-u",
        "switch-controller",
        "--",
        "/opt/switch/node/bin/node",
        "/opt/switch/controller/bin/switch-agent-controller",
    ]
    assert enroll[enroll.index("--code") + 1] == CODE
    assert enroll[enroll.index("--data-dir") + 1] == str(
        tmp_path / ".switch-controller"
    )
    [setup] = commands.ran("install-service")
    assert setup[:2] == [
        "/opt/switch/node/bin/node",
        "/opt/switch/controller/bin/switch-agent-controller",
    ]
    assert setup[setup.index("--agents-dir") + 1] == str(tmp_path / "agents")
    assert setup[setup.index("--user") + 1] == "switch-controller"
    assert "--no-block" in setup
    assert commands.calls.index(enroll) < commands.calls.index(setup)


def test_an_enrolled_machine_only_starts_its_controller(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path)
    (tmp_path / ".switch-controller").mkdir()
    commands = FakeCommands({" status ": [(0, "Controller: 9a1c…")]})
    boot.start_controller(
        commands,
        CONFIG,
        boot.parse_bundle(bundle(id=CONTROLLER_ID, enrollmentCode=None)),
    )
    assert commands.ran("enroll") == []
    assert len(commands.ran("install-service")) == 1


def test_a_new_code_sets_a_revoked_enrollment_aside(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path)
    (tmp_path / ".switch-controller").mkdir()
    (tmp_path / ".switch-controller" / "controller.db").write_text("old")
    (tmp_path / ".switch-controller-code").write_text(
        hashlib.sha256(b"swce_old").hexdigest()
    )
    commands = FakeCommands({" status ": [(0, "Controller: old")]})
    boot.start_controller(commands, CONFIG, boot.parse_bundle(bundle()), now=lambda: 7)
    assert (
        tmp_path / ".switch-controller.replaced-7" / "controller.db"
    ).read_text() == "old"
    assert not (tmp_path / ".switch-controller" / "controller.db").exists()
    assert len(commands.ran("enroll")) == 1
    assert (tmp_path / ".switch-controller-code").read_text() != hashlib.sha256(
        b"swce_old"
    ).hexdigest()


def test_an_enrollment_made_with_this_code_is_kept_when_the_boot_runs_again(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path)
    first = FakeCommands({" status ": [(1, "Not enrolled.")]})
    boot.start_controller(first, CONFIG, boot.parse_bundle(bundle()))
    assert len(first.ran("enroll")) == 1
    # It failed after enrolling: systemd starts the boot again, and Switch,
    # which has not linked the controller yet, still hands over the code.
    (tmp_path / ".switch-controller" / "controller.db").write_text("enrolled")
    again = FakeCommands({" status ": [(0, "Controller: new")]})
    boot.start_controller(again, CONFIG, boot.parse_bundle(bundle()), now=lambda: 7)
    assert again.ran("enroll") == []
    assert not (tmp_path / ".switch-controller.replaced-7").exists()
    assert (tmp_path / ".switch-controller" / "controller.db").read_text() == "enrolled"
    assert len(again.ran("install-service")) == 1


def test_no_enrollment_and_no_code_says_what_to_do(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path)
    commands = FakeCommands({" status ": [(1, "Not enrolled.")]})
    with pytest.raises(boot.BootError, match="Machines page"):
        boot.start_controller(
            commands,
            CONFIG,
            boot.parse_bundle(bundle(id=CONTROLLER_ID, enrollmentCode=None)),
        )
    assert commands.ran("install-service") == []
