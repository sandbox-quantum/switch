from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.gateway.known_agents import (
    KNOWN_AGENTS,
    AntigravityKnownAgent,
    AntigravityOptions,
    ClaudeCodeKnownAgent,
    ClaudeCodeOptions,
    CodexKnownAgent,
    CodexOptions,
    CursorKnownAgent,
    CursorOptions,
    OpenCodeKnownAgent,
    OpenCodeOptions,
    known_agent_for,
)


def _agent(metadata: dict | None) -> SimpleNamespace:
    return SimpleNamespace(name="claude-code.test", metadata_=metadata)


def _agent_named(name: str) -> SimpleNamespace:
    return SimpleNamespace(name=name, metadata_={})


class TestBuildProfileConnectionModel:
    def test_channels_enabled_defaults_to_session_addressable(self) -> None:
        profile = ClaudeCodeKnownAgent.build_profile(
            ClaudeCodeOptions(channels_enabled=True)
        )
        assert profile.connection_model == "session_addressable"

    def test_auto_session_option_sets_auto_session_model(self) -> None:
        profile = ClaudeCodeKnownAgent.build_profile(
            ClaudeCodeOptions(channels_enabled=True, auto_session=True)
        )
        assert profile.connection_model == "auto_session"

    def test_auto_session_takes_precedence_without_channels(self) -> None:
        # Auto-spawn is driven by the connector's HTTP notification watch and a
        # pull-on-connect, not a live channel push, so auto_session applies even
        # when channels are disabled.
        profile = ClaudeCodeKnownAgent.build_profile(
            ClaudeCodeOptions(channels_enabled=False, auto_session=True)
        )
        assert profile.connection_model == "auto_session"

    def test_channels_disabled_without_auto_session_is_session_passive(self) -> None:
        profile = ClaudeCodeKnownAgent.build_profile(
            ClaudeCodeOptions(channels_enabled=False)
        )
        assert profile.connection_model == "session_passive"

    def test_auto_session_defaults_off(self) -> None:
        assert ClaudeCodeOptions(channels_enabled=True).auto_session is False


class TestBuildProfileCommandCapabilities:
    def test_claude_code_commands_are_session_dependent(self) -> None:
        # Claude Code can be reset/compacted/interrupted only when a session is
        # driving it from Switch Console — so all three depend on the live session.
        caps = ClaudeCodeKnownAgent.build_profile(
            ClaudeCodeOptions(channels_enabled=True)
        ).command_capabilities
        assert caps.reset == "session_dependent"
        assert caps.compact == "session_dependent"
        assert caps.interrupt == "session_dependent"


class TestCodexKnownAgent:
    def test_registered_under_codex_key(self) -> None:
        assert KNOWN_AGENTS.get("codex") is CodexKnownAgent
        assert CodexKnownAgent.connector_type == "Codex CLI"

    def test_default_profile_is_session_addressable(self) -> None:
        profile = CodexKnownAgent.build_profile(CodexOptions())
        assert profile.connection_model == "session_addressable"

    def test_auto_session_sets_auto_session_model(self) -> None:
        profile = CodexKnownAgent.build_profile(CodexOptions(auto_session=True))
        assert profile.connection_model == "auto_session"

    def test_no_tool_call_mediation_or_reporting(self) -> None:
        # Codex runs auto-approved and reports lifecycle hooks only (not per-tool
        # events), unlike Claude Code.
        profile = CodexKnownAgent.build_profile(CodexOptions())
        assert profile.pre_invocation_mediation == []
        assert profile.event_reporting == []

    def test_can_delegate_and_accept_tasks(self) -> None:
        profile = CodexKnownAgent.build_profile(CodexOptions())
        assert profile.task_protocol.can_delegate is True
        assert profile.task_protocol.can_accept is True

    def test_commands_are_session_dependent(self) -> None:
        # Codex is a TUI driven by Switch Console keystroke injection, same as Claude
        # Code — so reset/compact/interrupt depend on a live managed session.
        # Must stay in step with `BY_PROVIDER.codex` in Switch Console's
        # `main/core/switch-rooms/session-control.ts`; declaring a command here
        # that Switch Console cannot execute yields a worse message than "unsupported".
        caps = CodexKnownAgent.build_profile(CodexOptions()).command_capabilities
        assert caps.reset == "session_dependent"
        assert caps.compact == "session_dependent"
        assert caps.interrupt == "session_dependent"

    def test_channels_enabled_is_dropped_not_offered_as_an_option(self) -> None:
        # Switch Console sends channels_enabled for every provider, so registration
        # must still accept it — but Codex has no channel, so it is not a field.
        # The gateway renders the options form from this schema; a declared field
        # would be an interactive control that changes nothing.
        assert "channels_enabled" not in CodexOptions.model_json_schema()["properties"]

        opts = CodexOptions.model_validate({"channels_enabled": False})
        assert "channels_enabled" not in opts.model_dump()
        assert (
            CodexKnownAgent.build_profile(opts).connection_model
            == "session_addressable"
        )

    def test_known_agent_for_round_trips_codex(self) -> None:
        agent = _agent(
            {
                "known_agent_type": "codex",
                "known_agent_options": {"auto_session": True, "repo_dir": "/tmp/r"},
            }
        )
        result = known_agent_for(agent)
        assert result is not None
        spec, options = result
        assert spec is CodexKnownAgent
        assert isinstance(options, CodexOptions)
        assert options.auto_session is True
        assert options.repo_dir == "/tmp/r"


class TestOpenCodeKnownAgent:
    def test_registered_under_opencode_key(self) -> None:
        assert KNOWN_AGENTS.get("opencode") is OpenCodeKnownAgent
        assert OpenCodeKnownAgent.connector_type == "OpenCode CLI"

    def test_default_profile_is_session_addressable(self) -> None:
        profile = OpenCodeKnownAgent.build_profile(OpenCodeOptions())
        assert profile.connection_model == "session_addressable"

    def test_auto_session_sets_auto_session_model(self) -> None:
        profile = OpenCodeKnownAgent.build_profile(OpenCodeOptions(auto_session=True))
        assert profile.connection_model == "auto_session"

    def test_no_tool_call_mediation_or_reporting(self) -> None:
        # OpenCode's connector reports activity to Switch Console over the local
        # hook port to drive session status; none of it reaches Switch as
        # reported events, and nothing gates a tool call before it runs.
        profile = OpenCodeKnownAgent.build_profile(OpenCodeOptions())
        assert profile.pre_invocation_mediation == []
        assert profile.post_invocation_mediation == []
        assert profile.event_reporting == []

    def test_can_delegate_and_accept_tasks(self) -> None:
        profile = OpenCodeKnownAgent.build_profile(OpenCodeOptions())
        assert profile.task_protocol.can_delegate is True
        assert profile.task_protocol.can_accept is True

    def test_commands_are_session_dependent(self) -> None:
        # Must stay in step with `BY_PROVIDER.opencode` in Switch Console's
        # `main/core/switch-rooms/session-control.ts`; declaring a command here
        # that Switch Console cannot execute yields a worse message than
        # "unsupported".
        caps = OpenCodeKnownAgent.build_profile(OpenCodeOptions()).command_capabilities
        assert caps.reset == "session_dependent"
        assert caps.compact == "session_dependent"
        assert caps.interrupt == "session_dependent"

    def test_channels_enabled_is_dropped_not_offered_as_an_option(self) -> None:
        # Switch Console sends channels_enabled for every provider, so registration
        # must still accept it — but OpenCode has no channel, so it is not a
        # field. The gateway renders the options form from this schema; a
        # declared field would be an interactive control that changes nothing.
        assert (
            "channels_enabled" not in OpenCodeOptions.model_json_schema()["properties"]
        )

        opts = OpenCodeOptions.model_validate({"channels_enabled": False})
        assert "channels_enabled" not in opts.model_dump()
        assert (
            OpenCodeKnownAgent.build_profile(opts).connection_model
            == "session_addressable"
        )

    def test_known_agent_for_round_trips_opencode(self) -> None:
        agent = _agent(
            {
                "known_agent_type": "opencode",
                "known_agent_options": {"auto_session": True, "repo_dir": "/tmp/r"},
            }
        )
        result = known_agent_for(agent)
        assert result is not None
        spec, options = result
        assert spec is OpenCodeKnownAgent
        assert isinstance(options, OpenCodeOptions)
        assert options.auto_session is True
        assert options.repo_dir == "/tmp/r"


class TestKnownAgentFor:
    def test_round_trips_claude_code_options(self) -> None:
        agent = _agent(
            {
                "known_agent_type": "claude-code",
                "known_agent_options": {
                    "channels_enabled": False,
                    "repo_dir": "/tmp/r",
                },
            }
        )
        result = known_agent_for(agent)
        assert result is not None
        spec, options = result
        assert spec is ClaudeCodeKnownAgent
        assert isinstance(options, ClaudeCodeOptions)
        assert options.channels_enabled is False
        assert options.repo_dir == "/tmp/r"

    def test_round_trips_subagent_name(self) -> None:
        agent = _agent(
            {
                "known_agent_type": "claude-code",
                "known_agent_options": {
                    "channels_enabled": True,
                    "repo_dir": "/tmp/r",
                    "subagent_name": "seo-writer",
                },
            }
        )
        result = known_agent_for(agent)
        assert result is not None
        _, options = result
        assert isinstance(options, ClaudeCodeOptions)
        assert options.subagent_name == "seo-writer"

    def test_returns_none_when_metadata_missing(self) -> None:
        assert known_agent_for(_agent(None)) is None
        assert known_agent_for(_agent({})) is None

    def test_returns_none_for_unknown_agent_type(self) -> None:
        agent = _agent({"known_agent_type": "made-up"})
        assert known_agent_for(agent) is None

    def test_returns_none_when_agent_type_is_not_a_string(self) -> None:
        agent = _agent({"known_agent_type": 42})
        assert known_agent_for(agent) is None

    def test_returns_none_for_non_dict_metadata(self) -> None:
        # JSONB columns can hold any JSON value; some pre-existing rows
        # stored a list. Tolerate non-dict metadata.
        agent = _agent([])  # type: ignore[arg-type]
        assert known_agent_for(agent) is None

    def test_uses_option_defaults_when_options_missing(self) -> None:
        agent = _agent({"known_agent_type": "claude-code"})
        result = known_agent_for(agent)
        assert result is not None
        _, options = result
        assert isinstance(options, ClaudeCodeOptions)
        assert options.channels_enabled is True
        assert options.repo_dir is None


class TestAntigravityKnownAgent:
    def test_registry_and_profile(self) -> None:
        assert KNOWN_AGENTS["antigravity"] is AntigravityKnownAgent
        for auto_session, expected in [
            (False, "session_addressable"),
            (True, "auto_session"),
        ]:
            profile = AntigravityKnownAgent.build_profile(
                AntigravityOptions(auto_session=auto_session)
            )
            assert profile.connection_model == expected
            assert profile.message_exchange
            assert profile.command_capabilities.interrupt == "session_dependent"
            assert profile.pre_invocation_mediation == []


class TestCursorKnownAgent:
    def test_registry_and_profile(self) -> None:
        assert KNOWN_AGENTS["cursor"] is CursorKnownAgent
        for auto_session, expected in [
            (False, "session_addressable"),
            (True, "auto_session"),
        ]:
            profile = CursorKnownAgent.build_profile(
                CursorOptions(auto_session=auto_session)
            )
            assert profile.connection_model == expected
            assert profile.message_exchange
            assert profile.command_capabilities.interrupt == "session_dependent"
            assert profile.pre_invocation_mediation == []


class TestBlankOptionsAreNormalised:
    @pytest.mark.parametrize(
        ("options_cls", "field"),
        [
            (ClaudeCodeOptions, "repo_dir"),
            (ClaudeCodeOptions, "subagent_name"),
            (CodexOptions, "repo_dir"),
            (OpenCodeOptions, "repo_dir"),
            (AntigravityOptions, "repo_dir"),
            (CursorOptions, "repo_dir"),
        ],
    )
    def test_blank_string_becomes_none(self, options_cls: type, field: str) -> None:
        # The gateway edit form submits "" when a field is cleared.
        assert getattr(options_cls.model_validate({field: " "}), field) is None


_ALL_KNOWN_AGENTS = list(KNOWN_AGENTS.values())


class TestStartSessionInstructions:
    """The reply posted when a known agent is addressed with no live session.

    Every provider gets the same answer: start it from Switch Console. A CLI
    started by hand in a terminal gets none of the Switch tools, so no terminal
    command is ever offered.
    """

    @pytest.mark.parametrize("spec", _ALL_KNOWN_AGENTS)
    def test_points_at_switch_console_and_offers_no_command(self, spec: type) -> None:
        msg = spec.start_session_instructions(
            _agent_named("worker.test"), "cmcd", None, False
        )
        assert msg.startswith("@cmcd — ")
        assert "I don't have a session connected to this room." in msg
        assert "opening **worker.test** in Switch Console" in msg
        assert "```" not in msg
        assert "connect to switch room" not in msg

    @pytest.mark.parametrize("spec", _ALL_KNOWN_AGENTS)
    def test_an_unlinked_owner_is_named_without_a_mention(self, spec: type) -> None:
        msg = spec.start_session_instructions(
            _agent_named("worker.test"), None, None, False
        )
        assert not msg.startswith("@")
        assert "My owner can start one" in msg

    def test_a_live_session_elsewhere_is_offered_first(self) -> None:
        msg = CodexKnownAgent.start_session_instructions(
            _agent_named("worker.test"), "cmcd", ["Hub", "Ops"], False
        )
        assert "I do have one in **Hub**, **Ops**" in msg
        assert "Ask me there" in msg
        assert "```" not in msg

    def test_a_session_here_that_is_not_live_asks_for_a_restart(self) -> None:
        msg = ClaudeCodeKnownAgent.start_session_instructions(
            _agent_named("worker.test"), "cmcd", None, True
        )
        assert "isn't reporting as live" in msg
        assert "You can restart it by opening **worker.test** in Switch Console" in msg
        assert "```" not in msg
