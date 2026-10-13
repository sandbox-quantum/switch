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
from switch_core.providers.registry import (
    AgentProvider,
    agent_provider,
    agent_providers,
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
    """Pre-built agent definition for one-click registration, for one provider.

    Each subclass binds together the typed options schema accepted at
    registration and a `build_profile` method that derives the integration
    profile from validated options. The connector type and tools come from the
    provider's entry in `switch_core.providers.registry`.
    """

    options_schema: ClassVar[type[KnownAgentOptions]]

    def __init__(self, provider: AgentProvider) -> None:
        self.provider = provider

    @property
    def connector_type(self) -> str:
        return self.provider.connector_type

    @property
    def tools(self) -> list[ToolSpec]:
        return list(self.provider.tools)

    @property
    def models(self) -> list[ModelSpec]:
        return []

    @abstractmethod
    def build_profile(self, options: KnownAgentOptions) -> IntegrationProfile: ...

    def parse_options(self, raw: dict[str, Any] | None) -> KnownAgentOptions:
        return self.options_schema.model_validate(raw or {})


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
    options_schema = ClaudeCodeOptions

    def build_profile(self, options: KnownAgentOptions) -> IntegrationProfile:
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


class GenericAgentOptions(KnownAgentOptions):
    auto_session: bool = False
    """When True, the operator's connector (Switch Console) watches every room
    this agent belongs to and auto-spawns a session — connected to the room and
    wired to the agent's identity — the moment the agent is addressed in a room
    where it has no live session. The registered profile becomes
    `auto_session`. These providers have no connector channel of their own;
    Switch Console delivers inbound room messages into the session itself."""

    repo_dir: str | None = None
    """Absolute path to the directory the agent's sessions run in. Switch
    Console sets it when the agent is onboarded. None when it is unknown."""

    # No `channels_enabled`: Switch Console sends it for every provider, but
    # only Claude Code has a connector channel that could act on it.
    # `KnownAgentOptions` ignores unknown keys, so the shared registration path
    # still works — and the schema-driven gateway form does not render a
    # control that silently does nothing.

    @field_validator("repo_dir", mode="before")
    @classmethod
    def _blank_string_to_none(cls, value: object) -> object:
        if isinstance(value, str) and value.strip() == "":
            return None
        return value


class GenericKnownAgent(KnownAgent):
    """The known agent of every provider without one of its own: a CLI that
    Switch Console runs, delivering room messages into its session."""

    options_schema = GenericAgentOptions

    def build_profile(self, options: KnownAgentOptions) -> IntegrationProfile:
        assert isinstance(options, GenericAgentOptions)
        return IntegrationProfile(
            # Switch Console watches and auto-spawns when auto_session; otherwise
            # it keeps a session live and delivers messages into it, which is
            # the session_addressable model.
            connection_model=(
                "auto_session" if options.auto_session else "session_addressable"
            ),
            message_exchange=True,
            # Tool activity, where a provider reports it, goes to Switch Console
            # to drive the session's status; none of it reaches Switch as
            # reported events, and nothing mediates a tool call before it runs.
            pre_invocation_mediation=[],
            post_invocation_mediation=[],
            event_reporting=[],
            task_protocol=TaskProtocolConfig(can_delegate=True, can_accept=True),
            # Reset / compact / interrupt only work while Switch Console drives
            # the session; a standalone CLI cannot be controlled, so all three
            # resolve per live session via AgentRuntimeState.
            command_capabilities=CommandCapabilities(
                reset="session_dependent",
                compact="session_dependent",
                interrupt="session_dependent",
            ),
        )


# Providers whose known agent is not the generic one, by `known_agent_type`.
_SPECIALISED: dict[str, type[KnownAgent]] = {"claude-code": ClaudeCodeKnownAgent}


def _known_agent_of(provider: AgentProvider) -> KnownAgent:
    return _SPECIALISED.get(provider.known_agent_type, GenericKnownAgent)(provider)


def known_agents() -> dict[str, KnownAgent]:
    """Every known-agent spec, one per provider, keyed by the
    `known_agent_type` an agent registered through it stores."""
    return {
        provider.known_agent_type: _known_agent_of(provider)
        for provider in agent_providers()
    }


def known_agent(agent_type: str) -> KnownAgent | None:
    """The spec registered as `agent_type`, or None when there is none."""
    return known_agents().get(agent_type)


def provider_known_agent(provider_id: str) -> KnownAgent:
    """The spec agents of `provider_id` register through. Raises
    UnknownProvider for a provider Switch does not run."""
    return _known_agent_of(agent_provider(provider_id))


def known_agent_for(
    agent: Agent,
) -> tuple[KnownAgent, KnownAgentOptions] | None:
    """Resolve the KnownAgent spec and parsed options for a registered Agent.

    Returns None when the agent was not registered via `/agents/register`
    (e.g. `register-other` agents have no `known_agent_type` in metadata).
    """
    md = agent.metadata_ if isinstance(agent.metadata_, dict) else {}
    agent_type = md.get("known_agent_type")
    spec = known_agent(agent_type) if isinstance(agent_type, str) else None
    if spec is None:
        return None
    options = spec.parse_options(md.get("known_agent_options"))
    return spec, options
