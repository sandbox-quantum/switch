from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.bridges.agent.protocol.types import (
    CommandCapabilities,
    IntegrationProfile,
)
from switch_core.gateway.known_agents import (
    ClaudeCodeKnownAgent,
    ClaudeCodeOptions,
    GenericAgentOptions,
    GenericKnownAgent,
    known_agent_for,
    known_agents,
)

CLAUDE = known_agents()["claude-code"]
CODEX = known_agents()["codex"]
OPENCODE = known_agents()["opencode"]
ANTIGRAVITY = known_agents()["antigravity"]
CURSOR = known_agents()["cursor"]


def _agent(metadata: dict | None) -> SimpleNamespace:
    return SimpleNamespace(name="claude-code.test", metadata_=metadata)


class TestBuildProfileConnectionModel:
    def test_channels_enabled_defaults_to_session_addressable(self) -> None:
        profile = CLAUDE.build_profile(ClaudeCodeOptions(channels_enabled=True))
        assert profile.connection_model == "session_addressable"

    def test_auto_session_option_sets_auto_session_model(self) -> None:
        profile = CLAUDE.build_profile(
            ClaudeCodeOptions(channels_enabled=True, auto_session=True)
        )
        assert profile.connection_model == "auto_session"

    def test_auto_session_takes_precedence_without_channels(self) -> None:
        # Auto-spawn is driven by the connector's HTTP notification watch and a
        # pull-on-connect, not a live channel push, so auto_session applies even
        # when channels are disabled.
        profile = CLAUDE.build_profile(
            ClaudeCodeOptions(channels_enabled=False, auto_session=True)
        )
        assert profile.connection_model == "auto_session"

    def test_channels_disabled_without_auto_session_is_session_passive(self) -> None:
        profile = CLAUDE.build_profile(ClaudeCodeOptions(channels_enabled=False))
        assert profile.connection_model == "session_passive"

    def test_auto_session_defaults_off(self) -> None:
        assert ClaudeCodeOptions(channels_enabled=True).auto_session is False


class TestBuildProfileCommandCapabilities:
    def test_claude_code_commands_are_session_dependent(self) -> None:
        # Claude Code can be reset/compacted/interrupted only when a session is
        # driving it from Switch Console — so all three depend on the live session.
        caps = CLAUDE.build_profile(
            ClaudeCodeOptions(channels_enabled=True)
        ).command_capabilities
        assert caps.reset == "session_dependent"
        assert caps.compact == "session_dependent"
        assert caps.interrupt == "session_dependent"


class TestCodexKnownAgent:
    def test_registered_under_codex_key(self) -> None:
        assert isinstance(CODEX, GenericKnownAgent)
        assert CODEX.connector_type == "Codex CLI"

    def test_default_profile_is_session_addressable(self) -> None:
        profile = CODEX.build_profile(GenericAgentOptions())
        assert profile.connection_model == "session_addressable"

    def test_auto_session_sets_auto_session_model(self) -> None:
        profile = CODEX.build_profile(GenericAgentOptions(auto_session=True))
        assert profile.connection_model == "auto_session"

    def test_no_tool_call_mediation_or_reporting(self) -> None:
        # Codex runs auto-approved and reports lifecycle hooks only (not per-tool
        # events), unlike Claude Code.
        profile = CODEX.build_profile(GenericAgentOptions())
        assert profile.pre_invocation_mediation == []
        assert profile.event_reporting == []

    def test_commands_are_session_dependent(self) -> None:
        # Codex is a TUI driven by Switch Console keystroke injection, same as Claude
        # Code — so reset/compact/interrupt depend on a live managed session.
        # Must stay in step with `BY_PROVIDER.codex` in Switch Console's
        # `main/core/switch-rooms/session-control.ts`; declaring a command here
        # that Switch Console cannot execute yields a worse message than "unsupported".
        caps = CODEX.build_profile(GenericAgentOptions()).command_capabilities
        assert caps.reset == "session_dependent"
        assert caps.compact == "session_dependent"
        assert caps.interrupt == "session_dependent"

    def test_channels_enabled_is_dropped_not_offered_as_an_option(self) -> None:
        # Switch Console sends channels_enabled for every provider, so registration
        # must still accept it — but Codex has no channel, so it is not a field.
        # The gateway renders the options form from this schema; a declared field
        # would be an interactive control that changes nothing.
        assert (
            "channels_enabled"
            not in GenericAgentOptions.model_json_schema()["properties"]
        )

        opts = GenericAgentOptions.model_validate({"channels_enabled": False})
        assert "channels_enabled" not in opts.model_dump()
        assert CODEX.build_profile(opts).connection_model == "session_addressable"

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
        assert spec.provider.id == "codex"
        assert isinstance(options, GenericAgentOptions)
        assert options.auto_session is True
        assert options.repo_dir == "/tmp/r"


class TestOpenCodeKnownAgent:
    def test_registered_under_opencode_key(self) -> None:
        assert isinstance(OPENCODE, GenericKnownAgent)
        assert OPENCODE.connector_type == "OpenCode CLI"

    def test_default_profile_is_session_addressable(self) -> None:
        profile = OPENCODE.build_profile(GenericAgentOptions())
        assert profile.connection_model == "session_addressable"

    def test_auto_session_sets_auto_session_model(self) -> None:
        profile = OPENCODE.build_profile(GenericAgentOptions(auto_session=True))
        assert profile.connection_model == "auto_session"

    def test_no_tool_call_mediation_or_reporting(self) -> None:
        # OpenCode's connector reports activity to Switch Console over the local
        # hook port to drive session status; none of it reaches Switch as
        # reported events, and nothing gates a tool call before it runs.
        profile = OPENCODE.build_profile(GenericAgentOptions())
        assert profile.pre_invocation_mediation == []
        assert profile.post_invocation_mediation == []
        assert profile.event_reporting == []

    def test_commands_are_session_dependent(self) -> None:
        # Must stay in step with `BY_PROVIDER.opencode` in Switch Console's
        # `main/core/switch-rooms/session-control.ts`; declaring a command here
        # that Switch Console cannot execute yields a worse message than
        # "unsupported".
        caps = OPENCODE.build_profile(GenericAgentOptions()).command_capabilities
        assert caps.reset == "session_dependent"
        assert caps.compact == "session_dependent"
        assert caps.interrupt == "session_dependent"

    def test_channels_enabled_is_dropped_not_offered_as_an_option(self) -> None:
        # Switch Console sends channels_enabled for every provider, so registration
        # must still accept it — but OpenCode has no channel, so it is not a
        # field. The gateway renders the options form from this schema; a
        # declared field would be an interactive control that changes nothing.
        assert (
            "channels_enabled"
            not in GenericAgentOptions.model_json_schema()["properties"]
        )

        opts = GenericAgentOptions.model_validate({"channels_enabled": False})
        assert "channels_enabled" not in opts.model_dump()
        assert OPENCODE.build_profile(opts).connection_model == "session_addressable"

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
        assert spec.provider.id == "opencode"
        assert isinstance(options, GenericAgentOptions)
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
        assert isinstance(spec, ClaudeCodeKnownAgent)
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
        assert isinstance(ANTIGRAVITY, GenericKnownAgent)
        for auto_session, expected in [
            (False, "session_addressable"),
            (True, "auto_session"),
        ]:
            profile = ANTIGRAVITY.build_profile(
                GenericAgentOptions(auto_session=auto_session)
            )
            assert profile.connection_model == expected
            assert profile.message_exchange
            assert profile.command_capabilities.interrupt == "session_dependent"
            assert profile.pre_invocation_mediation == []


class TestCursorKnownAgent:
    def test_registry_and_profile(self) -> None:
        assert isinstance(CURSOR, GenericKnownAgent)
        for auto_session, expected in [
            (False, "session_addressable"),
            (True, "auto_session"),
        ]:
            profile = CURSOR.build_profile(
                GenericAgentOptions(auto_session=auto_session)
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
            (GenericAgentOptions, "repo_dir"),
        ],
    )
    def test_blank_string_becomes_none(self, options_cls: type, field: str) -> None:
        # The gateway edit form submits "" when a field is cleared.
        assert getattr(options_cls.model_validate({field: " "}), field) is None


_SESSION_DEPENDENT = CommandCapabilities(
    reset="session_dependent",
    compact="session_dependent",
    interrupt="session_dependent",
)


@pytest.mark.parametrize(
    ("known_agent_type", "connector_type", "tools", "reported"),
    [
        (
            "claude-code",
            "Claude Code",
            [
                "Bash",
                "Edit",
                "Write",
                "Read",
                "Glob",
                "Grep",
                "NotebookEdit",
                "Agent",
                "WebFetch",
                "WebSearch",
                "Monitor",
                "Skill",
            ],
            ["tool_calls"],
        ),
        ("codex", "Codex CLI", ["Shell", "ApplyPatch", "Read"], []),
        (
            "opencode",
            "OpenCode CLI",
            [
                "Bash",
                "Edit",
                "Write",
                "Read",
                "Grep",
                "Glob",
                "List",
                "WebFetch",
                "Task",
            ],
            [],
        ),
        (
            "antigravity",
            "Antigravity CLI",
            [
                "run_command",
                "write_to_file",
                "replace_file_content",
                "multi_replace_file_content",
                "view_file",
                "grep_search",
                "find_by_name",
                "list_dir",
                "read_url_content",
                "search_web",
                "call_mcp_tool",
                "invoke_subagent",
            ],
            [],
        ),
        (
            "cursor",
            "Cursor CLI",
            ["shell", "read_file", "write", "str_replace", "grep", "glob"],
            [],
        ),
        (
            "kimi",
            "Kimi Code CLI",
            [],
            [],
        ),
    ],
)
def test_every_stored_known_agent_type_resolves_as_before(
    known_agent_type: str, connector_type: str, tools: list[str], reported: list[str]
) -> None:
    """Agents carry their `known_agent_type` and options in metadata; each one
    already stored must keep resolving to the same connector type, tools and
    profile."""
    for auto_session in (False, True):
        agent = _agent(
            {
                "known_agent_type": known_agent_type,
                "known_agent_options": {"auto_session": auto_session, "repo_dir": "/r"},
            }
        )
        resolved = known_agent_for(agent)
        assert resolved is not None
        spec, options = resolved
        assert spec.connector_type == connector_type
        assert [tool.name for tool in spec.tools] == tools
        assert spec.models == []
        assert options.model_dump()["repo_dir"] == "/r"
        assert spec.build_profile(options) == IntegrationProfile(
            connection_model="auto_session" if auto_session else "session_addressable",
            message_exchange=True,
            pre_invocation_mediation=reported,
            post_invocation_mediation=[],
            event_reporting=reported,
            command_capabilities=_SESSION_DEPENDENT,
        )
