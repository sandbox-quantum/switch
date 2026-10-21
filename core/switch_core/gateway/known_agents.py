from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, ClassVar

from pydantic import BaseModel, field_validator

from switch_core.bridges.agent.protocol.types import (
    CommandCapabilities,
    IntegrationProfile,
    ModelSpec,
    ToolSpec,
)
from switch_core.providers.registry import (
    AgentProvider,
    ConsoleStart,
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

    def start_session_instructions(
        self,
        options: KnownAgentOptions,
        agent: Agent,
        room_name: str,
        owner_handle: str | None,
        assume_role: str | None = None,
        other_room_names: list[str] | None = None,
        connected_not_live: bool = False,
    ) -> str | None:
        """Return markdown telling the operator how to start a session that
        connects this agent to the room named `room_name`. Posted
        automatically when the agent is addressed but has no live session,
        and on demand via `!run-cmd`.

        Every session is started from Switch Console, so this says where in
        Console to do it rather than giving a terminal command: a CLI run by
        hand has no Switch tools.

        `owner_handle` is the agent owner's account on the platform this room
        is bridged to, @-mentioned so they are actually notified — None when
        the agent has no owner or that owner has claimed no account there, in
        which case the message still posts and simply says "my operator". It
        is passed in rather than read from `options`: the right handle depends
        on which platform the room is on, which the caller knows and a
        per-agent setting could not.

        When `assume_role` is set, the message also says to ask the started
        session to take that role (e.g. `!run-cmd @agent @role`).

        When `other_room_names` is set, the agent has no session here but does
        have live session(s) connected to those rooms; the opening sentence
        names them and offers asking there as an alternative.

        When `connected_not_live` is set, a session is bound to THIS room but
        is not reporting as live; the opening says so and asks for it to be
        restarted.
        """
        return _console_start_instructions(
            self.provider.session_start,
            agent,
            room_name,
            owner_handle,
            assume_role=assume_role,
            other_room_names=other_room_names,
            connected_not_live=connected_not_live,
        )


class ClaudeCodeOptions(KnownAgentOptions):
    channels_enabled: bool = True
    """Whether the Claude Code installation can receive inbound room events as
    live channel pushes. Defaults to True for backwards compatibility. Set to
    False for installations that cannot (e.g. Vertex AI or other managed setups
    without a Claude subscription); the registered profile then becomes
    `session_passive` instead of `session_addressable`."""

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
    """Absolute path to the local checkout/directory Claude Code runs from.
    Switch Console reads it to find the agent's directory on a host, and a
    subagent inherits it from its parent. None when the directory is unknown."""

    subagent_name: str | None = None
    """When set, this agent is a Claude Code *subagent* (a `.claude/agents/*.md`
    definition) rather than a top-level Claude Code install. The value is the
    bare Claude Code subagent identifier (its `name` frontmatter field). Leave
    None for ordinary top-level agents."""

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
            # Claude Code can reset / compact / interrupt only when a session is
            # driving it from Switch Console (which can inject keystrokes and
            # relaunch it). A standalone `claude` session can't be controlled,
            # so all three resolve per live session via AgentRuntimeState.
            command_capabilities=CommandCapabilities(
                reset="session_dependent",
                compact="session_dependent",
                interrupt="session_dependent",
            ),
        )

    def start_session_instructions(
        self,
        options: KnownAgentOptions,
        agent: Agent,
        room_name: str,
        owner_handle: str | None,
        assume_role: str | None = None,
        other_room_names: list[str] | None = None,
        connected_not_live: bool = False,
    ) -> str | None:
        assert isinstance(options, ClaudeCodeOptions)
        if options.channels_enabled:
            return super().start_session_instructions(
                options,
                agent,
                room_name,
                owner_handle,
                assume_role=assume_role,
                other_room_names=other_room_names,
                connected_not_live=connected_not_live,
            )
        # A session_passive agent is never live to Switch, so this reply follows
        # every message addressed to it, including while a session is open and
        # simply has not pulled yet. Lead with pulling from that session, so the
        # operator does not start a duplicate.
        operator = f"my operator @{owner_handle}" if owner_handle else "my operator"
        step = _console_step(self.provider.session_start, agent, room_name, assume_role)
        return (
            f"I read room messages asynchronously, not in real time — {operator} "
            f"has to trigger me to pull the latest messages. They can ask a session "
            f"I already have open to pull this room, or, if none is running, "
            f"{step}\n\n(For me to receive messages in real time instead, sign my "
            f"Claude Code in with an Anthropic account or API key.)"
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
    """Absolute path to the directory the agent runs from. Switch Console reads
    it to find the agent's directory on a host. None when it is unknown."""

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
            # Reset / compact / interrupt only work while Switch Console drives
            # the session; a standalone CLI cannot be controlled, so all three
            # resolve per live session via AgentRuntimeState.
            command_capabilities=CommandCapabilities(
                reset="session_dependent",
                compact="session_dependent",
                interrupt="session_dependent",
            ),
        )


def _console_step(
    start: ConsoleStart, agent: Agent, room_name: str, assume_role: str | None
) -> str:
    """Where in Switch Console to start the session, as an imperative."""
    runtime = (
        f", enable the {start.runtime} runtime in its advanced settings,"
        if start.runtime
        else ""
    )
    role = f" Then ask me to take the **{assume_role}** role." if assume_role else ""
    sign_in = (
        f" Sign in with `{start.sign_in_command}` first if you have not already."
        if start.sign_in_command
        else ""
    )
    return (
        f"open **{agent.name}** in Switch Console{runtime} and start a local "
        f"session in **{room_name}**.{role}{sign_in}"
    )


def _console_start_instructions(
    start: ConsoleStart,
    agent: Agent,
    room_name: str,
    owner_handle: str | None,
    *,
    assume_role: str | None,
    other_room_names: list[str] | None,
    connected_not_live: bool,
) -> str:
    step = _console_step(start, agent, room_name, assume_role)
    # With no owner to tag, the step is addressed to "my operator": a bare
    # imperative would read as an instruction to whoever addressed the agent,
    # who usually cannot act on it.
    lead = f"@{owner_handle} — " if owner_handle else ""
    must = step if owner_handle else f"my operator needs to {step}"
    may = step if owner_handle else f"my operator can {step}"
    if connected_not_live:
        message = (
            f"{lead}I have a session connected to this room, but it isn't "
            f"reporting as live, so I'm not receiving messages. To restart it, "
            f"{must}"
        )
    elif other_room_names:
        where = ", ".join(f"**{name}**" for name in other_room_names)
        message = (
            f"{lead}I don't have a session connected to this room, but I do have "
            f"one in {where} — ask me there to come here, or {may}"
        )
    else:
        message = f"{lead}{must}"
    return message[0].upper() + message[1:]


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
