from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

from .config import ConfigError, ControllerConfig
from .model import DesiredState, ObservedState
from .store import AgentNotFoundError, AgentStore

logger = logging.getLogger(__name__)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise GatewayError(code)


class GatewayError(RuntimeError):
    def __init__(self, status: int):
        self.status = status
        super().__init__(f"Cloud gateway request failed with status {status}.")


@dataclass(frozen=True)
class GatewayConfig:
    origin: str
    token: str = field(repr=False)
    instance_type: str
    mcp_runtime: str

    @classmethod
    def load(cls, path: Path) -> GatewayConfig:
        raw = json.loads(path.read_text())
        if not isinstance(raw, dict) or set(raw) != {
            "origin",
            "token",
            "instance_type",
            "mcp_runtime",
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

    def request(self, path: str, body: dict | None = None) -> Any:
        request = Request(
            self.settings.origin + "/gateway/hosted-controller" + path,
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
            raise GatewayError(error.code) from None
        except (URLError, TimeoutError):
            raise GatewayError(503) from None

    def accept_launches(self) -> None:
        for job in self.request(""):
            request_id = str(UUID(job["request_id"]))
            agent_id = job["agent_id"]
            assignment = self.config.assignment(agent_id)
            try:
                agent = self.store.get(agent_id)
            except AgentNotFoundError:
                if job["state"] == "error":
                    continue
                agent = self.store.reserve_create(
                    agent_id=agent_id,
                    instance_type=self.settings.instance_type,
                    image_id=self.config.image_id,
                    assignment_secret_arn=assignment.assignment_secret_arn,
                    instance_profile_arn=assignment.instance_profile_arn,
                    max_agents=self.config.max_agents,
                )
            if job["state"] == "error":
                self.store.set_desired(agent_id, DesiredState.STOPPED)
                continue
            if agent.volume_id is None or agent.instance_launch_issued:
                continue
            try:
                versions = self.secrets.describe_secret(
                    SecretId=assignment.assignment_secret_arn
                ).get("VersionIdsToStages", {})
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
            except GatewayError as error:
                logger.error(
                    "Cloud preparation failed for request %s: HTTP %s", request_id, error.status
                )
                if error.status == 422:
                    self.store.set_desired(agent_id, DesiredState.STOPPED)
                    self.request(f"/{request_id}/observation", {"state": "error"})
                else:
                    raise

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
            self.request(f"/{UUID(job['request_id'])}/observation", {"state": state})

    def bundle(self, prepared: dict, volume_id: str) -> dict:
        spec = prepared["spec"]
        deployment = {
            "version": 1,
            "session": {
                "sessionId": "watcher-" + prepared["agent_id"],
                "agentId": prepared["agent_id"],
            },
            "provider": {
                "kind": "claude",
                "credential": {
                    "kind": prepared["provider_kind"],
                    "path": "/run/switch-hosted/secrets/provider",
                },
                "binaryPath": "/opt/switch/claude/bin/claude",
                "context": "Use the Switch tools to read room context and post replies to the room.\n"
                + spec["instructions"],
                "definition": {"name": spec["name"], "content": spec["definition"]},
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
            "mcpRuntime": self.settings.mcp_runtime,
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
            "providerCredential": prepared["provider_credential"],
            "switchCredentials": prepared["switch_credentials"],
            "githubCredential": prepared["github_credential"],
        }
