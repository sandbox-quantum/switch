#!/usr/bin/env python3
"""Trusted root supervisor for one hosted Switch machine and its agents."""

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
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

logger = logging.getLogger("switch-hosted-worker")

DATA_MOUNT = Path("/data")
RUNTIME_DIRECTORY = Path("/run/switch-hosted")
LOCK_PATH = Path("/run/lock/switch-hosted-worker.lock")
BOOT_ID_PATH = Path("/proc/sys/kernel/random/boot_id")
MEMINFO_PATH = Path("/proc/meminfo")
IMDS_BASE = "http://169.254.169.254/latest"
SYSTEMCTL = "/usr/bin/systemctl"
SYSTEMD_MOUNT = "/usr/bin/systemd-mount"
SETPRIV = "/usr/bin/setpriv"
FLOCK = "/usr/bin/flock"
GIT = "/usr/bin/git"
UNIT_NODE_PATH = "/opt/switch/node/bin/node"
UNIT_BOOTSTRAP_PATH = "/opt/switch/agent-providers/hosted-bootstrap.mjs"
AGENT_SLICE = "switch-agents.slice"
SUPERVISOR_VERSION = "2.0.0"
MARKER_LAYOUT = "per-user-v1"
ONE_AGENT_LAYOUT_MESSAGE = "data volume uses the one-agent layout; see 'Moving to one machine per user' in deploy/hosted/README.md"
OBSOLETE_EXIT_CODE = 75
OBSERVE_SECONDS = 3
DEFAULT_HEARTBEAT_SECONDS = 15
RETIRED_HEARTBEAT_SECONDS = 60
LIST_RETRY_SECONDS = 15
RECONCILE_RETRY_MAX_SECONDS = 300
HTTP_TIMEOUT_SECONDS = 30
GIT_TIMEOUT_SECONDS = 300
GIT_KILL_WAIT_SECONDS = 10
SLICE_RESERVE_BYTES = 1024**3
MAX_SECRET_BYTES = 128 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
ROOT_UID = 0
INSTANCE_RE = re.compile(r"^i-[0-9a-f]{8,17}$")
VOLUME_RE = re.compile(r"^vol-[0-9a-f]{8,17}$")
SECRET_ARN_RE = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z]{2}(?:-gov)?-[a-z]+-\d):([0-9]{12}):secret:([A-Za-z0-9/_+=.@-]+)$"
)
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$")
CAPABILITY_RE = re.compile(r"^[\x21-\x7e]{16,4096}$")
REPOSITORY_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$"
)
DEFINITION_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
FINGERPRINT_RE = re.compile(r"^sha256:[0-9a-f]{1,64}$")
OWNERSHIP_TICKET_RE = re.compile(r"^\d+-[0-9a-f-]+\.json$")
OWNERSHIP_TEMPORARY_RE = re.compile(r"^\d+-[0-9a-f-]+\.json\.[0-9a-f-]+\.tmp$")
SKILL_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
SKILL_PATH_RE = re.compile(
    r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}){0,7}$"
)
MAX_SKILL_BYTES = 32 * 1024
MAX_SKILLS = 16
CREDENTIAL_KINDS = {"api-key", "setup-token", "auth-json"}
SKILL_PROVIDERS = {"claude", "codex", "opencode"}
PROVIDER_CONTEXT = (
    "Use the Switch tools to read room context and post replies to the room.\n"
)
INVALID_CONFIG = "invalid-config"
SETUP_FAILED = "setup-failed"
OWNERSHIP_INVALID = "ownership-invalid"


class WorkerError(RuntimeError):
    pass


class ObsoleteBundle(WorkerError):
    pass


class GitAbandoned(WorkerError):
    pass


class ReconcileIncomplete(WorkerError):
    pass


class MachineRetired(Exception):
    pass


class CoreUnavailable(Exception):
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


def _agent_id(value: Any) -> str:
    try:
        if isinstance(value, str) and str(uuid.UUID(value)) == value:
            return value
    except ValueError:
        pass
    raise WorkerError("Agent ID must be a lowercase UUID.")


def _unavailable_code(entry: dict[str, Any]) -> str | None:
    code = entry.get("unavailable")
    if code is None:
        return None
    _text(code, "Unavailable code", maximum=128)
    _agent_id(entry["agent_id"])
    _identifier(entry["launch_id"], "Launch ID")
    return code


def _is_agent_id(value: str) -> bool:
    try:
        _agent_id(value)
    except WorkerError:
        return False
    return True


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
        raise WorkerError(f"{label} is invalid.")
    return endpoint


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
    slot_id: str
    generation: int
    secret_id: str
    secret_region: str
    volume_id: str
    device_path: str
    runtime: RuntimeConfig


@dataclass(frozen=True)
class MachineBundle:
    machine_id: str
    api_endpoint: str
    machine_capability: str = field(repr=False)


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
    runtime: Path

    @property
    def marker_directory(self) -> Path:
        return self.data / ".switch-hosted"

    @property
    def marker(self) -> Path:
        return self.marker_directory / "machine.json"

    @property
    def agent_records(self) -> Path:
        return self.marker_directory / "agents.json"

    @property
    def quarantine(self) -> Path:
        return self.marker_directory / "quarantine"

    @property
    def ownership_blocked(self) -> Path:
        return self.marker_directory / "ownership-blocked.json"

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
    def bundle(self) -> Path:
        return self.runtime / "machine" / "bundle.json"

    @property
    def agents_runtime(self) -> Path:
        return self.runtime / "agents"

    def pending_install(self, agent_id: str) -> Path:
        return self.bundle.parent / f"pending-{agent_id}.json"


def load_worker_config(assignment_path: Path, runtime_path: Path) -> WorkerConfig:
    value = _load_json(
        assignment_path, "Worker assignment configuration is invalid.", MAX_SECRET_BYTES
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
        "worker assignment",
    )
    if value["version"] != 2:
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
    if (
        runtime.node_path != UNIT_NODE_PATH
        or runtime.bootstrap_path != UNIT_BOOTSTRAP_PATH
    ):
        raise WorkerError(
            "Pinned runtime paths do not match the switch-agent@ unit ExecStart."
        )
    secret_id = _text(value["assignmentSecretId"], "worker secret ID")
    return WorkerConfig(
        installation_id=_identifier(value["installationId"], "installation ID"),
        slot_id=_identifier(value["slotId"], "slot ID"),
        generation=_positive_integer(
            value["generation"], "worker assignment generation"
        ),
        secret_id=secret_id,
        secret_region=_secret_arn_region(secret_id),
        volume_id=volume_id,
        device_path=_absolute_path(value["dataDevice"], "worker data device"),
        runtime=runtime,
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


def parse_bundle(raw: str, config: WorkerConfig) -> MachineBundle:
    if len(raw.encode()) > MAX_SECRET_BYTES:
        raise WorkerError("Machine bundle is invalid.")
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError):
        raise WorkerError("Machine bundle is invalid.") from None
    if not isinstance(value, dict) or "version" not in value:
        raise WorkerError("Machine bundle is invalid.")
    if value["version"] != 2:
        raise ObsoleteBundle("obsolete bundle")
    value = _strict(
        value,
        {"version", "machineId", "assignment", "machineCapability", "apiEndpoint"},
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
        raise WorkerError("Machine bundle does not match the worker assignment.")
    capability = value["machineCapability"]
    if not isinstance(capability, str) or not CAPABILITY_RE.fullmatch(capability):
        raise WorkerError("Machine capability is invalid.")
    return MachineBundle(
        machine_id=_identifier(value["machineId"], "machine ID"),
        api_endpoint=_https_endpoint(value["apiEndpoint"], "Switch API endpoint"),
        machine_capability=capability,
    )


def _validate_skills(value: Any) -> None:
    if not isinstance(value, list) or not 0 < len(value) <= MAX_SKILLS:
        raise WorkerError("Deployment skills are invalid.")
    slugs: set[str] = set()
    total = 0
    for item in value:
        skill = _strict(item, {"slug", "files"}, set(), "deployment skill")
        slug = skill["slug"]
        if (
            not isinstance(slug, str)
            or not SKILL_SLUG_RE.fullmatch(slug)
            or slug in slugs
        ):
            raise WorkerError("Deployment skill name is invalid or repeated.")
        slugs.add(slug)
        files = skill["files"]
        if not isinstance(files, dict) or "SKILL.md" not in files:
            raise WorkerError("Deployment skill must include SKILL.md.")
        for path, content in files.items():
            if (
                not isinstance(path, str)
                or not SKILL_PATH_RE.fullmatch(path)
                or any(part in {".", ".."} for part in path.split("/"))
            ):
                raise WorkerError("Deployment skill file path is unsafe.")
            if not isinstance(content, str) or "\x00" in content:
                raise WorkerError("Deployment skill file content is invalid.")
            total += len(content.encode())
    if total > MAX_SKILL_BYTES:
        raise WorkerError("Deployment skills exceed the size limit.")


def _validate_switch_credentials(value: Any, agent_id: str) -> dict[str, Any]:
    value = _strict(value, {"env"}, set(), "Switch credentials")
    env = _strict(
        value["env"],
        {"SWITCH_API_ENDPOINT", "SWITCH_API_TOKEN", "SWITCH_AGENT_ID"},
        set(),
        "Switch credential environment",
    )
    _https_endpoint(env["SWITCH_API_ENDPOINT"], "Switch API endpoint")
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


@dataclass(frozen=True)
class AgentPlan:
    launch_id: str
    agent_id: str
    revision: int
    desired_state: str
    deployment: dict[str, Any]
    switch_credentials: dict[str, Any] = field(repr=False)
    worker_capability: str = field(repr=False)
    workspace: Path
    worktree_owner: Path | None


AGENT_FIELDS = {
    "launch_id",
    "agent_id",
    "name",
    "revision",
    "desired_state",
    "provider",
    "provider_credential_kind",
    "worker_capability",
    "switch_credentials",
    "repository",
    "spec",
    "skills",
}


def build_agent_plan(
    value: dict[str, Any], runtime: RuntimeConfig, paths: Paths
) -> AgentPlan:
    missing = AGENT_FIELDS - set(value)
    if missing:
        raise WorkerError(f"Agent entry is missing {', '.join(sorted(missing))}.")
    agent_id = _agent_id(value["agent_id"])
    launch_id = _identifier(value["launch_id"], "launch ID")
    revision = _positive_integer(value["revision"], "launch revision")
    if value["desired_state"] not in {"running", "stopped"}:
        raise WorkerError("Agent desired state is invalid.")
    provider = value["provider"]
    if provider == "claude":
        binary = runtime.provider_binary_path
    elif isinstance(provider, str) and provider in runtime.providers:
        binary = runtime.providers[provider]["path"]
    else:
        raise WorkerError(f"Provider {provider!r} is not installed on this machine.")
    credential_kind = value["provider_credential_kind"]
    if credential_kind not in CREDENTIAL_KINDS:
        raise WorkerError(f"Provider credential kind {credential_kind!r} is invalid.")
    capability = value["worker_capability"]
    if not isinstance(capability, str) or not CAPABILITY_RE.fullmatch(capability):
        raise WorkerError("Worker capability is invalid.")
    switch_credentials = _validate_switch_credentials(
        value["switch_credentials"], agent_id
    )
    repository = value["repository"]
    if repository is not None and (
        not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository)
    ):
        raise WorkerError("Hosted GitHub repository must be an owner/repository name.")
    skills = value["skills"]
    if not isinstance(skills, list):
        raise WorkerError("Deployment skills are invalid.")
    if skills:
        _validate_skills(skills)
        if provider not in SKILL_PROVIDERS:
            raise WorkerError("This provider has no skills directory.")
    spec = value["spec"]
    if not isinstance(spec, dict):
        raise WorkerError("Launch spec must be an object.")
    for key in (
        "instructions",
        "auto_session",
        "auto_approve",
        "definition_attributes",
    ):
        if key not in spec:
            raise WorkerError(f"Launch spec is missing {key}.")
    if not isinstance(spec["instructions"], str):
        raise WorkerError("Launch instructions are invalid.")
    if not isinstance(spec["auto_session"], bool) or not isinstance(
        spec["auto_approve"], bool
    ):
        raise WorkerError("Launch session flags are invalid.")
    if not isinstance(spec["definition_attributes"], dict):
        raise WorkerError("Launch definition attributes are invalid.")
    agent_runtime = paths.agents_runtime / agent_id
    provider_spec: dict[str, Any] = {
        "kind": provider,
        "credential": {
            "kind": credential_kind,
            "path": str(agent_runtime / "provider"),
            "refresh": True,
        },
        "binaryPath": binary,
        "context": _text(
            PROVIDER_CONTEXT + spec["instructions"],
            "deployment provider context",
            maximum=64 * 1024,
        ),
    }
    if provider == "claude":
        name = spec.get("name")
        if not isinstance(name, str) or not DEFINITION_NAME_RE.fullmatch(name):
            raise WorkerError("Hosted agent definition name is invalid.")
        provider_spec["definition"] = {
            "name": name,
            "content": _text(
                spec.get("definition"), "agent definition", maximum=64 * 1024
            ),
        }
    model = spec["definition_attributes"].get("model")
    if model:
        provider_spec["model"] = {"id": _text(model, "deployment model ID")}
    deployment: dict[str, Any] = {
        "version": 2,
        "revision": revision,
        "session": {"sessionId": "watcher-" + agent_id, "agentId": agent_id},
        "provider": provider_spec,
    }
    worktree_owner = None
    if repository is not None:
        owner, name = repository.lower().split("/")
        worktree_owner = paths.worktrees / agent_id / owner
        workspace = worktree_owner / name
        deployment["github"] = {
            "credentialPath": str(agent_runtime / "github"),
            "repository": repository,
            "refresh": True,
            "mirrorPath": str(paths.repos / owner / f"{name}.git"),
        }
    else:
        workspace = paths.worktrees / agent_id / "workspace"
    deployment.update(
        {
            "workspacePath": str(workspace),
            "watch": spec["auto_session"],
            "runtimeMode": "full-access"
            if spec["auto_approve"]
            else "approval-required",
            "switchCredentialsPath": str(agent_runtime / "switch.json"),
            "workerCapabilityPath": str(agent_runtime / "worker-capability"),
        }
    )
    if skills:
        deployment["skills"] = skills
    return AgentPlan(
        launch_id=launch_id,
        agent_id=agent_id,
        revision=revision,
        desired_state=value["desired_state"],
        deployment=deployment,
        switch_credentials=switch_credentials,
        worker_capability=capability,
        workspace=workspace,
        worktree_owner=worktree_owner,
    )


def agent_environment(
    runtime: RuntimeConfig,
    identity: MachineIdentity,
    machine_id: str,
    paths: Paths,
    agent_id: str,
) -> str:
    state = paths.agents / agent_id
    values = {
        "PATH": runtime.path,
        "USER": runtime.agent_user,
        "LOGNAME": runtime.agent_user,
        "SHELL": "/bin/bash",
        "LANG": "C.UTF-8",
        "HOME": str(state / "home"),
        "TMPDIR": str(state / "tmp"),
        "SWITCH_HOST_INSTANCE_ID": identity.instance_id,
        "SWITCH_HOST_BOOT_ID": identity.boot_id,
        "SWITCH_HOST_ASSIGNMENT_GENERATION": str(identity.assignment_generation),
        "SWITCH_HOST_MACHINE_ID": machine_id,
    }
    for name, value in values.items():
        if any(character in value for character in "\r\n\x00\\\"'"):
            raise WorkerError(f"Agent environment value {name} is invalid.")
    return "".join(f"{name}={value}\n" for name, value in values.items())


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

    def read(self, secret_id: str) -> str:
        try:
            response = self._client.get_secret_value(
                SecretId=secret_id, VersionStage="AWSCURRENT"
            )
            value = response.get("SecretString")
        except Exception:
            raise WorkerError("The assignment secret could not be read.") from None
        if not isinstance(value, str):
            raise WorkerError("The assignment secret is not a JSON string.")
        return value


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


class CoreClient:
    def __init__(
        self,
        bundle: MachineBundle,
        identity: MachineIdentity,
        opener: Callable[[urllib.request.Request, float], Any],
    ) -> None:
        self._base = (
            bundle.api_endpoint.rstrip("/")
            + "/hosted/machines/"
            + quote(bundle.machine_id, safe="")
        )
        self._headers = {
            "Authorization": "Bearer " + bundle.machine_capability,
            "X-Switch-Host-Boot-Id": identity.boot_id,
            "X-Switch-Host-Instance-Id": identity.instance_id,
            "Accept": "application/json",
        }
        self._opener = opener

    def agents(self) -> dict[str, Any]:
        value = self._request("/agents", None)
        if (
            not isinstance(value, dict)
            or isinstance(value.get("agents_version"), bool)
            or not isinstance(value.get("agents_version"), int)
            or not isinstance(value.get("agents"), list)
        ):
            raise CoreUnavailable("Switch returned an invalid agent list.")
        return value

    def heartbeat(self, body: dict[str, Any]) -> dict[str, Any]:
        value = self._request("/heartbeat", body)
        if (
            not isinstance(value, dict)
            or isinstance(value.get("agents_version"), bool)
            or not isinstance(value.get("agents_version"), int)
        ):
            raise CoreUnavailable("Switch returned an invalid heartbeat response.")
        return value

    def _request(self, suffix: str, body: dict[str, Any] | None) -> Any:
        headers = dict(self._headers)
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(
            self._base + suffix,
            data=data,
            headers=headers,
            method="GET" if body is None else "POST",
        )
        try:
            with self._opener(request, HTTP_TIMEOUT_SECONDS) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            error.close()
            if error.code == 401:
                raise WorkerError(
                    "Switch rejected the machine capability; restarting to re-read the bundle."
                ) from None
            if error.code == 410:
                raise MachineRetired() from None
            raise CoreUnavailable(
                f"Switch returned HTTP {error.code} for {suffix}."
            ) from None
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise CoreUnavailable(
                f"Switch is unreachable for {suffix}: {type(error).__name__}."
            ) from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise CoreUnavailable(f"Switch response for {suffix} is too large.")
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeError):
            raise CoreUnavailable(
                f"Switch response for {suffix} is not JSON."
            ) from None


def default_opener() -> Callable[[urllib.request.Request, float], Any]:
    opener = urllib.request.build_opener(_NoRedirect())
    return lambda request, timeout: opener.open(request, timeout=timeout)


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


def agent_unit(agent_id: str) -> str:
    return f"switch-agent@{_agent_id(agent_id)}.service"


SHOW_PROPERTIES = (
    "ActiveState",
    "SubState",
    "Result",
    "NRestarts",
    "ExecMainStatus",
    "ExecMainCode",
    "ExecMainExitTimestampMonotonic",
)


class Systemd:
    def __init__(self, commands: Commands) -> None:
        self._commands = commands

    def show(self, agent_id: str) -> dict[str, str]:
        output = self._commands.run(
            [SYSTEMCTL, "show", "-p", ",".join(SHOW_PROPERTIES), agent_unit(agent_id)]
        )
        values = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        if not set(SHOW_PROPERTIES) <= set(values):
            raise WorkerError(f"systemctl show returned no state for {agent_id}.")
        return values

    def start(self, agent_id: str) -> None:
        self._commands.run(
            [SYSTEMCTL, "--no-block", "start", agent_unit(agent_id)], capture=False
        )

    def restart(self, agent_id: str) -> None:
        self._commands.run(
            [SYSTEMCTL, "--no-block", "restart", agent_unit(agent_id)], capture=False
        )

    def stop(self, agent_id: str, *, wait: bool) -> None:
        self._commands.run(
            [
                SYSTEMCTL,
                *([] if wait else ["--no-block"]),
                "stop",
                agent_unit(agent_id),
            ],
            capture=False,
        )

    def reset_failed(self, agent_id: str) -> None:
        self._commands.result(
            [SYSTEMCTL, "reset-failed", agent_unit(agent_id)], capture=False
        )

    def stop_all(self) -> None:
        self._commands.run([SYSTEMCTL, "stop", "switch-agent@*.service"], capture=False)

    def limit_slice(self, memory_max: int) -> None:
        self._commands.run(
            [
                SYSTEMCTL,
                "set-property",
                "--runtime",
                AGENT_SLICE,
                f"MemoryMax={memory_max}",
            ],
            capture=False,
        )


def setpriv_prefix(uid: int, gid: int) -> list[str]:
    return [
        SETPRIV,
        f"--reuid={uid}",
        f"--regid={gid}",
        "--clear-groups",
        "--no-new-privs",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--bounding-set=-all",
    ]


class GitRunner:
    def __init__(self, prefix: list[str], flock: str, git: str) -> None:
        self._prefix = prefix
        self._flock = flock
        self._git = git

    def run(self, mirror: Path, arguments: list[str]) -> None:
        command = [
            *self._prefix,
            self._flock,
            "--no-fork",
            f"{mirror}.lock",
            self._git,
            "-C",
            str(mirror),
            *arguments,
        ]
        label = f"git {' '.join(arguments[:2])} on {mirror}"
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                env={
                    "PATH": "/usr/bin:/bin",
                    "LANG": "C",
                    "HOME": "/nonexistent",
                    "GIT_CONFIG_NOSYSTEM": "1",
                    "GIT_CONFIG_GLOBAL": "/dev/null",
                    "GIT_TERMINAL_PROMPT": "0",
                },
            )
        except OSError:
            raise WorkerError(f"{label} could not run.") from None
        try:
            returncode = process.wait(timeout=GIT_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            _kill_process_group(process, label)
            raise WorkerError(f"{label} timed out and was killed.") from None
        if returncode != 0:
            raise WorkerError(f"{label} failed with exit status {returncode}.")


def _kill_process_group(process: subprocess.Popen[bytes], label: str) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    process.wait()
    deadline = time.monotonic() + GIT_KILL_WAIT_SECONDS
    while True:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        except PermissionError:
            pass
        if time.monotonic() >= deadline:
            raise GitAbandoned(f"{label} timed out and its processes did not exit.")
        time.sleep(0.1)


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
                SYSTEMD_MOUNT,
                "--type=ext4",
                "--options=nodev,nosuid",
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
            "Another trusted worker supervisor already owns this instance."
        ) from None
    return os.fdopen(descriptor, "r+")


def reconcile_marker(
    identity: MachineIdentity,
    config: WorkerConfig,
    filesystem_uuid: str,
    runtime_fingerprint: str,
    paths: Paths,
) -> set[str]:
    marker_directory = paths.marker_directory
    marker_directory.mkdir(mode=0o700, parents=False, exist_ok=True)
    os.chown(marker_directory, 0, 0)
    os.chmod(marker_directory, 0o700)
    if paths.marker.exists() or paths.marker.is_symlink():
        marker = _read_root_marker(paths.marker)
        if (
            marker["installationId"] != config.installation_id
            or marker["slotId"] != config.slot_id
        ):
            raise WorkerError("Retained disk belongs to another installation or slot.")
        if marker["generation"] != config.generation:
            raise WorkerError("Retained disk belongs to another assignment generation.")
        if marker["filesystemUuid"] != filesystem_uuid:
            raise WorkerError("Retained disk filesystem identity changed.")
        if marker["bootId"] != identity.boot_id:
            blocked = _quarantine_agents(
                paths,
                [path.name for path in _agent_state_directories(paths.agents)],
                marker["bootId"],
                identity.boot_id,
            )
        else:
            blocked = _retry_blocked_ownership(paths, identity.boot_id)
            if (
                marker["instanceId"] == identity.instance_id
                and marker["runtimeFingerprint"] == runtime_fingerprint
            ):
                return blocked
    else:
        blocked = set()
        unexpected = {
            child.name
            for child in paths.data.iterdir()
            if child.name not in {"lost+found", marker_directory.name}
        }
        if unexpected:
            raise WorkerError(
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
    return blocked


def _quarantine_agents(
    paths: Paths, agent_ids: list[str], previous_boot_id: str, current_boot_id: str
) -> set[str]:
    blocked: set[str] = set()
    for agent_id in agent_ids:
        try:
            _quarantine_stale_ownership(
                paths.agents / agent_id,
                paths.quarantine,
                agent_id,
                previous_boot_id,
                current_boot_id,
            )
        except (WorkerError, OSError) as error:
            logger.error(
                "Agent %s ownership could not be quarantined; it will not start: %s",
                agent_id,
                error,
            )
            blocked.add(agent_id)
    if blocked:
        _write_root_json(
            paths.ownership_blocked,
            {
                "version": 1,
                "bootId": current_boot_id,
                "previousBootId": previous_boot_id,
                "agents": sorted(blocked),
            },
        )
    else:
        paths.ownership_blocked.unlink(missing_ok=True)
    return blocked


def _retry_blocked_ownership(paths: Paths, boot_id: str) -> set[str]:
    path = paths.ownership_blocked
    if not path.exists() and not path.is_symlink():
        return set()
    try:
        details = path.lstat()
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != ROOT_UID
            or details.st_mode & 0o077
        ):
            raise ValueError()
        value = _strict(
            _read_json_nofollow(path),
            {"version", "bootId", "previousBootId", "agents"},
            set(),
            "blocked ownership",
        )
        if (
            value["version"] != 1
            or value["bootId"] != boot_id
            or not isinstance(value["previousBootId"], str)
            or not isinstance(value["agents"], list)
        ):
            raise ValueError()
        agent_ids = [_agent_id(agent_id) for agent_id in value["agents"]]
    except (OSError, ValueError, WorkerError):
        raise WorkerError("Blocked ownership record is invalid.") from None
    return _quarantine_agents(paths, agent_ids, value["previousBootId"], boot_id)


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
        raise WorkerError("Retained disk machine marker is invalid.") from None
    if isinstance(value, dict) and value.get("version") == 1:
        raise WorkerError(ONE_AGENT_LAYOUT_MESSAGE)
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
    except (ValueError, WorkerError):
        raise WorkerError("Retained disk machine marker is invalid.") from None


def _agent_state_directories(agents: Path) -> list[Path]:
    if not agents.exists() and not agents.is_symlink():
        return []
    _validate_root_directory(agents, create=False)
    result = []
    for child in sorted(agents.iterdir()):
        if not _is_agent_id(child.name):
            logger.warning("Ignoring unexpected entry %s in %s.", child.name, agents)
            continue
        result.append(child)
    return result


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


def _validate_owner_record(relative: Path, path: Path) -> None:
    name = relative.name
    if relative.parent.name == "ownership" and OWNERSHIP_TEMPORARY_RE.fullmatch(name):
        return
    value = _read_json_nofollow(path)
    try:
        if name == "shared-owner.lock":
            record = _strict(value, {"pid", "token"}, {"group"}, "owner record")
            if record.get("group") is not None:
                _positive_integer(record["group"], "owner process group")
        elif name == "owner.json":
            record = _strict(value, {"pid", "token", "build"}, set(), "owner record")
            _text(record["build"], "owner build")
        elif OWNERSHIP_TICKET_RE.fullmatch(name):
            record = _strict(value, {"choosing", "ticket"}, set(), "ownership ticket")
            ticket = record["ticket"]
            if (
                not isinstance(record["choosing"], bool)
                or isinstance(ticket, bool)
                or not isinstance(ticket, int)
                or ticket < 0
            ):
                raise WorkerError("ownership ticket is invalid.")
            return
        else:
            raise WorkerError("ownership record name is invalid.")
        _positive_integer(record["pid"], "owner PID")
        _text(record["token"], "owner token")
    except WorkerError:
        raise WorkerError("Saved ownership record is invalid.") from None


def _validate_quarantine_tree(directory: Path) -> dict[Path, Path]:
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
            _validate_owner_record(relative, path)
            result[relative] = path
    return result


def _private_root_directory(path: Path) -> None:
    path.mkdir(mode=0o700, exist_ok=True)
    os.chown(path, 0, 0)
    os.chmod(path, 0o700)


def _quarantine_stale_ownership(
    state_path: Path,
    quarantine_root: Path,
    agent_id: str,
    previous_boot_id: str,
    current_boot_id: str,
) -> None:
    sources: dict[Path, Path] = {}
    for path in _ownership_paths(state_path):
        if path.is_symlink() or not path.is_file():
            raise WorkerError("Saved ownership record is invalid.")
        relative = path.relative_to(state_path)
        _validate_owner_record(relative, path)
        sources[relative] = path
    if not sources:
        return
    agent_quarantine = quarantine_root / agent_id
    quarantine = agent_quarantine / f"{previous_boot_id}--{current_boot_id}"
    for directory in (quarantine_root, agent_quarantine, quarantine):
        _private_root_directory(directory)
    existing = _validate_quarantine_tree(quarantine)
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
    _fsync_directory(agent_quarantine)


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


def resolve_agent_account(user: str, group: str) -> tuple[int, int]:
    try:
        account = pwd.getpwnam(user)
        gid = grp.getgrnam(group).gr_gid
    except KeyError:
        raise WorkerError(
            "Pinned AMI is missing the unprivileged agent account."
        ) from None
    if account.pw_uid == 0 or gid == 0 or account.pw_gid != gid:
        raise WorkerError(
            "Pinned AMI agent account must use its non-root primary group."
        )
    return account.pw_uid, gid


def _root_directory(path: Path, mode: int, gid: int) -> None:
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=mode)
    details = path.lstat()
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_uid != ROOT_UID
    ):
        raise WorkerError(f"{path} must be a root-owned directory.")
    os.chown(path, 0, gid)
    os.chmod(path, mode)


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def _open_trusted_root(path: Path) -> int:
    try:
        descriptor = os.open(path, DIRECTORY_FLAGS)
    except OSError:
        raise WorkerError(f"{path} is unavailable.") from None
    details = os.fstat(descriptor)
    if details.st_uid != ROOT_UID or details.st_mode & 0o022:
        os.close(descriptor)
        raise WorkerError(f"{path} must be a root-owned non-writable directory.")
    return descriptor


def _agent_directories(root: Path, parts: tuple[str, ...], uid: int, gid: int) -> None:
    """Create or repair each directory of root/parts as a private agent directory.

    Every component is opened relative to its already-open parent with
    O_NOFOLLOW and changed through its descriptor, so an agent that swaps a
    component for a symlink cannot redirect root's chown or chmod.
    """
    descriptor = _open_trusted_root(root)
    path = root
    try:
        for name in parts:
            if name in {"", ".", ".."} or "/" in name:
                raise WorkerError(f"{root} has an unsafe path component.")
            path = path / name
            try:
                os.mkdir(name, 0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            try:
                child = os.open(name, DIRECTORY_FLAGS, dir_fd=descriptor)
            except OSError:
                raise WorkerError(
                    f"{path} is not a private agent-owned directory."
                ) from None
            os.close(descriptor)
            descriptor = child
            details = os.fstat(descriptor)
            if details.st_uid not in {ROOT_UID, uid}:
                raise WorkerError(f"{path} is not a private agent-owned directory.")
            if details.st_uid != uid or details.st_gid != gid:
                os.fchown(descriptor, uid, gid)
            if stat.S_IMODE(details.st_mode) != 0o700:
                os.fchmod(descriptor, 0o700)
    finally:
        os.close(descriptor)


def prepare_layout(paths: Paths, uid: int, gid: int) -> None:
    _root_directory(paths.agents, 0o755, 0)
    _root_directory(paths.worktrees, 0o755, 0)
    _agent_directories(paths.data, (paths.repos.name,), uid, gid)


def prepare_runtime_directory(commands: Commands, paths: Paths, gid: int) -> None:
    filesystem = commands.run(
        [
            "/usr/bin/findmnt",
            "--noheadings",
            "--output",
            "FSTYPE",
            "--target",
            str(paths.runtime),
        ]
    ).strip()
    if filesystem != "tmpfs":
        raise WorkerError("Runtime secret directory is not backed by tmpfs.")
    _validate_root_directory(paths.runtime, create=False)
    os.chown(paths.runtime, 0, gid)
    os.chmod(paths.runtime, 0o750)
    _root_directory(paths.bundle.parent, 0o700, 0)
    _root_directory(paths.agents_runtime, 0o750, gid)


def write_bundle(paths: Paths, bundle: MachineBundle) -> None:
    _write_root_json(
        paths.bundle,
        {
            "version": 2,
            "machineId": bundle.machine_id,
            "machineCapability": bundle.machine_capability,
            "apiEndpoint": bundle.api_endpoint,
        },
    )


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


def remove_runtime_orphans(parent: Path) -> None:
    for orphan in parent.iterdir():
        if orphan.name.startswith("."):
            _remove_secret_tree(orphan)


def install_runtime_files(
    parent: Path, name: str, files: dict[str, str], gid: int
) -> None:
    target = parent / name
    temporary = parent / f".tmp-{uuid.uuid4()}"
    previous = parent / f".old-{uuid.uuid4()}"
    try:
        temporary.mkdir(mode=0o750)
        directory_fd = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchown(directory_fd, 0, gid)
            os.fchmod(directory_fd, 0o750)
            for file_name, value in files.items():
                descriptor = os.open(
                    file_name,
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
        if target.exists() or target.is_symlink():
            _validate_secret_tree(target)
            os.replace(target, previous)
        os.replace(temporary, target)
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


def _remove_tree(path: Path) -> None:
    if path.is_symlink():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


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


def read_meminfo(path: Path) -> tuple[int, int]:
    values: dict[str, int] = {}
    try:
        for line in path.read_text(encoding="ascii").splitlines():
            name, _, rest = line.partition(":")
            if name in {"MemTotal", "MemAvailable"}:
                number, unit = rest.split()
                if unit != "kB":
                    raise ValueError()
                values[name] = int(number) * 1024
        return values["MemTotal"], values["MemAvailable"]
    except (OSError, ValueError, KeyError):
        raise WorkerError("Memory information is unavailable.") from None


@dataclass(frozen=True)
class Failure:
    process_state: str
    result: str


@dataclass
class HeldAgent:
    launch_id: str
    agent_id: str
    revision: int
    desired_state: str | None
    failure: Failure | None


@dataclass
class ObservedState:
    process_state: str
    restarts: int
    exit: dict[str, Any] | None
    since: str


class Supervisor:
    def __init__(
        self,
        *,
        runtime: RuntimeConfig,
        identity: MachineIdentity,
        machine_id: str,
        runtime_fingerprint: str,
        paths: Paths,
        uid: int,
        gid: int,
        client: CoreClient,
        systemd: Systemd,
        git: GitRunner,
        clock: Callable[[], datetime],
        monotonic: Callable[[], float],
        sleep: Callable[[float], None],
        statvfs: Callable[[str], Any],
        meminfo: Path,
        ownership_blocked: set[str],
    ) -> None:
        self._ownership_blocked = set(ownership_blocked)
        self._runtime = runtime
        self._identity = identity
        self._machine_id = machine_id
        self._fingerprint = runtime_fingerprint
        self._paths = paths
        self._uid = uid
        self._gid = gid
        self._client = client
        self._systemd = systemd
        self._git = git
        self._clock = clock
        self._monotonic = monotonic
        self._sleep = sleep
        self._statvfs = statvfs
        self._meminfo = meminfo
        self._held: list[HeldAgent] = []
        self._states: dict[str, ObservedState] = {}
        self._touched: set[str] = set()
        self._obsolete_exits: dict[str, str] = {}
        self._agents_version: int | None = None
        self._reconcile_failures = 0
        self._pending_prunes: set[Path] = set()
        self._need_list = True
        self._next_list = 0.0
        self._next_heartbeat = 0.0
        self._heartbeat_every = DEFAULT_HEARTBEAT_SECONDS
        self._retired = False
        self._records = self._load_records()

    def run(self) -> None:
        self.limit_slice()
        while True:
            self.tick()
            self._sleep(OBSERVE_SECONDS)

    def limit_slice(self) -> None:
        total, _available = read_meminfo(self._meminfo)
        if total <= SLICE_RESERVE_BYTES:
            raise WorkerError("The machine has too little memory for agents.")
        self._systemd.limit_slice(total - SLICE_RESERVE_BYTES)

    def tick(self) -> None:
        now = self._monotonic()
        if self._retired:
            if now >= self._next_heartbeat:
                self._observe()
                self._send_heartbeat()
            return
        if self._need_list and now >= self._next_list:
            self._refresh()
            if self._retired:
                return
        changed = self._observe()
        if changed or self._monotonic() >= self._next_heartbeat:
            self._send_heartbeat()
        if (
            self._need_list
            and self._monotonic() >= self._next_list
            and not self._retired
        ):
            self._refresh()

    def _refresh(self) -> None:
        try:
            listing = self._client.agents()
        except MachineRetired:
            self._retire()
            return
        except CoreUnavailable as error:
            logger.warning("Agent list fetch failed; retrying: %s", error)
            self._next_list = self._monotonic() + LIST_RETRY_SECONDS
            return
        try:
            self.reconcile(listing["agents"])
        except (WorkerError, OSError) as error:
            self._reconcile_failures += 1
            delay = min(
                LIST_RETRY_SECONDS * 2 ** (self._reconcile_failures - 1),
                RECONCILE_RETRY_MAX_SECONDS,
            )
            logger.error(
                "Agents version %s was not fully applied; retrying in %s seconds: %s",
                listing["agents_version"],
                delay,
                error,
            )
            self._next_list = self._monotonic() + delay
            return
        self._reconcile_failures = 0
        self._need_list = False
        self._agents_version = listing["agents_version"]

    def _send_heartbeat(self) -> None:
        interval = RETIRED_HEARTBEAT_SECONDS if self._retired else self._heartbeat_every
        try:
            response = self._client.heartbeat(self.heartbeat_body())
        except MachineRetired:
            self._retire()
            return
        except CoreUnavailable as error:
            logger.warning("Heartbeat failed; retrying: %s", error)
            self._next_heartbeat = self._monotonic() + interval
            return
        every = response.get("heartbeat_every_s", DEFAULT_HEARTBEAT_SECONDS)
        if (
            isinstance(every, bool)
            or not isinstance(every, int)
            or not 0 < every <= 3600
        ):
            logger.warning("Heartbeat interval from Switch is invalid; using default.")
            every = DEFAULT_HEARTBEAT_SECONDS
        self._heartbeat_every = every
        if self._retired:
            logger.warning("Switch accepts this machine again; resuming agents.")
            self._retired = False
            self._need_list = True
            self._next_list = 0.0
        if response["agents_version"] != self._agents_version:
            self._need_list = True
        self._next_heartbeat = self._monotonic() + self._heartbeat_every

    def _retire(self) -> None:
        if not self._retired:
            logger.warning("Switch retired this machine; stopping all agents.")
            self._systemd.stop_all()
            self._touched.update(held.agent_id for held in self._held)
            self._retired = True
        self._next_heartbeat = self._monotonic() + RETIRED_HEARTBEAT_SECONDS

    def reconcile(self, entries: list[Any]) -> None:
        failures: list[str] = []
        remove_runtime_orphans(self._paths.agents_runtime)
        counts: dict[str, int] = {}
        for entry in entries:
            if isinstance(entry, dict) and isinstance(entry.get("agent_id"), str):
                counts[entry["agent_id"]] = counts.get(entry["agent_id"], 0) + 1
        held: list[HeldAgent] = []
        for entry in entries:
            if (
                not isinstance(entry, dict)
                or not isinstance(entry.get("launch_id"), str)
                or not isinstance(entry.get("agent_id"), str)
                or isinstance(entry.get("revision"), bool)
                or not isinstance(entry.get("revision"), int)
            ):
                logger.error(
                    "Ignoring an agent entry without launch, agent and revision."
                )
                continue
            agent_id = entry["agent_id"]
            try:
                if counts[agent_id] > 1:
                    raise WorkerError("The agent is listed more than once.")
                if agent_id in self._ownership_blocked:
                    logger.error(
                        "Agent %s has invalid saved ownership; it stays stopped.",
                        agent_id,
                    )
                    held.append(
                        HeldAgent(
                            entry["launch_id"],
                            agent_id,
                            entry["revision"],
                            None,
                            Failure("failed", OWNERSHIP_INVALID),
                        )
                    )
                    self._disable(agent_id, failures)
                    continue
                unavailable = _unavailable_code(entry)
                if unavailable is not None:
                    logger.warning(
                        "Agent %s is unavailable (%s); stopping it and keeping its data.",
                        agent_id,
                        unavailable,
                    )
                    held.append(
                        HeldAgent(
                            entry["launch_id"],
                            agent_id,
                            entry["revision"],
                            "stopped",
                            Failure("stopped", INVALID_CONFIG),
                        )
                    )
                    self._disable(agent_id, failures)
                    continue
                plan = build_agent_plan(entry, self._runtime, self._paths)
            except WorkerError as error:
                logger.error(
                    "Agent %s has an invalid configuration: %s", agent_id, error
                )
                held.append(
                    HeldAgent(
                        entry["launch_id"],
                        agent_id,
                        entry["revision"],
                        None,
                        Failure("failed", INVALID_CONFIG),
                    )
                )
                self._disable(agent_id, failures)
                continue
            failure: Failure | None = None
            try:
                self._apply(plan)
            except (WorkerError, OSError) as error:
                logger.error("Agent %s could not be set up: %s", agent_id, error)
                failure = Failure("failed", SETUP_FAILED)
                failures.append(agent_id)
            held.append(
                HeldAgent(
                    plan.launch_id,
                    plan.agent_id,
                    plan.revision,
                    plan.desired_state,
                    failure,
                )
            )
        self._held = held
        listed = {agent.agent_id for agent in held} | set(counts)
        for agent_id in sorted(self._agents_on_disk() - listed):
            try:
                self.remove_agent(agent_id)
            except (WorkerError, OSError) as error:
                logger.error("Agent %s removal failed; will retry: %s", agent_id, error)
                failures.append(agent_id)
        self._prune_mirrors()
        if self._pending_prunes:
            failures.append("worktree prune")
        for agent_id in set(self._states) - {agent.agent_id for agent in held}:
            del self._states[agent_id]
        if failures:
            raise ReconcileIncomplete(
                "Work is left to retry for: " + ", ".join(failures) + "."
            )

    def _disable(self, agent_id: str, failures: list[str]) -> None:
        if not _is_agent_id(agent_id):
            return
        try:
            self._stop(agent_id, wait=False)
            target = self._paths.agents_runtime / agent_id
            if target.exists() or target.is_symlink():
                _remove_secret_tree(target)
            self._paths.pending_install(agent_id).unlink(missing_ok=True)
        except (WorkerError, OSError) as error:
            logger.error("Agent %s could not be stopped: %s", agent_id, error)
            failures.append(agent_id)

    def _stop(self, agent_id: str, *, wait: bool) -> None:
        self._systemd.stop(agent_id, wait=wait)
        self._systemd.reset_failed(agent_id)
        self._touched.add(agent_id)

    def _prune_mirrors(self) -> None:
        for mirror in sorted(self._pending_prunes):
            if mirror.is_dir() and not mirror.is_symlink():
                try:
                    self._git.run(mirror, ["worktree", "prune"])
                except WorkerError as error:
                    logger.error("Worktree prune failed; will retry: %s", error)
                    continue
            self._pending_prunes.discard(mirror)

    def _apply(self, plan: AgentPlan) -> None:
        agent_id = plan.agent_id
        for leaf in ("home", "tmp"):
            _agent_directories(
                self._paths.agents, (agent_id, leaf), self._uid, self._gid
            )
        _agent_directories(
            self._paths.worktrees,
            plan.workspace.relative_to(self._paths.worktrees).parts,
            self._uid,
            self._gid,
        )
        if self._installed_revision(agent_id) != plan.revision:
            pending = self._paths.pending_install(agent_id)
            _write_root_json(pending, {"revision": plan.revision})
            install_runtime_files(
                self._paths.agents_runtime,
                agent_id,
                {
                    "switch.json": json.dumps(
                        plan.switch_credentials, separators=(",", ":")
                    ),
                    "deployment.json": json.dumps(
                        plan.deployment, separators=(",", ":")
                    ),
                    "worker-capability": plan.worker_capability,
                    "env": agent_environment(
                        self._runtime,
                        self._identity,
                        self._machine_id,
                        self._paths,
                        agent_id,
                    ),
                },
                self._gid,
            )
            if plan.desired_state == "running":
                self._systemd.reset_failed(agent_id)
                self._systemd.restart(agent_id)
                self._touched.add(agent_id)
            else:
                self._stop(agent_id, wait=False)
            self._reset_oom_kills(agent_id, plan.revision)
            pending.unlink()
            return
        active = self._systemd.show(agent_id)["ActiveState"]
        if plan.desired_state == "running" and active == "inactive":
            self._systemd.start(agent_id)
            self._touched.add(agent_id)
        elif plan.desired_state == "stopped" and active in {
            "active",
            "activating",
            "reloading",
            "failed",
        }:
            self._stop(agent_id, wait=False)

    def _reset_oom_kills(self, agent_id: str, revision: int) -> None:
        record = self._records.get(agent_id)
        if record is not None and record.get("revision") != revision:
            self._records[agent_id] = {
                "oomKills": 0,
                "lastOomExit": record["lastOomExit"],
                "revision": revision,
            }
            self._save_records()

    def _installed_revision(self, agent_id: str) -> int | None:
        pending = self._paths.pending_install(agent_id)
        if pending.exists() or pending.is_symlink():
            return None
        try:
            value = _read_json_nofollow(
                self._paths.agents_runtime / agent_id / "deployment.json",
                maximum=MAX_SECRET_BYTES,
            )
        except (OSError, WorkerError):
            return None
        revision = value.get("revision") if isinstance(value, dict) else None
        return revision if isinstance(revision, int) else None

    def _agents_on_disk(self) -> set[str]:
        found: set[str] = set()
        for parent in (
            self._paths.agents_runtime,
            self._paths.agents,
            self._paths.worktrees,
        ):
            if not parent.is_dir():
                continue
            for child in parent.iterdir():
                if parent == self._paths.agents_runtime and child.name.startswith("."):
                    continue
                if not _is_agent_id(child.name):
                    logger.warning(
                        "Ignoring unexpected entry %s in %s.", child.name, parent
                    )
                    continue
                found.add(child.name)
        return found

    def remove_agent(self, agent_id: str) -> None:
        agent_id = _agent_id(agent_id)
        self._stop(agent_id, wait=True)
        runtime_files = self._paths.agents_runtime / agent_id
        if runtime_files.exists() or runtime_files.is_symlink():
            _remove_secret_tree(runtime_files)
        self._paths.pending_install(agent_id).unlink(missing_ok=True)
        worktree_root = self._paths.worktrees / agent_id
        mirrors: list[Path] = []
        if worktree_root.is_dir() and not worktree_root.is_symlink():
            for owner in sorted(worktree_root.iterdir()):
                if owner.is_symlink() or not owner.is_dir():
                    continue
                for repository in sorted(owner.iterdir()):
                    if repository.is_symlink() or not repository.is_dir():
                        continue
                    mirror = self._paths.repos / owner.name / f"{repository.name}.git"
                    if mirror.is_symlink() or not mirror.is_dir():
                        continue
                    try:
                        self._git.run(
                            mirror, ["worktree", "remove", "--force", str(repository)]
                        )
                    except GitAbandoned:
                        raise
                    except WorkerError as error:
                        logger.warning("Agent %s: %s", agent_id, error)
                    mirrors.append(mirror)
        _remove_tree(self._paths.agents / agent_id)
        _remove_tree(worktree_root)
        self._pending_prunes.update(mirrors)
        if self._records.pop(agent_id, None) is not None:
            self._save_records()
        self._states.pop(agent_id, None)
        self._touched.discard(agent_id)
        self._obsolete_exits.pop(agent_id, None)
        self._ownership_blocked.discard(agent_id)
        logger.warning("Removed agent %s from this machine.", agent_id)

    def _load_records(self) -> dict[str, dict[str, Any]]:
        path = self._paths.agent_records
        if not path.exists() and not path.is_symlink():
            return {}
        try:
            details = path.lstat()
            if (
                not stat.S_ISREG(details.st_mode)
                or details.st_uid != ROOT_UID
                or details.st_mode & 0o077
            ):
                raise ValueError()
            value = _strict(
                _read_json_nofollow(path, maximum=MAX_SECRET_BYTES),
                {"version", "agents"},
                set(),
                "agent records",
            )
            if value["version"] != 1 or not isinstance(value["agents"], dict):
                raise ValueError()
            for agent_id, record in value["agents"].items():
                _agent_id(agent_id)
                record = _strict(
                    record, {"oomKills", "lastOomExit"}, {"revision"}, "record"
                )
                if isinstance(record["oomKills"], bool) or not isinstance(
                    record["oomKills"], int
                ):
                    raise ValueError()
                if "revision" in record:
                    _positive_integer(record["revision"], "record revision")
            return value["agents"]
        except (OSError, ValueError, WorkerError):
            raise WorkerError("Agent records on the data volume are invalid.") from None

    def _save_records(self) -> None:
        _write_root_json(
            self._paths.agent_records, {"version": 1, "agents": self._records}
        )

    def _observe(self) -> bool:
        changed = False
        now = self._clock().astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        for held in self._held:
            observed: tuple[str, int, dict[str, Any] | None]
            if held.failure is not None:
                observed = (
                    held.failure.process_state,
                    0,
                    {"code": None, "signal": None, "result": held.failure.result},
                )
            else:
                try:
                    observed = self._unit_state(held)
                except (WorkerError, ValueError) as error:
                    logger.warning(
                        "Agent %s state is unavailable: %s", held.agent_id, error
                    )
                    continue
            process_state, restarts, exit_value = observed
            previous = self._states.get(held.agent_id)
            since = now
            if previous is not None and previous.process_state == process_state:
                since = previous.since
            else:
                changed = True
            self._states[held.agent_id] = ObservedState(
                process_state, restarts, exit_value, since
            )
        return changed

    def _unit_state(self, held: HeldAgent) -> tuple[str, int, dict[str, Any] | None]:
        agent_id = held.agent_id
        properties = self._systemd.show(agent_id)
        active = properties["ActiveState"]
        sub = properties["SubState"]
        result = properties["Result"]
        restarts = int(properties["NRestarts"] or 0)
        code = int(properties["ExecMainCode"] or 0)
        status = int(properties["ExecMainStatus"] or 0)
        exited_at = properties["ExecMainExitTimestampMonotonic"] or "0"
        ran = exited_at != "0"
        if result == "oom-kill" and ran:
            key = f"{self._identity.boot_id}:{exited_at}"
            record = self._records.get(agent_id, {"oomKills": 0, "lastOomExit": ""})
            if record["lastOomExit"] != key:
                self._records[agent_id] = {
                    "oomKills": record["oomKills"] + 1,
                    "lastOomExit": key,
                    "revision": held.revision,
                }
                self._save_records()
        if code == 1 and status == OBSOLETE_EXIT_CODE and ran:
            if self._obsolete_exits.get(agent_id) != exited_at:
                self._obsolete_exits[agent_id] = exited_at
                logger.warning(
                    "Agent %s reported an obsolete worker; refetching.", agent_id
                )
                self._need_list = True
                self._next_list = 0.0
        if active in {"active", "reloading"}:
            process_state = "running"
        elif active == "activating":
            process_state = (
                "restarting" if sub.startswith("auto-restart") else "starting"
            )
        elif active == "deactivating":
            process_state = "stopping"
        elif active == "failed":
            process_state = "crashed" if result == "start-limit-hit" else "failed"
        elif active == "inactive":
            process_state = (
                "stopped"
                if held.desired_state == "stopped" or agent_id in self._touched or ran
                else "pending"
            )
        else:
            raise WorkerError(f"unknown unit state {active}/{sub}")
        exit_value: dict[str, Any] | None = None
        if process_state != "running":
            if code == 1:
                exit_value = {"code": status, "signal": None, "result": result}
            elif code in {2, 3}:
                exit_value = {"code": None, "signal": status, "result": result}
        return process_state, restarts, exit_value

    def heartbeat_body(self) -> dict[str, Any]:
        disk = self._statvfs(str(self._paths.data))
        total_memory, available_memory = read_meminfo(self._meminfo)
        agents = []
        for held in self._held:
            observed = self._states.get(held.agent_id)
            if observed is None:
                continue
            agents.append(
                {
                    "launch_id": held.launch_id,
                    "agent_id": held.agent_id,
                    "revision": held.revision,
                    "process_state": observed.process_state,
                    "restarts": observed.restarts,
                    "oom_kills": self._records.get(held.agent_id, {}).get(
                        "oomKills", 0
                    ),
                    "exit": observed.exit,
                    "since": observed.since,
                }
            )
        return {
            "boot_id": self._identity.boot_id,
            "instance_id": self._identity.instance_id,
            "supervisor_version": SUPERVISOR_VERSION,
            "runtime_fingerprint": self._fingerprint,
            "disk": {
                "path": str(self._paths.data),
                "total_bytes": disk.f_blocks * disk.f_frsize,
                "used_bytes": (disk.f_blocks - disk.f_bfree) * disk.f_frsize,
                "available_bytes": disk.f_bavail * disk.f_frsize,
            },
            "memory": {
                "total_bytes": total_memory,
                "available_bytes": available_memory,
            },
            "agents": agents,
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config", default="/etc/switch-hosted/assignment.json", type=Path
    )
    parser.add_argument(
        "--runtime-config", default="/etc/switch-hosted/runtime.json", type=Path
    )
    arguments = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if os.geteuid() != 0:
        raise WorkerError("Trusted worker supervisor must run as root.")
    root_lock = acquire_root_lock()
    try:
        config = load_worker_config(arguments.config, arguments.runtime_config)
        runtime_fingerprint = "sha256:" + verify_pinned_runtime(config)
        uid, gid = resolve_agent_account(
            config.runtime.agent_user, config.runtime.agent_group
        )
        identity = MachineIdentity(
            ImdsV2().instance_id(), _read_boot_id(), config.generation
        )
        try:
            bundle = parse_bundle(
                SecretsManager(config.secret_region).read(config.secret_id), config
            )
        except ObsoleteBundle:
            print("obsolete bundle", file=sys.stderr, flush=True)
            return OBSOLETE_EXIT_CODE
        commands = Commands()
        paths = Paths(DATA_MOUNT, RUNTIME_DIRECTORY)
        prepare_runtime_directory(commands, paths, gid)
        write_bundle(paths, bundle)
        storage, _formatted = prepare_storage(commands, config)
        ownership_blocked = reconcile_marker(
            identity,
            config,
            storage.filesystem_uuid or "",
            runtime_fingerprint,
            paths,
        )
        prepare_layout(paths, uid, gid)
        Supervisor(
            runtime=config.runtime,
            identity=identity,
            machine_id=bundle.machine_id,
            runtime_fingerprint=runtime_fingerprint,
            paths=paths,
            uid=uid,
            gid=gid,
            client=CoreClient(bundle, identity, default_opener()),
            systemd=Systemd(commands),
            git=GitRunner(setpriv_prefix(uid, gid), FLOCK, GIT),
            clock=lambda: datetime.now(UTC),
            monotonic=time.monotonic,
            sleep=time.sleep,
            statvfs=os.statvfs,
            meminfo=MEMINFO_PATH,
            ownership_blocked=ownership_blocked,
        ).run()
        return 0
    finally:
        root_lock.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except WorkerError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
