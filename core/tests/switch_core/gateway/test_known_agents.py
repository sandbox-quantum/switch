from __future__ import annotations

from types import SimpleNamespace

from switch_core.gateway.known_agents import (
    KNOWN_AGENTS,
    ClaudeCodeKnownAgent,
    ClaudeCodeOptions,
    CodexKnownAgent,
    CodexOptions,
    OpenCodeKnownAgent,
    OpenCodeOptions,
    known_agent_for,
)


def _agent(metadata: dict | None) -> SimpleNamespace:
    return SimpleNamespace(name="claude-code.test", metadata_=metadata)


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


class TestStartSessionInstructions:
    def test_channels_enabled_appends_dev_flag_after_prompt(self) -> None:
        opts = ClaudeCodeOptions(channels_enabled=True, repo_dir="/Users/x/aq-switch")
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        # The flag must come AFTER the prompt argument so claude treats the
        # quoted text as the initial prompt, not as a value for the flag.
        assert (
            'claude "connect to switch room hub" '
            "--dangerously-load-development-channels "
            "plugin:switch-connector@switch-plugins"
        ) in msg
        assert "cd /Users/x/aq-switch" in msg

    def test_channels_disabled_passive_message_shape(self) -> None:
        opts = ClaudeCodeOptions(channels_enabled=False, repo_dir="/srv/agent")
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "ops")
        assert msg is not None
        assert "--dangerously-load-development-channels" not in msg
        # The connect prompt itself instructs a pull (passive sessions get no
        # pushed events), and the message frames reading as asynchronous.
        assert (
            'cd /srv/agent && claude "connect to switch room ops '
            'and pull the latest messages"'
        ) in msg
        assert "asynchronously" in msg
        # Real-time delivery requires an API-key / subscription Claude Code.
        assert "Anthropic API key or subscription" in msg

    def test_channels_enabled_is_not_passive_shaped(self) -> None:
        opts = ClaudeCodeOptions(channels_enabled=True, repo_dir="/srv/agent")
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "ops")
        assert msg is not None
        assert "pull the latest messages" not in msg
        assert "Anthropic API key or subscription" not in msg

    def test_channels_disabled_auto_session_keeps_pull_based_message(self) -> None:
        # A channels-off auto_session agent falls back to the pull-based
        # onboarding message when no connector is watching — the onboarding
        # command depends only on channels_enabled, not the connection model.
        opts = ClaudeCodeOptions(
            channels_enabled=False, auto_session=True, repo_dir="/srv/agent"
        )
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "ops")
        assert msg is not None
        assert "--dangerously-load-development-channels" not in msg
        assert (
            'cd /srv/agent && claude "connect to switch room ops '
            'and pull the latest messages"'
        ) in msg

    def test_connected_not_live_opening(self) -> None:
        opts = ClaudeCodeOptions(channels_enabled=True, repo_dir="/srv/agent")
        msg = ClaudeCodeKnownAgent.start_session_instructions(
            opts, _agent({}), "ops", connected_not_live=True
        )
        assert msg is not None
        # Acknowledges a connected-but-not-live session and steers to relaunch
        # with live channels (the flag is in the command), rather than implying
        # there is no session.
        assert "isn't reporting as live" in msg
        assert "I don't have a session connected to this room." not in msg
        assert "--dangerously-load-development-channels" in msg

    def test_no_repo_dir_uses_placeholder(self) -> None:
        opts = ClaudeCodeOptions(channels_enabled=True, repo_dir=None)
        msg = ClaudeCodeKnownAgent.start_session_instructions(
            opts, _agent({}), "triage"
        )
        assert msg is not None
        assert "cd <claude-dir>" in msg
        # Still the channels flag because channels_enabled is True.
        assert "--dangerously-load-development-channels" in msg
        # No user-facing mention of the option name.
        assert "repo_dir" not in msg

    def test_empty_string_repo_dir_normalised_to_none(self) -> None:
        # The gateway edit form submits "" when the field is cleared.
        opts = ClaudeCodeOptions(channels_enabled=False, repo_dir="")
        assert opts.repo_dir is None
        msg = ClaudeCodeKnownAgent.start_session_instructions(
            opts, _agent({}), "triage"
        )
        assert msg is not None
        assert "cd <claude-dir>" in msg

    def test_notify_user_is_prepended_as_at_mention(self) -> None:
        opts = ClaudeCodeOptions(
            channels_enabled=True, repo_dir="/x", notify_user="louisa"
        )
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert msg.startswith("@louisa\n\n")

    def test_empty_string_notify_user_normalised_to_none(self) -> None:
        opts = ClaudeCodeOptions(channels_enabled=True, notify_user="")
        assert opts.notify_user is None
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert not msg.startswith("@")

    def test_passive_mentions_operator_inline(self) -> None:
        # Passive message names the operator inline ("my operator @louisa")
        # rather than as a leading prefix, so they still get pinged to pull.
        opts = ClaudeCodeOptions(
            channels_enabled=False, repo_dir="/x", notify_user="louisa"
        )
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert "my operator @louisa" in msg

    def test_passive_without_notify_user_says_my_operator(self) -> None:
        opts = ClaudeCodeOptions(channels_enabled=False, repo_dir="/x")
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert "my operator has to trigger me" in msg
        assert "@" not in msg

    def test_subagent_name_appends_agent_and_settings_flags(self) -> None:
        opts = ClaudeCodeOptions(
            channels_enabled=True,
            repo_dir="/Users/x/repo",
            subagent_name="seo-writer",
        )
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        # --agent / --settings come after the quoted prompt and before the
        # dev-channels flag; the settings path matches what the configure skill
        # writes the subagent credentials to.
        assert (
            'claude "connect to switch room hub" '
            "--agent seo-writer "
            "--settings .claude/switch-subagents/seo-writer.settings.json "
            "--dangerously-load-development-channels "
            "plugin:switch-connector@switch-plugins"
        ) in msg

    def test_subagent_flags_present_without_channels(self) -> None:
        opts = ClaudeCodeOptions(
            channels_enabled=False, repo_dir="/r", subagent_name="reviewer"
        )
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "ops")
        assert msg is not None
        assert "--agent reviewer" in msg
        assert "--settings .claude/switch-subagents/reviewer.settings.json" in msg
        assert "--dangerously-load-development-channels" not in msg

    def test_no_subagent_name_omits_agent_flag(self) -> None:
        opts = ClaudeCodeOptions(channels_enabled=True, repo_dir="/r")
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert "--agent" not in msg
        assert "switch-subagents" not in msg

    def test_empty_string_subagent_name_normalised_to_none(self) -> None:
        opts = ClaudeCodeOptions(channels_enabled=True, subagent_name="")
        assert opts.subagent_name is None
        msg = ClaudeCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert "--agent" not in msg

    def test_message_does_not_interpolate_room_name(self) -> None:
        # We refer to "this room" in the lead-in rather than naming it, so the
        # message reads the same regardless of where it's posted.
        opts = ClaudeCodeOptions(channels_enabled=True, repo_dir="/x")
        msg = ClaudeCodeKnownAgent.start_session_instructions(
            opts, _agent({}), "Some Long Room Name"
        )
        assert msg is not None
        # The room name still appears once inside the quoted `connect to switch
        # room ...` command — that's where the operator actually needs it.
        assert msg.count("Some Long Room Name") == 1
        assert "I don't have a session connected to this room." in msg


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

    def test_start_session_instructions_emit_codex_not_claude(self) -> None:
        opts = CodexOptions(repo_dir="/Users/x/repo")
        msg = CodexKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        # The path is quoted so a repo_dir with spaces still produces a valid
        # paste command.
        assert 'cd "/Users/x/repo" && codex "connect to switch room hub"' in msg
        # It must NOT suggest a claude command or Claude-specific flags.
        assert "claude" not in msg
        assert "--dangerously-load-development-channels" not in msg
        # The footer must not falsely promise auto-start (this message only shows
        # when no session is being auto-spawned); it points at a manual start.
        assert "auto-starts one when I'm addressed" not in msg
        assert "start Codex manually" in msg

    def test_repo_dir_with_spaces_stays_quoted(self) -> None:
        opts = CodexOptions(repo_dir="/Users/alice/my project")
        msg = CodexKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert 'cd "/Users/alice/my project" && codex' in msg

    def test_connected_not_live_opening(self) -> None:
        opts = CodexOptions(repo_dir="/r")
        msg = CodexKnownAgent.start_session_instructions(
            opts, _agent({}), "ops", connected_not_live=True
        )
        assert msg is not None
        assert "isn't reporting" in msg
        assert "I don't have a session connected to this room." not in msg
        assert "claude" not in msg

    def test_other_room_names_branch(self) -> None:
        opts = CodexOptions(repo_dir="/r")
        msg = CodexKnownAgent.start_session_instructions(
            opts, _agent({}), "ops", other_room_names=["hub", "triage"]
        )
        assert msg is not None
        assert "**hub**" in msg
        assert "**triage**" in msg
        assert "claude" not in msg

    def test_assume_role_folded_into_prompt(self) -> None:
        opts = CodexOptions(repo_dir="/r")
        msg = CodexKnownAgent.start_session_instructions(
            opts, _agent({}), "ops", assume_role="reviewer"
        )
        assert msg is not None
        assert 'codex "connect to switch room ops and assume the role reviewer"' in msg

    def test_empty_string_repo_dir_normalised_to_placeholder(self) -> None:
        opts = CodexOptions(repo_dir="")
        assert opts.repo_dir is None
        msg = CodexKnownAgent.start_session_instructions(opts, _agent({}), "triage")
        assert msg is not None
        assert 'cd "<codex-dir>"' in msg

    def test_empty_string_notify_user_normalised_to_none(self) -> None:
        opts = CodexOptions(notify_user="")
        assert opts.notify_user is None
        msg = CodexKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert not msg.startswith("@")

    def test_no_repo_dir_uses_codex_placeholder(self) -> None:
        msg = CodexKnownAgent.start_session_instructions(
            CodexOptions(repo_dir=None), _agent({}), "triage"
        )
        assert msg is not None
        assert 'cd "<codex-dir>"' in msg

    def test_notify_user_prepended_as_at_mention(self) -> None:
        opts = CodexOptions(repo_dir="/x", notify_user="cmcd")
        msg = CodexKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert msg.startswith("@cmcd\n\n")

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

    def test_prompt_is_passed_as_a_flag_not_a_positional(self) -> None:
        # OpenCode reads its first positional as the project directory, so a bare
        # `opencode "connect to switch room hub"` asks it to open a directory of
        # that name. The prompt must go through --prompt.
        opts = OpenCodeOptions(repo_dir="/Users/x/repo")
        msg = OpenCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert (
            'cd "/Users/x/repo" && opencode --prompt "connect to switch room hub"'
            in msg
        )
        assert 'opencode "connect' not in msg

    def test_start_session_instructions_emit_opencode_only(self) -> None:
        opts = OpenCodeOptions(repo_dir="/Users/x/repo")
        msg = OpenCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert "claude" not in msg
        assert "codex" not in msg
        assert "--dangerously-load-development-channels" not in msg
        assert "auto-starts one when I'm addressed" not in msg
        assert "start OpenCode manually" in msg

    def test_repo_dir_with_spaces_stays_quoted(self) -> None:
        opts = OpenCodeOptions(repo_dir="/Users/alice/my project")
        msg = OpenCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert 'cd "/Users/alice/my project" && opencode' in msg

    def test_assume_role_is_folded_into_the_prompt(self) -> None:
        opts = OpenCodeOptions(repo_dir="/r")
        msg = OpenCodeKnownAgent.start_session_instructions(
            opts, _agent({}), "ops", assume_role="reviewer"
        )
        assert msg is not None
        assert (
            '--prompt "connect to switch room ops and assume the role reviewer"' in msg
        )

    def test_blank_repo_dir_uses_placeholder(self) -> None:
        msg = OpenCodeKnownAgent.start_session_instructions(
            OpenCodeOptions(repo_dir=""), _agent({}), "triage"
        )
        assert msg is not None
        assert 'cd "<opencode-dir>"' in msg

    def test_no_repo_dir_uses_placeholder(self) -> None:
        msg = OpenCodeKnownAgent.start_session_instructions(
            OpenCodeOptions(repo_dir=None), _agent({}), "triage"
        )
        assert msg is not None
        assert 'cd "<opencode-dir>"' in msg

    def test_blank_notify_user_produces_no_mention(self) -> None:
        opts = OpenCodeOptions(notify_user="")
        msg = OpenCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert not msg.startswith("@")

    def test_notify_user_is_mentioned(self) -> None:
        opts = OpenCodeOptions(repo_dir="/x", notify_user="cmcd")
        msg = OpenCodeKnownAgent.start_session_instructions(opts, _agent({}), "hub")
        assert msg is not None
        assert msg.startswith("@cmcd")

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
