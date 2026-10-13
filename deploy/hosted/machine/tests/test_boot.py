"""The boot of a Switch cloud machine that runs one agents controller per workspace."""

from __future__ import annotations

import contextlib
import dataclasses
import hashlib
import importlib.util
import io
import json
import logging
import stat
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
OTHER_CONTROLLER_ID = "9a1c2b4a-0000-4000-8000-0000000000bb"
KEY_A = "5e1c2b4a-0000-4000-8000-00000000000a"
KEY_B = "5e1c2b4a-0000-4000-8000-00000000000b"
KEY_C = "5e1c2b4a-0000-4000-8000-00000000000c"
CODE = "swce_SyntheticEnrollmentCode0000"
VOLUME_ID = "vol-0123456789abcdef0"
CONFIG = boot.MachineConfig(
    controller_user="switch-controller",
    node="/opt/switch/node/bin/node",
    cli="/opt/switch/controller/bin/switch-agent-controller",
    path="/opt/switch/node/bin:/usr/bin:/bin",
    agent_users=16,
)


def entry(key: str = KEY_A, **fields) -> dict:
    return {"key": key, "id": None, "enrollmentCode": CODE, **fields}


def enrolled_entry(key: str, controller_id: str = CONTROLLER_ID) -> dict:
    return entry(key, id=controller_id, enrollmentCode=None)


def bundle(*controllers: dict, **fields) -> str:
    return json.dumps(
        {
            "version": 5,
            "installationId": "inst-test",
            "machineId": MACHINE_ID,
            "dataVolumeId": VOLUME_ID,
            "apiEndpoint": "https://switch.example.test/agent-api",
            "controllers": list(controllers) if controllers else [entry()],
            **fields,
        }
    )


def uuid_key(n: int) -> str:
    return f"5e1c2b4a-0000-4000-8000-{n:012d}"


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


@pytest.fixture
def machine(monkeypatch, tmp_path) -> Path:
    """A data volume and a root volume's systemd directory, both empty."""
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(boot, "DATA_MOUNT", data)
    monkeypatch.setattr(boot, "SYSTEMD_SYSTEM_DIR", tmp_path / "systemd")
    return data


def start(commands, raw: str | None = None, index: int = 0, now=lambda: 7) -> None:
    parsed = boot.parse_bundle(raw or bundle())
    boot.start_controller(
        commands,
        CONFIG,
        parsed.api_endpoint,
        boot.seat_for(index, CONFIG),
        parsed.controllers[0],
        now,
    )


def setups(commands: FakeCommands) -> list[str]:
    """The controller users install-service was run for, in order."""
    return [call[call.index("--user") + 1] for call in commands.ran("install-service")]


def test_the_bundle_is_read_strictly():
    parsed = boot.parse_bundle(bundle(entry(KEY_A), enrolled_entry(KEY_B)))
    assert parsed == boot.Bundle(
        installation_id="inst-test",
        machine_id=MACHINE_ID,
        volume_id=VOLUME_ID,
        api_endpoint="https://switch.example.test/agent-api",
        controllers=(
            boot.BundleController(key=KEY_A, controller_id=None, enrollment_code=CODE),
            boot.BundleController(
                key=KEY_B, controller_id=CONTROLLER_ID, enrollment_code=None
            ),
        ),
    )


V4_BUNDLE = json.dumps(
    {
        "version": 4,
        "installationId": "inst-test",
        "machineId": MACHINE_ID,
        "dataVolumeId": VOLUME_ID,
        "apiEndpoint": "https://switch.example.test/agent-api",
        "controller": {"id": None, "enrollmentCode": CODE},
    }
)


@pytest.mark.parametrize(
    "raw",
    [
        V4_BUNDLE,
        bundle(version=4),
        bundle(entry(enrollmentCode=None)),
        bundle(entry(enrollmentCode="swcc_a-long-lived-credential-00")),
        bundle(entry(id=CONTROLLER_ID)),
        bundle(entry(key="seat-a")),
        bundle(entry(key=KEY_A.upper())),
        bundle({"id": None, "enrollmentCode": CODE}),
        bundle({**entry(), "slotId": "slot-a"}),
        bundle(entry(KEY_A), entry(KEY_A)),
        bundle(enrolled_entry(KEY_A), enrolled_entry(KEY_B)),
        bundle(controllers=[]),
        bundle(*[entry(uuid_key(n)) for n in range(9)]),
        bundle(controllers=entry()),
        bundle().replace(VOLUME_ID, "vol-nope"),
        bundle().replace("https://", "http://"),
        json.dumps({**json.loads(bundle()), "slotId": "slot-a"}),
        json.dumps({**json.loads(bundle()), "controller": entry()}),
    ],
)
def test_a_bundle_this_image_does_not_read_is_refused(raw):
    with pytest.raises(boot.BootError):
        boot.parse_bundle(raw)


def test_a_bundle_lists_up_to_eight_controllers():
    parsed = boot.parse_bundle(bundle(*[entry(uuid_key(n)) for n in range(8)]))
    assert len(parsed.controllers) == 8


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
    boot.reconcile_marker(tmp_path, boot.parse_bundle(bundle(enrolled_entry(KEY_A))))
    other = bundle().replace(MACHINE_ID, "3f1c2b4a-0000-4000-8000-000000000002")
    with pytest.raises(boot.BootError, match="another machine"):
        boot.reconcile_marker(tmp_path, boot.parse_bundle(other))


def test_index_zero_is_the_baked_controller_on_the_single_controller_layout(machine):
    seat = boot.seat_for(0, CONFIG)
    assert (seat.uid, seat.gid, seat.user) == (2000, 2000, "switch-controller")
    assert (seat.agents_group, seat.agents_gid) == ("switch-agents-2000", 2001)
    assert (seat.agent_user(1), seat.agent_uid(1)) == ("sa2000-01", 2101)
    assert (seat.agent_user(16), seat.agent_uid(16)) == ("sa2000-16", 2116)
    assert seat.unit == "switch-agent-controller-2000.service"
    assert seat.data_dir == machine / ".switch-controller"
    assert seat.code_record == machine / ".switch-controller-code"
    assert seat.agents_dir == machine / "agents"


def test_another_index_has_ids_and_paths_of_its_own(machine):
    seat = boot.seat_for(3, CONFIG)
    assert (seat.uid, seat.gid, seat.user) == (2600, 2600, "switch-controller-3")
    assert (seat.agents_group, seat.agents_gid) == ("switch-agents-2600", 2601)
    assert (seat.agent_user(1), seat.agent_uid(1)) == ("sa2600-01", 2701)
    assert (seat.agent_user(99), seat.agent_uid(99)) == ("sa2600-99", 2799)
    assert seat.unit == "switch-agent-controller-2600.service"
    assert seat.data_dir == machine / "controllers" / "3" / "data"
    assert seat.code_record == machine / "controllers" / "3" / "code"
    assert seat.agents_dir == machine / "controllers" / "3" / "agents"
    last = boot.seat_for(7, CONFIG)
    assert last.agent_uid(99) < boot.seat_for(0, CONFIG).uid + 8 * boot.UID_STRIDE
    with pytest.raises(boot.BootError):
        boot.seat_for(8, CONFIG)


def test_a_new_seat_gets_the_lowest_free_index_and_a_recorded_one_keeps_its_own():
    assert boot.assign_indexes(None, [KEY_B, KEY_A]) == {KEY_B: 0, KEY_A: 1}
    assert boot.assign_indexes({KEY_A: 0, KEY_C: 2}, [KEY_C, KEY_B]) == {
        KEY_A: 0,
        KEY_B: 1,
        KEY_C: 2,
    }
    full = {uuid_key(n): n for n in range(8)}
    assert boot.assign_indexes(full, [KEY_A]) == full


def test_the_first_boot_numbers_the_seats_in_bundle_order(machine):
    commands = FakeCommands({"getent": [(2, "")]})
    raw = bundle(enrolled_entry(KEY_B), enrolled_entry(KEY_A, OTHER_CONTROLLER_ID))
    assert boot.boot_controllers(commands, CONFIG, boot.parse_bundle(raw)) == {}
    path = machine / ".switch-controllers.json"
    assert json.loads(path.read_text()) == {
        "version": 1,
        "controllers": {KEY_B: 0, KEY_A: 1},
    }
    assert stat.S_IMODE(path.lstat().st_mode) == 0o600
    assert setups(commands) == ["switch-controller", "switch-controller-1"]


def test_a_seat_that_left_keeps_its_index_and_its_data_and_its_controller_is_stopped(
    machine,
):
    boot.save_indexes(machine, {KEY_A: 0, KEY_B: 1})
    left = boot.seat_for(1, CONFIG)
    left.data_dir.mkdir(parents=True)
    (left.data_dir / "controller.db").write_text("kept")
    commands = FakeCommands()
    raw = bundle(enrolled_entry(KEY_A))
    assert boot.boot_controllers(commands, CONFIG, boot.parse_bundle(raw)) == {}
    assert [
        "/usr/bin/systemctl",
        "disable",
        "--now",
        "switch-agent-controller-2200.service",
    ] in (commands.calls)
    assert [
        "/usr/bin/systemctl",
        "stop",
        "switch-agent-2200@*.service",
    ] in commands.calls
    assert (left.data_dir / "controller.db").read_text() == "kept"
    assert setups(commands) == ["switch-controller"]
    assert boot.load_indexes(machine) == {KEY_A: 0, KEY_B: 1}

    again = FakeCommands({"getent": [(2, "")]})
    raw = bundle(enrolled_entry(KEY_A), enrolled_entry(KEY_C, OTHER_CONTROLLER_ID))
    assert boot.boot_controllers(again, CONFIG, boot.parse_bundle(raw)) == {}
    assert boot.load_indexes(machine) == {KEY_A: 0, KEY_B: 1, KEY_C: 2}
    assert setups(again) == ["switch-controller", "switch-controller-2"]


def test_a_controller_that_left_is_stopped_even_when_its_unit_is_not_on_this_root_volume(
    machine,
):
    boot.save_indexes(machine, {KEY_A: 0, KEY_B: 1})
    missing = "Failed to disable unit: Unit file switch-agent-controller-2200.service does not exist."
    commands = FakeCommands({"disable --now": [(1, missing)]})
    assert (
        boot.boot_controllers(
            commands, CONFIG, boot.parse_bundle(bundle(enrolled_entry(KEY_A)))
        )
        == {}
    )
    failing = FakeCommands({"disable --now": [(1, "Access denied")]})
    [(key, failure)] = boot.boot_controllers(
        failing, CONFIG, boot.parse_bundle(bundle(enrolled_entry(KEY_A)))
    ).items()
    assert key == KEY_B and KEY_B in failure
    assert setups(failing) == ["switch-controller"]


def test_a_seat_without_a_free_index_fails_alone(machine):
    boot.save_indexes(machine, {uuid_key(n): n for n in range(1, 8)} | {KEY_A: 0})
    commands = FakeCommands()
    raw = bundle(enrolled_entry(KEY_A), enrolled_entry(KEY_B, OTHER_CONTROLLER_ID))
    [(key, failure)] = boot.boot_controllers(
        commands, CONFIG, boot.parse_bundle(raw)
    ).items()
    assert key == KEY_B and "no free controller index" in failure
    assert setups(commands) == ["switch-controller"]


def test_the_indexes_are_never_read_through_a_link(machine):
    elsewhere = machine.parent / "elsewhere.json"
    elsewhere.write_text(json.dumps({"version": 1, "controllers": {KEY_A: 0}}))
    (machine / ".switch-controllers.json").symlink_to(elsewhere)
    with pytest.raises(boot.BootError, match="cannot be read"):
        boot.load_indexes(machine)
    with pytest.raises(boot.BootError):
        boot.boot_controllers(FakeCommands(), CONFIG, boot.parse_bundle(bundle()))


def test_the_indexes_are_never_written_through_a_link(machine):
    victim = machine.parent / "victim"
    victim.write_text("untouched")
    (machine / ".switch-controllers.json.new").symlink_to(victim)
    boot.save_indexes(machine, {KEY_A: 0})
    assert victim.read_text() == "untouched"
    path = machine / ".switch-controllers.json"
    assert stat.S_ISREG(path.lstat().st_mode)
    assert boot.load_indexes(machine) == {KEY_A: 0}


@pytest.mark.parametrize(
    "recorded",
    [
        {"version": 2, "controllers": {}},
        {"version": 1, "controllers": {KEY_A: 0, KEY_B: 0}},
        {"version": 1, "controllers": {KEY_A: 8}},
        {"version": 1, "controllers": {KEY_A: True}},
        {"version": 1, "controllers": {"seat-a": 0}},
        {"version": 1, "controllers": [KEY_A]},
        {"version": 1, "controllers": {}, "extra": 1},
    ],
)
def test_indexes_this_image_does_not_read_are_refused(machine, recorded):
    (machine / ".switch-controllers.json").write_text(json.dumps(recorded))
    with pytest.raises(boot.BootError):
        boot.load_indexes(machine)


def test_another_index_gets_its_users_with_their_fixed_ids():
    commands = FakeCommands({"getent": [(2, "")]})
    seat = boot.seat_for(1, CONFIG)
    boot.ensure_identities(commands, dataclasses.replace(CONFIG, agent_users=2), seat)
    nologin = [
        "--no-create-home",
        "--home-dir",
        "/nonexistent",
        "--shell",
        "/usr/sbin/nologin",
    ]
    assert [call for call in commands.calls if "getent" not in call[0]] == [
        ["/usr/sbin/groupadd", "--system", "--gid", "2200", "switch-controller-1"],
        [
            "/usr/sbin/useradd",
            "--system",
            "--uid",
            "2200",
            "--gid",
            "2200",
            *nologin,
            "--comment",
            "Switch agents controller",
            "switch-controller-1",
        ],
        ["/usr/sbin/groupadd", "--system", "--gid", "2201", "switch-agents-2200"],
        [
            "/usr/sbin/useradd",
            "--system",
            "--uid",
            "2301",
            "--gid",
            "switch-agents-2200",
            *nologin,
            "--comment",
            "Switch agent",
            "sa2200-01",
        ],
        [
            "/usr/sbin/useradd",
            "--system",
            "--uid",
            "2302",
            "--gid",
            "switch-agents-2200",
            *nologin,
            "--comment",
            "Switch agent",
            "sa2200-02",
        ],
    ]


def test_users_that_exist_with_their_fixed_ids_are_kept():
    commands = FakeCommands(
        {
            "getent passwd switch-controller-1": [
                (0, "switch-controller-1:x:2200:2200::/nonexistent:/usr/sbin/nologin\n")
            ],
            "getent group switch-controller-1": [(0, "switch-controller-1:x:2200:\n")],
            "getent group switch-agents-2200": [(0, "switch-agents-2200:x:2201:\n")],
            "getent passwd sa2200-01": [
                (0, "sa2200-01:x:2301:2201::/nonexistent:/usr/sbin/nologin")
            ],
        }
    )
    seat = boot.seat_for(1, CONFIG)
    boot.ensure_identities(commands, dataclasses.replace(CONFIG, agent_users=1), seat)
    assert all(call[0] == "/usr/bin/getent" for call in commands.calls)


@pytest.mark.parametrize(
    "answers",
    [
        {
            "getent passwd switch-controller-1": [
                (0, "switch-controller-1:x:4242:2200::/:/bin/sh")
            ]
        },
        {
            "getent passwd switch-controller-1": [
                (0, "switch-controller-1:x:2200:100::/:/bin/sh")
            ]
        },
        {"getent group switch-controller-1": [(0, "switch-controller-1:x:4242:")]},
        {"getent group switch-agents-2200": [(0, "switch-agents-2200:x:4242:")]},
        {"getent passwd sa2200-01": [(0, "sa2200-01:x:4242:2201::/:/bin/sh")]},
    ],
)
def test_a_user_or_group_with_another_id_is_refused(answers):
    commands = FakeCommands({**answers, "getent": [(2, "")]})
    seat = boot.seat_for(1, CONFIG)
    with pytest.raises(boot.BootError, match="another"):
        boot.ensure_identities(
            commands, dataclasses.replace(CONFIG, agent_users=1), seat
        )
    refused = next(name for name in answers)
    assert commands.calls[-1] == ["/usr/bin/getent", *refused.split()[1:]]


def test_another_indexs_unit_is_ordered_after_the_boot(machine):
    commands = FakeCommands({"getent": [(2, "")]})
    raw = bundle(enrolled_entry(KEY_A), enrolled_entry(KEY_B, OTHER_CONTROLLER_ID))
    assert boot.boot_controllers(commands, CONFIG, boot.parse_bundle(raw)) == {}
    systemd = boot.SYSTEMD_SYSTEM_DIR
    drop_in = systemd / "switch-agent-controller-2200.service.d" / "after-boot.conf"
    assert (
        drop_in.read_text()
        == (SCRIPT.parent / "controller-after-boot.conf").read_text()
    )
    assert stat.S_IMODE(drop_in.stat().st_mode) == 0o644
    assert not (systemd / "switch-agent-controller-2000.service.d").exists()
    reloads = [i for i, call in enumerate(commands.calls) if "daemon-reload" in call]
    first_setup = commands.calls.index(commands.ran("install-service")[0])
    assert len(reloads) == 1 and reloads[0] < first_setup
    drop_in.write_text("stale")
    again = FakeCommands({"getent": [(2, "")]})
    assert boot.boot_controllers(again, CONFIG, boot.parse_bundle(raw)) == {}
    assert drop_in.read_text() == boot.AFTER_BOOT_DROP_IN


def test_another_index_enrolls_and_runs_on_its_own_paths_as_its_own_user(machine):
    commands = FakeCommands({" status ": [(1, "Not enrolled.")]})
    start(commands, index=2)
    seat = boot.seat_for(2, CONFIG)
    [enroll] = commands.ran("enroll")
    assert enroll[:4] == ["/usr/sbin/runuser", "-u", "switch-controller-2", "--"]
    assert enroll[enroll.index("--data-dir") + 1] == str(seat.data_dir)
    assert [
        "/usr/bin/chown",
        "switch-controller-2:",
        str(seat.data_dir),
    ] in commands.calls
    assert stat.S_IMODE(seat.data_dir.stat().st_mode) == 0o700
    for directory in (machine / "controllers", machine / "controllers" / "2"):
        assert stat.S_IMODE(directory.stat().st_mode) == 0o755
    assert (machine / "controllers" / "2" / "code").read_text() == (
        hashlib.sha256(CODE.encode()).hexdigest()
    )
    assert not (machine / ".switch-controller").exists()
    [setup] = commands.ran("install-service")
    assert setup[setup.index("--user") + 1] == "switch-controller-2"
    assert setup[setup.index("--data-dir") + 1] == str(seat.data_dir)
    assert setup[setup.index("--agents-dir") + 1] == str(seat.agents_dir)


def test_a_fresh_machine_enrolls_then_runs_its_agents_as_users_of_their_own(machine):
    commands = FakeCommands({" status ": [(1, "Not enrolled.")]})
    start(commands)
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
    assert enroll[enroll.index("--name") + 1] == "Switch cloud"
    assert enroll[enroll.index("--data-dir") + 1] == str(machine / ".switch-controller")
    [setup] = commands.ran("install-service")
    assert setup[:2] == [
        "/opt/switch/node/bin/node",
        "/opt/switch/controller/bin/switch-agent-controller",
    ]
    assert setup[setup.index("--agents-dir") + 1] == str(machine / "agents")
    assert setup[setup.index("--user") + 1] == "switch-controller"
    assert setup[setup.index("--agent-users") + 1] == "16"
    assert "--no-block" in setup
    assert commands.calls.index(enroll) < commands.calls.index(setup)


def test_an_enrolled_machine_only_starts_its_controller(machine):
    (machine / ".switch-controller").mkdir()
    commands = FakeCommands({" status ": [(0, "Controller: 9a1c…")]})
    start(commands, bundle(enrolled_entry(KEY_A)))
    assert commands.ran("enroll") == []
    assert len(commands.ran("install-service")) == 1


def test_a_new_code_sets_a_revoked_enrollment_aside(machine):
    (machine / ".switch-controller").mkdir()
    (machine / ".switch-controller" / "controller.db").write_text("old")
    (machine / ".switch-controller-code").write_text(
        hashlib.sha256(b"swce_old").hexdigest()
    )
    commands = FakeCommands({" status ": [(0, "Controller: old")]})
    start(commands)
    assert (
        machine / ".switch-controller.replaced-7" / "controller.db"
    ).read_text() == "old"
    assert not (machine / ".switch-controller" / "controller.db").exists()
    assert len(commands.ran("enroll")) == 1
    assert (machine / ".switch-controller-code").read_text() != hashlib.sha256(
        b"swce_old"
    ).hexdigest()


def test_another_index_sets_its_revoked_enrollment_aside_next_to_it(machine):
    seat = boot.seat_for(1, CONFIG)
    seat.data_dir.mkdir(parents=True)
    (seat.data_dir / "controller.db").write_text("old")
    seat.code_record.write_text(hashlib.sha256(b"swce_old").hexdigest())
    commands = FakeCommands({" status ": [(0, "Controller: old")]})
    start(commands, index=1)
    aside = machine / "controllers" / "1" / "data.replaced-7"
    assert (aside / "controller.db").read_text() == "old"
    assert len(commands.ran("enroll")) == 1


def test_an_enrollment_made_with_this_code_is_kept_when_the_boot_runs_again(machine):
    first = FakeCommands({" status ": [(1, "Not enrolled.")]})
    start(first)
    assert len(first.ran("enroll")) == 1
    # It failed after enrolling: systemd starts the boot again, and Switch,
    # which has not linked the controller yet, still hands over the code.
    (machine / ".switch-controller" / "controller.db").write_text("enrolled")
    again = FakeCommands({" status ": [(0, "Controller: new")]})
    start(again)
    assert again.ran("enroll") == []
    assert not (machine / ".switch-controller.replaced-7").exists()
    assert (machine / ".switch-controller" / "controller.db").read_text() == "enrolled"
    assert len(again.ran("install-service")) == 1


def test_no_enrollment_and_no_code_says_what_to_do(machine):
    commands = FakeCommands({" status ": [(1, "Not enrolled.")]})
    with pytest.raises(boot.BootError, match="Machines page"):
        start(commands, bundle(enrolled_entry(KEY_A)))
    assert commands.ran("install-service") == []


def test_one_failing_controller_does_not_keep_the_others_from_starting(
    machine, monkeypatch, caplog
):
    commands = FakeCommands(
        {
            "controllers/1/data": [(0, "Controller: b")],
            " status ": [(1, "Not enrolled.")],
            " enroll ": [(1, "")],
            "getent": [(2, "")],
        }
    )
    parsed = boot.parse_bundle(bundle(entry(KEY_A), enrolled_entry(KEY_B)))
    monkeypatch.setattr(boot.os, "geteuid", lambda: 0)
    monkeypatch.setattr(boot, "acquire_lock", contextlib.nullcontext)
    monkeypatch.setattr(boot, "read_bundle", lambda: parsed)
    monkeypatch.setattr(boot, "load_machine_config", lambda: CONFIG)
    monkeypatch.setattr(boot, "Commands", lambda: commands)
    monkeypatch.setattr(boot, "prepare_storage", lambda *_: None)
    waits = []
    monkeypatch.setattr(boot.time, "sleep", waits.append)
    with caplog.at_level(logging.ERROR, logger="switch-machine-boot"):
        assert boot.main([]) == 0
    assert waits == [boot.CONTROLLER_RETRY_SECONDS] * boot.CONTROLLER_RETRIES
    assert len(commands.ran("enroll")) == 1 + boot.CONTROLLER_RETRIES
    assert setups(commands) == ["switch-controller-1"]
    [failure] = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.ERROR
    ]
    assert "switch-controller" in failure and KEY_A in failure


def test_a_controller_that_fails_once_is_started_on_the_next_try(machine, monkeypatch):
    commands = FakeCommands(
        {
            " status ": [(1, "Not enrolled.")],
            " enroll ": [(1, ""), (0, "")],
            "getent": [(2, "")],
        }
    )
    parsed = boot.parse_bundle(bundle(entry(KEY_A)))
    monkeypatch.setattr(boot.os, "geteuid", lambda: 0)
    monkeypatch.setattr(boot, "acquire_lock", contextlib.nullcontext)
    monkeypatch.setattr(boot, "read_bundle", lambda: parsed)
    monkeypatch.setattr(boot, "load_machine_config", lambda: CONFIG)
    monkeypatch.setattr(boot, "Commands", lambda: commands)
    monkeypatch.setattr(boot, "prepare_storage", lambda *_: None)
    waits = []
    monkeypatch.setattr(boot.time, "sleep", waits.append)
    assert boot.main([]) == 0
    assert waits == [boot.CONTROLLER_RETRY_SECONDS]
    assert len(commands.ran("enroll")) == 2
    assert setups(commands) == ["switch-controller"]


def test_a_machine_whose_controllers_all_start_boots(machine, monkeypatch):
    commands = FakeCommands({"getent": [(2, "")]})
    parsed = boot.parse_bundle(
        bundle(enrolled_entry(KEY_A), enrolled_entry(KEY_B, OTHER_CONTROLLER_ID))
    )
    monkeypatch.setattr(boot.os, "geteuid", lambda: 0)
    monkeypatch.setattr(boot, "acquire_lock", contextlib.nullcontext)
    monkeypatch.setattr(boot, "read_bundle", lambda: parsed)
    monkeypatch.setattr(boot, "load_machine_config", lambda: CONFIG)
    monkeypatch.setattr(boot, "Commands", lambda: commands)
    monkeypatch.setattr(boot, "prepare_storage", lambda *_: None)
    assert boot.main([]) == 0
    assert (
        json.loads((machine / ".switch-machine.json").read_text())["machineId"]
        == MACHINE_ID
    )
    assert setups(commands) == ["switch-controller", "switch-controller-1"]


def test_user_data_that_is_no_bundle_is_not_retried(monkeypatch):
    def no_bundle():
        raise boot.NoBundle("no bundle")

    monkeypatch.setattr(boot.os, "geteuid", lambda: 0)
    monkeypatch.setattr(boot, "acquire_lock", contextlib.nullcontext)
    monkeypatch.setattr(boot, "read_bundle", no_bundle)
    assert boot.main([]) == boot.NO_BUNDLE_EXIT
