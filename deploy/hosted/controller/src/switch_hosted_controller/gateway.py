from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from time import monotonic
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

from .config import ConfigError, ControllerConfig
from .model import DesiredState, ObservedState
from .store import AgentNotFoundError, AgentStore

logger = logging.getLogger(__name__)

WORKER_CAPABILITY_PATH = "/run/switch-hosted/secrets/worker-capability"
WORKER_CAPABILITY_RE = re.compile(r"^[\x21-\x7e]{16,4096}$")


def worker_attach_fields(prepared: dict) -> tuple[dict[str, str], dict[str, str]]:
    """The deployment and bundle fields a worker needs to attach to Switch.

    The capability is the one Core's `prepare` issued for this launch revision;
    the worker writes it to `WORKER_CAPABILITY_PATH` and sends it as
    `X-Switch-Worker-Capability`. The boot and instance ids it sends beside it
    are read on the machine itself, because a bundle outlives a boot.
    """
    capability = prepared.get("worker_capability")
    if not isinstance(capability, str) or not WORKER_CAPABILITY_RE.fullmatch(capability):
        raise ConfigError("Cloud gateway returned no valid worker capability.")
    return {"workerCapabilityPath": WORKER_CAPABILITY_PATH}, {"workerCapability": capability}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise GatewayError(code)


class GatewayError(RuntimeError):
    def __init__(self, status: int, detail: str | None = None):
        self.status = status
        self.detail = detail
        super().__init__(f"Cloud gateway request failed with status {status}.")


@dataclass(frozen=True)
class GatewayConfig:
    origin: str
    token: str = field(repr=False)
    instance_type: str

    @classmethod
    def load(cls, path: Path) -> GatewayConfig:
        raw = json.loads(path.read_text())
        if not isinstance(raw, dict) or set(raw) != {
            "origin",
            "token",
            "instance_type",
        }:
            raise ConfigError("Cloud gateway configuration keys are invalid.")
        if not all(isinstance(value, str) and value for value in raw.values()):
            raise ConfigError("Cloud gateway configuration values must be strings.")
        url = urlsplit(raw["origin"])
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.path
            or url.query
            or url.fragment
        ):
            raise ConfigError("Cloud gateway origin must be an HTTPS origin.")
        if len(raw["token"]) < 32:
            raise ConfigError("Cloud gateway credential is too short.")
        return cls(**raw)


class Gateway:
    def __init__(
        self,
        settings: GatewayConfig,
        config: ControllerConfig,
        store: AgentStore,
        secrets_client: Any,
    ):
        if settings.instance_type not in config.allowed_instance_types:
            raise ConfigError("Cloud gateway instance type is not allowed.")
        self.settings = settings
        self.config = config
        self.store = store
        self.secrets = secrets_client
        self.prepare_failures: dict[str, float] = {}
        for agent in store.list():
            assignment = config.assignment(agent.agent_id)
            if (
                assignment.assignment_secret_arn != agent.assignment_secret_arn
                or assignment.instance_profile_arn != agent.instance_profile_arn
            ):
                raise ConfigError(
                    "An existing worker assignment cannot change its secret or IAM identity."
                )

    def request(
        self, path: str, body: dict | None = None, *, prefix: str = "/gateway/hosted-controller"
    ) -> Any:
        request = Request(
            self.settings.origin + prefix + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + self.settings.token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with build_opener(NoRedirect()).open(request, timeout=120) as response:
                return json.load(response)
        except HTTPError as error:
            detail = None
            if error.code == 422:
                try:
                    value = json.loads(error.read(4096)).get("detail")
                    if isinstance(value, str):
                        detail = value[:512]
                except (ValueError, AttributeError):
                    logger.warning("Gateway returned an invalid validation response.")
            raise GatewayError(error.code, detail) from None
        except (URLError, TimeoutError):
            raise GatewayError(503) from None

    def accept_launches(self) -> None:
        jobs = self.request("")
        active_ids = {job["request_id"] for job in jobs}
        self.prepare_failures = {
            key: started for key, started in self.prepare_failures.items() if key in active_ids
        }
        for job in jobs:
            try:
                self.accept_launch(job)
                self.prepare_failures.pop(job["request_id"], None)
            except Exception as error:
                logger.error(
                    "Cloud launch preparation failed for %s: %s",
                    job.get("request_id"),
                    type(error).__name__,
                )
                if job["desired_state"] != "running":
                    continue
                terminal = isinstance(error, ConfigError) or (
                    isinstance(error, GatewayError) and error.status == 422
                )
                first_failure = self.prepare_failures.setdefault(job["request_id"], monotonic())
                if not terminal and monotonic() - first_failure < 300:
                    continue
                try:
                    self.store.set_desired(job["agent_id"], DesiredState.STOPPED)
                except Exception as stop_error:
                    logger.error(
                        "Could not stop failed launch %s: %s",
                        job.get("request_id"),
                        type(stop_error).__name__,
                    )
                try:
                    self.request(
                        f"/{UUID(job['request_id'])}/observation",
                        {
                            "state": "error",
                            "revision": job["revision"],
                            "error": error.detail
                            if isinstance(error, GatewayError)
                            and error.status == 422
                            and error.detail
                            else "Cloud agent setup failed. Check the agent name, provider connection and repository write access, then retry. If it still fails, contact your administrator.",
                        },
                    )
                except Exception as report_error:
                    logger.error(
                        "Could not report failed launch %s: %s",
                        job.get("request_id"),
                        type(report_error).__name__,
                    )

    def accept_launch(self, job: dict) -> None:
        request_id = str(UUID(job["request_id"]))
        agent_id = job["agent_id"]
        assignment = self.config.assignment(agent_id)
        try:
            agent = self.store.get(agent_id)
        except AgentNotFoundError:
            if job["state"] == "error":
                return
            agent = self.store.reserve_create(
                agent_id=agent_id,
                instance_type=self.settings.instance_type,
                image_id=self.config.image_id,
                assignment_secret_arn=assignment.assignment_secret_arn,
                instance_profile_arn=assignment.instance_profile_arn,
                max_agents=self.config.max_agents,
            )
        desired = job["desired_state"]
        if desired in {"stopped", "restart", "deleted"}:
            if (
                desired == "deleted"
                and agent.desired_state == DesiredState.STOPPED
                and agent.observed_state == ObservedState.STOPPED
            ):
                self.store.set_desired(agent_id, DesiredState.DELETED)
            elif agent.desired_state != DesiredState.DELETED:
                self.store.set_desired(agent_id, DesiredState.STOPPED)
            return
        if job["state"] == "error":
            self.store.set_desired(agent_id, DesiredState.STOPPED)
            return
        if agent.desired_state == DesiredState.STOPPED:
            agent = self.store.set_desired(agent_id, DesiredState.RUNNING)
        if agent.volume_id is None or agent.instance_launch_issued:
            return
        versions = self.secrets.describe_secret(SecretId=assignment.assignment_secret_arn).get(
            "VersionIdsToStages", {}
        )
        if request_id not in versions:
            prepared = self.request(f"/{request_id}/prepare", {})
            if prepared["agent_id"] != agent_id:
                raise ConfigError("Cloud gateway returned a different worker identity.")
            bundle = self.bundle(prepared, agent.volume_id)
            self.secrets.put_secret_value(
                SecretId=assignment.assignment_secret_arn,
                ClientRequestToken=request_id,
                SecretString=json.dumps(bundle, separators=(",", ":")),
            )

    def report_observations(self) -> None:
        for job in self.request(""):
            if job["state"] == "error":
                continue
            try:
                agent = self.store.get(job["agent_id"])
            except AgentNotFoundError:
                continue
            state = "provisioning"
            if agent.observed_state == ObservedState.RUNNING:
                state = "running"
            elif agent.observed_state == ObservedState.NEEDS_ATTENTION:
                state = "error"
            elif agent.observed_state in {
                ObservedState.STOPPING,
                ObservedState.STOPPED,
                ObservedState.DELETING,
                ObservedState.DELETED,
            }:
                state = agent.observed_state.value
            if state == "error":
                logger.error(
                    "Cloud worker %s needs repair: %s", job["request_id"], agent.last_error
                )
            try:
                self.request(
                    f"/{UUID(job['request_id'])}/observation",
                    {
                        "state": state,
                        "revision": job["revision"],
                        "error": "The cloud worker needs repair. Contact your server administrator."
                        if state == "error"
                        else None,
                        "error_code": "worker_needs_attention" if state == "error" else None,
                    },
                )
            except Exception as error:
                logger.error(
                    "Could not report launch %s: %s", job["request_id"], type(error).__name__
                )

    def bundle(self, prepared: dict, volume_id: str) -> dict:
        attach_deployment, attach_bundle = worker_attach_fields(prepared)
        spec = prepared["spec"]
        provider = spec.get("provider", "claude")
        binary = {
            "claude": "/opt/switch/claude/bin/claude",
            "codex": "/opt/switch/providers/codex",
            "cursor": "/opt/switch/providers/cursor",
            "opencode": "/opt/switch/providers/opencode",
            "antigravity": "/opt/switch/providers/antigravity-acp",
        }[provider]
        deployment = {
            "version": 1,
            "revision": prepared["revision"],
            "session": {
                "sessionId": "watcher-" + prepared["agent_id"],
                "agentId": prepared["agent_id"],
            },
            "provider": {
                "kind": provider,
                "credential": {
                    "kind": prepared["provider_kind"],
                    "path": "/run/switch-hosted/secrets/provider",
                    "refresh": True,
                },
                "binaryPath": binary,
                "context": "Use the Switch tools to read room context and post replies to the room.\n"
                + spec["instructions"],
                **(
                    {"definition": {"name": spec["name"], "content": spec["definition"]}}
                    if provider == "claude"
                    else {}
                ),
            },
            "github": {
                "credentialPath": "/run/switch-hosted/secrets/github",
                "repository": prepared["repository"],
                "refresh": True,
            },
            "workspacePath": "/data/workspace",
            "watch": spec["auto_session"],
            "runtimeMode": "full-access" if spec["auto_approve"] else "approval-required",
            "switchCredentialsPath": "/run/switch-hosted/secrets/switch.json",
            **attach_deployment,
        }
        model = spec["definition_attributes"].get("model")
        if model:
            deployment["provider"]["model"] = {"id": model}
        return {
            "version": 1,
            "assignment": {
                "installationId": self.config.installation_id,
                "agentId": prepared["agent_id"],
                "generation": 1,
                "dataVolumeId": volume_id,
            },
            "deployment": deployment,
            "switchCredentials": prepared["switch_credentials"],
            "githubCredential": prepared["github_credential"],
            **attach_bundle,
        }
