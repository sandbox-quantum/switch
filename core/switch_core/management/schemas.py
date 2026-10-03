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
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from switch_core.db.models import Agent, AgentController, AgentControllerOperation
from switch_core.db.models import AgentDefinition as AgentDefinitionRow

Provider = Literal["claude", "codex", "opencode", "antigravity", "cursor"]
ControllerKind = Literal["console", "daemon", "ec2"]
DesiredState = Literal["running", "stopped"]

# The known-agent spec each provider registers through.
PROVIDER_KNOWN_AGENT_TYPES: dict[str, str] = {
    "claude": "claude-code",
    "codex": "codex",
    "opencode": "opencode",
    "antigravity": "antigravity",
    "cursor": "cursor",
}

MAX_INSTRUCTIONS_BYTES = 32 * 1024
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


class PublicKey(_StatusBody):
    alg: str
    key: str


class DefinitionV1(_GatewayBody):
    """The v1 agent definition, as a person's client submits it."""

    provider: Provider
    model: str | None = None
    instructions: str = ""
    auto_session: bool = True
    auto_approve: bool = False
    directory: str | None = None

    @field_validator("instructions")
    @classmethod
    def _instructions_fit(cls, value: str) -> str:
        if len(value.encode()) > MAX_INSTRUCTIONS_BYTES:
            raise ValueError(
                f"instructions must be at most {MAX_INSTRUCTIONS_BYTES} bytes"
            )
        return value


# ── Controller-facing requests ────────────────────────────────────────────────


class EnrollmentCodeProof(_ControllerBody):
    kind: Literal["enrollment_code"]
    code: str


class ControllerDescription(_ControllerBody):
    kind: ControllerKind
    name: str = Field(min_length=1, max_length=200)
    platform: Platform
    version: str


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


class ControllerConnectionRequest(_ControllerBody):
    """Opening the controller's stream: where to resume each of its agents.

    A cursor is a sequence number in that agent's own buffer, or `"head"`. An
    agent left out starts at its head. `placements` is the initial map of
    rooms each agent has a session working in, as on a beat; absent is none.
    """

    client: str | None = None
    client_version: str | None = None
    cursors: dict[str, int | Literal["head"]]
    placements: dict[str, list[str]] = Field(default_factory=dict)

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


class ControllerBeatRequest(_ControllerBody):
    """A beat. `placements` is, for each bound agent, every room where one of
    its sessions works now: the whole map each time, replacing the last. An
    agent left out is in no room."""

    connection_id: str
    generation: int
    cursors: dict[str, int]
    placements: dict[str, list[str]]


# ── Gateway requests ──────────────────────────────────────────────────────────


class ConsoleControllerRequest(_GatewayBody):
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["console"]
    platform: Platform
    version: str
    public_key: PublicKey | None = None


class CreateManagedAgentRequest(_GatewayBody):
    name: str
    description: str
    display_name: str | None = None
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
            "instructions": definition.get("instructions", ""),
            "auto_session": definition.get("auto_session", True),
            "auto_approve": definition.get("auto_approve", False),
            "directory": definition.get("directory"),
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


def controller_view(controller: AgentController, state: str) -> dict[str, Any]:
    return {
        "id": controller.id,
        "name": controller.name,
        "kind": controller.kind,
        "platform": controller.platform,
        "version": controller.version,
        "state": state,
        "last_seen_at": wire_time_or_none(controller.last_seen_at),
        "status": controller.status,
        "assignment_revision": controller.assignment_revision,
        "created_at": wire_time(controller.created_at),
        "revoked_at": wire_time_or_none(controller.revoked_at),
    }


def agent_status_from(
    controller: AgentController | None, agent_id: str
) -> dict[str, Any] | None:
    """The agent's entry in its controller's last status report, if there is one."""
    if controller is None or controller.status is None:
        return None
    agents = controller.status.get("agents")
    for entry in agents if isinstance(agents, list) else []:
        if isinstance(entry, dict) and entry.get("agent_id") == agent_id:
            return entry
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
        "controller_state": controller_state,
        "desired_state": row.desired_state,
        "revision": row.revision,
        "definition": row.definition,
        "status": agent_status_from(controller, agent.id),
        "created_at": wire_time(row.created_at),
        "updated_at": wire_time(row.updated_at),
    }
