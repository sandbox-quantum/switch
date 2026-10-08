"""The boot of a Switch cloud machine that runs the agents controller."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "switch_machine_boot.py"
spec = importlib.util.spec_from_file_location("switch_machine_boot", SCRIPT)
assert spec is not None and spec.loader is not None
boot = importlib.util.module_from_spec(spec)
sys.modules["switch_machine_boot"] = boot
spec.loader.exec_module(boot)

SECRET = "arn:aws:secretsmanager:eu-west-1:000000000000:secret:switch/slot-a"
MACHINE_ID = "3f1c2b4a-0000-4000-8000-000000000001"
CONTROLLER_ID = "9a1c2b4a-0000-4000-8000-0000000000aa"
CODE = "swce_SyntheticEnrollmentCode0000"
ASSIGNMENT = boot.Assignment(
    installation_id="inst-test",
    slot_id="slot-a",
    generation=1,
    secret_id=SECRET,
    secret_region="eu-west-1",
    volume_id="vol-0123456789abcdef0",
)
CONFIG = boot.MachineConfig(
    controller_user="switch-controller",
    cli="/opt/switch/controller/bin/switch-agent-controller",
    path="/opt/switch/node/bin:/usr/bin:/bin",
    agent_users=16,
)


def bundle(**controller) -> str:
    return json.dumps(
        {
            "version": 3,
            "machineId": MACHINE_ID,
            "assignment": {
                "installationId": "inst-test",
                "slotId": "slot-a",
                "generation": 1,
                "dataVolumeId": "vol-0123456789abcdef0",
            },
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


def test_the_assignment_and_bundle_are_read_strictly(tmp_path):
    assignment = tmp_path / "assignment.json"
    assignment.write_text(
        json.dumps(
            {
                "version": 2,
                "installationId": "inst-test",
                "slotId": "slot-a",
                "generation": 1,
                "assignmentSecretId": SECRET,
                "dataVolumeId": "vol-0123456789abcdef0",
                "dataDevice": "/dev/sdf",
                "mountPath": "/data",
                "previousInstanceId": "i-0123456789abcdef0",
            }
        )
    )
    assert boot.load_assignment(assignment) == ASSIGNMENT
    parsed = boot.parse_bundle(bundle(), ASSIGNMENT)
    assert (parsed.machine_id, parsed.enrollment_code, parsed.controller_id) == (
        MACHINE_ID,
        CODE,
        None,
    )
    enrolled = boot.parse_bundle(bundle(id=CONTROLLER_ID, enrollmentCode=None), ASSIGNMENT)
    assert (enrolled.controller_id, enrolled.enrollment_code) == (CONTROLLER_ID, None)


@pytest.mark.parametrize(
    "raw",
    [
        bundle(enrollmentCode=None),
        bundle(enrollmentCode="swcc_a-long-lived-credential-00"),
        bundle(id=CONTROLLER_ID),
        bundle().replace("slot-a", "slot-b"),
        bundle().replace("https://", "http://"),
        "not json",
    ],
)
def test_a_bundle_that_is_not_this_machines_is_refused(raw):
    with pytest.raises(boot.BootError):
        boot.parse_bundle(raw, ASSIGNMENT)


def test_a_workers_bundle_is_obsolete():
    with pytest.raises(boot.ObsoleteBundle):
        boot.parse_bundle(json.dumps({"version": 2}), ASSIGNMENT)


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
    boot.prepare_storage(commands, ASSIGNMENT.volume_id, sleep=lambda _: None)
    assert commands.ran("/usr/sbin/mkfs.ext4")[0][-1] == "/dev/nvme1n1"
    assert commands.ran(boot.SYSTEMD_MOUNT)[0][-2:] == ["/dev/nvme1n1", str(tmp_path / "data")]


def test_a_volume_attached_late_is_waited_for_and_a_formatted_one_kept(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path / "data")
    commands = FakeCommands(
        {
            "lsblk": [(0, json.dumps({"blockdevices": []})), (0, LSBLK_EXT4)],
            "findmnt": [(1, "")],
        }
    )
    boot.prepare_storage(commands, ASSIGNMENT.volume_id, sleep=lambda _: None)
    assert commands.ran("/usr/sbin/mkfs.ext4") == []
    assert len(commands.ran(boot.SYSTEMD_MOUNT)) == 1


def test_a_disk_with_unknown_contents_is_never_formatted(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path / "data")
    commands = FakeCommands(
        {"lsblk": [(0, LSBLK_BLANK)], "wipefs": [(0, '{"signatures": [{"type": "xfs"}]}')]}
    )
    with pytest.raises(boot.BootError, match="not blank"):
        boot.prepare_storage(commands, ASSIGNMENT.volume_id, sleep=lambda _: None)
    assert commands.ran("/usr/sbin/mkfs.ext4") == []


def test_the_volume_marker_refuses_another_machines_disk(tmp_path):
    boot.reconcile_marker(tmp_path, ASSIGNMENT, MACHINE_ID)
    boot.reconcile_marker(tmp_path, ASSIGNMENT, MACHINE_ID)
    with pytest.raises(boot.BootError, match="another machine"):
        boot.reconcile_marker(tmp_path, ASSIGNMENT, "3f1c2b4a-0000-4000-8000-000000000002")


def test_a_fresh_machine_enrolls_then_runs_its_agents_as_users_of_their_own(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path)
    commands = FakeCommands({" status ": [(1, "Not enrolled.")]})
    boot.start_controller(commands, CONFIG, ASSIGNMENT, boot.parse_bundle(bundle(), ASSIGNMENT))
    [enroll] = commands.ran("enroll")
    assert enroll[:4] == ["/usr/sbin/runuser", "-u", "switch-controller", "--"]
    assert enroll[enroll.index("--code") + 1] == CODE
    assert enroll[enroll.index("--data-dir") + 1] == str(tmp_path / ".switch-controller")
    [setup] = commands.ran("install-service")
    assert setup[setup.index("--agents-dir") + 1] == str(tmp_path / "agents")
    assert setup[setup.index("--user") + 1] == "switch-controller"
    assert commands.calls.index(enroll) < commands.calls.index(setup)


def test_an_enrolled_machine_only_starts_its_controller(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path)
    (tmp_path / ".switch-controller").mkdir()
    commands = FakeCommands({" status ": [(0, "Controller: 9a1c…")]})
    boot.start_controller(
        commands,
        CONFIG,
        ASSIGNMENT,
        boot.parse_bundle(bundle(id=CONTROLLER_ID, enrollmentCode=None), ASSIGNMENT),
    )
    assert commands.ran("enroll") == []
    assert len(commands.ran("install-service")) == 1


def test_a_new_code_sets_a_revoked_enrollment_aside(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path)
    (tmp_path / ".switch-controller").mkdir()
    (tmp_path / ".switch-controller" / "controller.db").write_text("old")
    commands = FakeCommands({" status ": [(0, "Controller: old")]})
    boot.start_controller(
        commands, CONFIG, ASSIGNMENT, boot.parse_bundle(bundle(), ASSIGNMENT), now=lambda: 7
    )
    assert (tmp_path / ".switch-controller.replaced-7" / "controller.db").read_text() == "old"
    assert not (tmp_path / ".switch-controller" / "controller.db").exists()
    assert len(commands.ran("enroll")) == 1


def test_no_enrollment_and_no_code_says_what_to_do(monkeypatch, tmp_path):
    monkeypatch.setattr(boot, "DATA_MOUNT", tmp_path)
    commands = FakeCommands({" status ": [(1, "Not enrolled.")]})
    with pytest.raises(boot.BootError, match="Machines page"):
        boot.start_controller(
            commands,
            CONFIG,
            ASSIGNMENT,
            boot.parse_bundle(bundle(id=CONTROLLER_ID, enrollmentCode=None), ASSIGNMENT),
        )
    assert commands.ran("install-service") == []
