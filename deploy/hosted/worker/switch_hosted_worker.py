#!/usr/bin/env python3
"""Trusted root launcher for one retained-disk hosted Switch agent."""

from __future__ import annotations

import argparse
import fcntl
import grp
import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

DATA_MOUNT = Path("/data")
STATE_PATH = DATA_MOUNT / "state"
WORKSPACE_PATH = DATA_MOUNT / "workspace"
MARKER_DIRECTORY = DATA_MOUNT / ".switch-hosted"
MARKER_PATH = MARKER_DIRECTORY / "machine.json"
RUNTIME_DIRECTORY = Path("/run/switch-hosted")
LOCK_PATH = Path("/run/lock/switch-hosted-worker.lock")
BOOT_ID_PATH = Path("/proc/sys/kernel/random/boot_id")
OBSOLETE_BUNDLE_PATH = STATE_PATH / "obsolete-bundle"
OBSOLETE_BUNDLE_EXIT_CODE = 75
OBSOLETE_POLL_SECONDS = 30
OBSOLETE_WARN_SECONDS = 5 * 60
IMDS_BASE = "http://169.254.169.254/latest"
MAX_SECRET_BYTES = 128 * 1024
ROOT_UID = 0
INSTANCE_RE = re.compile(r"^i-[0-9a-f]{8,17}$")
VOLUME_RE = re.compile(r"^vol-[0-9a-f]{8,17}$")
SECRET_ARN_RE = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z]{2}(?:-gov)?-[a-z]+-\d):([0-9]{12}):secret:([A-Za-z0-9/_+=.@-]+)$"
)
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$")
WORKER_CAPABILITY_RE = re.compile(r"^[\x21-\x7e]{16,4096}$")


class WorkerError(RuntimeError):
    pass


def _strict(
    value: Any, required: set[str], optional: set[str], label: str
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkerError(f"{label} must be an object.")
    keys = set(value)
    missing = required - keys
    unexpected = keys - required - optional
    if missing or unexpected:
        raise WorkerError(f"{label} has missing or unexpected fields.")
    return value


def _text(value: Any, label: str, *, maximum: int = 4096) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or "\x00" in value
    ):
        raise WorkerError(f"{label} is invalid.")
    return value


def _identifier(value: Any, label: str) -> str:
    value = _text(value, label, maximum=200)
    if not IDENTIFIER_RE.fullmatch(value):
        raise WorkerError(f"{label} is invalid.")
    return value


def _positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise WorkerError(f"{label} is invalid.")
    return value


@dataclass(frozen=True)
class RuntimeConfig:
    node_path: str
    bootstrap_path: str
    shared_host_daemon_path: str
    provider_binary_path: str
    agent_user: str
    agent_group: str
    path: str
    allow_initial_format: bool
    artifact_sha256: dict[str, str]
    providers: dict[str, dict[str, str]] = field(default_factory=dict)


@dataclass(frozen=True)
class WorkerConfig:
    installation_id: str
    secret_id: str
    secret_region: str
    agent_id: str
    generation: int
    volume_id: str
    device_path: str
    runtime: RuntimeConfig
    previous_instance_id: str | None = None
    previous_runtime_fingerprint: str | None = None


@dataclass(frozen=True)
class MachineIdentity:
    instance_id: str
    boot_id: str
    assignment_generation: int

    def json(self) -> dict[str, Any]:
        return {
            "instanceId": self.instance_id,
            "bootId": self.boot_id,
            "assignmentGeneration": self.assignment_generation,
        }


@dataclass(frozen=True)
class SecretBundle:
    deployment: dict[str, Any]
    provider_credential: str | None
    switch_credentials: dict[str, Any]
    worker_capability: str
    github_credential: str | None = None


@dataclass(frozen=True)
class StorageObservation:
    device_path: str
    volume_id: str
    filesystem_type: str | None
    filesystem_uuid: str | None
    has_children: bool
    signatures: tuple[str, ...]


def load_worker_config(assignment_path: Path, runtime_path: Path) -> WorkerConfig:
    value = _load_json(
        assignment_path, "Worker assignment configuration is invalid.", MAX_SECRET_BYTES
    )
    value = _strict(
        value,
        {
            "version",
            "installationId",
            "agentId",
            "generation",
            "assignmentSecretId",
            "dataVolumeId",
            "dataDevice",
            "mountPath",
        },
        {"previousInstanceId", "previousRuntimeFingerprint"},
        "worker assignment",
    )
    if value["version"] != 1:
        raise WorkerError("Worker assignment version is unsupported.")
    if value["mountPath"] != str(DATA_MOUNT):
        raise WorkerError("Worker data mount path must be /data.")
    volume_id = _text(value["dataVolumeId"], "worker data volume ID", maximum=32)
    if not VOLUME_RE.fullmatch(volume_id):
        raise WorkerError("Worker data volume ID is invalid.")
    runtime_value = _load_json(
        runtime_path, "Pinned AMI runtime configuration is invalid.", MAX_SECRET_BYTES
    )
    runtime_value = _strict(
        runtime_value,
        {
            "version",
            "nodePath",
            "bootstrapPath",
            "sharedHostDaemonPath",
            "providerBinaryPath",
            "agentUser",
            "agentGroup",
            "path",
            "allowInitialFormat",
            "artifactSha256",
        },
        {"providers"},
        "worker runtime",
    )
    if runtime_value["version"] != 1:
        raise WorkerError("Pinned AMI runtime version is unsupported.")
    if not isinstance(runtime_value["allowInitialFormat"], bool):
        raise WorkerError("Worker initial-format policy is invalid.")
    artifact_sha256 = _artifact_hashes(runtime_value["artifactSha256"])
    runtime = RuntimeConfig(
        node_path=_absolute_path(runtime_value["nodePath"], "Node executable"),
        bootstrap_path=_absolute_path(
            runtime_value["bootstrapPath"], "bootstrap entrypoint"
        ),
        shared_host_daemon_path=_absolute_path(
            runtime_value["sharedHostDaemonPath"], "shared host daemon"
        ),
        provider_binary_path=_absolute_path(
            runtime_value["providerBinaryPath"], "provider executable"
        ),
        agent_user=_identifier(runtime_value["agentUser"], "agent user"),
        agent_group=_identifier(runtime_value["agentGroup"], "agent group"),
        path=_text(runtime_value["path"], "runtime PATH"),
        allow_initial_format=runtime_value["allowInitialFormat"],
        artifact_sha256=artifact_sha256,
        providers=_provider_runtimes(runtime_value.get("providers", {})),
    )
    secret_id = _text(value["assignmentSecretId"], "worker secret ID")
    secret_region = _secret_arn_region(secret_id)
    previous_fingerprint = value.get("previousRuntimeFingerprint")
    if previous_fingerprint is not None and (
        not isinstance(previous_fingerprint, str)
        or not re.fullmatch(r"[0-9a-f]{64}", previous_fingerprint)
        or "previousInstanceId" not in value
    ):
        raise WorkerError(
            "Runtime upgrade requires an exact predecessor and runtime fingerprint."
        )
    return WorkerConfig(
        installation_id=_identifier(value["installationId"], "installation ID"),
        secret_id=secret_id,
        secret_region=secret_region,
        agent_id=_identifier(value["agentId"], "worker agent ID"),
        generation=_positive_integer(
            value["generation"], "worker assignment generation"
        ),
        volume_id=volume_id,
        device_path=_absolute_path(value["dataDevice"], "worker data device"),
        runtime=runtime,
        previous_runtime_fingerprint=previous_fingerprint,
        previous_instance_id=_text(value["previousInstanceId"], "previous instance ID")
        if "previousInstanceId" in value
        else None,
    )


def _provider_runtimes(value: Any) -> dict[str, dict[str, str]]:
    if not isinstance(value, dict) or not set(value).issubset(
        {"codex", "cursor", "opencode", "antigravity"}
    ):
        raise WorkerError("Pinned provider runtimes are invalid.")
    for provider, runtime in value.items():
        if (
            not isinstance(runtime, dict)
            or set(runtime) != {"path", "sha256"}
            or runtime["path"]
            != f"/opt/switch/providers/{'antigravity-acp' if provider == 'antigravity' else provider}"
            or not re.fullmatch(r"[0-9a-f]{64}", str(runtime["sha256"]))
        ):
            raise WorkerError("Pinned provider runtime path or checksum is invalid.")
    return value


def _secret_arn_region(value: str) -> str:
    match = SECRET_ARN_RE.fullmatch(value)
    if not match:
        raise WorkerError(
            "Worker assignment secret ID must be a full Secrets Manager ARN."
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
        raise WorkerError(
            "Worker assignment secret ARN partition and region do not match."
        )
    return region


def _artifact_hashes(value: Any) -> dict[str, str]:
    value = _strict(
        value,
        {"node", "bootstrap", "sharedHostDaemon", "provider"},
        set(),
        "runtime artifact hashes",
    )
    for name, digest in value.items():
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise WorkerError(f"Runtime artifact hash {name} is invalid.")
    return value


def parse_secret_document(raw: str, config: WorkerConfig) -> SecretBundle:
    if len(raw.encode()) > MAX_SECRET_BYTES:
        raise WorkerError("Assignment secret is invalid.")
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError):
        raise WorkerError("Assignment secret is invalid.") from None
    value = _strict(
        value,
        {
            "version",
            "assignment",
            "deployment",
            "switchCredentials",
            "workerCapability",
        },
        {"githubCredential", "providerCredential"},
        "assignment secret",
    )
    if value["version"] != 1:
        raise WorkerError("Assignment secret version is unsupported.")
    assignment = _strict(
        value["assignment"],
        {"installationId", "agentId", "generation", "dataVolumeId"},
        set(),
        "secret assignment",
    )
    if (
        assignment["installationId"] != config.installation_id
        or assignment["agentId"] != config.agent_id
        or assignment["generation"] != config.generation
        or assignment["dataVolumeId"] != config.volume_id
    ):
        raise WorkerError("Assignment secret does not match the worker assignment.")
    deployment = _validate_deployment(value["deployment"], config)
    credential = None
    if not deployment["provider"]["credential"].get("refresh"):
        credential = _text(
            value.get("providerCredential"), "provider credential", maximum=16 * 1024
        ).strip()
        if not credential or any(character in credential for character in "\x00\r\n"):
            raise WorkerError("Provider credential is invalid.")
    switch_credentials = _validate_switch_credentials(
        value["switchCredentials"], config.agent_id
    )
    worker_capability = value["workerCapability"]
    if not isinstance(worker_capability, str) or not WORKER_CAPABILITY_RE.fullmatch(
        worker_capability
    ):
        raise WorkerError("Worker capability is invalid.")
    if deployment["session"]["agentId"] != config.agent_id:
        raise WorkerError("Hosted deployment belongs to a different agent.")
    has_github_credential = "githubCredential" in value
    has_github_deployment = "github" in deployment
    if has_github_credential != has_github_deployment:
        raise WorkerError(
            "GitHub credential and deployment configuration must be provided together."
        )
    github_credential = (
        _github_credential(value["githubCredential"]) if has_github_credential else None
    )
    return SecretBundle(
        deployment, credential, switch_credentials, worker_capability, github_credential
    )


def _validate_deployment(value: Any, config: WorkerConfig) -> dict[str, Any]:
    value = _strict(
        value,
        {
            "version",
            "session",
            "provider",
            "workspacePath",
            "runtimeMode",
            "switchCredentialsPath",
            "workerCapabilityPath",
            "watch",
        },
        {"github"},
        "hosted deployment",
    )
    if value["version"] != 1:
        raise WorkerError("Hosted deployment version is unsupported.")
    session = _strict(
        value["session"],
        {"sessionId", "agentId"},
        set(),
        "deployment session",
    )
    _identifier(session["sessionId"], "deployment session ID")
    _identifier(session["agentId"], "deployment agent ID")
    if not isinstance(value["watch"], bool):
        raise WorkerError("Deployment watcher configuration is invalid.")
    provider = _strict(
        value["provider"],
        {"kind", "credential", "binaryPath", "context"},
        {"model", "definition"},
        "deployment provider",
    )
    if provider["kind"] not in {"claude", *config.runtime.providers}:
        raise WorkerError("Hosted deployment provider is unsupported.")
    credential = _strict(
        provider["credential"],
        {"kind", "path"},
        {"refresh"},
        "deployment provider credential",
    )
    if credential["kind"] not in {"api-key", "setup-token", "auth-json"}:
        raise WorkerError("Hosted deployment provider credential kind is unsupported.")
    if credential["path"] != str(RUNTIME_DIRECTORY / "secrets/provider"):
        raise WorkerError("Hosted deployment provider credential path is not fixed.")
    expected_binary = (
        config.runtime.provider_binary_path
        if provider["kind"] == "claude"
        else config.runtime.providers[provider["kind"]]["path"]
    )
    if provider["binaryPath"] != expected_binary:
        raise WorkerError(
            "Hosted deployment provider executable is not the pinned executable."
        )
    _text(provider["context"], "deployment provider context", maximum=64 * 1024)
    if "definition" in provider:
        definition = _strict(
            provider["definition"], {"name", "content"}, set(), "agent definition"
        )
        if not isinstance(definition["name"], str) or not re.fullmatch(
            r"[a-z0-9][a-z0-9._-]{0,127}", definition["name"]
        ):
            raise WorkerError("Hosted agent definition name is invalid.")
        _text(definition["content"], "agent definition", maximum=64 * 1024)
    if "model" in provider:
        model = _strict(provider["model"], {"id"}, {"options"}, "deployment model")
        _text(model["id"], "deployment model ID")
        if "options" in model:
            if not isinstance(model["options"], dict) or not all(
                isinstance(key, str) and isinstance(item, str)
                for key, item in model["options"].items()
            ):
                raise WorkerError("Deployment model options are invalid.")
    if value["workspacePath"] != str(WORKSPACE_PATH):
        raise WorkerError("Hosted deployment workspace path is not fixed.")
    if value["runtimeMode"] not in {
        "approval-required",
        "auto-accept-edits",
        "full-access",
    }:
        raise WorkerError("Hosted deployment runtime mode is invalid.")
    if value["switchCredentialsPath"] != str(RUNTIME_DIRECTORY / "secrets/switch.json"):
        raise WorkerError("Hosted deployment Switch credential path is not fixed.")
    if value["workerCapabilityPath"] != str(
        RUNTIME_DIRECTORY / "secrets/worker-capability"
    ):
        raise WorkerError("Hosted deployment worker capability path is not fixed.")
    if "github" in value:
        github = _strict(
            value["github"],
            {"credentialPath"},
            {"repository", "refresh"},
            "deployment GitHub",
        )
        if "refresh" in github and (
            github["refresh"] is not True or "repository" not in github
        ):
            raise WorkerError("Hosted GitHub refresh requires a selected repository.")
        if "repository" in github and (
            not isinstance(github["repository"], str)
            or not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}",
                github["repository"],
            )
        ):
            raise WorkerError(
                "Hosted GitHub repository must be an owner/repository name."
            )
        if github["credentialPath"] != str(RUNTIME_DIRECTORY / "secrets/github"):
            raise WorkerError("Hosted deployment GitHub credential path is not fixed.")
    return value


def _github_credential(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 16 * 1024
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value)
    ):
        raise WorkerError("GitHub credential is invalid.")
    return value


def _validate_switch_credentials(value: Any, agent_id: str) -> dict[str, Any]:
    value = _strict(value, {"env"}, set(), "Switch credentials")
    env = _strict(
        value["env"],
        {"SWITCH_API_ENDPOINT", "SWITCH_API_TOKEN", "SWITCH_AGENT_ID"},
        set(),
        "Switch credential environment",
    )
    endpoint = _text(env["SWITCH_API_ENDPOINT"], "Switch API endpoint")
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise WorkerError("Switch API endpoint is invalid.")
    _text(env["SWITCH_API_TOKEN"], "Switch API token", maximum=16 * 1024)
    if env["SWITCH_AGENT_ID"] != agent_id:
        raise WorkerError("Switch credentials belong to a different agent.")
    return value


def _absolute_path(value: Any, label: str) -> str:
    value = _text(value, label)
    if not os.path.isabs(value) or os.path.normpath(value) != value:
        raise WorkerError(f"{label} must be a normalized absolute path.")
    return value


def _load_json(path: Path, failure: str, maximum: int) -> Any:
    try:
        if path.is_symlink() or path.stat().st_size > maximum:
            raise WorkerError(failure)
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        raise WorkerError(failure) from None


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
            raise WorkerError("IMDSv2 instance identity is unavailable.") from None
        if not INSTANCE_RE.fullmatch(instance_id):
            raise WorkerError("IMDSv2 returned an invalid instance identity.")
        return instance_id


class SecretsManager:
    def __init__(self, region: str, client: Any = None) -> None:
        if client is None:
            try:
                import boto3  # type: ignore[import-not-found]
            except ImportError:
                raise WorkerError("The pinned AMI is missing boto3.") from None
            client = boto3.client("secretsmanager", region_name=region)
        self._client = client

    def read(self, secret_id: str) -> tuple[str, str]:
        try:
            response = self._client.get_secret_value(
                SecretId=secret_id, VersionStage="AWSCURRENT"
            )
            value = response.get("SecretString")
            version_id = response.get("VersionId")
        except Exception:
            raise WorkerError("The assignment secret could not be read.") from None
        if not isinstance(value, str):
            raise WorkerError("The assignment secret is not a JSON string.")
        if not isinstance(version_id, str) or not version_id:
            raise WorkerError("The assignment secret has no version ID.")
        return value, version_id


class Commands:
    def result(
        self, arguments: list[str], *, capture: bool = True
    ) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                arguments,
                check=False,
                text=True,
                stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
            )
        except OSError:
            raise WorkerError(
                f"Required host operation failed: {arguments[0]}."
            ) from None

    def run(self, arguments: list[str], *, capture: bool = True) -> str:
        completed = self.result(arguments, capture=capture)
        if completed.returncode != 0:
            raise WorkerError(f"Required host operation failed: {arguments[0]}.")
        return completed.stdout if capture else ""


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
        raise WorkerError(
            "Data volume inspection returned an invalid result."
        ) from None
    resolved_path = _absolute_path(device.get("path"), "resolved data device")
    serial = str(device.get("serial") or "").lower().replace("-", "")
    if device.get("type") != "disk" or serial != volume_id.replace("-", ""):
        raise WorkerError(
            "Attached data device does not match the assigned EBS volume."
        )
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
            raise WorkerError("Data volume signature inspection failed.") from None
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
        raise WorkerError(f"{path} is unavailable.") from None
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_uid != ROOT_UID
        or details.st_mode & 0o022
    ):
        raise WorkerError(f"{path} must be a root-owned non-writable directory.")


def prepare_storage(
    commands: Commands, config: WorkerConfig
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
            raise WorkerError("Data volume is not a safely initializable blank disk.")
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
        raise WorkerError(
            "Data volume filesystem is unexpected; refusing to format or mount it."
        )
    _validate_root_directory(DATA_MOUNT, create=True)
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
        mounted_source = mounted.stdout.strip()
        if os.path.realpath(mounted_source) != os.path.realpath(
            observation.device_path
        ):
            raise WorkerError("The data mountpoint is occupied by another device.")
    elif mounted.returncode == 1:
        commands.run(
            [
                "/usr/bin/mount",
                "--types",
                "ext4",
                "--options",
                "nodev,nosuid",
                observation.device_path,
                str(DATA_MOUNT),
            ],
            capture=False,
        )
    else:
        raise WorkerError("Data mountpoint inspection failed.")
    _validate_root_directory(DATA_MOUNT, create=False)
    return observation, formatted


def _read_boot_id(path: Path = BOOT_ID_PATH) -> str:
    try:
        value = path.read_text(encoding="ascii").strip()
        return str(uuid.UUID(value))
    except (OSError, ValueError):
        raise WorkerError("Kernel boot identity is unavailable.") from None


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
        raise WorkerError("Worker root lock is not a private root-owned file.")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        raise WorkerError(
            "Another trusted worker launcher already owns this instance."
        ) from None
    return os.fdopen(descriptor, "r+")


def reconcile_boot_identity(
    identity: MachineIdentity,
    installation_id: str,
    agent_id: str,
    filesystem_uuid: str,
    runtime_fingerprint: str,
    *,
    previous_instance_id: str | None = None,
    previous_runtime_fingerprint: str | None = None,
    marker_directory: Path = MARKER_DIRECTORY,
    marker_path: Path = MARKER_PATH,
    state_path: Path = STATE_PATH,
    data_mount: Path = DATA_MOUNT,
) -> None:
    marker_directory.mkdir(mode=0o700, parents=False, exist_ok=True)
    os.chown(marker_directory, 0, 0)
    os.chmod(marker_directory, 0o700)
    if marker_path.exists() or marker_path.is_symlink():
        marker = _read_root_marker(marker_path)
        previous = _marker_identity(marker)
        if marker["installationId"] != installation_id:
            raise WorkerError("Retained disk belongs to another installation.")
        if marker["agentId"] != agent_id:
            raise WorkerError("Retained disk belongs to another agent.")
        if marker["runtimeFingerprint"] != runtime_fingerprint and not (
            previous.instance_id == previous_instance_id
            and previous.instance_id != identity.instance_id
            and marker["runtimeFingerprint"] == previous_runtime_fingerprint
        ):
            raise WorkerError(
                "Pinned hosted runtime changed for the retained assignment."
            )
        if marker["filesystemUuid"] != filesystem_uuid:
            raise WorkerError("Retained disk filesystem identity changed.")
        if (
            previous.instance_id != identity.instance_id
            and previous.instance_id != previous_instance_id
        ):
            raise WorkerError(
                "Retained disk belongs to another EC2 instance; replacement is unsupported."
            )
        if previous.assignment_generation != identity.assignment_generation:
            raise WorkerError("Retained disk belongs to another assignment generation.")
        if previous.boot_id == identity.boot_id:
            return
        _quarantine_stale_ownership(
            state_path, marker_directory, previous, identity.boot_id
        )
    else:
        unexpected = {
            child.name
            for child in data_mount.iterdir()
            if child.name not in {"lost+found", marker_directory.name}
        }
        if unexpected:
            raise WorkerError(
                "Retained disk has no trusted machine marker; refusing legacy state."
            )
    _write_root_json(
        marker_path,
        {
            "version": 1,
            "installationId": installation_id,
            "agentId": agent_id,
            "instanceId": identity.instance_id,
            "bootId": identity.boot_id,
            "assignmentGeneration": identity.assignment_generation,
            "filesystemUuid": filesystem_uuid,
            "runtimeFingerprint": runtime_fingerprint,
        },
    )


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
        value = _strict(
            value,
            {
                "version",
                "installationId",
                "agentId",
                "instanceId",
                "bootId",
                "assignmentGeneration",
                "filesystemUuid",
                "runtimeFingerprint",
            },
            set(),
            "machine marker",
        )
        if value["version"] != 1:
            raise ValueError()
        _identifier(value["installationId"], "marker installation ID")
        _identifier(value["agentId"], "marker agent ID")
        _marker_identity(value)
        str(uuid.UUID(_text(value["filesystemUuid"], "filesystem UUID")))
        if not re.fullmatch(r"[0-9a-f]{64}", value["runtimeFingerprint"]):
            raise ValueError()
        return value
    except (OSError, ValueError, json.JSONDecodeError, WorkerError):
        raise WorkerError("Retained disk machine marker is invalid.") from None


def _marker_identity(value: dict[str, Any]) -> MachineIdentity:
    instance_id = _text(value["instanceId"], "marker instance ID")
    if not INSTANCE_RE.fullmatch(instance_id):
        raise WorkerError("Machine marker instance ID is invalid.")
    try:
        boot_id = str(uuid.UUID(_text(value["bootId"], "marker boot ID")))
    except ValueError:
        raise WorkerError("Machine marker boot ID is invalid.") from None
    return MachineIdentity(
        instance_id,
        boot_id,
        _positive_integer(value["assignmentGeneration"], "marker generation"),
    )


def _validated_directory(path: Path, *, root: Path) -> None:
    try:
        path.relative_to(root)
        details = path.lstat()
    except (OSError, ValueError):
        raise WorkerError("Saved ownership path is invalid.") from None
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_mode & 0o022
    ):
        raise WorkerError("Saved ownership directory is invalid.")


def _read_json_nofollow(path: Path, maximum: int = 16 * 1024) -> Any:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_size > maximum:
            raise WorkerError("Saved ownership record is invalid.")
        with os.fdopen(descriptor, "r", encoding="utf-8", closefd=False) as handle:
            return json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise WorkerError("Saved ownership record is invalid.") from None
    finally:
        os.close(descriptor)


def _ownership_paths(state_path: Path) -> list[Path]:
    if not state_path.exists():
        return []
    _validated_directory(state_path, root=state_path)
    paths = [state_path / "shared-owner.lock"]
    supervisor = state_path / "supervisor"
    if supervisor.exists() or supervisor.is_symlink():
        _validated_directory(supervisor, root=state_path)
        paths.append(supervisor / "owner.json")
    launch = state_path / "launch"
    if launch.exists() or launch.is_symlink():
        _validated_directory(launch, root=state_path)
    for directory in [
        state_path / "ownership",
        supervisor / "ownership",
        launch / "ownership",
    ]:
        if directory.exists() or directory.is_symlink():
            _validated_directory(directory, root=state_path)
            paths.extend(sorted(directory.iterdir()))
    sessions = state_path
    for component in ("home", ".local", "state", "switch", "sdk-sessions"):
        sessions = sessions / component
        if not sessions.exists() and not sessions.is_symlink():
            break
        _validated_directory(sessions, root=state_path)
    else:
        for root in sorted(sessions.iterdir()):
            if not re.fullmatch(r"[0-9a-f]{64}", root.name):
                raise WorkerError("Saved SDK session directory is invalid.")
            _validated_directory(root, root=state_path)
            paths.extend(_ownership_paths(root))
    return [path for path in paths if path.exists() or path.is_symlink()]


def _known_owner_relative(relative: Path) -> bool:
    parts = relative.parts
    if (
        len(parts) > 6
        and parts[:5] == ("home", ".local", "state", "switch", "sdk-sessions")
        and re.fullmatch(r"[0-9a-f]{64}", parts[5])
    ):
        return _known_owner_relative(Path(*parts[6:]))
    if parts in {("shared-owner.lock",), ("supervisor", "owner.json")}:
        return True
    return (
        len(parts) == 2
        and parts[0] == "ownership"
        or len(parts) == 3
        and parts[:2] in {("supervisor", "ownership"), ("launch", "ownership")}
    )


def _validate_quarantine_tree(
    directory: Path, previous: MachineIdentity
) -> dict[Path, Path]:
    result: dict[Path, Path] = {}
    if not directory.exists() and not directory.is_symlink():
        return result
    _validated_directory(directory, root=directory)
    if (
        directory.lstat().st_uid != ROOT_UID
        or stat.S_IMODE(directory.lstat().st_mode) != 0o700
    ):
        raise WorkerError("Ownership quarantine is not a private root-owned directory.")
    for root, names, files in os.walk(directory, followlinks=False):
        root_path = Path(root)
        _validated_directory(root_path, root=directory)
        if root_path.lstat().st_uid != ROOT_UID:
            raise WorkerError("Ownership quarantine directory is not root-owned.")
        for name in names:
            child = root_path / name
            if child.is_symlink():
                raise WorkerError("Ownership quarantine contains a symlink.")
        for name in files:
            path = root_path / name
            relative = path.relative_to(directory)
            if not _known_owner_relative(relative) or path.is_symlink():
                raise WorkerError("Ownership quarantine contains an unknown record.")
            value = _read_json_nofollow(path)
            machine = _strict(
                value.get("machine") if isinstance(value, dict) else None,
                {"instanceId", "bootId", "assignmentGeneration"},
                set(),
                "ownership machine",
            )
            if machine != previous.json():
                raise WorkerError(
                    "Quarantined ownership record has unknown machine identity."
                )
            result[relative] = path
    return result


def _quarantine_stale_ownership(
    state_path: Path,
    marker_directory: Path,
    previous: MachineIdentity,
    current_boot_id: str,
) -> None:
    sources: dict[Path, Path] = {}
    for path in _ownership_paths(state_path):
        if path.is_symlink() or not path.is_file():
            raise WorkerError("Saved ownership record is invalid.")
        value = _read_json_nofollow(path)
        machine = _strict(
            value.get("machine") if isinstance(value, dict) else None,
            {"instanceId", "bootId", "assignmentGeneration"},
            set(),
            "ownership machine",
        )
        if machine != previous.json():
            raise WorkerError("Saved ownership record has unknown machine identity.")
        sources[path.relative_to(state_path)] = path
    quarantine_parent = marker_directory / "quarantine"
    quarantine_parent.mkdir(mode=0o700, exist_ok=True)
    os.chown(quarantine_parent, 0, 0)
    os.chmod(quarantine_parent, 0o700)
    quarantine = quarantine_parent / f"{previous.boot_id}--{current_boot_id}"
    quarantine.mkdir(mode=0o700, exist_ok=True)
    os.chown(quarantine, 0, 0)
    os.chmod(quarantine, 0o700)
    existing = _validate_quarantine_tree(quarantine, previous)
    collisions = set(sources) & set(existing)
    if collisions:
        raise WorkerError(
            "Ownership quarantine collides with a saved ownership record."
        )
    for relative, path in sources.items():
        target = quarantine / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chown(target.parent, 0, 0)
        os.chmod(target.parent, 0o700)
        os.replace(path, target)
        _fsync_directory(target.parent)
    _fsync_directory(quarantine)
    _fsync_directory(quarantine_parent)


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


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def prepare_agent_directories(user: str, group: str) -> tuple[int, int]:
    try:
        uid = pwd.getpwnam(user).pw_uid
        gid = grp.getgrnam(group).gr_gid
    except KeyError:
        raise WorkerError(
            "Pinned AMI is missing the unprivileged agent account."
        ) from None
    account = pwd.getpwnam(user)
    if uid == 0 or gid == 0 or account.pw_gid != gid:
        raise WorkerError(
            "Pinned AMI agent account must use its non-root primary group."
        )
    for path in [STATE_PATH, WORKSPACE_PATH]:
        if path.exists():
            details = path.lstat()
            if (
                not stat.S_ISDIR(details.st_mode)
                or stat.S_ISLNK(details.st_mode)
                or details.st_uid != uid
                or details.st_gid != gid
                or details.st_mode & 0o077
            ):
                raise WorkerError(f"{path} is not a private agent-owned directory.")
        else:
            path.mkdir(mode=0o700)
            os.chown(path, uid, gid)
            os.chmod(path, 0o700)
    return uid, gid


def _validate_secret_tree(directory: Path) -> None:
    details = directory.lstat()
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_uid != ROOT_UID
        or details.st_mode & 0o027
    ):
        raise WorkerError("Runtime secret directory is unsafe.")
    for root, names, files in os.walk(directory, followlinks=False):
        root_path = Path(root)
        root_details = root_path.lstat()
        if (
            not stat.S_ISDIR(root_details.st_mode)
            or stat.S_ISLNK(root_details.st_mode)
            or root_details.st_uid != ROOT_UID
            or root_details.st_mode & 0o027
        ):
            raise WorkerError("Runtime secret directory contains an unsafe directory.")
        for name in names:
            if (root_path / name).is_symlink():
                raise WorkerError("Runtime secret directory contains a symlink.")
        for name in files:
            path = root_path / name
            file_details = path.lstat()
            if (
                not stat.S_ISREG(file_details.st_mode)
                or stat.S_ISLNK(file_details.st_mode)
                or file_details.st_uid != ROOT_UID
                or file_details.st_mode & 0o022
            ):
                raise WorkerError("Runtime secret directory contains an unsafe file.")


def _remove_secret_tree(directory: Path) -> None:
    _validate_secret_tree(directory)
    shutil.rmtree(directory)


def materialize_secrets(
    bundle: SecretBundle,
    uid: int,
    gid: int,
    runtime_directory: Path = RUNTIME_DIRECTORY,
) -> tuple[Path, Callable[[], None]]:
    del uid
    commands = Commands()
    filesystem = commands.run(
        [
            "/usr/bin/findmnt",
            "--noheadings",
            "--output",
            "FSTYPE",
            "--target",
            str(runtime_directory),
        ]
    ).strip()
    if filesystem != "tmpfs":
        raise WorkerError("Runtime secret directory is not backed by tmpfs.")
    _validate_root_directory(runtime_directory, create=False)
    os.chown(runtime_directory, 0, gid)
    os.chmod(runtime_directory, 0o750)
    for orphan in runtime_directory.iterdir():
        if orphan.name.startswith(".secrets-"):
            _remove_secret_tree(orphan)
    secret_directory = runtime_directory / "secrets"
    temporary = runtime_directory / f".secrets-{uuid.uuid4()}"
    previous = runtime_directory / f".secrets-old-{uuid.uuid4()}"
    try:
        temporary.mkdir(mode=0o750)
        directory_fd = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchown(directory_fd, 0, gid)
            os.fchmod(directory_fd, 0o750)
            files = {
                "switch.json": json.dumps(
                    bundle.switch_credentials, separators=(",", ":")
                ),
                "deployment.json": json.dumps(bundle.deployment, separators=(",", ":")),
                "worker-capability": bundle.worker_capability,
            }
            if bundle.provider_credential is not None:
                files["provider"] = bundle.provider_credential + "\n"
            if bundle.github_credential is not None:
                files["github"] = bundle.github_credential + "\n"
            for name, value in files.items():
                descriptor = os.open(
                    name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o440,
                    dir_fd=directory_fd,
                )
                try:
                    os.fchown(descriptor, 0, gid)
                    os.fchmod(descriptor, 0o440)
                    os.write(descriptor, value.encode())
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        if secret_directory.exists() or secret_directory.is_symlink():
            _validate_secret_tree(secret_directory)
            os.replace(secret_directory, previous)
        os.replace(temporary, secret_directory)
        if previous.exists():
            _remove_secret_tree(previous)
    except Exception:
        for path in (temporary, previous):
            if path.exists() and not path.is_symlink():
                try:
                    _remove_secret_tree(path)
                except WorkerError:
                    pass
        raise

    def cleanup() -> None:
        try:
            _remove_secret_tree(secret_directory)
        except FileNotFoundError:
            pass

    return secret_directory / "deployment.json", cleanup


def build_launch(
    config: WorkerConfig,
    identity: MachineIdentity,
    deployment_path: Path,
    uid: int,
    gid: int,
) -> tuple[list[str], dict[str, str]]:
    arguments = [
        "/usr/bin/setpriv",
        f"--reuid={uid}",
        f"--regid={gid}",
        "--clear-groups",
        "--no-new-privs",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--bounding-set=-all",
        config.runtime.node_path,
        config.runtime.bootstrap_path,
        str(STATE_PATH),
        str(deployment_path),
    ]
    environment = {
        "PATH": config.runtime.path,
        "USER": config.runtime.agent_user,
        "LOGNAME": config.runtime.agent_user,
        "SHELL": "/bin/bash",
        "LANG": "C.UTF-8",
        "SWITCH_HOST_INSTANCE_ID": identity.instance_id,
        "SWITCH_HOST_BOOT_ID": identity.boot_id,
        "SWITCH_HOST_ASSIGNMENT_GENERATION": str(identity.assignment_generation),
    }
    return arguments, environment


def run_child(arguments: list[str], environment: dict[str, str]) -> int:
    child = subprocess.Popen(arguments, env=environment, start_new_session=True)
    stopping = False

    def forward(signum: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass

    previous = {
        signum: signal.signal(signum, forward)
        for signum in (signal.SIGTERM, signal.SIGINT)
    }
    try:
        code = child.wait()
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    if stopping and code in {-signal.SIGTERM, -signal.SIGINT}:
        return 0
    return code


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        raise WorkerError("Pinned runtime artifact is unreadable.") from None
    return digest.hexdigest()


def verify_pinned_runtime(config: WorkerConfig) -> str:
    artifacts = {
        "node": config.runtime.node_path,
        "bootstrap": config.runtime.bootstrap_path,
        "sharedHostDaemon": config.runtime.shared_host_daemon_path,
        "provider": config.runtime.provider_binary_path,
    }
    hashes = dict(config.runtime.artifact_sha256)
    for provider, runtime in config.runtime.providers.items():
        artifacts["provider-" + provider] = runtime["path"]
        hashes["provider-" + provider] = runtime["sha256"]
    for name, path in artifacts.items():
        try:
            details = os.stat(path, follow_symlinks=False)
        except OSError:
            raise WorkerError("Pinned runtime artifact is missing.") from None
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != ROOT_UID
            or details.st_mode & 0o022
        ):
            raise WorkerError("Pinned runtime artifact is missing or not root-owned.")
        if _sha256_file(path) != hashes[name]:
            raise WorkerError(
                "Pinned runtime artifact checksum does not match the AMI manifest."
            )
    try:
        version = subprocess.run(
            [config.runtime.node_path, "--version"],
            check=True,
            text=True,
            capture_output=True,
            env={"PATH": config.runtime.path, "LANG": "C"},
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        raise WorkerError(
            "Pinned Node.js executable failed its version check."
        ) from None
    if not re.fullmatch(r"v24\.\d+\.\d+", version):
        raise WorkerError("Pinned AMI does not provide Node.js 24.")
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "artifacts": hashes,
                "nodeVersion": version,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return fingerprint


def record_obsolete_bundle(path: Path, version_id: str) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(version_id)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def read_obsolete_bundle(path: Path) -> str | None:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    except OSError:
        raise WorkerError("Obsolete bundle marker is invalid.") from None
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_size > 1024:
            raise WorkerError("Obsolete bundle marker is invalid.")
        return os.read(descriptor, 1024).decode().strip()
    except (OSError, UnicodeError):
        raise WorkerError("Obsolete bundle marker is invalid.") from None
    finally:
        os.close(descriptor)


def await_current_bundle(
    secrets: SecretsManager, secret_id: str, marker: Path
) -> tuple[str, str]:
    raw, version_id = secrets.read(secret_id)
    obsolete = read_obsolete_bundle(marker)
    if obsolete is None:
        return raw, version_id
    warned_at: float | None = None
    while version_id == obsolete:
        now = time.monotonic()
        if warned_at is None or now - warned_at >= OBSOLETE_WARN_SECONDS:
            print(
                "The assignment secret still holds the bundle Switch refused as "
                "obsolete; waiting for the controller to publish the current one.",
                file=sys.stderr,
                flush=True,
            )
            warned_at = now
        time.sleep(OBSOLETE_POLL_SECONDS)
        raw, version_id = secrets.read(secret_id)
    os.unlink(marker)
    _fsync_directory(marker.parent)
    return raw, version_id


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config", default="/etc/switch-hosted/assignment.json", type=Path
    )
    parser.add_argument(
        "--runtime-config", default="/etc/switch-hosted/runtime.json", type=Path
    )
    arguments = parser.parse_args(argv)
    if os.geteuid() != 0:
        raise WorkerError("Trusted worker launcher must run as root.")
    root_lock = acquire_root_lock()

    def cleanup() -> None:
        pass

    try:
        config = load_worker_config(arguments.config, arguments.runtime_config)
        runtime_fingerprint = verify_pinned_runtime(config)
        instance_id = ImdsV2().instance_id()
        boot_id = _read_boot_id()
        identity = MachineIdentity(instance_id, boot_id, config.generation)
        commands = Commands()
        storage, _formatted = prepare_storage(commands, config)
        reconcile_boot_identity(
            identity,
            config.installation_id,
            config.agent_id,
            storage.filesystem_uuid or "",
            runtime_fingerprint,
            previous_instance_id=config.previous_instance_id,
            previous_runtime_fingerprint=config.previous_runtime_fingerprint,
        )
        uid, gid = prepare_agent_directories(
            config.runtime.agent_user, config.runtime.agent_group
        )
        raw_secret, version_id = await_current_bundle(
            SecretsManager(config.secret_region),
            config.secret_id,
            OBSOLETE_BUNDLE_PATH,
        )
        bundle = parse_secret_document(raw_secret, config)
        raw_secret = ""
        deployment_path, cleanup = materialize_secrets(bundle, uid, gid)
        launch, environment = build_launch(config, identity, deployment_path, uid, gid)
        code = run_child(launch, environment)
        if code == OBSOLETE_BUNDLE_EXIT_CODE:
            record_obsolete_bundle(OBSOLETE_BUNDLE_PATH, version_id)
            print(
                "Switch refused this worker's bundle as obsolete; restarting onto "
                "the current assignment secret.",
                file=sys.stderr,
                flush=True,
            )
        return code
    finally:
        cleanup()
        root_lock.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except WorkerError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
