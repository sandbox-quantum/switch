from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, ClassVar

from pydantic import BaseModel, field_validator

from switch_core.bridges.agent.protocol.types import (
    CommandCapabilities,
    IntegrationProfile,
    ModelSpec,
    TaskProtocolConfig,
    ToolSpec,
)

if TYPE_CHECKING:
    from switch_core.db.models import Agent


class KnownAgentOptions(BaseModel):
    """Base class for per-known-agent registration options.

    Subclasses define the typed config fields that the gateway UI and the
    `register-known` endpoints accept for a given known agent type. Field
    defaults must preserve the behaviour of pre-existing registrations (which
    carry no options on file).
    """


class KnownAgent(ABC):
    """Pre-built agent definition for one-click registration.

    Each subclass binds together: the connector type, the typed options schema
    accepted at registration, and a `build_profile` classmethod that derives
    the integration profile from validated options.
    """

    connector_type: ClassVar[str]
    options_schema: ClassVar[type[KnownAgentOptions]]
    tools: ClassVar[list[ToolSpec]]
    models: ClassVar[list[ModelSpec]]

    @classmethod
    @abstractmethod
    def build_profile(cls, options: KnownAgentOptions) -> IntegrationProfile: ...

    @classmethod
    def parse_options(cls, raw: dict[str, Any] | None) -> KnownAgentOptions:
        return cls.options_schema.model_validate(raw or {})

    @classmethod
    def start_session_instructions(
        cls,
        agent: Agent,
        owner_handle: str | None,
        other_room_names: list[str] | None,
        connected_not_live: bool,
    ) -> str:
        """Return markdown telling the agent's owner how to bring it online in
        the room it was just addressed in. Posted when the agent is addressed
        but has no live session there.

        Sessions are started by Switch Console, its sidecar on an SSH host, or
        an agents controller, never by hand: a CLI started in a terminal gets
        none of the Switch tools. So the answer is always to start it from
        Switch Console, and no terminal command is offered.

        `owner_handle` is the agent owner's account on the platform this room
        is bridged to, @-mentioned so they are actually notified. None when the
        agent has no owner or that owner has claimed no account there, in which
        case the message still posts and says "my owner". It is passed in
        rather than read from `options`: the right handle depends on which
        platform the room is on, which the caller knows and a per-agent setting
        could not.

        When `other_room_names` is set, the agent has no session here but does
        have live sessions in those rooms; the message names them as somewhere
        the asker can go instead.

        When `connected_not_live` is set, a session is bound to this room but
        is not reporting as live; the message says so and asks for a restart.
        """
        prefix = f"@{owner_handle} — " if owner_handle else ""
        actor = "you" if owner_handle else "my owner"
        console = f"opening **{agent.name}** in Switch Console"
        if connected_not_live:
            return (
                f"{prefix}I have a session connected to this room, but it isn't "
                "reporting as live, so I'm not receiving messages. "
                f"{actor.capitalize()} can restart it by {console}."
            )
        if other_room_names:
            where = ", ".join(f"**{name}**" for name in other_room_names)
            return (
                f"{prefix}I don't have a session in this room right now, but I do "
                f"have one in {where}. Ask me there, or {actor} can start one here "
                f"by {console}."
            )
        return (
            f"{prefix}I don't have a session connected to this room. "
            f"{actor.capitalize()} can start one by {console}."
        )


class ClaudeCodeOptions(KnownAgentOptions):
    channels_enabled: bool = True
    """Whether sessions receive room events as they happen. Switch Console
    registers every agent with this on. When False, the registered profile
    becomes `session_passive` instead of `session_addressable`."""

    auto_session: bool = False
    """When True, the operator's connector (Switch Console) watches every room this
    agent belongs to and automatically spins up a Claude Code session — wired
    to the right working dir/identity and connected to the room — the moment the
    agent is addressed in a room where it has no live session. The registered
    profile becomes `auto_session`, taking precedence over both
    `session_addressable` and `session_passive`. Works independently of
    `channels_enabled`: the connector watches the notification stream over HTTP,
    and the auto-spawned session pulls the waiting message on connect
    (`read_context`) rather than needing a live channel push — so a
    channels-disabled agent still auto-starts a session when addressed. Without
    channels, that session reads asynchronously (no real-time push) once
    started, same as any `session_passive` install."""

    repo_dir: str | None = None
    """Absolute path to the directory the agent's sessions run in. Switch
    Console sets it when the agent is onboarded. None when it is unknown."""

    subagent_name: str | None = None
    """When set, this agent is a Claude Code *subagent* (a `.claude/agents/*.md`
    definition) rather than a top-level Claude Code install. The value is the
    bare Claude Code subagent identifier (its `name` frontmatter field). Switch
    Console uses it to start the session as that subagent, with the subagent's
    own credentials, so the session authenticates to Switch as the subagent
    rather than the parent. Leave None for ordinary top-level agents."""

    @field_validator("repo_dir", "subagent_name", mode="before")
    @classmethod
    def _blank_string_to_none(cls, value: object) -> object:
        # The gateway edit form submits an empty string when the user clears
        # the field. Normalise to None so downstream "has a value" checks
        # don't fire on a blank value.
        if isinstance(value, str) and value.strip() == "":
            return None
        return value


class ClaudeCodeKnownAgent(KnownAgent):
    connector_type = "Claude Code"
    options_schema = ClaudeCodeOptions
    tools = [
        ToolSpec(name="Bash", description="Executes shell commands"),
        ToolSpec(name="Edit", description="Makes targeted edits to files"),
        ToolSpec(name="Write", description="Creates or overwrites files"),
        ToolSpec(name="Read", description="Reads file contents"),
        ToolSpec(name="Glob", description="Finds files by name pattern"),
        ToolSpec(name="Grep", description="Searches file contents for patterns"),
        ToolSpec(name="NotebookEdit", description="Modifies Jupyter notebook cells"),
        ToolSpec(name="Agent", description="Spawns a subagent to handle a task"),
        ToolSpec(name="WebFetch", description="Fetches and processes web content"),
        ToolSpec(name="WebSearch", description="Performs web searches"),
        ToolSpec(name="Monitor", description="Runs background watch commands"),
        ToolSpec(name="Skill", description="Executes a skill"),
    ]
    models: ClassVar[list[ModelSpec]] = []

    @classmethod
    def build_profile(cls, options: KnownAgentOptions) -> IntegrationProfile:
        assert isinstance(options, ClaudeCodeOptions)
        if options.auto_session:
            connection_model = "auto_session"
        elif not options.channels_enabled:
            connection_model = "session_passive"
        else:
            connection_model = "session_addressable"
        return IntegrationProfile(
            connection_model=connection_model,
            message_exchange=True,
            pre_invocation_mediation=["tool_calls"],
            post_invocation_mediation=[],
            event_reporting=["tool_calls"],
            task_protocol=TaskProtocolConfig(can_delegate=True, can_accept=True),
            # Reset / compact / interrupt work only on a session that Switch
            # Console (or its sidecar or an agents controller) is running, so
            # all three resolve per live session via AgentRuntimeState.
            command_capabilities=CommandCapabilities(
                reset="session_dependent",
                compact="session_dependent",
                interrupt="session_dependent",
            ),
        )


class CodexOptions(KnownAgentOptions):
    auto_session: bool = False
    """When True, the operator's connector (Switch Console) watches every room this
    agent belongs to and auto-spawns a Codex session — connected to the room and
    wired to the agent's identity — the moment the agent is addressed in a room
    where it has no live session. The registered profile becomes `auto_session`.
    Switch Console delivers inbound room messages through Codex's app-server
    protocol."""

    repo_dir: str | None = None
    """Absolute path to the directory the agent's sessions run in. Switch
    Console sets it when the agent is onboarded. None when it is unknown."""

    # No `channels_enabled`: Switch Console sends it for every provider, but Codex
    # has no connector channel of its own, so nothing here could act on it.
    # `KnownAgentOptions` ignores unknown keys, so the shared registration path
    # still works — and the schema-driven gateway form does not render a control
    # that silently does nothing.

    @field_validator("repo_dir", mode="before")
    @classmethod
    def _blank_string_to_none(cls, value: object) -> object:
        if isinstance(value, str) and value.strip() == "":
            return None
        return value


class CodexKnownAgent(KnownAgent):
    connector_type = "Codex CLI"
    options_schema = CodexOptions
    tools = [
        ToolSpec(name="Shell", description="Executes shell commands"),
        ToolSpec(name="ApplyPatch", description="Applies patches to files"),
        ToolSpec(name="Read", description="Reads file contents"),
    ]
    models: ClassVar[list[ModelSpec]] = []

    @classmethod
    def build_profile(cls, options: KnownAgentOptions) -> IntegrationProfile:
        assert isinstance(options, CodexOptions)
        # Switch Console watches and starts a session when auto_session;
        # otherwise the profile is session_addressable. Codex does not report
        # per-tool events to Switch or have its tool calls mediated by Switch,
        # so those lists stay empty, unlike Claude Code.
        connection_model = (
            "auto_session" if options.auto_session else "session_addressable"
        )
        return IntegrationProfile(
            connection_model=connection_model,
            message_exchange=True,
            pre_invocation_mediation=[],
            post_invocation_mediation=[],
            event_reporting=[],
            task_protocol=TaskProtocolConfig(can_delegate=True, can_accept=True),
            # Same as Claude Code: these work only on a session Switch Console
            # is running, so all three resolve per live session via
            # AgentRuntimeState.
            command_capabilities=CommandCapabilities(
                reset="session_dependent",
                compact="session_dependent",
                interrupt="session_dependent",
            ),
        )


class OpenCodeOptions(KnownAgentOptions):
    auto_session: bool = False
    """When True, the operator's connector (Switch Console) watches every room this
    agent belongs to and auto-spawns an OpenCode session — connected to the room
    and wired to the agent's identity — the moment the agent is addressed in a
    room where it has no live session. The registered profile becomes
    `auto_session`. Switch Console delivers inbound room messages through
    OpenCode's HTTP server."""

    repo_dir: str | None = None
    """Absolute path to the directory the agent's sessions run in. Switch
    Console sets it when the agent is onboarded. None when it is unknown."""

    # No `channels_enabled`, for the same reason as Codex: Switch Console sends it
    # for every provider, but OpenCode has no connector channel for it to act on.

    @field_validator("repo_dir", mode="before")
    @classmethod
    def _blank_string_to_none(cls, value: object) -> object:
        if isinstance(value, str) and value.strip() == "":
            return None
        return value


class OpenCodeKnownAgent(KnownAgent):
    connector_type = "OpenCode CLI"
    options_schema = OpenCodeOptions
    tools = [
        ToolSpec(name="Bash", description="Executes shell commands"),
        ToolSpec(name="Edit", description="Edits existing files"),
        ToolSpec(name="Write", description="Writes new files"),
        ToolSpec(name="Read", description="Reads file contents"),
        ToolSpec(name="Grep", description="Searches file contents"),
        ToolSpec(name="Glob", description="Finds files by pattern"),
        ToolSpec(name="List", description="Lists directory contents"),
        ToolSpec(name="WebFetch", description="Fetches web pages"),
        ToolSpec(name="Task", description="Spawns a sub-agent"),
    ]
    models: ClassVar[list[ModelSpec]] = []

    @classmethod
    def build_profile(cls, options: KnownAgentOptions) -> IntegrationProfile:
        assert isinstance(options, OpenCodeOptions)
        return IntegrationProfile(
            connection_model=(
                "auto_session" if options.auto_session else "session_addressable"
            ),
            message_exchange=True,
            # OpenCode's tool activity is shown in Switch Console but is not
            # reported to Switch as events, and Switch does not mediate its tool
            # calls, so both lists stay empty, the same as Codex.
            pre_invocation_mediation=[],
            post_invocation_mediation=[],
            event_reporting=[],
            task_protocol=TaskProtocolConfig(can_delegate=True, can_accept=True),
            # These work only on a session Switch Console is running, so all
            # three resolve per live session via AgentRuntimeState.
            command_capabilities=CommandCapabilities(
                reset="session_dependent",
                compact="session_dependent",
                interrupt="session_dependent",
            ),
        )


class AntigravityOptions(KnownAgentOptions):
    auto_session: bool = False
    repo_dir: str | None = None

    @field_validator("repo_dir", mode="before")
    @classmethod
    def _blank_string_to_none(cls, value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value


class AntigravityKnownAgent(KnownAgent):
    connector_type = "Antigravity CLI"
    options_schema = AntigravityOptions
    tools = [
        ToolSpec(name="run_command", description="Executes shell commands"),
        ToolSpec(name="write_to_file", description="Writes files"),
        ToolSpec(name="replace_file_content", description="Edits existing files"),
        ToolSpec(
            name="multi_replace_file_content",
            description="Applies several edits to one file",
        ),
        ToolSpec(name="view_file", description="Reads file contents"),
        ToolSpec(name="grep_search", description="Searches file contents"),
        ToolSpec(name="find_by_name", description="Finds files by pattern"),
        ToolSpec(name="list_dir", description="Lists directory contents"),
        ToolSpec(name="read_url_content", description="Fetches web pages"),
        ToolSpec(name="search_web", description="Searches the web"),
        ToolSpec(name="call_mcp_tool", description="Calls a tool on an MCP server"),
        ToolSpec(name="invoke_subagent", description="Delegates to a subagent"),
    ]
    models: ClassVar[list[ModelSpec]] = []

    @classmethod
    def build_profile(cls, options: KnownAgentOptions) -> IntegrationProfile:
        assert isinstance(options, AntigravityOptions)
        return IntegrationProfile(
            connection_model="auto_session"
            if options.auto_session
            else "session_addressable",
            message_exchange=True,
            pre_invocation_mediation=[],
            post_invocation_mediation=[],
            event_reporting=[],
            task_protocol=TaskProtocolConfig(can_delegate=True, can_accept=True),
            command_capabilities=CommandCapabilities(
                reset="session_dependent",
                compact="session_dependent",
                interrupt="session_dependent",
            ),
        )


class CursorOptions(KnownAgentOptions):
    auto_session: bool = False
    repo_dir: str | None = None

    @field_validator("repo_dir", mode="before")
    @classmethod
    def _blank_string_to_none(cls, value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value


class CursorKnownAgent(KnownAgent):
    connector_type = "Cursor CLI"
    options_schema = CursorOptions
    tools = [
        ToolSpec(name="shell", description="Executes shell commands"),
        ToolSpec(name="read_file", description="Reads file contents"),
        ToolSpec(name="write", description="Writes files"),
        ToolSpec(name="str_replace", description="Edits existing files"),
        ToolSpec(name="grep", description="Searches file contents"),
        ToolSpec(name="glob", description="Finds files by pattern"),
    ]
    models: ClassVar[list[ModelSpec]] = []

    @classmethod
    def build_profile(cls, options: KnownAgentOptions) -> IntegrationProfile:
        assert isinstance(options, CursorOptions)
        return IntegrationProfile(
            connection_model="auto_session"
            if options.auto_session
            else "session_addressable",
            message_exchange=True,
            pre_invocation_mediation=[],
            post_invocation_mediation=[],
            event_reporting=[],
            task_protocol=TaskProtocolConfig(can_delegate=True, can_accept=True),
            command_capabilities=CommandCapabilities(
                reset="session_dependent",
                compact="session_dependent",
                interrupt="session_dependent",
            ),
        )


KNOWN_AGENTS: dict[str, type[KnownAgent]] = {
    "claude-code": ClaudeCodeKnownAgent,
    "codex": CodexKnownAgent,
    "opencode": OpenCodeKnownAgent,
    "antigravity": AntigravityKnownAgent,
    "cursor": CursorKnownAgent,
}


def known_agent_for(
    agent: Agent,
) -> tuple[type[KnownAgent], KnownAgentOptions] | None:
    """Resolve the KnownAgent spec and parsed options for a registered Agent.

    Returns None when the agent was not registered via `/agents/register`
    (e.g. `register-other` agents have no `known_agent_type` in metadata).
    """
    md = agent.metadata_ if isinstance(agent.metadata_, dict) else {}
    agent_type = md.get("known_agent_type")
    spec = KNOWN_AGENTS.get(agent_type) if isinstance(agent_type, str) else None
    if spec is None:
        return None
    options = spec.parse_options(md.get("known_agent_options"))
    return spec, options
