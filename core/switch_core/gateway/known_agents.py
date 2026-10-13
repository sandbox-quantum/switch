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
    ConsoleStart,
    TerminalStart,
    agent_provider,
    agent_providers,
)

if TYPE_CHECKING:
    from switch_core.db.models import Agent


def connect_prompt(
    room_name: str,
    agent_name: str,
    assume_role: str | None,
    also_pull: bool,
) -> str:
    """The natural-language prompt a started session is launched with.

    One directory can hold credentials for several provisioned agents, in which
    case the session has to be told which one it is before it may act. Naming
    the agent in the prompt itself answers that without the operator having to
    know it happens.
    """
    prompt = f"connect to switch room {room_name}"
    if assume_role:
        prompt += f" and assume the role {assume_role}"
    if also_pull:
        prompt += " and pull the latest messages"
    return f"{prompt} — if you are asked which agent you are, you are {agent_name}"


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

    def connect_command(
        self,
        options: KnownAgentOptions,
        agent: Agent,
        room_name: str,
        assume_role: str | None,
    ) -> str | None:
        """The paste-ready shell command that starts this agent connected to
        `room_name`, with no surrounding prose.

        Split out from `start_session_instructions` because the command is the
        one host-specific part: callers that need their own wording around it
        (the addressed-but-offline reply) take the command and write the rest
        themselves, rather than each host restating the same sentences.

        None when no command applies — the same condition that makes
        `start_session_instructions` return None.
        """
        return None

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

        `owner_handle` is the agent owner's account on the platform this room
        is bridged to, @-mentioned so they are actually notified — None when
        the agent has no owner or that owner has claimed no account there, in
        which case the message still posts and simply says "my operator". It
        is passed in rather than read from `options`: the right handle depends
        on which platform the room is on, which the caller knows and a
        per-agent setting could not.

        When `assume_role` is set, the generated connect prompt also tells the
        agent to assume that role on connect (e.g. `!run-cmd @agent @role`).

        When `other_room_names` is set, the agent has no session here but does
        have live session(s) connected to those rooms; the opening sentence
        names them and offers asking there as an alternative to running the
        command.

        When `connected_not_live` is set, a session is bound to THIS room but
        is not reporting as live (e.g. a session_addressable install launched
        without the dev-channels flag); the opening says so and tells the
        operator to relaunch with live channels.

        Default is None — meaning "no onboarding command applies" (e.g.
        always_on agents that aren't operator-driven).
        """
        return None


class ClaudeCodeOptions(KnownAgentOptions):
    channels_enabled: bool = True
    """Whether the Claude Code installation can run with
    `--dangerously-load-development-channels plugin:switch-connector@switch-plugins`
    so the channel server delivers inbound room events. Defaults to True for
    backwards compatibility. Set to False for installations that cannot enable
    that flag (e.g. Vertex AI or other managed setups without a Claude
    subscription); the registered profile then becomes `session_passive`
    instead of `session_addressable`."""

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
    """Absolute path to the local checkout/directory the operator runs Claude
    Code from. When set, Switch uses it to generate ready-to-paste terminal
    commands (`cd <repo_dir> && claude "connect to switch room ..."`) shown
    in rooms whenever someone tries to address this agent while no session is
    active. Leave None if the directory is unknown — a fallback guidance
    message is shown instead."""

    subagent_name: str | None = None
    """When set, this agent is a Claude Code *subagent* (a `.claude/agents/*.md`
    definition) rather than a top-level Claude Code install. The value is the
    bare Claude Code subagent identifier (its `name` frontmatter field). Switch
    uses it to launch the session as that subagent: the generated connect
    command gains `--agent <subagent_name>` (adopt the subagent persona/tools/
    model) and `--settings .claude/switch-subagents/<subagent_name>.settings.json`
    (a settings file holding this subagent's own SWITCH_* credentials, so the
    session authenticates to Switch as the subagent, not the parent). Leave
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
            task_protocol=TaskProtocolConfig(can_delegate=True, can_accept=True),
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

    def connect_command(
        self,
        options: KnownAgentOptions,
        agent: Agent,
        room_name: str,
        assume_role: str | None,
    ) -> str | None:
        assert isinstance(options, ClaudeCodeOptions)
        # Channels-enabled installations need the dev-channels flag so the
        # plugin can deliver inbound events; without channels the flag is a
        # no-op (e.g. Vertex AI / Bedrock installations).
        flag = (
            " --dangerously-load-development-channels plugin:switch-connector@switch-plugins"
            if options.channels_enabled
            else ""
        )
        # Use a `<claude-dir>` placeholder when the operator hasn't configured
        # a directory — the command is still useful, the operator just has to
        # substitute their own path.
        dir_token = options.repo_dir if options.repo_dir else "<claude-dir>"
        # Subagents launch as their own session: `--agent <name>` adopts the
        # subagent persona, and `--settings <file>` points at a settings file
        # holding the subagent's own SWITCH_* credentials so the session
        # authenticates to Switch as the subagent rather than the parent. The
        # settings path is relative to the directory we `cd` into above.
        subagent_flags = ""
        if options.subagent_name:
            settings_path = (
                f".claude/switch-subagents/{options.subagent_name}.settings.json"
            )
            subagent_flags = (
                f" --agent {options.subagent_name} --settings {settings_path}"
            )
        # A session_passive session receives no pushed events, so the connect
        # must also pull — fold that into the prompt itself.
        prompt = connect_prompt(
            room_name,
            agent.name,
            assume_role,
            also_pull=not options.channels_enabled,
        )
        return f'cd {dir_token} && claude "{prompt}"{subagent_flags}{flag}'

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
        """Build the room-facing onboarding message.

        Shape depends on the install's connection model:

        - channels disabled (session_passive): the agent reads asynchronously,
          so the message says the operator must trigger a pull, the connect
          command itself includes "and pull the latest messages", and a note
          explains real-time delivery needs an Anthropic API key / subscription.
        - channels enabled (session_addressable): the usual connect command.
          `connected_not_live` switches the opening to "a session is connected
          here but isn't live" (operator likely launched it without the
          dev-channels flag); `other_room_names` points the asker at live
          sessions in genuinely different rooms instead.
        """
        assert isinstance(options, ClaudeCodeOptions)
        cmd = self.connect_command(options, agent, room_name, assume_role)

        if not options.channels_enabled:
            # session_passive: reads asynchronously, so the operator must
            # trigger a pull (from an open session or a fresh one). Mention the
            # configured operator inline so they get pinged.
            operator = f"my operator @{owner_handle}" if owner_handle else "my operator"
            return (
                f"I read room messages asynchronously, not in real time — "
                f"{operator} has to trigger me to pull the latest messages. "
                f"They can use a session I already have open, or start a new "
                f"one:\n\n```\n{cmd}\n```\n\n(For me to process messages in real "
                f"time instead, run my Claude Code with an Anthropic API key or "
                f"subscription so live channels can be enabled.)"
            )

        # session_addressable: an optional @-mention so the operator gets a
        # push from the bridged platform. The bridge re-parses these as
        # addressed events.
        prefix = f"@{owner_handle}\n\n" if owner_handle else ""
        if connected_not_live:
            opening = (
                "I have a session connected to this room, but it isn't "
                "reporting as live, so I'm not receiving messages. If it's "
                "still running it was likely started without live channels — "
                "relaunch it, or start a fresh session, with:"
            )
        elif other_room_names:
            where = ", ".join(f"**{name}**" for name in other_room_names)
            opening = (
                f"I don't have a session connected to this room right now, but "
                f"I do have other session(s) connected to {where}. Either ask me "
                "in one of those rooms to come here, or start a new session "
                "connected to this room — my operator should run:"
            )
        else:
            opening = (
                "I don't have a session connected to this room. To set up a new "
                "session connected to this room, my operator should run:"
            )
        return (
            f"{prefix}{opening}\n\n```\n{cmd}\n```\n\n(or start Claude Code "
            "manually and ask me to connect to the room.)"
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
    """Absolute path to the directory the operator runs the agent from, used in
    the start command shown when the agent is addressed with no live session.
    None shows a `<provider-dir>` placeholder instead."""

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

    def connect_command(
        self,
        options: KnownAgentOptions,
        agent: Agent,
        room_name: str,
        assume_role: str | None,
    ) -> str | None:
        assert isinstance(options, GenericAgentOptions)
        start = self.provider.session_start
        if not isinstance(start, TerminalStart):
            return None
        dir_token = (
            options.repo_dir if options.repo_dir else f"<{self.provider.id}-dir>"
        )
        prompt = connect_prompt(room_name, agent.name, assume_role, also_pull=False)
        return f'cd "{dir_token}" && ' + start.command.replace("{prompt}", prompt)

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
        """Build the room-facing onboarding message: the start command for a
        provider started from a terminal, else how to start it from Switch
        Console. These sessions are normally auto-managed by Switch Console, so
        this is shown mainly when no connector is watching."""
        assert isinstance(options, GenericAgentOptions)
        start = self.provider.session_start
        if isinstance(start, ConsoleStart):
            return _console_start_instructions(start, agent, room_name, owner_handle)
        cmd = self.connect_command(options, agent, room_name, assume_role)
        prefix = f"@{owner_handle}\n\n" if owner_handle else ""
        if connected_not_live:
            opening = (
                "I have a session connected to this room, but it isn't reporting "
                "as live, so I'm not receiving messages. Relaunch it, or start a "
                "fresh session, with:"
            )
        elif other_room_names:
            where = ", ".join(f"**{name}**" for name in other_room_names)
            opening = (
                f"I don't have a session connected to this room right now, but I "
                f"do have other session(s) connected to {where}. Either ask me in "
                "one of those rooms to come here, or start a new session connected "
                "to this room — my operator should run:"
            )
        else:
            opening = (
                "I don't have a session connected to this room. To set up a new "
                "session connected to this room, my operator should run:"
            )
        return (
            f"{prefix}{opening}\n\n```\n{cmd}\n```\n\n(or start "
            f"{self.provider.label} manually and ask me to connect to the room.)"
        )


def _console_start_instructions(
    start: ConsoleStart, agent: Agent, room_name: str, owner_handle: str | None
) -> str:
    prefix = f"{owner_handle} — " if owner_handle else ""
    runtime = (
        f", enable the {start.runtime} runtime in its advanced settings,"
        if start.runtime
        else ""
    )
    sign_in = (
        f" Sign in with `{start.sign_in_command}` first if you have not already."
        if start.sign_in_command
        else ""
    )
    return (
        f"{prefix}open **{agent.name}** in Switch Console{runtime} and start a "
        f"local session in **{room_name}**.{sign_in}"
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
