#!/usr/bin/env python3
"""Root boot step for a hosted machine that runs the shared agent controller.

Runs once per boot as switch-machine-boot.service, before switch-controller:
mounts and verifies the data volume, moves a worker-layout volume onto the
controller layout, reads the controller bundle from Secrets Manager, writes
the controller's configuration and credential to tmpfs, and loads the rules
that keep agents away from the instance metadata service.
"""

from __future__ import annotations

import argparse
import fcntl
import grp
import hashlib
import json
import logging
import os
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

try:
    import boto3  # type: ignore[import-not-found]
except ImportError:
    boto3 = None

logger = logging.getLogger("switch-machine-boot")

DATA_MOUNT = Path("/data")
MACHINE_RUNTIME = Path("/run/switch-machine")
LOCK_PATH = Path("/run/lock/switch-machine-boot.lock")
BOOT_ID_PATH = Path("/proc/sys/kernel/random/boot_id")
NFT_RULES_PATH = "/etc/nftables.d/switch-imds.nft"
IMDS_BASE = "http://169.254.169.254/latest"
SYSTEMD_MOUNT = "/usr/bin/systemd-mount"
NFT = "/usr/sbin/nft"
NODE_PATH = "/opt/switch/node/bin/node"
CONTROLLER_PATH = "/opt/switch/controller/switch-agent-controller.mjs"
SHARED_HOST_DAEMON_PATH = "/opt/switch/agent-providers/shared-host-daemon.mjs"
BOOTSTRAP_PATH = "/opt/switch/agent-providers/hosted-bootstrap.mjs"
CLAUDE_PATH = "/opt/switch/claude/bin/claude"
CONTROLLER_USER = "switch-controller"
AGENT_USER = "switch-agent"
AGENT_GROUP = "switch-agent"
RELAY_PORT = 47100
MARKER_LAYOUT = "per-user-v1"
CONTROLLER_LAYOUT = "controller-v1"
ONE_AGENT_LAYOUT_MESSAGE = "data volume uses the one-agent layout; see 'Moving to one machine per user' in deploy/hosted/README.md"
OBSOLETE_EXIT_CODE = 75
BUNDLE_VERSION = 3
WORKER_BUNDLE_VERSION = 2
MAX_SECRET_BYTES = 128 * 1024
ROOT_UID = 0
NETWORK_ATTEMPTS = 8
NETWORK_BACKOFF_MAX_SECONDS = 30
TEST_HOOKS_ENV = "SWITCH_MACHINE_BOOT_TEST_HOOKS"
PROVIDER_NAMES = ("codex", "cursor", "opencode", "antigravity")
ARTIFACT_KEYS = {
    "node",
    "sharedHostDaemon",
    "bootstrap",
    "controller",
    "boot",
    "provider",
}
INSTANCE_RE = re.compile(r"^i-[0-9a-f]{8,17}$")
VOLUME_RE = re.compile(r"^vol-[0-9a-f]{8,17}$")
SECRET_ARN_RE = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z]{2}(?:-gov)?-[a-z]+-\d):([0-9]{12}):secret:([A-Za-z0-9/_+=.@-]+)$"
)
KMS_KEY_ARN_RE = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):kms:([a-z]{2}(?:-gov)?-[a-z]+-\d):([0-9]{12}):key/[A-Za-z0-9-]{1,128}$"
)
REGION_RE = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z]+-\d$")
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$")
AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CONTROLLER_CREDENTIAL_RE = re.compile(r"^swcc_[\x21-\x7e]{16,4096}$")
GRANT_TOKEN_RE = re.compile(r"^[\x21-\x7e]{1,8192}$")
FINGERPRINT_RE = re.compile(r"^sha256:[0-9a-f]{1,64}$")
KMS_CONTEXT_KEYS = {"switch:tenant", "switch:owner_id", "switch:controller_id"}
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class BootError(RuntimeError):
    pass


class ObsoleteBundle(BootError):
    pass


def _strict(
    value: Any, required: set[str], optional: set[str], label: str
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BootError(f"{label} must be an object.")
    keys = set(value)
    missing = required - keys
    unexpected = keys - required - optional
    if missing or unexpected:
        raise BootError(f"{label} has missing or unexpected fields.")
    return value


def _text(value: Any, label: str, *, maximum: int = 4096) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or "\x00" in value
    ):
        raise BootError(f"{label} is invalid.")
    return value


def _identifier(value: Any, label: str) -> str:
    value = _text(value, label, maximum=200)
    if not IDENTIFIER_RE.fullmatch(value):
        raise BootError(f"{label} is invalid.")
    return value


def _positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise BootError(f"{label} is invalid.")
    return value


def _https_endpoint(value: Any, label: str) -> str:
    endpoint = _text(value, label)
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise BootError(f"{label} is invalid.")
    return endpoint


def _absolute_path(value: Any, label: str) -> str:
    value = _text(value, label)
    if not os.path.isabs(value) or os.path.normpath(value) != value:
        raise BootError(f"{label} must be a normalized absolute path.")
    return value


def _digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise BootError(f"{label} is invalid.")
    return value


def _load_json(path: Path, failure: str, maximum: int) -> Any:
    try:
        if path.is_symlink() or path.stat().st_size > maximum:
            raise BootError(failure)
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        raise BootError(failure) from None


def _secret_arn_region(value: str) -> str:
    match = SECRET_ARN_RE.fullmatch(value)
    if not match:
        raise BootError(
            "Machine assignment secret ID must be a full Secrets Manager ARN."
        )
    partition, region, _account, _name = match.groups()
    if (
        partition == "aws-cn"
        and not region.startswith("cn-")
        or partition == "aws-us-gov"
        and not region.startswith("us-gov-")
        or partition == "aws"
        and (region.startswith("cn-") or region.startswith("us-gov-"))
    ):
        raise BootError(
            "Machine assignment secret ARN partition and region do not match."
        )
    return region


@dataclass(frozen=True)
class RuntimeConfig:
    node_path: str
    controller_path: str
    shared_host_daemon_path: str
    bootstrap_path: str
    boot_path: str
    provider_binary_path: str
    controller_user: str
    agent_user: str
    agent_group: str
    path: str
    allow_initial_format: bool
    artifact_sha256: dict[str, str]
    providers: dict[str, dict[str, str]] = field(default_factory=dict)


@dataclass(frozen=True)
class MachineConfig:
    installation_id: str
    slot_id: str
    generation: int
    secret_id: str
    secret_region: str
    volume_id: str
    device_path: str
    runtime: RuntimeConfig


@dataclass(frozen=True)
class KmsConfig:
    key_arn: str
    region: str
    grant_tokens: tuple[str, ...]
    context: dict[str, str]


@dataclass(frozen=True)
class ControllerBundle:
    machine_id: str
    api_endpoint: str
    controller_id: str
    controller_credential: str = field(repr=False)
    kms: KmsConfig = field(repr=False)


@dataclass(frozen=True)
class MachineIdentity:
    instance_id: str
    boot_id: str


@dataclass(frozen=True)
class Accounts:
    controller_uid: int
    controller_gid: int
    agent_uid: int
    agent_gid: int


@dataclass(frozen=True)
class StorageObservation:
    device_path: str
    volume_id: str
    filesystem_type: str | None
    filesystem_uuid: str | None
    has_children: bool
    signatures: tuple[str, ...]


@dataclass(frozen=True)
class Paths:
    data: Path
    machine_runtime: Path

    @property
    def marker_directory(self) -> Path:
        return self.data / ".switch-hosted"

    @property
    def marker(self) -> Path:
        return self.marker_directory / "machine.json"

    @property
    def controller_marker(self) -> Path:
        return self.marker_directory / CONTROLLER_LAYOUT

    @property
    def controller_state(self) -> Path:
        return self.data / ".switch-controller"

    @property
    def agents(self) -> Path:
        return self.data / "agents"

    @property
    def repos(self) -> Path:
        return self.data / "repos"

    @property
    def worktrees(self) -> Path:
        return self.data / "worktrees"

    @property
    def controller_config(self) -> Path:
        return self.machine_runtime / "controller.json"

    @property
    def controller_credential(self) -> Path:
        return self.machine_runtime / "controller-credential"


def load_machine_config(assignment_path: Path, runtime_path: Path) -> MachineConfig:
    value = _load_json(
        assignment_path,
        "Machine assignment configuration is invalid.",
        MAX_SECRET_BYTES,
    )
    value = _strict(
        value,
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
        {"previousInstanceId", "previousRuntimeFingerprint"},
        "machine assignment",
    )
    if value["version"] != 2:
        raise BootError("Machine assignment version is unsupported.")
    if value["mountPath"] != str(DATA_MOUNT):
        raise BootError("Machine data mount path must be /data.")
    volume_id = _text(value["dataVolumeId"], "data volume ID", maximum=32)
    if not VOLUME_RE.fullmatch(volume_id):
        raise BootError("Data volume ID is invalid.")
    secret_id = _text(value["assignmentSecretId"], "assignment secret ID")
    return MachineConfig(
        installation_id=_identifier(value["installationId"], "installation ID"),
        slot_id=_identifier(value["slotId"], "slot ID"),
        generation=_positive_integer(value["generation"], "assignment generation"),
        secret_id=secret_id,
        secret_region=_secret_arn_region(secret_id),
        volume_id=volume_id,
        device_path=_absolute_path(value["dataDevice"], "data device"),
        runtime=load_runtime_config(runtime_path),
    )


def load_runtime_config(path: Path) -> RuntimeConfig:
    value = _load_json(
        path, "Pinned AMI runtime configuration is invalid.", MAX_SECRET_BYTES
    )
    if isinstance(value, dict) and value.get("version") == 1:
        raise BootError(
            "This image carries the worker runtime configuration, not the controller one."
        )
    value = _strict(
        value,
        {
            "version",
            "nodePath",
            "controllerPath",
            "sharedHostDaemonPath",
            "bootstrapPath",
            "bootPath",
            "providerBinaryPath",
            "controllerUser",
            "agentUser",
            "agentGroup",
            "path",
            "allowInitialFormat",
            "artifactSha256",
        },
        {"providers"},
        "controller runtime",
    )
    if value["version"] != 2:
        raise BootError("Pinned AMI runtime version is unsupported.")
    if not isinstance(value["allowInitialFormat"], bool):
        raise BootError("Initial-format policy is invalid.")
    hashes = _strict(
        value["artifactSha256"], ARTIFACT_KEYS, set(), "runtime artifact hashes"
    )
    for name, digest in hashes.items():
        _digest(digest, f"Runtime artifact hash {name}")
    runtime = RuntimeConfig(
        node_path=_absolute_path(value["nodePath"], "Node executable"),
        controller_path=_absolute_path(
            value["controllerPath"], "controller entrypoint"
        ),
        shared_host_daemon_path=_absolute_path(
            value["sharedHostDaemonPath"], "shared host daemon"
        ),
        bootstrap_path=_absolute_path(value["bootstrapPath"], "hosted bootstrap"),
        boot_path=_absolute_path(value["bootPath"], "boot entrypoint"),
        provider_binary_path=_absolute_path(
            value["providerBinaryPath"], "provider executable"
        ),
        controller_user=_identifier(value["controllerUser"], "controller user"),
        agent_user=_identifier(value["agentUser"], "agent user"),
        agent_group=_identifier(value["agentGroup"], "agent group"),
        path=_text(value["path"], "runtime PATH"),
        allow_initial_format=value["allowInitialFormat"],
        artifact_sha256=dict(hashes),
        providers=_provider_runtimes(value.get("providers", {})),
    )
    if (
        runtime.node_path != NODE_PATH
        or runtime.controller_path != CONTROLLER_PATH
        or runtime.shared_host_daemon_path != SHARED_HOST_DAEMON_PATH
        or runtime.bootstrap_path != BOOTSTRAP_PATH
        or runtime.provider_binary_path != CLAUDE_PATH
    ):
        raise BootError(
            "Pinned runtime paths do not match the switch-controller and switch-agent@ units."
        )
    if (
        runtime.controller_user != CONTROLLER_USER
        or runtime.agent_user != AGENT_USER
        or runtime.agent_group != AGENT_GROUP
    ):
        raise BootError("Pinned runtime accounts do not match the units.")
    return runtime


def provider_path(provider: str) -> str:
    return f"/opt/switch/providers/{'antigravity-acp' if provider == 'antigravity' else provider}"


def _provider_runtimes(value: Any) -> dict[str, dict[str, str]]:
    if not isinstance(value, dict) or not set(value).issubset(PROVIDER_NAMES):
        raise BootError("Pinned provider runtimes are invalid.")
    for provider, runtime in value.items():
        if (
            not isinstance(runtime, dict)
            or set(runtime) != {"path", "sha256"}
            or runtime["path"] != provider_path(provider)
            or not re.fullmatch(r"[0-9a-f]{64}", str(runtime["sha256"]))
        ):
            raise BootError("Pinned provider runtime path or checksum is invalid.")
    return value


def parse_bundle(raw: str, config: MachineConfig) -> ControllerBundle:
    if len(raw.encode()) > MAX_SECRET_BYTES:
        raise BootError("Machine bundle is invalid.")
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError):
        raise BootError("Machine bundle is invalid.") from None
    if not isinstance(value, dict) or "version" not in value:
        raise BootError("Machine bundle is invalid.")
    if value["version"] == WORKER_BUNDLE_VERSION:
        raise ObsoleteBundle("worker bundle")
    if value["version"] != BUNDLE_VERSION:
        raise BootError("Machine bundle version is unsupported.")
    value = _strict(
        value,
        {"version", "machineId", "assignment", "apiEndpoint", "controller", "kms"},
        set(),
        "machine bundle",
    )
    assignment = _strict(
        value["assignment"],
        {"installationId", "slotId", "generation", "dataVolumeId"},
        set(),
        "bundle assignment",
    )
    if (
        assignment["installationId"] != config.installation_id
        or assignment["slotId"] != config.slot_id
        or assignment["generation"] != config.generation
        or assignment["dataVolumeId"] != config.volume_id
    ):
        raise BootError("Machine bundle does not match the machine assignment.")
    controller = _strict(
        value["controller"], {"id", "credential"}, set(), "bundle controller"
    )
    controller_id = _identifier(controller["id"], "controller ID")
    credential = controller["credential"]
    if not isinstance(credential, str) or not CONTROLLER_CREDENTIAL_RE.fullmatch(
        credential
    ):
        raise BootError("Controller credential is invalid.")
    return ControllerBundle(
        machine_id=_identifier(value["machineId"], "machine ID"),
        api_endpoint=_https_endpoint(value["apiEndpoint"], "Switch API endpoint"),
        controller_id=controller_id,
        controller_credential=credential,
        kms=_parse_kms(value["kms"], controller_id),
    )


def _parse_kms(value: Any, controller_id: str) -> KmsConfig:
    value = _strict(
        value, {"keyArn", "region", "grantTokens", "context"}, set(), "bundle kms"
    )
    key_arn = _text(value["keyArn"], "KMS key ARN", maximum=256)
    match = KMS_KEY_ARN_RE.fullmatch(key_arn)
    region = _text(value["region"], "KMS region", maximum=32)
    if not match or not REGION_RE.fullmatch(region) or match.group(2) != region:
        raise BootError("KMS key ARN or region is invalid.")
    tokens = value["grantTokens"]
    if (
        not isinstance(tokens, list)
        or len(tokens) > 10
        or not all(
            isinstance(token, str) and GRANT_TOKEN_RE.fullmatch(token)
            for token in tokens
        )
    ):
        raise BootError("KMS grant tokens are invalid.")
    context = _strict(
        value["context"], KMS_CONTEXT_KEYS, set(), "KMS encryption context"
    )
    for name, entry in context.items():
        _text(entry, f"KMS context {name}", maximum=256)
    if context["switch:controller_id"] != controller_id:
        raise BootError("KMS encryption context names another controller.")
    return KmsConfig(
        key_arn=key_arn,
        region=region,
        grant_tokens=tuple(tokens),
        context=dict(context),
    )


class Commands:
    def result(
        self, arguments: list[str], *, capture: bool = True
    ) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                arguments,
                check=False,
                text=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
            )
        except OSError:
            raise BootError(
                f"Required host operation failed: {arguments[0]}."
            ) from None

    def run(self, arguments: list[str], *, capture: bool = True) -> str:
        completed = self.result(arguments, capture=capture)
        if completed.returncode != 0:
            detail = (completed.stderr or "").strip()[-500:]
            raise BootError(
                f"Required host operation failed: {arguments[0]}."
                + (f" {detail}" if detail else "")
            )
        return completed.stdout if capture else ""


class ImdsV2:
    def __init__(self, opener: Callable[..., Any] = urllib.request.urlopen) -> None:
        self._opener = opener

    def instance_id(self) -> str:
        token_request = urllib.request.Request(
            f"{IMDS_BASE}/api/token",
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
        )
        try:
            with self._opener(token_request, timeout=2) as response:
                token = response.read(4096).decode().strip()
            if not token:
                raise ValueError()
            identity_request = urllib.request.Request(
                f"{IMDS_BASE}/meta-data/instance-id",
                headers={"X-aws-ec2-metadata-token": token},
            )
            with self._opener(identity_request, timeout=2) as response:
                instance_id = response.read(128).decode().strip()
        except Exception:
            raise BootError("IMDSv2 instance identity is unavailable.") from None
        if not INSTANCE_RE.fullmatch(instance_id):
            raise BootError("IMDSv2 returned an invalid instance identity.")
        return instance_id


class SecretsManager:
    def __init__(self, region: str, client: Any = None) -> None:
        if client is None:
            if boto3 is None:
                raise BootError("The pinned AMI is missing boto3.")
            client = boto3.client("secretsmanager", region_name=region)
        self._client = client

    def read(self, secret_id: str) -> str:
        try:
            response = self._client.get_secret_value(
                SecretId=secret_id, VersionStage="AWSCURRENT"
            )
            value = response.get("SecretString")
        except Exception:
            raise BootError("The assignment secret could not be read.") from None
        if not isinstance(value, str):
            raise BootError("The assignment secret is not a JSON string.")
        return value


def with_retries(
    label: str,
    operation: Callable[[], Any],
    *,
    attempts: int = NETWORK_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> Any:
    """Retry a network read; a fresh instance may boot before its role or route is usable."""
    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except BootError as error:
            if attempt == attempts:
                raise
            delay = min(2**attempt, NETWORK_BACKOFF_MAX_SECONDS)
            logger.warning(
                "%s failed (attempt %d of %d), retrying in %ds: %s",
                label,
                attempt,
                attempts,
                delay,
                error,
            )
            sleep(delay)
    raise AssertionError("unreachable")


def inspect_storage(
    commands: Commands, device_path: str, volume_id: str
) -> StorageObservation:
    try:
        value = json.loads(
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
        serial_id = volume_id.replace("-", "")
        devices = [
            item
            for item in value["blockdevices"]
            if item.get("type") == "disk"
            and str(item.get("serial") or "").lower().replace("-", "") == serial_id
        ]
        if len(devices) != 1:
            raise ValueError()
        device = devices[0]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        raise BootError("Data volume inspection returned an invalid result.") from None
    resolved_path = _absolute_path(device.get("path"), "resolved data device")
    serial = str(device.get("serial") or "").lower().replace("-", "")
    if device.get("type") != "disk" or serial != volume_id.replace("-", ""):
        raise BootError("Attached data device does not match the assigned EBS volume.")
    children = bool(device.get("children"))
    signatures: tuple[str, ...] = ()
    if not device.get("fstype") and not children:
        try:
            signatures_value = json.loads(
                commands.run(["/usr/sbin/wipefs", "--json", "--no-act", resolved_path])
            )
            signatures = tuple(
                str(item.get("type") or item.get("usage") or "unknown")
                for item in signatures_value.get("signatures", [])
            )
        except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
            raise BootError("Data volume signature inspection failed.") from None
    return StorageObservation(
        device_path=resolved_path,
        volume_id=volume_id,
        filesystem_type=device.get("fstype") or None,
        filesystem_uuid=device.get("uuid") or None,
        has_children=children,
        signatures=signatures,
    )


def _validate_root_directory(path: Path, *, create: bool) -> None:
    if create:
        path.mkdir(mode=0o755, parents=True, exist_ok=True)
    try:
        details = path.lstat()
    except OSError:
        raise BootError(f"{path} is unavailable.") from None
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_uid != ROOT_UID
        or details.st_mode & 0o022
    ):
        raise BootError(f"{path} must be a root-owned non-writable directory.")


def prepare_storage(
    commands: Commands, config: MachineConfig, data: Path = DATA_MOUNT
) -> tuple[StorageObservation, bool]:
    observation = inspect_storage(commands, config.device_path, config.volume_id)
    formatted = False
    if observation.filesystem_type is None:
        if (
            not config.runtime.allow_initial_format
            or observation.filesystem_uuid is not None
            or observation.has_children
            or observation.signatures
        ):
            raise BootError("Data volume is not a safely initializable blank disk.")
        commands.run(
            [
                "/usr/sbin/mkfs.ext4",
                "-q",
                "-m",
                "0",
                "-L",
                "switch-hosted-data",
                observation.device_path,
            ],
            capture=False,
        )
        commands.run(
            ["/usr/bin/udevadm", "trigger", "--action=change", observation.device_path]
        )
        commands.run(["/usr/bin/udevadm", "settle", "--timeout=30"])
        observation = inspect_storage(commands, config.device_path, config.volume_id)
        formatted = True
    if (
        observation.filesystem_type != "ext4"
        or not observation.filesystem_uuid
        or observation.has_children
    ):
        raise BootError(
            "Data volume filesystem is unexpected; refusing to format or mount it."
        )
    _validate_root_directory(data, create=True)
    mounted = commands.result(
        [
            "/usr/bin/findmnt",
            "--mountpoint",
            str(data),
            "--noheadings",
            "--output",
            "SOURCE",
        ]
    )
    if mounted.returncode == 0:
        mounted_source = mounted.stdout.strip()
        if os.path.realpath(mounted_source) != os.path.realpath(
            observation.device_path
        ):
            raise BootError("The data mountpoint is occupied by another device.")
    elif mounted.returncode == 1:
        commands.run(
            [
                SYSTEMD_MOUNT,
                "--type=ext4",
                "--options=nodev,nosuid",
                observation.device_path,
                str(data),
            ],
            capture=False,
        )
    else:
        raise BootError("Data mountpoint inspection failed.")
    _validate_root_directory(data, create=False)
    return observation, formatted


def _read_boot_id(path: Path = BOOT_ID_PATH) -> str:
    try:
        value = path.read_text(encoding="ascii").strip()
        return str(uuid.UUID(value))
    except (OSError, ValueError):
        raise BootError("Kernel boot identity is unavailable.") from None


def acquire_root_lock(path: Path = LOCK_PATH) -> Any:
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    details = os.fstat(descriptor)
    if (
        not stat.S_ISREG(details.st_mode)
        or details.st_uid != ROOT_UID
        or details.st_mode & 0o077
    ):
        os.close(descriptor)
        raise BootError("Boot lock is not a private root-owned file.")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        raise BootError("Another machine boot step is already running.") from None
    return os.fdopen(descriptor, "r+")


def _read_root_marker(path: Path) -> dict[str, Any]:
    try:
        details = path.lstat()
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != ROOT_UID
            or details.st_mode & 0o077
            or details.st_size > 4096
        ):
            raise ValueError()
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        raise BootError("Retained disk machine marker is invalid.") from None
    if isinstance(value, dict) and value.get("version") == 1:
        raise BootError(ONE_AGENT_LAYOUT_MESSAGE)
    try:
        value = _strict(
            value,
            {
                "version",
                "installationId",
                "slotId",
                "generation",
                "instanceId",
                "bootId",
                "filesystemUuid",
                "runtimeFingerprint",
                "layout",
            },
            set(),
            "machine marker",
        )
        if value["version"] != 2 or value["layout"] != MARKER_LAYOUT:
            raise ValueError()
        _identifier(value["installationId"], "marker installation ID")
        _identifier(value["slotId"], "marker slot ID")
        _positive_integer(value["generation"], "marker generation")
        if not INSTANCE_RE.fullmatch(_text(value["instanceId"], "marker instance")):
            raise ValueError()
        if str(uuid.UUID(_text(value["bootId"], "marker boot ID"))) != value["bootId"]:
            raise ValueError()
        str(uuid.UUID(_text(value["filesystemUuid"], "filesystem UUID")))
        if not FINGERPRINT_RE.fullmatch(
            _text(value["runtimeFingerprint"], "runtime fingerprint")
        ):
            raise ValueError()
        return value
    except (ValueError, BootError):
        raise BootError("Retained disk machine marker is invalid.") from None


def reconcile_marker(
    identity: MachineIdentity,
    config: MachineConfig,
    filesystem_uuid: str,
    runtime_fingerprint: str,
    paths: Paths,
) -> None:
    """Verify the volume belongs to this assignment and record this boot on it.

    The marker keeps the worker's per-user-v1 shape so a worker image can still
    read the volume after a rollback.
    """
    marker_directory = paths.marker_directory
    marker_directory.mkdir(mode=0o700, parents=False, exist_ok=True)
    details = marker_directory.lstat()
    if not stat.S_ISDIR(details.st_mode):
        raise BootError(f"{marker_directory} must be a directory.")
    os.chown(marker_directory, ROOT_UID, ROOT_UID)
    os.chmod(marker_directory, 0o700)
    if paths.marker.exists() or paths.marker.is_symlink():
        marker = _read_root_marker(paths.marker)
        if (
            marker["installationId"] != config.installation_id
            or marker["slotId"] != config.slot_id
        ):
            raise BootError("Retained disk belongs to another installation or slot.")
        if marker["generation"] != config.generation:
            raise BootError("Retained disk belongs to another assignment generation.")
        if marker["filesystemUuid"] != filesystem_uuid:
            raise BootError("Retained disk filesystem identity changed.")
        if (
            marker["instanceId"] == identity.instance_id
            and marker["bootId"] == identity.boot_id
            and marker["runtimeFingerprint"] == runtime_fingerprint
        ):
            return
    else:
        unexpected = {
            child.name
            for child in paths.data.iterdir()
            if child.name not in {"lost+found", marker_directory.name}
        }
        if unexpected:
            raise BootError(
                "Retained disk has no trusted machine marker; refusing legacy state."
            )
    _write_root_json(
        paths.marker,
        {
            "version": 2,
            "installationId": config.installation_id,
            "slotId": config.slot_id,
            "generation": config.generation,
            "instanceId": identity.instance_id,
            "bootId": identity.boot_id,
            "filesystemUuid": filesystem_uuid,
            "runtimeFingerprint": runtime_fingerprint,
            "layout": MARKER_LAYOUT,
        },
    )


def resolve_accounts(
    controller_user: str, agent_user: str, agent_group: str
) -> Accounts:
    try:
        controller = pwd.getpwnam(controller_user)
        agent = pwd.getpwnam(agent_user)
        agent_group_entry = grp.getgrnam(agent_group)
    except KeyError:
        raise BootError(
            "Pinned AMI is missing the controller or agent account."
        ) from None
    agent_gid = agent_group_entry.gr_gid
    if (
        agent.pw_uid == ROOT_UID
        or agent_gid == ROOT_UID
        or agent.pw_gid != agent_gid
        or controller.pw_uid == ROOT_UID
        or controller.pw_gid == ROOT_UID
        or controller.pw_uid == agent.pw_uid
        or controller.pw_gid == agent_gid
    ):
        raise BootError(
            "Pinned AMI controller and agent accounts must be distinct, non-root, with their own primary groups."
        )
    if controller_user not in agent_group_entry.gr_mem:
        raise BootError("The controller account must belong to the agent group.")
    if os.getgrouplist(agent_user, agent_gid) != [agent_gid]:
        raise BootError("The agent account must have no supplementary groups.")
    if set(os.getgrouplist(controller_user, controller.pw_gid)) != {
        controller.pw_gid,
        agent_gid,
    }:
        raise BootError(
            "The controller account must have only the agent group as a supplementary group."
        )
    return Accounts(
        controller_uid=controller.pw_uid,
        controller_gid=controller.pw_gid,
        agent_uid=agent.pw_uid,
        agent_gid=agent_gid,
    )


def _open_directory(name: str, parent: int, label: Path) -> int:
    try:
        return os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
    except OSError:
        raise BootError(f"{label} is not a real directory.") from None


def _ensure_directory(
    parent: int, name: str, label: Path, uid: int, gid: int, mode: int
) -> None:
    """Create or repair parent/name through descriptors, never following a symlink."""
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
    except FileExistsError:
        pass
    descriptor = _open_directory(name, parent, label)
    try:
        details = os.fstat(descriptor)
        if details.st_uid != uid or details.st_gid != gid:
            os.fchown(descriptor, uid, gid)
        if stat.S_IMODE(details.st_mode) != mode:
            os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)


def _shared_agent_directory(
    parent: int, name: str, label: Path, accounts: Accounts
) -> None:
    """Hand one existing directory to the controller, shared with agents through the group.

    Only the directory itself changes; what agents wrote inside stays theirs.
    Setgid keeps the group on what agents create; sticky stops an agent
    replacing an entry the controller owns, such as watcher/, with a link.
    """
    descriptor = _open_directory(name, parent, label)
    try:
        os.fchown(descriptor, accounts.controller_uid, accounts.agent_gid)
        os.fchmod(descriptor, 0o3770)
    finally:
        os.close(descriptor)


def _agent_entries(parent: int, label: Path) -> list[str]:
    names = []
    for name in sorted(os.listdir(parent)):
        if not AGENT_ID_RE.fullmatch(name):
            logger.warning("Ignoring unexpected entry %s in %s.", name, label)
            continue
        names.append(name)
    return names


def prepare_controller_layout(paths: Paths, accounts: Accounts) -> list[str]:
    """Bring the data volume onto the controller layout; return the agents migrated.

    The top-level directories are repaired on every boot. The pass over existing
    agent and worktree roots runs until the controller-v1 marker records it, so an
    interrupted pass repeats in full: every step is idempotent.
    """
    data = os.open(paths.data, DIRECTORY_FLAGS)
    try:
        _ensure_directory(
            data,
            paths.controller_state.name,
            paths.controller_state,
            accounts.controller_uid,
            accounts.controller_gid,
            0o700,
        )
        for directory in (paths.agents, paths.worktrees):
            _ensure_directory(
                data,
                directory.name,
                directory,
                accounts.controller_uid,
                accounts.controller_gid,
                0o750,
            )
        repos_created = False
        try:
            os.mkdir(paths.repos.name, 0o700, dir_fd=data)
            repos_created = True
        except FileExistsError:
            pass
        repos = _open_directory(paths.repos.name, data, paths.repos)
        try:
            if repos_created:
                os.fchown(repos, accounts.agent_uid, accounts.agent_gid)
        finally:
            os.close(repos)
    finally:
        os.close(data)

    if paths.controller_marker.exists() or paths.controller_marker.is_symlink():
        _read_controller_marker(paths.controller_marker)
        return []

    migrated: list[str] = []
    agents = os.open(paths.agents, DIRECTORY_FLAGS)
    try:
        for name in _agent_entries(agents, paths.agents):
            root = paths.agents / name
            _shared_agent_directory(agents, name, root, accounts)
            migrated.append(name)
            root_descriptor = _open_directory(name, agents, root)
            try:
                try:
                    watcher = os.lstat("watcher", dir_fd=root_descriptor)
                except FileNotFoundError:
                    continue
                if not stat.S_ISDIR(watcher.st_mode):
                    logger.error(
                        "%s/watcher is not a real directory; leaving it for the controller to refuse.",
                        root,
                    )
                    continue
                _shared_agent_directory(
                    root_descriptor, "watcher", root / "watcher", accounts
                )
            finally:
                os.close(root_descriptor)
    finally:
        os.close(agents)
    worktrees = os.open(paths.worktrees, DIRECTORY_FLAGS)
    try:
        for name in _agent_entries(worktrees, paths.worktrees):
            _shared_agent_directory(worktrees, name, paths.worktrees / name, accounts)
    finally:
        os.close(worktrees)
    _write_root_json(
        paths.controller_marker,
        {
            "version": 1,
            "layout": CONTROLLER_LAYOUT,
            "migratedAt": datetime.now(UTC).isoformat(),
            "agents": migrated,
        },
    )
    return migrated


def _read_controller_marker(path: Path) -> dict[str, Any]:
    try:
        details = path.lstat()
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != ROOT_UID
            or details.st_mode & 0o077
            or details.st_size > 1024 * 1024
        ):
            raise ValueError()
        value = json.loads(path.read_text(encoding="utf-8"))
        value = _strict(
            value,
            {"version", "layout", "migratedAt", "agents"},
            set(),
            "controller marker",
        )
        if value["version"] != 1 or value["layout"] != CONTROLLER_LAYOUT:
            raise ValueError()
        return value
    except (OSError, ValueError, json.JSONDecodeError, BootError):
        raise BootError("Controller layout marker is invalid.") from None


def _write_root_json(path: Path, value: Any) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _write_private_file(path: Path, data: bytes, *, mode: int, gid: int) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchown(descriptor, ROOT_UID, gid)
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def prepare_machine_runtime(
    commands: Commands, paths: Paths, accounts: Accounts
) -> None:
    directory = paths.machine_runtime
    directory.mkdir(mode=0o750, exist_ok=True)
    details = directory.lstat()
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_uid != ROOT_UID
    ):
        raise BootError(f"{directory} must be a root-owned directory.")
    filesystem = commands.run(
        [
            "/usr/bin/findmnt",
            "--noheadings",
            "--output",
            "FSTYPE",
            "--target",
            str(directory),
        ]
    ).strip()
    if filesystem != "tmpfs":
        raise BootError(f"{directory} is not backed by tmpfs.")
    os.chown(directory, ROOT_UID, accounts.controller_gid)
    os.chmod(directory, 0o750)


def controller_config(
    bundle: ControllerBundle, identity: MachineIdentity, runtime: RuntimeConfig
) -> dict[str, Any]:
    providers = {"claude": runtime.provider_binary_path}
    for provider in PROVIDER_NAMES:
        if provider in runtime.providers:
            providers[provider] = runtime.providers[provider]["path"]
    return {
        "controllerId": bundle.controller_id,
        "server": bundle.api_endpoint,
        "relayPort": RELAY_PORT,
        "instanceId": identity.instance_id,
        "bootId": identity.boot_id,
        "kms": {
            "keyArn": bundle.kms.key_arn,
            "region": bundle.kms.region,
            "grantTokens": list(bundle.kms.grant_tokens),
            "context": dict(bundle.kms.context),
        },
        "sharedHostBundle": runtime.shared_host_daemon_path,
        "nodePath": runtime.node_path,
        "providers": providers,
    }


def write_controller_files(
    paths: Paths,
    bundle: ControllerBundle,
    identity: MachineIdentity,
    runtime: RuntimeConfig,
    accounts: Accounts,
) -> None:
    config = (
        json.dumps(
            controller_config(bundle, identity, runtime), indent=2, sort_keys=True
        ).encode()
        + b"\n"
    )
    _write_private_file(
        paths.controller_config, config, mode=0o640, gid=accounts.controller_gid
    )
    _write_private_file(
        paths.controller_credential,
        bundle.controller_credential.encode(),
        mode=0o600,
        gid=ROOT_UID,
    )
    _fsync_directory(paths.machine_runtime)


def load_imds_rules(commands: Commands, rules: str = NFT_RULES_PATH) -> None:
    commands.run([NFT, "-f", rules], capture=False)


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        raise BootError("Pinned runtime artifact is unreadable.") from None
    return digest.hexdigest()


def runtime_artifacts(runtime: RuntimeConfig) -> tuple[dict[str, str], dict[str, str]]:
    artifacts = {
        "node": runtime.node_path,
        "sharedHostDaemon": runtime.shared_host_daemon_path,
        "bootstrap": runtime.bootstrap_path,
        "controller": runtime.controller_path,
        "boot": runtime.boot_path,
        "provider": runtime.provider_binary_path,
    }
    hashes = dict(runtime.artifact_sha256)
    for provider, entry in runtime.providers.items():
        artifacts["provider-" + provider] = entry["path"]
        hashes["provider-" + provider] = entry["sha256"]
    return artifacts, hashes


def verify_pinned_runtime(runtime: RuntimeConfig) -> str:
    artifacts, hashes = runtime_artifacts(runtime)
    for name, path in artifacts.items():
        try:
            details = os.stat(path, follow_symlinks=False)
        except OSError:
            raise BootError(f"Pinned runtime artifact {name} is missing.") from None
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != ROOT_UID
            or details.st_mode & 0o022
        ):
            raise BootError(f"Pinned runtime artifact {name} is not a root-owned file.")
        if _sha256_file(path) != hashes[name]:
            raise BootError(
                f"Pinned runtime artifact {name} does not match the AMI manifest."
            )
    try:
        version = subprocess.run(
            [runtime.node_path, "--version"],
            check=True,
            text=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            env={"PATH": runtime.path, "LANG": "C"},
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        raise BootError("Pinned Node.js executable failed its version check.") from None
    if not re.fullmatch(r"v24\.\d+\.\d+", version):
        raise BootError("Pinned AMI does not provide Node.js 24.")
    return (
        "sha256:"
        + hashlib.sha256(
            json.dumps(
                {
                    "artifacts": hashes,
                    "nodeVersion": version,
                    "layout": CONTROLLER_LAYOUT,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
    )


def read_bundle(config: MachineConfig, bundle_file: Path | None) -> ControllerBundle:
    if bundle_file is not None:
        try:
            raw = bundle_file.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            raise BootError("The test bundle file is unreadable.") from None
    else:
        manager = SecretsManager(config.secret_region)
        raw = with_retries(
            "Reading the machine bundle", lambda: manager.read(config.secret_id)
        )
    return parse_bundle(raw, config)


def parse_arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config", default="/etc/switch-hosted/assignment.json", type=Path
    )
    parser.add_argument(
        "--runtime-config", default="/etc/switch-hosted/runtime.json", type=Path
    )
    parser.add_argument(
        "--bundle-file",
        type=Path,
        help=f"read the bundle from a file instead of Secrets Manager; needs {TEST_HOOKS_ENV}=1",
    )
    arguments = parser.parse_args(argv)
    if arguments.bundle_file is not None and os.environ.get(TEST_HOOKS_ENV) != "1":
        parser.error(f"--bundle-file is a test hook and needs {TEST_HOOKS_ENV}=1")
    return arguments


def main(argv: list[str] | None = None) -> int:
    arguments = parse_arguments(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if os.geteuid() != ROOT_UID:
        raise BootError("The machine boot step must run as root.")
    root_lock = acquire_root_lock(LOCK_PATH)
    try:
        config = load_machine_config(arguments.config, arguments.runtime_config)
        runtime_fingerprint = verify_pinned_runtime(config.runtime)
        accounts = resolve_accounts(
            config.runtime.controller_user,
            config.runtime.agent_user,
            config.runtime.agent_group,
        )
        imds = ImdsV2()
        identity = MachineIdentity(
            with_retries("Reading the instance identity", imds.instance_id),
            _read_boot_id(),
        )
        # Read before touching the disk, so a machine still assigned to the
        # worker runtime never has its volume moved onto the controller layout.
        try:
            bundle = read_bundle(config, arguments.bundle_file)
        except ObsoleteBundle:
            print(
                "machine bundle is version 2 (worker runtime); this image runs the controller",
                file=sys.stderr,
                flush=True,
            )
            return OBSOLETE_EXIT_CODE
        commands = Commands()
        paths = Paths(DATA_MOUNT, MACHINE_RUNTIME)
        storage, formatted = prepare_storage(commands, config)
        if formatted:
            logger.info("Formatted the blank data volume %s.", config.volume_id)
        reconcile_marker(
            identity, config, storage.filesystem_uuid or "", runtime_fingerprint, paths
        )
        migrated = prepare_controller_layout(paths, accounts)
        if migrated:
            logger.info(
                "Moved %d agent roots onto the controller layout.", len(migrated)
            )
        load_imds_rules(commands)
        prepare_machine_runtime(commands, paths, accounts)
        write_controller_files(paths, bundle, identity, config.runtime, accounts)
        logger.info(
            "Controller %s is configured for %s.",
            bundle.controller_id,
            identity.instance_id,
        )
        return 0
    finally:
        root_lock.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BootError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
