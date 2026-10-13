#!/usr/bin/env python3
"""Boot a Switch cloud machine that runs one agents controller per workspace.

Runs as root, once per boot, before the controllers' services
(`switch-machine-boot.service`). It reads the bundle the hosted controller
gave this machine as its instance's user data and mounts the machine's own
data volume on /data. Then, for each workspace seat the bundle lists, it
enrolls a `switch-agent-controller` with the seat's one-time code when the
data volume holds no live enrollment for it yet, and sets it up to run every
agent as a Linux user of its own (`install-service --separate-users`), its
state and its agents' directories on /data.

Each seat keeps an index on the data volume, from which its users, ids and
paths are derived, so they mean the same on every instance. A seat that is no
longer in the bundle has its controller stopped; its data stays on the volume.

The bundle never holds a long-lived credential: each controller keeps the one
it enrolls with in its data directory, on the machine's own volume.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import logging
import os
import re
import stat
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import OpenerDirector, ProxyHandler, Request, build_opener

logger = logging.getLogger("switch-machine-boot")

DATA_MOUNT = Path("/data")
MACHINE_CONFIG_PATH = Path("/etc/switch-hosted/machine.json")
LOCK_PATH = Path("/run/lock/switch-machine-boot.lock")
MARKER_NAME = ".switch-machine.json"
# Index 0's layout, which predates several controllers per machine.
CONTROLLER_DIR_NAME = ".switch-controller"
# The SHA-256 of the code the enrollment in a data directory was made with.
CODE_RECORD_NAME = ".switch-controller-code"
AGENTS_DIR_NAME = "agents"
# The other indexes' directories, each in CONTROLLERS_DIR_NAME/<index>.
CONTROLLERS_DIR_NAME = "controllers"
INDEXES_NAME = ".switch-controllers.json"
MAX_CONTROLLERS = 8
# The ids the image gives index 0 (install.sh); index k's are offset by k * UID_STRIDE.
FIRST_CONTROLLER_UID = 2000
UID_STRIDE = 200
SYSTEMD_SYSTEM_DIR = Path("/etc/systemd/system")
# What install.sh installs as controller-after-boot.conf for index 0.
AFTER_BOOT_DROP_IN = """# The controller's state is on the data volume the boot service mounts.
[Unit]
Requires=switch-machine-boot.service
After=switch-machine-boot.service
RequiresMountsFor=/data
"""
SYSTEMD_MOUNT = "/usr/bin/systemd-mount"
VOLUME_RE = re.compile(r"^vol-[0-9a-f]{8,17}$")
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$")
ENROLLMENT_CODE_RE = re.compile(r"^swce_[A-Za-z0-9_-]{16,128}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_JSON_BYTES = 128 * 1024
VOLUME_WAIT_SECONDS = 600
# A controller that fails to enroll or start is tried again this many times,
# this far apart, before the boot leaves it stopped and the others running.
CONTROLLER_RETRIES = 4
CONTROLLER_RETRY_SECONDS = 30
METADATA_WAIT_SECONDS = 300
# Instance metadata, IMDSv2: agents cannot reach it, root can.
METADATA_URL = "http://169.254.169.254/latest"
# The exit status of an instance the hosted controller did not launch, which
# has nothing to boot from: systemd does not run it again.
NO_BUNDLE_EXIT = 3


class BootError(RuntimeError):
    """Booting cannot go on; the message says why."""


class NoBundle(BootError):
    """The instance's user data is no bundle: the hosted controller did not launch it."""


@dataclass(frozen=True)
class MachineConfig:
    controller_user: str
    node: str
    cli: str
    path: str
    agent_users: int


@dataclass(frozen=True)
class BundleController:
    """A workspace's seat on this machine, and the controller it runs there."""

    key: str
    controller_id: str | None
    enrollment_code: str | None


@dataclass(frozen=True)
class Bundle:
    installation_id: str
    machine_id: str
    volume_id: str
    api_endpoint: str
    controllers: tuple[BundleController, ...]


@dataclass(frozen=True)
class Seat:
    """The users, ids and paths of the controller with a given index."""

    index: int
    uid: int
    user: str
    data_dir: Path
    code_record: Path
    agents_dir: Path

    @property
    def gid(self) -> int:
        return self.uid

    @property
    def agents_group(self) -> str:
        return f"switch-agents-{self.uid}"

    @property
    def agents_gid(self) -> int:
        return self.uid + 1

    @property
    def unit(self) -> str:
        return f"switch-agent-controller-{self.uid}.service"

    def agent_user(self, slot: int) -> str:
        return f"sa{self.uid}-{slot:02d}"

    def agent_uid(self, slot: int) -> int:
        return self.uid + 100 + slot


def seat_for(index: int, config: MachineConfig) -> Seat:
    """Index 0 is the controller the image bakes, on the layout of a machine
    with a single controller, so its disk keeps its enrollment."""
    if not 0 <= index < MAX_CONTROLLERS:
        raise BootError(f"There is no controller index {index}.")
    uid = FIRST_CONTROLLER_UID + UID_STRIDE * index
    if index == 0:
        return Seat(
            index=0,
            uid=uid,
            user=config.controller_user,
            data_dir=DATA_MOUNT / CONTROLLER_DIR_NAME,
            code_record=DATA_MOUNT / CODE_RECORD_NAME,
            agents_dir=DATA_MOUNT / AGENTS_DIR_NAME,
        )
    home = DATA_MOUNT / CONTROLLERS_DIR_NAME / str(index)
    return Seat(
        index=index,
        uid=uid,
        user=f"{config.controller_user}-{index}",
        data_dir=home / "data",
        code_record=home / "code",
        agents_dir=home / "agents",
    )


def _load_json(path: Path, what: str) -> Any:
    try:
        details = path.lstat()
        if not stat.S_ISREG(details.st_mode) or details.st_size > MAX_JSON_BYTES:
            raise ValueError()
        return json.loads(path.read_text())
    except (OSError, ValueError):
        raise BootError(f"The {what} at {path} cannot be read.") from None


def _strict(value: Any, keys: set[str], what: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise BootError(f"The {what} is not one this image reads.")
    return value


def _identifier(value: Any, what: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_RE.fullmatch(value):
        raise BootError(f"The {what} is invalid.")
    return value


def load_machine_config(path: Path = MACHINE_CONFIG_PATH) -> MachineConfig:
    """What the image was baked with (`install.sh`)."""
    value = _strict(
        _load_json(path, "machine image configuration"),
        {"version", "controllerUser", "node", "cli", "path", "agentUsers"},
        "machine image configuration",
    )
    agent_users = value["agentUsers"]
    if (
        value["version"] != 1
        or not isinstance(agent_users, int)
        or isinstance(agent_users, bool)
        or not 1 <= agent_users <= 99
        or not isinstance(value["cli"], str)
        or not value["cli"].startswith("/")
        or not isinstance(value["node"], str)
        or not value["node"].startswith("/")
        or not isinstance(value["path"], str)
    ):
        raise BootError("The machine image configuration is not one this image reads.")
    return MachineConfig(
        controller_user=_identifier(value["controllerUser"], "controller user"),
        node=value["node"],
        cli=value["cli"],
        path=value["path"],
        agent_users=agent_users,
    )


def parse_bundle(raw: str) -> Bundle:
    """The bundle for this machine, as `Gateway.bundle` in the hosted controller writes it."""
    try:
        value = json.loads(raw)
    except ValueError:
        raise NoBundle(
            "This instance's user data is not a machine bundle: only an instance the "
            "hosted controller launched can boot as a Switch cloud machine."
        ) from None
    if isinstance(value, dict) and value.get("version") != 5:
        raise BootError("The machine bundle's version is not one this image reads.")
    value = _strict(
        value,
        {
            "version",
            "installationId",
            "machineId",
            "dataVolumeId",
            "apiEndpoint",
            "controllers",
        },
        "machine bundle",
    )
    machine_id = value["machineId"]
    if not isinstance(machine_id, str) or not UUID_RE.fullmatch(machine_id):
        raise BootError("The machine bundle's machine id is invalid.")
    volume_id = value["dataVolumeId"]
    if not isinstance(volume_id, str) or not VOLUME_RE.fullmatch(volume_id):
        raise BootError("The machine bundle's data volume is invalid.")
    endpoint = value["apiEndpoint"]
    url = urlsplit(endpoint) if isinstance(endpoint, str) else None
    if url is None or url.scheme != "https" or not url.hostname:
        raise BootError("The machine bundle's server is not an HTTPS URL.")
    entries = value["controllers"]
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_CONTROLLERS:
        raise BootError(
            f"The machine bundle must list 1 to {MAX_CONTROLLERS} controllers."
        )
    controllers = tuple(_bundle_controller(entry) for entry in entries)
    if len({controller.key for controller in controllers}) != len(controllers):
        raise BootError("The machine bundle lists a controller key twice.")
    ids = [c.controller_id for c in controllers if c.controller_id is not None]
    if len(set(ids)) != len(ids):
        raise BootError("The machine bundle lists a controller twice.")
    return Bundle(
        installation_id=_identifier(value["installationId"], "installation id"),
        machine_id=machine_id,
        volume_id=volume_id,
        api_endpoint=endpoint,
        controllers=controllers,
    )


def _bundle_controller(entry: Any) -> BundleController:
    controller = _strict(
        entry, {"key", "id", "enrollmentCode"}, "machine bundle's controller"
    )
    key = controller["key"]
    if not isinstance(key, str) or not UUID_RE.fullmatch(key):
        raise BootError("The machine bundle's controller key is invalid.")
    controller_id, code = controller["id"], controller["enrollmentCode"]
    if controller_id is not None:
        if (
            code is not None
            or not isinstance(controller_id, str)
            or not UUID_RE.fullmatch(controller_id)
        ):
            raise BootError("The machine bundle's controller is invalid.")
    elif not isinstance(code, str) or not ENROLLMENT_CODE_RE.fullmatch(code):
        raise BootError(
            "The machine bundle holds neither a controller nor an enrollment code."
        )
    return BundleController(key=key, controller_id=controller_id, enrollment_code=code)


def _user_data(opener: OpenerDirector) -> str:
    token_request = Request(
        f"{METADATA_URL}/api/token",
        method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
    )
    with opener.open(token_request, timeout=5) as response:
        token = response.read().decode()
    request = Request(
        f"{METADATA_URL}/user-data", headers={"X-aws-ec2-metadata-token": token}
    )
    try:
        with opener.open(request, timeout=5) as response:
            raw = response.read(MAX_JSON_BYTES + 1)
    except HTTPError as error:
        if error.code == 404:
            raise NoBundle(
                "This instance has no user data: only an instance the hosted controller "
                "launched can boot as a Switch cloud machine."
            ) from None
        raise
    if len(raw) > MAX_JSON_BYTES:
        raise BootError("The instance's user data is too large to be a machine bundle.")
    return raw.decode()


def read_bundle(
    opener: OpenerDirector | None = None,
    sleep: Callable[[float], None] = time.sleep,
    wait_seconds: float = METADATA_WAIT_SECONDS,
) -> Bundle:
    """The bundle in the instance's user data, read on every boot: the hosted
    controller replaces it while the instance is stopped when the machine must
    enroll again. Instance metadata is waited for a while."""
    opener = opener or build_opener(ProxyHandler({}))
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            raw = _user_data(opener)
            break
        except BootError:
            raise
        except Exception as error:
            if time.monotonic() > deadline:
                raise BootError(
                    f"The instance's user data cannot be read: {error}"
                ) from None
            logger.warning("Waiting for instance metadata: %s", error)
            sleep(5)
    return parse_bundle(raw)


class Commands:
    """Runs host commands, never through a shell."""

    def result(
        self, arguments: list[str], *, env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                arguments,
                check=False,
                text=True,
                capture_output=True,
                env=env or {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
            )
        except OSError:
            raise BootError(f"{arguments[0]} cannot be run.") from None

    def run(self, arguments: list[str], *, env: dict[str, str] | None = None) -> str:
        completed = self.result(arguments, env=env)
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout).strip().splitlines()
            raise BootError(
                f"{arguments[0]} {arguments[1] if len(arguments) > 1 else ''} failed"
                f"{': ' + detail[-1] if detail else ''}."
            )
        return completed.stdout


def _data_device(commands: Commands, volume_id: str) -> dict[str, Any] | None:
    """The attached disk whose serial is the volume's id, or None while it is not attached."""
    listed = json.loads(
        commands.run(
            [
                "/usr/bin/lsblk",
                "--json",
                "--paths",
                "--output",
                "PATH,TYPE,FSTYPE,UUID,SERIAL,MOUNTPOINTS",
            ]
        )
    )
    serial = volume_id.replace("-", "")
    found = [
        device
        for device in listed.get("blockdevices", [])
        if device.get("type") == "disk"
        and str(device.get("serial") or "").lower().replace("-", "") == serial
    ]
    if len(found) > 1:
        raise BootError("More than one attached disk claims to be the data volume.")
    return found[0] if found else None


def prepare_storage(
    commands: Commands,
    volume_id: str,
    sleep: Callable[[float], None] = time.sleep,
    wait_seconds: float = VOLUME_WAIT_SECONDS,
) -> None:
    """Mounts the machine's data volume on /data (nodev, nosuid), formatting it
    only when it is blank. The volume is attached after the instance starts,
    so it is waited for."""
    deadline = time.monotonic() + wait_seconds
    device = _data_device(commands, volume_id)
    while device is None:
        if time.monotonic() > deadline:
            raise BootError(f"The data volume {volume_id} was not attached in time.")
        sleep(5)
        device = _data_device(commands, volume_id)
    path = device.get("path")
    if not isinstance(path, str) or not path.startswith("/dev/"):
        raise BootError("The data volume's device path is invalid.")
    if device.get("children"):
        raise BootError("The data volume is partitioned; refusing to touch it.")
    if not device.get("fstype"):
        signatures = json.loads(
            commands.run(["/usr/sbin/wipefs", "--json", "--no-act", path]) or "{}"
        ).get("signatures", [])
        if signatures or device.get("uuid"):
            raise BootError("The data volume is not blank, but holds no filesystem.")
        logger.info("Formatting the blank data volume %s", volume_id)
        commands.run(
            ["/usr/sbin/mkfs.ext4", "-q", "-m", "0", "-L", "switch-data", path]
        )
        commands.run(["/usr/bin/udevadm", "settle", "--timeout=30"])
        device = _data_device(commands, volume_id)
        if device is None:
            raise BootError("The data volume went away while it was formatted.")
    if device.get("fstype") != "ext4":
        raise BootError(
            "The data volume's filesystem is not ext4; refusing to mount it."
        )
    DATA_MOUNT.mkdir(mode=0o755, exist_ok=True)
    mounted = commands.result(
        [
            "/usr/bin/findmnt",
            "--mountpoint",
            str(DATA_MOUNT),
            "--noheadings",
            "--output",
            "SOURCE",
        ]
    )
    if mounted.returncode == 0:
        if os.path.realpath(mounted.stdout.strip()) != os.path.realpath(path):
            raise BootError("/data is another device's mountpoint.")
        return
    commands.run(
        [SYSTEMD_MOUNT, "--type=ext4", "--options=nodev,nosuid", path, str(DATA_MOUNT)]
    )


def reconcile_marker(data: Path, bundle: Bundle) -> None:
    """Records which machine the data volume belongs to, and refuses one that
    belongs to another: an agent's data never reaches someone else's machine."""
    marker = data / MARKER_NAME
    wanted = {
        "version": 1,
        "installationId": bundle.installation_id,
        "machineId": bundle.machine_id,
        "volumeId": bundle.volume_id,
    }
    if marker.exists():
        if marker.is_symlink():
            raise BootError("The data volume's marker is a link.")
        if json.loads(marker.read_text()) != wanted:
            raise BootError(
                "The data volume belongs to another machine; refusing to use it."
            )
        return
    _write_atomically(marker, json.dumps(wanted), 0o600)


def _write_atomically(path: Path, text: str, mode: int) -> None:
    """Writes `path` through a fresh file renamed over it, never through a link."""
    temporary = path.with_name(f"{path.name}.new")
    temporary.unlink(missing_ok=True)
    descriptor = os.open(
        temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode
    )
    with os.fdopen(descriptor, "w") as file:
        os.fchmod(file.fileno(), mode)
        file.write(text)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def load_indexes(data: Path) -> dict[str, int] | None:
    """Each seat's index, as recorded on the data volume; None before the first."""
    path = data / INDEXES_NAME
    if not path.exists() and not path.is_symlink():
        return None
    value = _strict(
        _load_json(path, "controllers' indexes"),
        {"version", "controllers"},
        "controllers' indexes",
    )
    indexes = value["controllers"]
    if (
        value["version"] != 1
        or not isinstance(indexes, dict)
        or not all(isinstance(key, str) and UUID_RE.fullmatch(key) for key in indexes)
        or not all(
            isinstance(index, int)
            and not isinstance(index, bool)
            and 0 <= index < MAX_CONTROLLERS
            for index in indexes.values()
        )
        or len(set(indexes.values())) != len(indexes)
    ):
        raise BootError(
            f"The controllers' indexes at {path} are not ones this image reads."
        )
    return dict(indexes)


def assign_indexes(recorded: dict[str, int] | None, keys: list[str]) -> dict[str, int]:
    """Every seat's index: the recorded ones, kept even for a seat that left the
    machine, and the lowest free one for each new seat, in bundle order. A seat
    there is no free index for is left out."""
    indexes = dict(recorded or {})
    for key in keys:
        if key in indexes:
            continue
        free = [i for i in range(MAX_CONTROLLERS) if i not in indexes.values()]
        if free:
            indexes[key] = free[0]
    return indexes


def save_indexes(data: Path, indexes: dict[str, int]) -> None:
    _write_atomically(
        data / INDEXES_NAME,
        json.dumps({"version": 1, "controllers": indexes}, indent=2, sort_keys=True),
        0o600,
    )


def _getent(commands: Commands, database: str, name: str) -> list[str] | None:
    """The entry for `name`, split into its fields, or None when there is none."""
    found = commands.result(["/usr/bin/getent", database, name])
    if found.returncode == 2:
        return None
    if found.returncode != 0:
        raise BootError(f"getent {database} {name} failed.")
    return found.stdout.strip().split(":")


def _ensure_group(commands: Commands, group: str, gid: int) -> None:
    entry = _getent(commands, "group", group)
    if entry is None:
        commands.run(["/usr/sbin/groupadd", "--system", "--gid", str(gid), group])
    elif len(entry) < 3 or entry[2] != str(gid):
        raise BootError(
            f"The group {group} exists with another gid than {gid}; refusing to use it."
        )


def _ensure_user(
    commands: Commands, user: str, uid: int, group: str, gid: int, comment: str
) -> None:
    entry = _getent(commands, "passwd", user)
    if entry is None:
        commands.run(
            [
                "/usr/sbin/useradd",
                "--system",
                "--uid",
                str(uid),
                "--gid",
                group,
                "--no-create-home",
                "--home-dir",
                "/nonexistent",
                "--shell",
                "/usr/sbin/nologin",
                "--comment",
                comment,
                user,
            ]
        )
    elif len(entry) < 4 or entry[2] != str(uid) or entry[3] != str(gid):
        raise BootError(
            f"The user {user} exists with another uid or group than {uid}:{gid}; "
            "refusing to use it."
        )


def ensure_identities(commands: Commands, config: MachineConfig, seat: Seat) -> None:
    """Creates the controller's user and its agents' group and users with the
    seat's fixed ids, as install.sh does for index 0, so that install-service
    finds them all and creates none with ids of its own choosing."""
    _ensure_group(commands, seat.user, seat.gid)
    _ensure_user(
        commands,
        seat.user,
        seat.uid,
        str(seat.gid),
        seat.gid,
        "Switch agents controller",
    )
    _ensure_group(commands, seat.agents_group, seat.agents_gid)
    for slot in range(1, config.agent_users + 1):
        _ensure_user(
            commands,
            seat.agent_user(slot),
            seat.agent_uid(slot),
            seat.agents_group,
            seat.agents_gid,
            "Switch agent",
        )


def write_drop_in(seat: Seat) -> None:
    """Orders the seat's controller unit after this service, as install.sh
    does for index 0. The root volume can be new, so it is written every boot."""
    directory = SYSTEMD_SYSTEM_DIR / f"{seat.unit}.d"
    directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    path = directory / "after-boot.conf"
    if path.is_symlink() or not path.exists() or path.read_text() != AFTER_BOOT_DROP_IN:
        _write_atomically(path, AFTER_BOOT_DROP_IN, 0o644)


def stop_controller(commands: Commands, seat: Seat) -> None:
    """Stops and disables a controller whose seat left the machine, and any of
    its agents still running. Its data stays on the volume."""
    stopped = commands.result(["/usr/bin/systemctl", "disable", "--now", seat.unit])
    output = f"{stopped.stdout}\n{stopped.stderr}"
    if stopped.returncode != 0 and not (
        "not loaded" in output or "does not exist" in output
    ):
        raise BootError(f"{seat.unit} cannot be stopped: {output.strip()}")
    commands.run(["/usr/bin/systemctl", "stop", f"switch-agent-{seat.uid}@*.service"])


def _ensure_root_directories(path: Path) -> None:
    """Creates `path` and its parents below /data, root's and 0755, refusing a link."""
    current = DATA_MOUNT
    for part in path.relative_to(DATA_MOUNT).parts:
        current = current / part
        if current.is_symlink():
            raise BootError(f"{current} is a link; refusing to use it.")
        if not current.exists():
            current.mkdir(mode=0o755)
            os.chmod(current, 0o755)


def enrolled(commands: Commands, config: MachineConfig, seat: Seat) -> bool:
    """Whether the seat's data directory holds an enrollment that was not revoked."""
    status = commands.result(
        _as_controller(
            seat, [*_cli(config), "status", "--data-dir", str(seat.data_dir)]
        ),
        env=_environment(config),
    )
    if status.returncode != 0:
        return False
    return "Revoked at:" not in status.stdout


def _cli(config: MachineConfig) -> list[str]:
    """The controller's CLI, run on the image's Node.js by its path rather
    than through `#!/usr/bin/env node` and whatever PATH there is."""
    return [config.node, config.cli]


def _environment(config: MachineConfig) -> dict[str, str]:
    return {"PATH": config.path, "LANG": "C.UTF-8"}


def _as_controller(seat: Seat, arguments: list[str]) -> list[str]:
    return ["/usr/sbin/runuser", "-u", seat.user, "--", *arguments]


def start_controller(
    commands: Commands,
    config: MachineConfig,
    api_endpoint: str,
    seat: Seat,
    controller: BundleController,
    now: Callable[[], float] = time.time,
) -> None:
    """Enrolls the seat's controller when it must, then sets it up and starts it."""
    _ensure_root_directories(seat.data_dir.parent)
    data_dir = seat.data_dir
    if not data_dir.exists():
        data_dir.mkdir(mode=0o700)
        commands.run(["/usr/bin/chown", f"{seat.user}:", str(data_dir)])
    record = seat.code_record
    code = controller.enrollment_code
    if code is not None:
        code_hash = hashlib.sha256(code.encode()).hexdigest()
        if enrolled(commands, config, seat):
            if _recorded(record) == code_hash:
                # An earlier attempt of this boot enrolled with this very code
                # and failed later on. Switch has not linked the controller
                # yet, so it still hands the code over, but the code is spent.
                logger.info("%s is already enrolled with this code", seat.user)
                code = None
            else:
                # A new code, so Switch holds no live controller for this
                # seat: whatever this directory holds was revoked there.
                aside = data_dir.with_name(f"{data_dir.name}.replaced-{int(now())}")
                logger.warning(
                    "Switch gave %s a new code; setting the old enrollment aside in %s",
                    seat.user,
                    aside,
                )
                os.replace(data_dir, aside)
                data_dir.mkdir(mode=0o700)
                commands.run(["/usr/bin/chown", f"{seat.user}:", str(data_dir)])
    if code is not None:
        # Recorded first: a crash right after enrolling must not leave an
        # enrollment the next attempt would take for a revoked one.
        _record(record, code_hash)
        logger.info("Enrolling %s", seat.user)
        commands.run(
            _as_controller(
                seat,
                [
                    *_cli(config),
                    "enroll",
                    "--server",
                    api_endpoint,
                    "--code",
                    code,
                    "--name",
                    "Switch cloud",
                    "--data-dir",
                    str(data_dir),
                    "--secret-store",
                    "file",
                ],
            ),
            env=_environment(config),
        )
    elif controller.enrollment_code is None and not enrolled(commands, config, seat):
        raise BootError(
            "The data volume holds no live enrollment, and Switch gave no code to enroll "
            "with. Remove this machine's controller in the workspace's Machines page; the "
            "next start gets a new code."
        )
    commands.run(
        [
            *_cli(config),
            "install-service",
            "--separate-users",
            "--user",
            seat.user,
            "--data-dir",
            str(data_dir),
            "--agents-dir",
            str(seat.agents_dir),
            "--agent-users",
            str(config.agent_users),
            # The controller's unit is ordered after this service: a restart
            # waited for here would wait for this very boot to finish.
            "--no-block",
        ],
        env=_environment(config),
    )


def _recorded(path: Path) -> str | None:
    try:
        if path.is_symlink():
            return None
        return path.read_text().strip()
    except FileNotFoundError:
        return None


def _record(path: Path, code_hash: str) -> None:
    _write_atomically(path, code_hash, 0o600)


def boot_controllers(
    commands: Commands,
    config: MachineConfig,
    bundle: Bundle,
    now: Callable[[], float] = time.time,
) -> dict[str, str]:
    """Starts every controller the bundle lists and stops those whose seat left
    the machine. One that fails does not keep the others from starting: the
    failures are returned by seat key, one message each."""
    keys = [controller.key for controller in bundle.controllers]
    recorded = load_indexes(DATA_MOUNT)
    indexes = assign_indexes(recorded, keys)
    if indexes != recorded:
        save_indexes(DATA_MOUNT, indexes)
    failures: dict[str, str] = {}
    for key, index in sorted(indexes.items(), key=lambda item: item[1]):
        if key in keys:
            continue
        seat = seat_for(index, config)
        logger.warning(
            "The workspace seat %s left this machine: stopping its controller %s. "
            "Its data stays on the volume.",
            key,
            seat.unit,
        )
        try:
            stop_controller(commands, seat)
        except BootError as error:
            failures[key] = f"The controller of the seat {key} that left: {error}"
    seats = {key: seat_for(indexes[key], config) for key in keys if key in indexes}
    for seat in seats.values():
        if seat.index:
            write_drop_in(seat)
    commands.run(["/usr/bin/systemctl", "daemon-reload"])
    failures.update(
        start_controllers(commands, config, bundle, indexes, set(keys), now)
    )
    return failures


def start_controllers(
    commands: Commands,
    config: MachineConfig,
    bundle: Bundle,
    indexes: dict[str, int],
    keys: set[str],
    now: Callable[[], float] = time.time,
) -> dict[str, str]:
    """Enrolls when it must and starts the controllers of the seats `keys`;
    the failures by seat key."""
    failures: dict[str, str] = {}
    for controller in bundle.controllers:
        if controller.key not in keys:
            continue
        if controller.key not in indexes:
            failures[controller.key] = (
                f"The seat {controller.key} has no free controller index: all "
                f"{MAX_CONTROLLERS} are held by this machine's other seats, present or past."
            )
            continue
        seat = seat_for(indexes[controller.key], config)
        try:
            if seat.index:
                ensure_identities(commands, config, seat)
            start_controller(
                commands, config, bundle.api_endpoint, seat, controller, now
            )
        except (BootError, OSError) as error:
            failures[controller.key] = (
                f"The controller {seat.user} (seat {controller.key}): {error}"
            )
    return failures


def acquire_lock(path: Path = LOCK_PATH) -> Any:
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        raise BootError("Another boot of this machine is already running.") from None
    return os.fdopen(descriptor, "r+")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if os.geteuid() != 0:
        logger.error("switch-machine-boot must run as root.")
        return 2
    try:
        with acquire_lock():
            bundle = read_bundle()
            config = load_machine_config()
            commands = Commands()
            prepare_storage(commands, bundle.volume_id)
            reconcile_marker(DATA_MOUNT, bundle)
            failures = boot_controllers(commands, config, bundle)
            indexes = load_indexes(DATA_MOUNT) or {}
            for _attempt in range(CONTROLLER_RETRIES):
                if not failures or set(failures) - set(indexes):
                    break
                for failure in failures.values():
                    logger.warning("%s; trying again", failure)
                time.sleep(CONTROLLER_RETRY_SECONDS)
                failures = start_controllers(
                    commands, config, bundle, indexes, set(failures)
                )
    except NoBundle as error:
        logger.error("%s", error)
        return NO_BUNDLE_EXIT
    except BootError as error:
        logger.error("%s", error)
        return 1
    # Not a failed boot: the controllers this boot started are ordered after it
    # (`controller-after-boot.conf`), so failing it would stop them too.
    for failure in failures.values():
        logger.error("%s", failure)
    logger.info(
        "%d of the machine's %d controllers are running",
        len(bundle.controllers) - len(failures),
        len(bundle.controllers),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
