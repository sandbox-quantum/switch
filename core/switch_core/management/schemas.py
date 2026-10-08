"""Request bodies and wire shapes for the management routes.

Field names follow `docs/design/controller-contract-v1.md` wherever v1
implements the same message. Bodies a controller sends ignore unknown fields
(the contract's forward-compatibility rule), and a status report keeps them,
since it is stored and shown as sent. Bodies a person's client sends through
the gateway refuse unknown fields, so a misspelt key fails rather than being
dropped.

The JSON fixtures under `core/tests/switch_core/fixtures/agent_controllers/`
are the recorded form of these shapes; the controller's own tests parse the
same files.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from switch_core.db.models import (
    Agent,
    AgentController,
    AgentControllerOperation,
    SealedProviderLogin,
)
from switch_core.db.models import AgentDefinition as AgentDefinitionRow
from switch_core.management.advanced_config import validate_advanced_config
from switch_core.management.process_lease import ProcessLeases
from switch_core.management.sealed_logins import PublicKey, key_id

Provider = Literal["claude", "codex", "opencode", "antigravity", "cursor"]
ControllerKind = Literal["console", "daemon", "ec2"]
DesiredState = Literal["running", "stopped"]
Isolation = Literal["shared", "isolated"]

# The known-agent spec each provider registers through.
PROVIDER_KNOWN_AGENT_TYPES: dict[str, str] = {
    "claude": "claude-code",
    "codex": "codex",
    "opencode": "opencode",
    "antigravity": "antigravity",
    "cursor": "cursor",
}

MAX_INSTRUCTIONS_BYTES = 32 * 1024
MAX_CONTROLLER_NAME_CHARS = 200
MAX_CONTROLLER_DESCRIPTION_CHARS = 500
MAX_STATUS_BYTES = 64 * 1024

# Process states that must carry a reason code.
FAILED_PROCESS_STATES = frozenset({"crashed", "failed"})


def wire_time(value: datetime) -> str:
    """RFC 3339 in UTC with a `Z`, the contract's time format."""
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def wire_time_or_none(value: datetime | None) -> str | None:
    return None if value is None else wire_time(value)


class _ControllerBody(BaseModel):
    model_config = ConfigDict(extra="ignore")


class _StatusBody(BaseModel):
    model_config = ConfigDict(extra="allow")


class _GatewayBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Shared pieces ─────────────────────────────────────────────────────────────


class Platform(_StatusBody):
    os: str
    arch: str
    os_version: str


class DefinitionV1(_GatewayBody):
    """The v1 agent definition, as a person's client submits it."""

    provider: Provider
    model: str | None = None
    # The provider's "Advanced configuration", checked against its schema in
    # `advanced_config`.
    advanced_config: dict[str, Any] = Field(default_factory=dict)
    instructions: str = ""
    auto_approve: bool = False
    directory: str | None = None
    # `shared`: the agent host runs inside its machine's controller.
    # `isolated`: it runs as a process of its own (a systemd unit on a cloud
    # machine, which runs every agent isolated).
    isolation: Isolation = "shared"

    @field_validator("instructions")
    @classmethod
    def _instructions_fit(cls, value: str) -> str:
        if len(value.encode()) > MAX_INSTRUCTIONS_BYTES:
            raise ValueError(
                f"instructions must be at most {MAX_INSTRUCTIONS_BYTES} bytes"
            )
        return value

    @model_validator(mode="after")
    def _advanced_config_fits_the_provider(self) -> DefinitionV1:
        validate_advanced_config(self.provider, self.advanced_config)
        return self


# ── Controller-facing requests ────────────────────────────────────────────────


class EnrollmentCodeProof(_ControllerBody):
    kind: Literal["enrollment_code"]
    code: str


def _controller_name(value: str) -> str:
    """A machine's name, trimmed, and refused when nothing is left."""
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("a machine's name must not be blank")
    return trimmed


def _controller_description(value: str | None) -> str | None:
    """A machine's description, trimmed; blank is no description."""
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


class ControllerDescription(_ControllerBody):
    """What a controller says about itself when it enrolls.

    `description` is the owner's note on what the machine is for, given at
    enrollment (`--description`) and editable afterwards; absent is none."""

    kind: ControllerKind
    name: str = Field(min_length=1, max_length=MAX_CONTROLLER_NAME_CHARS)
    description: str | None = Field(
        default=None, max_length=MAX_CONTROLLER_DESCRIPTION_CHARS
    )
    platform: Platform
    version: str

    @field_validator("name")
    @classmethod
    def _name_is_not_blank(cls, value: str) -> str:
        return _controller_name(value)

    @field_validator("description")
    @classmethod
    def _blank_description_is_none(cls, value: str | None) -> str | None:
        return _controller_description(value)


class EnrollRequest(_ControllerBody):
    proof: EnrollmentCodeProof
    controller: ControllerDescription
    public_key: PublicKey | None = None


class TokenRequest(_ControllerBody):
    credential: str


class StatusControllerInfo(_StatusBody):
    version: str
    protocol: int
    assignment_revision: int


class MachineStatus(_StatusBody):
    platform: Platform
    disk_free_bytes: int
    disk_total_bytes: int
    mem_free_bytes: int
    mem_total_bytes: int
    sessions_running: int
    sessions_max: int
    # The absolute directory the controller makes agents' workspaces in. A
    # controller older than this field does not send it.
    workspaces_dir: str | None = None


class ProviderStatus(_StatusBody):
    provider: str
    installed: bool
    version: str | None
    auth: str
    auth_source: str | None
    checked_at: str
    reason: str | None = None


class ToolStatus(_StatusBody):
    tool: str
    state: str
    reason: str | None = None


class AgentSessions(_StatusBody):
    active: int
    ids: list[str]


class AgentStatus(_StatusBody):
    agent_id: str
    applied_revision: int | None
    process: str
    attached: bool
    sessions: AgentSessions
    restarts_10m: int
    oom_kills: int
    # The absolute working directory the agent runs in; null before the
    # controller resolved one, absent from a controller older than this field.
    directory: str | None = None
    since: str
    reason: str | None = None
    detail: str | None = None

    @model_validator(mode="after")
    def _failure_has_a_reason(self) -> AgentStatus:
        if self.process in FAILED_PROCESS_STATES and not self.reason:
            raise ValueError(f"an agent whose process is {self.process} needs a reason")
        return self


class StatusReport(_StatusBody):
    seq: int = Field(ge=0)
    observed_at: str
    controller: StatusControllerInfo
    machine: MachineStatus
    providers: list[ProviderStatus]
    tools: list[ToolStatus]
    agents: list[AgentStatus]


class ProgressRequest(_ControllerBody):
    message: str


class OperationFailure(_ControllerBody):
    code: str
    message: str


class OperationResultRequest(_ControllerBody):
    outcome: Literal["succeeded", "failed"]
    output: dict[str, Any] | None = None
    error: OperationFailure | None = None

    @model_validator(mode="after")
    def _outcome_matches(self) -> OperationResultRequest:
        if self.outcome == "failed" and self.error is None:
            raise ValueError("a failed result needs an error")
        if self.outcome == "succeeded" and self.error is not None:
            raise ValueError("a succeeded result carries no error")
        return self

    def stored(self) -> dict[str, Any]:
        if self.outcome == "failed":
            assert self.error is not None
            return {"outcome": "failed", "error": self.error.model_dump()}
        result: dict[str, Any] = {"outcome": "succeeded"}
        if self.output is not None:
            result["output"] = self.output
        return result


class _ControllerStreamBody(_ControllerBody):
    """The connection open and beat. Unknown fields are ignored as on every
    controller body, except `placements`: Core no longer tracks where a
    controller's sessions are, and a controller still reporting them is
    refused so the mismatch is seen rather than silently dropped."""

    @model_validator(mode="before")
    @classmethod
    def _placements_refused(cls, data: Any) -> Any:
        if isinstance(data, dict) and "placements" in data:
            raise ValueError(
                "placements is not accepted: Switch tracks only whether a "
                "controller-backed agent is connected, not where its sessions are"
            )
        return data


class ControllerConnectionRequest(_ControllerStreamBody):
    """Opening the controller's stream: where to resume each of its agents.

    A cursor is a sequence number in that agent's own buffer, or `"head"`. An
    agent left out starts at its head.
    """

    client: str | None = None
    client_version: str | None = None
    cursors: dict[str, int | Literal["head"]]

    @field_validator("cursors")
    @classmethod
    def _cursors_are_sequences(
        cls, value: dict[str, int | Literal["head"]]
    ) -> dict[str, int | Literal["head"]]:
        for agent_id, cursor in value.items():
            if isinstance(cursor, int) and cursor < 0:
                raise ValueError(f"cursor for {agent_id} must not be negative")
        return value

    def resume_cursors(self) -> dict[str, int | None]:
        return {
            agent_id: None if cursor == "head" else cursor
            for agent_id, cursor in self.cursors.items()
        }


# ── Gateway requests ──────────────────────────────────────────────────────────


class ConsoleControllerRequest(_GatewayBody):
    name: str = Field(min_length=1, max_length=MAX_CONTROLLER_NAME_CHARS)
    description: str | None = Field(
        default=None, max_length=MAX_CONTROLLER_DESCRIPTION_CHARS
    )
    kind: Literal["console"]
    platform: Platform
    version: str
    public_key: PublicKey | None = None

    @field_validator("name")
    @classmethod
    def _name_is_not_blank(cls, value: str) -> str:
        return _controller_name(value)

    @field_validator("description")
    @classmethod
    def _blank_description_is_none(cls, value: str | None) -> str | None:
        return _controller_description(value)


class _ControllerDetailsChange(BaseModel):
    """Rename a machine or change its description. Either or both; a key left
    out is left as it is, and `description: null` (or blank) clears it — read
    `model_fields_set`, not the value."""

    name: str | None = Field(
        default=None, min_length=1, max_length=MAX_CONTROLLER_NAME_CHARS
    )
    description: str | None = Field(
        default=None, max_length=MAX_CONTROLLER_DESCRIPTION_CHARS
    )

    @field_validator("name")
    @classmethod
    def _name_is_not_blank(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("a machine's name cannot be cleared")
        return _controller_name(value)

    @field_validator("description")
    @classmethod
    def _blank_description_is_none(cls, value: str | None) -> str | None:
        return _controller_description(value)

    @model_validator(mode="after")
    def _changes_something(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("give a name, a description, or both")
        return self


class UpdateControllerRequest(_ControllerDetailsChange):
    """The owner's change, through the gateway."""

    model_config = ConfigDict(extra="forbid")


class ControllerInfoRequest(_ControllerDetailsChange):
    """The controller's own change (`switch-agent-controller set-info`), and
    the key its provider logins are sealed to, which a controller enrolled
    before it made one registers once."""

    model_config = ConfigDict(extra="ignore")

    public_key: PublicKey | None = None

    @field_validator("public_key")
    @classmethod
    def _key_is_not_cleared(cls, value: PublicKey | None) -> PublicKey:
        if value is None:
            raise ValueError("a controller's public key cannot be cleared")
        return value


class CreateManagedAgentRequest(_GatewayBody):
    name: str
    description: str
    display_name: str | None = None
    # Null for the robot its name generates (`agent_icon.generated_icon_url`).
    icon_url: str | None = None
    controller_id: str | None
    desired_state: DesiredState
    definition: DefinitionV1


class PutManagedAgentRequest(_GatewayBody):
    controller_id: str | None
    desired_state: DesiredState
    definition: DefinitionV1


class PatchManagedAgentRequest(_GatewayBody):
    """Any subset of the three. `controller_id: null` unplaces the agent, so a
    key that is absent and a key that is null mean different things — read
    `model_fields_set`, not the value."""

    definition: DefinitionV1 | None = None
    desired_state: DesiredState | None = None
    controller_id: str | None = None


class CreateOperationRequest(_GatewayBody):
    controller_id: str
    agent_id: str | None = None
    kind: str
    params: dict[str, Any] = Field(default_factory=dict)


# ── Wire shapes ───────────────────────────────────────────────────────────────


def assignment_entry(row: AgentDefinitionRow, agent: Agent) -> dict[str, Any]:
    """An `AgentAssignment`: the stored v1 definition, plus the agent's `name`,
    `display_name` and `icon_url` read from its own row.

    The definition is the v1 shape, `directory` included, rather than the
    target contract's (which nests it as `local.directory` and adds fields v1
    does not have); `agent-controllers-v1.md` defines it this way."""
    definition = row.definition
    return {
        "agent_id": row.agent_id,
        "revision": row.revision,
        "desired_state": row.desired_state,
        "definition": {
            "name": agent.name,
            "display_name": agent.display_name,
            "icon_url": agent.icon_url,
            "provider": definition["provider"],
            "model": definition.get("model"),
            "advanced_config": definition.get("advanced_config", {}),
            "instructions": definition.get("instructions", ""),
            "auto_approve": definition.get("auto_approve", False),
            "directory": definition.get("directory"),
            "isolation": definition.get("isolation", "shared"),
        },
    }


def operation_wire(operation: AgentControllerOperation) -> dict[str, Any]:
    """An `Operation` as a controller sees it. `lease_expires_at` is present only
    while the operation is claimed."""
    wire: dict[str, Any] = {
        "id": operation.id,
        "kind": operation.kind,
        "agent_id": operation.agent_id,
        "params": operation.params,
        "created_at": wire_time(operation.created_at),
    }
    if operation.state == "claimed" and operation.lease_expires_at is not None:
        wire["lease_expires_at"] = wire_time(operation.lease_expires_at)
    return wire


def operation_view(operation: AgentControllerOperation) -> dict[str, Any]:
    """An operation as its owner sees it in the gateway: everything, state included."""
    return {
        "id": operation.id,
        "controller_id": operation.controller_id,
        "agent_id": operation.agent_id,
        "kind": operation.kind,
        "params": operation.params,
        "state": operation.state,
        "lease_expires_at": wire_time_or_none(operation.lease_expires_at),
        "result": operation.result,
        "created_by": operation.created_by,
        "created_at": wire_time(operation.created_at),
        "updated_at": wire_time(operation.updated_at),
    }


def workspaces_dir_of(controller: AgentController) -> str | None:
    """The workspaces directory the controller last reported, or None when
    its last report did not carry one."""
    if controller.status is None:
        return None
    machine = controller.status.get("machine")
    directory = machine.get("workspaces_dir") if isinstance(machine, dict) else None
    return directory if isinstance(directory, str) and directory else None


def connection_view(
    controller: AgentController, leases: ProcessLeases
) -> dict[str, Any] | None:
    """The controller's connection as last recorded: the current one, or the
    last one once its socket went. None when none was ever recorded.

    A connection the row shows open whose holding process is no longer
    alive is shown as ended when and why that process stopped holding it:
    `server_shutdown` at its lease's `stopped_at`, or `server_lost` after its
    last renewal (when unknown once the lease is pruned)."""
    if controller.connected_at is None:
        return None
    disconnected_at = controller.disconnected_at
    reason = controller.disconnect_reason
    if disconnected_at is None and not leases.holds(controller.connection_process_id):
        disconnected_at, reason = leases.ended(controller.connection_process_id)
    return {
        "connected_at": wire_time(controller.connected_at),
        "disconnected_at": wire_time_or_none(disconnected_at),
        "disconnect_reason": reason,
    }


def controller_view(
    controller: AgentController, state: str, leases: ProcessLeases
) -> dict[str, Any]:
    return {
        "id": controller.id,
        "name": controller.name,
        "description": controller.description,
        "kind": controller.kind,
        "platform": controller.platform,
        "version": controller.version,
        "state": state,
        "last_seen_at": wire_time_or_none(controller.last_seen_at),
        "connection": connection_view(controller, leases),
        "status": controller.status,
        "assignment_revision": controller.assignment_revision,
        "workspaces_dir": workspaces_dir_of(controller),
        "public_key": public_key_view(controller),
        "created_at": wire_time(controller.created_at),
        "revoked_at": wire_time_or_none(controller.revoked_at),
    }


def public_key_view(controller: AgentController) -> dict[str, str] | None:
    """The key the owner's client seals this machine's provider logins to,
    with the id a sealed login names it by; null for one that has none."""
    if controller.public_key is None:
        return None
    return {**controller.public_key, "key_id": key_id(controller.public_key["key"])}


def sealed_login_view(row: SealedProviderLogin) -> dict[str, Any]:
    """What the owner sees of a sealed login: never the ciphertext."""
    return {
        "provider": row.provider,
        "revision": row.revision,
        "key_id": row.sealed["key_id"],
        "updated_at": wire_time(row.updated_at),
    }


def agent_status_from(
    controller: AgentController | None, agent_id: str
) -> dict[str, Any] | None:
    """The agent's entry in its controller's last status report, if there is
    one. `directory` is always present: null when the controller has not
    resolved one or predates the field."""
    if controller is None or controller.status is None:
        return None
    agents = controller.status.get("agents")
    for entry in agents if isinstance(agents, list) else []:
        if isinstance(entry, dict) and entry.get("agent_id") == agent_id:
            return {**entry, "directory": entry.get("directory")}
    return None


def managed_agent_view(
    row: AgentDefinitionRow,
    agent: Agent,
    controller: AgentController | None,
    controller_state: str | None,
) -> dict[str, Any]:
    return {
        "agent_id": agent.id,
        "name": agent.name,
        "display_name": agent.display_name,
        "icon_url": agent.icon_url,
        "description": agent.description,
        "controller_id": row.controller_id,
        "controller_name": controller.name if controller is not None else None,
        "controller_kind": controller.kind if controller is not None else None,
        "controller_state": controller_state,
        "desired_state": row.desired_state,
        "revision": row.revision,
        "definition": row.definition,
        "status": agent_status_from(controller, agent.id),
        "created_at": wire_time(row.created_at),
        "updated_at": wire_time(row.updated_at),
    }
