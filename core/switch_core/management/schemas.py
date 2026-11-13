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

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ModelWrapValidatorHandler,
    PrivateAttr,
    StrictBool,
    field_validator,
    model_validator,
)

from switch_core.config import ControllerRelease
from switch_core.db.models import (
    Agent,
    AgentController,
    AgentControllerOperation,
    SealedProviderLogin,
)
from switch_core.db.models import AgentDefinition as AgentDefinitionRow
from switch_core.management.advanced_config import validate_advanced_config
from switch_core.management.sealed_logins import PublicKey, key_id
from switch_core.process_lease import ProcessLeases
from switch_core.providers.registry import AgentProviderId

Provider = AgentProviderId
ControllerKind = Literal["console", "daemon", "ec2"]
DesiredState = Literal["running", "stopped"]
Isolation = Literal["shared", "isolated"]

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


# No box has a petabyte: a memory reading past this is refused.
MAX_MEMINFO_BYTES = 2**50
# No box runs anywhere near this many agent hosts: a count past it is refused.
MAX_VALVE_HOSTS = 1000
# The provider gateway's daily calls: the controller's own
# ceiling on the cap (`MAX_CAP` in gateway-usage.ts), so no honest figure is refused.
MAX_GATEWAY_CALLS = 1_000_000_000
# The memory guard's note codes (status extras): Console words them.
MEMORY_NOTE_CODES = ("unexplained", "sustained")


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
    # The provider's own automatic review: safe actions run, risky ones still
    # ask. A stored definition without the key predates it and reads as off
    # (`stored_definition`).
    auto_mode: bool = True
    # Bypass: every permission check skipped. Wins over `auto_mode`.
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
        raise ValueError("a device's name must not be blank")
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
    # Who moves it onto another release: itself, following the release Core
    # names, or Switch Console, which runs it (on an SSH host, say) and
    # replaces its bundle. Absent from a controller older than this field.
    updated_by: Literal["self", "console"] | None = None
    # When this controller process started, so a restart shows as a new start
    # time: a cloud machine's controller naming a new one is counted as a
    # restart (`switch.hosted.controller_restarts`). Absent from a controller
    # older than this field.
    started_at: datetime | None = None


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
    # The box's own memory from /proc/meminfo (AnonPages and Cached), in
    # bytes, for the cost model and the live page. Absent where the
    # controller has no /proc (macOS), and from controllers older than these.
    mem_anon_bytes: int | None = Field(
        default=None, ge=0, le=MAX_MEMINFO_BYTES, strict=True
    )
    mem_cached_bytes: int | None = Field(
        default=None, ge=0, le=MAX_MEMINFO_BYTES, strict=True
    )
    # The box valve's memory problem: "unprotected" when it has never
    # read the box's memory (it parks and refuses nothing for memory), or
    # "failing" while readings fail after good ones (new starts wait). Absent
    # when readings are fine, the valve is off, or the controller is older.
    valve_memory: Literal["unprotected", "failing"] | None = None
    # Which disk `disk_free_bytes` and `disk_total_bytes` measure: "workspace"
    # when a box's controller has the agents' own volume measured (its
    # launcher), "unknown" otherwise. Absent from older controllers, whose
    # figure is their own data folder. The apps show a disk only for "workspace".
    # Any other value is stored as "unknown", never refused: a bad mark must not
    # cost the box its whole report (heartbeat, memory, agents).
    disk_scope: Literal["workspace", "unknown"] | None = None

    @field_validator("disk_scope", mode="before")
    @classmethod
    def _disk_scope_or_unknown(cls, value: object) -> str | None:
        if value is None:
            return None
        return (
            value
            if value in ("workspace", "unknown") and isinstance(value, str)
            else "unknown"
        )

    # The box valve's agent hosts on the hub, and how many joined it.
    # Absent where the valve is off, and from controllers older than these.
    valve_hosts: int | None = Field(default=None, ge=0, le=MAX_VALVE_HOSTS, strict=True)
    valve_hosts_joined: int | None = Field(
        default=None, ge=0, le=MAX_VALVE_HOSTS, strict=True
    )
    # The provider gateway: agents it fronts and calls it refused, and,
    # where a daily cap is set, today's calls, whether the cap is reached and the
    # cap itself (Your cloud's "40 of 200 today"). Declared and
    # bounded so a box can't store anything else under these names.
    gateway_agents: int | None = Field(
        default=None, ge=0, le=MAX_VALVE_HOSTS, strict=True
    )
    gateway_refused: int | None = Field(
        default=None, ge=0, le=MAX_GATEWAY_CALLS, strict=True
    )
    gateway_calls_today: int | None = Field(
        default=None, ge=0, le=MAX_GATEWAY_CALLS, strict=True
    )
    gateway_capped: bool | None = Field(default=None, strict=True)
    gateway_daily_cap: int | None = Field(
        default=None, ge=1, le=MAX_GATEWAY_CALLS, strict=True
    )
    # Which number set today's cap: the operator's own
    # setting, or the workspace's daily cap held to the gateway's bounds.
    gateway_cap_source: Literal["local", "workspace"] | None = None
    # Since the controller started: agents its memory guard stopped, and
    # sessions its box valve parked. Bounded ints, so a report can't put
    # anything else in the hosted metrics. Absent where the guard or valve is
    # off, and from older controllers.
    guard_stops: int | None = Field(default=None, ge=0, le=1_000_000, strict=True)
    valve_parks: int | None = Field(default=None, ge=0, le=1_000_000, strict=True)
    # The memory guard's note while the box is high and no agent explains it:
    # a fixed code, never text, with the box's reading and its shared-memory
    # part in bytes. Console builds the wording. An older controller's
    # free-text note is dropped, never stored (see `_drop_old_memory_note`).
    memory_note: Literal["unexplained", "sustained"] | None = None
    memory_note_box_bytes: int | None = Field(
        default=None, ge=0, le=MAX_MEMINFO_BYTES, strict=True
    )
    memory_note_shmem_bytes: int | None = Field(
        default=None, ge=0, le=MAX_MEMINFO_BYTES, strict=True
    )
    # Set when an older controller's free-text `memory_note` was dropped, so
    # the service can count it without the text ever being kept or logged.
    _dropped_old_note: bool = PrivateAttr(default=False)

    @model_validator(mode="wrap")
    @classmethod
    def _drop_old_memory_note(
        cls, data: Any, handler: ModelWrapValidatorHandler[Self]
    ) -> Self:
        """An older controller sends the guard's note as a sentence. Refusing it
        would refuse that box's whole report, so a note that isn't one of the
        codes is dropped instead, and only counted."""
        dropped = False
        if (
            isinstance(data, dict)
            and data.get("memory_note") is not None
            and data["memory_note"] not in MEMORY_NOTE_CODES
        ):
            data = {key: value for key, value in data.items() if key != "memory_note"}
            dropped = True
        model = handler(data)
        model._dropped_old_note = dropped
        return model


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


class AgentLetGo(BaseModel):
    """The box let one of this agent's messages go for waiting too long for room
    (`waiting_too_long`). A fixed reason and a time only, so a box can't put text in front of its owner."""

    model_config = ConfigDict(extra="forbid")
    at: str = Field(max_length=40)
    reason: Literal["timed_out"]


class AgentStatus(_StatusBody):
    agent_id: str
    applied_revision: int | None
    process: str
    attached: bool
    sessions: AgentSessions
    # Where the agent's sessions stand (shown as Running, Back in a moment or
    # Resting). Only these three values are accepted, so a box can't put
    # arbitrary text in its owner's Console. Absent from older controllers.
    session: Literal["active", "waking", "parked"] | None = None
    restarts_10m: int
    oom_kills: int
    # This agent's AI calls today through the gateway, where the box has a daily
    # cap. Display only: each rise is filed under the agent's
    # client id, and nothing in Core enforces from it.
    ai_calls_today: int | None = Field(
        default=None, ge=0, le=MAX_GATEWAY_CALLS, strict=True
    )
    # The absolute working directory the agent runs in; null before the
    # controller resolved one, absent from a controller older than this field.
    directory: str | None = None
    since: str
    reason: str | None = None
    detail: str | None = None
    # The last message the box let go for waiting too long; absent from older controllers.
    let_go: AgentLetGo | None = None
    # Whether any of its sessions is mid-turn (working versus idle). Strictly a
    # boolean, so a box can't put anything else there; absent when its host doesn't report it.
    busy: StrictBool | None = None

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

    @model_validator(mode="wrap")
    @classmethod
    def _as_upstream_while_v2_is_off(
        cls, data: Any, handler: ModelWrapValidatorHandler[Self]
    ) -> Self:
        """The v1/v2 switch (sweep row 8): with hosted agents v2 off, a report
        is read as upstream reads it. The fields v2 declared are kept as sent,
        as upstream's `extra="allow"` keeps them, and none can refuse it."""
        from switch_core.hosted_v2 import process_hosted_v2

        if cls is StatusReport and not process_hosted_v2():
            return _V1StatusReport.model_validate(data)  # type: ignore[return-value]
        return handler(data)


# Every field hosted agents v2 declared on a status report, read as upstream
# reads an undeclared one while v2 is off: any value, kept as sent.
V2_MACHINE_STATUS_FIELDS = (
    "mem_anon_bytes",
    "mem_cached_bytes",
    "valve_memory",
    "disk_scope",
    "valve_hosts",
    "valve_hosts_joined",
    "gateway_agents",
    "gateway_refused",
    "gateway_calls_today",
    "gateway_capped",
    "gateway_daily_cap",
    "gateway_cap_source",
    "guard_stops",
    "valve_parks",
    "memory_note",
    "memory_note_box_bytes",
    "memory_note_shmem_bytes",
)
V2_AGENT_STATUS_FIELDS = ("session", "ai_calls_today", "let_go", "busy")


class _V1MachineStatus(MachineStatus):
    mem_anon_bytes: Any = None
    mem_cached_bytes: Any = None
    valve_memory: Any = None
    disk_scope: Any = None
    valve_hosts: Any = None
    valve_hosts_joined: Any = None
    gateway_agents: Any = None
    gateway_refused: Any = None
    gateway_calls_today: Any = None
    gateway_capped: Any = None
    gateway_daily_cap: Any = None
    gateway_cap_source: Any = None
    guard_stops: Any = None
    valve_parks: Any = None
    memory_note: Any = None
    memory_note_box_bytes: Any = None
    memory_note_shmem_bytes: Any = None

    @model_validator(mode="wrap")
    @classmethod
    def _drop_old_memory_note(
        cls, data: Any, handler: ModelWrapValidatorHandler[Self]
    ) -> Self:
        # As upstream: a note is kept as sent, never dropped.
        return handler(data)

    @field_validator("disk_scope", mode="before")
    @classmethod
    def _disk_scope_or_unknown(cls, value: object) -> Any:
        # As upstream: any value, kept as sent.
        return value


class _V1AgentStatus(AgentStatus):
    session: Any = None
    ai_calls_today: Any = None
    let_go: Any = None
    busy: Any = None


class _V1StatusReport(StatusReport):
    machine: _V1MachineStatus
    # Pydantic's v1 view of the same report: the narrower element type is the
    # point, so list's invariance check doesn't apply here.
    agents: list[_V1AgentStatus]  # type: ignore[assignment]


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
            raise ValueError("a device's name cannot be cleared")
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
    # Null for the icon its name generates (`agent_icon.generated_icon_url`),
    # or for no icon when the server has third-party avatars off.
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


def stored_definition(definition: dict[str, Any]) -> dict[str, Any]:
    """A stored v1 definition with the fields it may predate filled in as they
    read: a definition saved before `auto_mode` existed has it off."""
    return {**definition, "auto_mode": definition.get("auto_mode", False)}


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
            "auto_mode": definition.get("auto_mode", False),
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


def updated_by_console(controller: AgentController) -> bool:
    """Whether Switch Console updates this controller: Console's own, or one
    Console runs elsewhere and says so in its status. Either ships with
    Console and cannot follow the release Core names."""
    if controller.kind == "console":
        return True
    info = (controller.status or {}).get("controller") or {}
    return info.get("updated_by") == "console"


def release_for(
    controller: AgentController, release: ControllerRelease | None
) -> ControllerRelease | None:
    """The release this controller is told to run. None for one Switch Console
    updates, whatever is set."""
    return None if updated_by_console(controller) else release


def controller_release_view(
    controller: AgentController, release: ControllerRelease | None
) -> dict[str, str] | None:
    """The release the controller is told to run, or null when it is told none."""
    wanted = release_for(controller, release)
    if wanted is None:
        return None
    return {"version": wanted.version, "url": wanted.url, "sha256": wanted.sha256}


def release_view(
    controller: AgentController, release: ControllerRelease | None
) -> dict[str, Any] | None:
    """Whether the controller runs the release it is told to run: the version
    wanted, the one it last reported, and whether they are the same. Null when
    it is told none."""
    release = release_for(controller, release)
    if release is None:
        return None
    return {
        "wanted": release.version,
        "running": controller.version,
        "current": controller.version == release.version,
    }


def controller_view(
    controller: AgentController,
    state: str,
    leases: ProcessLeases,
    release: ControllerRelease | None,
) -> dict[str, Any]:
    return {
        "id": controller.id,
        "name": controller.name,
        "description": controller.description,
        "kind": controller.kind,
        "platform": controller.platform,
        "version": controller.version,
        "release": release_view(controller, release),
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
    template: dict[str, Any] | None,
) -> dict[str, Any]:
    """`template` is the template that created the agent, as its install
    records it ({id, key, revision}), or None for one no template run the
    server vouches for created."""
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
        "definition": stored_definition(row.definition),
        "status": agent_status_from(controller, agent.id),
        "template": template,
        "created_at": wire_time(row.created_at),
        "updated_at": wire_time(row.updated_at),
    }
