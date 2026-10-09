#!/usr/bin/env python3
"""Boot a Switch cloud machine that runs the agents controller.

Runs as root, once per boot, before the controller's service
(`switch-machine-boot.service`). It reads the bundle the hosted controller
gave this machine as its instance's user data, mounts the machine's own data
volume on /data,
enrolls `switch-agent-controller` with the one-time code in the bundle when
the data volume holds no live enrollment yet, and sets it up to run every
agent as a Linux user of its own (`install-service --separate-users`), its
state and its agents' directories on /data.

The bundle never holds a long-lived credential: the controller keeps the one
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
CONTROLLER_DIR_NAME = ".switch-controller"
# The SHA-256 of the code the enrollment in CONTROLLER_DIR_NAME was made with.
CODE_RECORD_NAME = ".switch-controller-code"
AGENTS_DIR_NAME = "agents"
SYSTEMD_MOUNT = "/usr/bin/systemd-mount"
VOLUME_RE = re.compile(r"^vol-[0-9a-f]{8,17}$")
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$")
ENROLLMENT_CODE_RE = re.compile(r"^swce_[A-Za-z0-9_-]{16,128}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_JSON_BYTES = 128 * 1024
VOLUME_WAIT_SECONDS = 600
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
class Bundle:
    installation_id: str
    machine_id: str
    volume_id: str
    api_endpoint: str
    controller_id: str | None
    enrollment_code: str | None


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
    value = _strict(
        value,
        {
            "version",
            "installationId",
            "machineId",
            "dataVolumeId",
            "apiEndpoint",
            "controller",
        },
        "machine bundle",
    )
    if value["version"] != 4:
        raise BootError("The machine bundle's version is not one this image reads.")
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
    controller = _strict(
        value["controller"], {"id", "enrollmentCode"}, "machine bundle's controller"
    )
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
    return Bundle(
        installation_id=_identifier(value["installationId"], "installation id"),
        machine_id=machine_id,
        volume_id=volume_id,
        api_endpoint=endpoint,
        controller_id=controller_id,
        enrollment_code=code,
    )


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
    temporary = data / f"{MARKER_NAME}.new"
    temporary.write_text(json.dumps(wanted))
    os.chmod(temporary, 0o600)
    os.replace(temporary, marker)


def enrolled(commands: Commands, config: MachineConfig, data_dir: Path) -> bool:
    """Whether the data directory holds an enrollment that was not revoked."""
    status = commands.result(
        _as_controller(config, [*_cli(config), "status", "--data-dir", str(data_dir)]),
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


def _as_controller(config: MachineConfig, arguments: list[str]) -> list[str]:
    return ["/usr/sbin/runuser", "-u", config.controller_user, "--", *arguments]


def start_controller(
    commands: Commands,
    config: MachineConfig,
    bundle: Bundle,
    now: Callable[[], float] = time.time,
) -> None:
    """Enrolls the controller when it must, then sets it up and starts it."""
    data_dir = DATA_MOUNT / CONTROLLER_DIR_NAME
    if not data_dir.exists():
        data_dir.mkdir(mode=0o700)
        commands.run(["/usr/bin/chown", f"{config.controller_user}:", str(data_dir)])
    record = DATA_MOUNT / CODE_RECORD_NAME
    code = bundle.enrollment_code
    if code is not None:
        code_hash = hashlib.sha256(code.encode()).hexdigest()
        if enrolled(commands, config, data_dir):
            if _recorded(record) == code_hash:
                # An earlier attempt of this boot enrolled with this very code
                # and failed later on. Switch has not linked the controller
                # yet, so it still hands the code over, but the code is spent.
                logger.info("The controller is already enrolled with this code")
                code = None
            else:
                # A new code, so Switch holds no live controller for this
                # machine: whatever this directory holds was revoked there.
                aside = DATA_MOUNT / f"{CONTROLLER_DIR_NAME}.replaced-{int(now())}"
                logger.warning(
                    "Switch gave a new code; setting the old enrollment aside in %s",
                    aside,
                )
                os.replace(data_dir, aside)
                data_dir.mkdir(mode=0o700)
                commands.run(
                    ["/usr/bin/chown", f"{config.controller_user}:", str(data_dir)]
                )
    if code is not None:
        # Recorded first: a crash right after enrolling must not leave an
        # enrollment the next attempt would take for a revoked one.
        _record(record, code_hash)
        logger.info("Enrolling the controller")
        commands.run(
            _as_controller(
                config,
                [
                    *_cli(config),
                    "enroll",
                    "--server",
                    bundle.api_endpoint,
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
    elif bundle.enrollment_code is None and not enrolled(commands, config, data_dir):
        raise BootError(
            "The data volume holds no live enrollment, and Switch gave no code to enroll "
            "with. Remove this machine's controller in the Machines page; the next start "
            "gets a new code."
        )
    commands.run(
        [
            *_cli(config),
            "install-service",
            "--separate-users",
            "--user",
            config.controller_user,
            "--data-dir",
            str(data_dir),
            "--agents-dir",
            str(DATA_MOUNT / AGENTS_DIR_NAME),
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
    temporary = path.with_name(f"{path.name}.new")
    temporary.write_text(code_hash)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


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
            start_controller(commands, config, bundle)
    except NoBundle as error:
        logger.error("%s", error)
        return NO_BUNDLE_EXIT
    except BootError as error:
        logger.error("%s", error)
        return 1
    logger.info("The controller is running")
    return 0


if __name__ == "__main__":
    sys.exit(main())
