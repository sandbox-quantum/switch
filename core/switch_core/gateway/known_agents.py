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
        options: KnownAgentOptions,
        agent: Agent,
        room_name: str,
        assume_role: str | None = None,
        other_room_names: list[str] | None = None,
        connected_not_live: bool = False,
    ) -> str | None:
        """Return markdown telling the operator how to start a session that
        connects this agent to the room named `room_name`. Posted
        automatically when the agent is addressed but has no live session,
        and on demand via `!run-cmd`.

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
    """When True, the operator's connector (switchdash) watches every room this
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

    notify_user: str | None = None
    """Username (on the room's bridged platform — Slack/Mattermost handle, or
    a Switch user name) to `@`-mention in the unavailable-session message so
    the operator gets a notification. Bare name, no leading `@`. Leave None
    to post without a mention."""

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

    @field_validator("repo_dir", "notify_user", "subagent_name", mode="before")
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
            # Claude Code can reset / compact / interrupt only when a session is
            # driving it from switchdash (which can inject keystrokes and
            # relaunch it). A standalone `claude` session can't be controlled,
            # so all three resolve per live session via AgentRuntimeState.
            command_capabilities=CommandCapabilities(
                reset="session_dependent",
                compact="session_dependent",
                interrupt="session_dependent",
            ),
        )

    @classmethod
    def start_session_instructions(
        cls,
        options: KnownAgentOptions,
        agent: Agent,
        room_name: str,
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
        # Fold an optional role into the connect prompt itself, so the started
        # session lands in the room AND takes the role in one go.
        prompt = f"connect to switch room {room_name}"
        if assume_role:
            prompt += f" and assume the role {assume_role}"
        # A session_passive session receives no pushed events, so the connect
        # must also pull — fold that into the prompt itself.
        if not options.channels_enabled:
            prompt += " and pull the latest messages"
        cmd = f'cd {dir_token} && claude "{prompt}"{subagent_flags}{flag}'

        if not options.channels_enabled:
            # session_passive: reads asynchronously, so the operator must
            # trigger a pull (from an open session or a fresh one). Mention the
            # configured operator inline so they get pinged.
            operator = (
                f"my operator @{options.notify_user}"
                if options.notify_user
                else "my operator"
            )
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
        prefix = f"@{options.notify_user}\n\n" if options.notify_user else ""
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


class CodexOptions(KnownAgentOptions):
    auto_session: bool = False
    """When True, the operator's connector (switchdash) watches every room this
    agent belongs to and auto-spawns a Codex session — connected to the room and
    wired to the agent's identity — the moment the agent is addressed in a room
    where it has no live session. The registered profile becomes `auto_session`.
    Codex has no plugin-channel of its own; switchdash delivers inbound room
    messages by injecting them into the session's terminal (CHOO-1436)."""

    repo_dir: str | None = None
    """Absolute path to the directory the operator runs Codex from. Used to
    generate a ready-to-paste `cd <repo_dir> && codex "connect to switch room …"`
    command shown when the agent is addressed with no live session. None → a
    `<codex-dir>` placeholder is shown instead."""

    notify_user: str | None = None
    """Username (on the room's bridged platform) to `@`-mention in the
    unavailable-session message so the operator gets a notification. Bare name,
    no leading `@`. None → post without a mention."""

    channels_enabled: bool = True
    """switchdash sends `channels_enabled` for every provider; Codex has no
    connector channel of its own, so it does not affect the registered profile.
    Accepted (and ignored) for request-shape compatibility with the claude-code
    options so the shared registration path needs no special-casing."""

    @field_validator("repo_dir", "notify_user", mode="before")
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
        # switchdash watches + auto-spawns when auto_session; otherwise it keeps a
        # session live and delivers messages by terminal injection, which is the
        # session_addressable model. Codex does not report per-tool events or
        # mediate tool calls (it runs auto-approved), so those lists stay empty —
        # unlike Claude Code, whose PostToolUse hooks report tool activity.
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
        )

    @classmethod
    def start_session_instructions(
        cls,
        options: KnownAgentOptions,
        agent: Agent,
        room_name: str,
        assume_role: str | None = None,
        other_room_names: list[str] | None = None,
        connected_not_live: bool = False,
    ) -> str | None:
        """Build the room-facing onboarding message for a Codex agent.

        Mirrors the Claude Code shape but emits a `codex "…"` command (never a
        `claude` one) and omits Claude-specific flags. Codex sessions are normally
        auto-managed by switchdash, so this fallback is shown mainly when no
        connector is watching.
        """
        assert isinstance(options, CodexOptions)
        dir_token = options.repo_dir if options.repo_dir else "<codex-dir>"
        prompt = f"connect to switch room {room_name}"
        if assume_role:
            prompt += f" and assume the role {assume_role}"
        cmd = f'cd "{dir_token}" && codex "{prompt}"'

        prefix = f"@{options.notify_user}\n\n" if options.notify_user else ""
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
            f"{prefix}{opening}\n\n```\n{cmd}\n```\n\n(or start Codex manually and "
            "ask me to connect to the room.)"
        )


KNOWN_AGENTS: dict[str, type[KnownAgent]] = {
    "claude-code": ClaudeCodeKnownAgent,
    "codex": CodexKnownAgent,
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
