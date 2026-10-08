#!/usr/bin/env python3
"""Boot a Switch cloud machine that runs the agents controller.

Runs as root, once per boot, before the controller's service
(`switch-machine-boot.service`). It reads the bundle the hosted controller
wrote for this machine, mounts the machine's own data volume on /data,
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
from urllib.parse import urlsplit

logger = logging.getLogger("switch-machine-boot")

DATA_MOUNT = Path("/data")
ASSIGNMENT_PATH = Path("/etc/switch-hosted/assignment.json")
MACHINE_CONFIG_PATH = Path("/etc/switch-hosted/machine.json")
LOCK_PATH = Path("/run/lock/switch-machine-boot.lock")
MARKER_NAME = ".switch-machine.json"
CONTROLLER_DIR_NAME = ".switch-controller"
# The SHA-256 of the code the enrollment in CONTROLLER_DIR_NAME was made with.
CODE_RECORD_NAME = ".switch-controller-code"
AGENTS_DIR_NAME = "agents"
SYSTEMD_MOUNT = "/usr/bin/systemd-mount"
VOLUME_RE = re.compile(r"^vol-[0-9a-f]{8,17}$")
SECRET_ARN_RE = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z]{2}(?:-gov)?-[a-z]+-\d):([0-9]{12}):secret:([A-Za-z0-9/_+=.@-]+)$"
)
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$")
ENROLLMENT_CODE_RE = re.compile(r"^swce_[A-Za-z0-9_-]{16,128}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_JSON_BYTES = 128 * 1024
VOLUME_WAIT_SECONDS = 600
SECRET_WAIT_SECONDS = 300
# The bundle of a worker machine: this image cannot run it, and says so.
OBSOLETE_EXIT_CODE = 75


class BootError(RuntimeError):
    """Booting cannot go on; the message says why."""


class ObsoleteBundle(BootError):
    pass


@dataclass(frozen=True)
class Assignment:
    installation_id: str
    slot_id: str
    generation: int
    secret_id: str
    secret_region: str
    volume_id: str


@dataclass(frozen=True)
class MachineConfig:
    controller_user: str
    node: str
    cli: str
    path: str
    agent_users: int


@dataclass(frozen=True)
class Bundle:
    machine_id: str
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


def load_assignment(path: Path = ASSIGNMENT_PATH) -> Assignment:
    """What the hosted controller wrote into the instance's user data."""
    value = _load_json(path, "machine assignment")
    if not isinstance(value, dict):
        raise BootError("The machine assignment is not an object.")
    optional = {"previousInstanceId", "previousRuntimeFingerprint"}
    value = _strict(
        {key: item for key, item in value.items() if key not in optional},
        {
            "version",
            "installationId",
            "slotId",
            "generation",
            "assignmentSecretId",
            "dataVolumeId",
            "dataDevice",
            "mountPath",
        },
        "machine assignment",
    )
    if value["version"] != 2 or value["mountPath"] != str(DATA_MOUNT):
        raise BootError("The machine assignment is not one this image reads.")
    generation = value["generation"]
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 1:
        raise BootError("The machine assignment's generation is invalid.")
    volume_id = value["dataVolumeId"]
    if not isinstance(volume_id, str) or not VOLUME_RE.fullmatch(volume_id):
        raise BootError("The machine assignment's data volume is invalid.")
    secret_id = value["assignmentSecretId"]
    matched = SECRET_ARN_RE.fullmatch(secret_id) if isinstance(secret_id, str) else None
    if matched is None:
        raise BootError("The machine assignment's secret is not a Secrets Manager ARN.")
    return Assignment(
        installation_id=_identifier(value["installationId"], "installation id"),
        slot_id=_identifier(value["slotId"], "slot id"),
        generation=generation,
        secret_id=secret_id,
        secret_region=matched.group(2),
        volume_id=volume_id,
    )


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


def parse_bundle(raw: str, assignment: Assignment) -> Bundle:
    """The bundle for this machine, as `controller_bundle` in the hosted controller writes it."""
    try:
        value = json.loads(raw)
    except ValueError:
        raise BootError("The machine bundle is not JSON.") from None
    if isinstance(value, dict) and value.get("version") == 2:
        raise ObsoleteBundle(
            "The machine bundle is a hosted worker's, which this image does not run: "
            "launch worker machines from the worker image, or have Switch claim "
            "machines with HOSTED_MACHINE_RUNTIME=controller."
        )
    value = _strict(
        value,
        {"version", "machineId", "assignment", "apiEndpoint", "controller"},
        "machine bundle",
    )
    if value["version"] != 3:
        raise BootError("The machine bundle's version is not one this image reads.")
    if value["assignment"] != {
        "installationId": assignment.installation_id,
        "slotId": assignment.slot_id,
        "generation": assignment.generation,
        "dataVolumeId": assignment.volume_id,
    }:
        raise BootError("The machine bundle is for another machine than this one.")
    machine_id = value["machineId"]
    if not isinstance(machine_id, str) or not UUID_RE.fullmatch(machine_id):
        raise BootError("The machine bundle's machine id is invalid.")
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
        raise BootError("The machine bundle holds neither a controller nor an enrollment code.")
    return Bundle(
        machine_id=machine_id,
        api_endpoint=endpoint,
        controller_id=controller_id,
        enrollment_code=code,
    )


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


def read_bundle(
    assignment: Assignment,
    client: Any,
    sleep: Callable[[float], None] = time.sleep,
    wait_seconds: float = SECRET_WAIT_SECONDS,
) -> Bundle:
    """The current bundle, waiting a while for one the hosted controller is still writing."""
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            response = client.get_secret_value(
                SecretId=assignment.secret_id, VersionStage="AWSCURRENT"
            )
            raw = response.get("SecretString")
            if not isinstance(raw, str):
                raise BootError("The machine bundle is not a string.")
            return parse_bundle(raw, assignment)
        except ObsoleteBundle:
            raise
        except Exception as error:
            if time.monotonic() > deadline:
                raise BootError(f"The machine bundle cannot be read: {error}") from None
            logger.warning("Waiting for the machine bundle: %s", error)
            sleep(10)


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
        commands.run(["/usr/sbin/mkfs.ext4", "-q", "-m", "0", "-L", "switch-data", path])
        commands.run(["/usr/bin/udevadm", "settle", "--timeout=30"])
        device = _data_device(commands, volume_id)
        if device is None:
            raise BootError("The data volume went away while it was formatted.")
    if device.get("fstype") != "ext4":
        raise BootError("The data volume's filesystem is not ext4; refusing to mount it.")
    DATA_MOUNT.mkdir(mode=0o755, exist_ok=True)
    mounted = commands.result(
        ["/usr/bin/findmnt", "--mountpoint", str(DATA_MOUNT), "--noheadings", "--output", "SOURCE"]
    )
    if mounted.returncode == 0:
        if os.path.realpath(mounted.stdout.strip()) != os.path.realpath(path):
            raise BootError("/data is another device's mountpoint.")
        return
    commands.run([SYSTEMD_MOUNT, "--type=ext4", "--options=nodev,nosuid", path, str(DATA_MOUNT)])


def reconcile_marker(data: Path, assignment: Assignment, machine_id: str) -> None:
    """Records which machine the data volume belongs to, and refuses one that
    belongs to another: an agent's data never reaches someone else's machine."""
    marker = data / MARKER_NAME
    wanted = {
        "version": 1,
        "installationId": assignment.installation_id,
        "machineId": machine_id,
        "volumeId": assignment.volume_id,
    }
    if marker.exists():
        if marker.is_symlink():
            raise BootError("The data volume's marker is a link.")
        if json.loads(marker.read_text()) != wanted:
            raise BootError("The data volume belongs to another machine; refusing to use it.")
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
    assignment: Assignment,
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
                    "Switch gave a new code; setting the old enrollment aside in %s", aside
                )
                os.replace(data_dir, aside)
                data_dir.mkdir(mode=0o700)
                commands.run(["/usr/bin/chown", f"{config.controller_user}:", str(data_dir)])
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
            assignment = load_assignment()
            config = load_machine_config()
            import boto3  # type: ignore[import-not-found]

            client = boto3.client("secretsmanager", region_name=assignment.secret_region)
            bundle = read_bundle(assignment, client)
            commands = Commands()
            prepare_storage(commands, assignment.volume_id)
            reconcile_marker(DATA_MOUNT, assignment, bundle.machine_id)
            start_controller(commands, config, assignment, bundle)
    except ObsoleteBundle as error:
        logger.error("%s", error)
        return OBSOLETE_EXIT_CODE
    except BootError as error:
        logger.error("%s", error)
        return 1
    logger.info("The controller is running")
    return 0


if __name__ == "__main__":
    sys.exit(main())
