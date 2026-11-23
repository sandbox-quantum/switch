"""Setting up a Slack app of your own: the manifest this server builds, and
what the tokens say once pasted. Slack is stood in for by an httpx mock
transport."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from switch_core.bridges.agent import commands
from switch_core.bridges.agent.commands import COMMANDS, Command
from switch_core.bridges.collaboration import own_app_setup
from switch_core.bridges.collaboration.own_app_setup import (
    SetupCheckError,
    check_slack,
    slack_create_url,
    slack_manifest,
)
from switch_core.bridges.collaboration.slack.install import BOT_SCOPES
from switch_core.feature_flags import DECISION_ROUTING

# Every flag that adds a command, so every command is there to check.
ALL_ON = {DECISION_ROUTING: True}


def _client(answers: dict[str, tuple[int, Any]]) -> httpx.AsyncClient:
    def handle(request: httpx.Request) -> httpx.Response:
        status, body = answers[request.url.path]
        return httpx.Response(status, json=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


class TestSlackManifest:
    def test_asks_for_what_this_server_uses(self) -> None:
        manifest = slack_manifest(ALL_ON)

        assert manifest["oauth_config"]["scopes"]["bot"] == list(BOT_SCOPES)
        assert manifest["settings"]["socket_mode_enabled"] is True
        assert {c["command"] for c in manifest["features"]["slash_commands"]} == {
            f"/{command.name}"
            for command in COMMANDS
            if command.description.strip() and not command.hidden
        }

    def test_shows_the_apps_messages_but_takes_none(self) -> None:
        # The prompt that confirms a linked account arrives in the app's own
        # conversation (CHOO-4121); nothing typed there reaches an agent.
        app_home = slack_manifest(ALL_ON)["features"]["app_home"]

        assert app_home["messages_tab_enabled"] is True
        assert app_home["messages_tab_read_only_enabled"] is True

    def test_every_registered_command_does_something(self) -> None:
        registered = {
            c["command"].removeprefix("/")
            for c in slack_manifest(ALL_ON)["features"]["slash_commands"]
        }
        by_name = {command.name: command for command in COMMANDS}

        assert "admin" not in registered
        for name in registered:
            assert by_name[name].handler is not None, name

    def test_a_command_without_a_handler_is_not_registered(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            commands,
            "COMMANDS",
            [*COMMANDS, Command("does-nothing", "Says it does something.")],
        )

        assert "/does-nothing" not in {
            c["command"] for c in slack_manifest(ALL_ON)["features"]["slash_commands"]
        }

    def test_stays_inside_slacks_limits(self) -> None:
        for command in slack_manifest(ALL_ON)["features"]["slash_commands"]:
            assert 0 < len(command["description"]) <= 100, command
            assert command["command"] == command["command"].lower()
            assert len(command["command"]) <= 32

    def test_leaves_out_a_command_whose_flag_is_off(self) -> None:
        """A server without auto-route offers no `/auto-route` to a team
        setting up its own Slack app; with the flag on it does."""
        off = {c["command"] for c in slack_manifest({})["features"]["slash_commands"]}

        assert "/auto-route" not in off
        assert {"/help", "/follow-ups", "/assign-agent"} <= off
        assert "/auto-route" in {
            c["command"] for c in slack_manifest(ALL_ON)["features"]["slash_commands"]
        }

    def test_the_create_link_carries_the_manifest(self) -> None:
        manifest = slack_manifest(ALL_ON)
        query = parse_qs(urlsplit(slack_create_url(manifest)).query)

        assert query["new_app"] == ["1"]
        assert json.loads(query["manifest_json"][0]) == manifest

    def test_the_create_link_stays_short_enough_for_slack_to_prefill(self) -> None:
        """Slack ignores a manifest in a link much longer than about 7,300
        characters and opens its app list instead of the prefilled dialog.
        6,000 leaves room for the next few commands and events; four more
        bot events stand in for the next additions."""
        manifest = slack_manifest(ALL_ON)
        assert len(slack_create_url(manifest)) <= 6000

        manifest["settings"]["event_subscriptions"]["bot_events"] += [
            "channel_created",
            "group_left",
            "member_joined_channel",
            "member_left_channel",
        ]
        assert len(slack_create_url(manifest)) <= 6000

    def test_every_command_has_a_short_phrase(self) -> None:
        for command in slack_manifest(ALL_ON)["features"]["slash_commands"]:
            assert command["command"].removeprefix("/") in (
                own_app_setup._SLACK_DESCRIPTIONS
            ), command
            assert len(command["description"]) <= 50, command

    def test_only_commands_with_arguments_escape_mentions(self) -> None:
        by_name = {command.name: command for command in COMMANDS}
        for entry in slack_manifest(ALL_ON)["features"]["slash_commands"]:
            takes_arguments = bool(by_name[entry["command"][1:]].args_spec)
            assert entry.get("should_escape", False) is takes_arguments, entry
            assert ("usage_hint" in entry) is takes_arguments, entry


class TestCheckingSlackTokens:
    async def test_reads_the_workspace_once_both_tokens_work(self) -> None:
        async with _client(
            {
                "/api/auth.test": (
                    200,
                    {
                        "ok": True,
                        "team_id": "T123",
                        "team": "Acme",
                        "user": "agent_switch",
                    },
                ),
                "/api/apps.connections.open": (200, {"ok": True, "url": "wss://x"}),
            }
        ) as http:
            checked = await check_slack(http, bot_token="xoxb-1", app_token="xapp-1")

        assert (checked.workspace_id, checked.workspace_name) == ("T123", "Acme")

    async def test_says_which_token_is_wrong(self) -> None:
        async with _client(
            {
                "/api/auth.test": (200, {"ok": True, "team_id": "T123"}),
                "/api/apps.connections.open": (
                    200,
                    {"ok": False, "error": "invalid_auth"},
                ),
            }
        ) as http:
            with pytest.raises(SetupCheckError, match="app-level token"):
                await check_slack(http, bot_token="xoxb-1", app_token="xapp-1")
            with pytest.raises(SetupCheckError, match="starts with xoxb-"):
                await check_slack(http, bot_token="xapp-1", app_token="xapp-1")

    async def test_names_the_scopes_an_app_lacks_before_it_is_connected(self) -> None:
        """An app built by hand without users:read connects, then fails the
        first time a person links their account; say so up front."""
        granted = ",".join(s for s in BOT_SCOPES if s != "users:read")

        def handle(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/auth.test":
                return httpx.Response(
                    200,
                    json={"ok": True, "team_id": "T123"},
                    headers={"x-oauth-scopes": granted},
                )
            return httpx.Response(200, json={"ok": True, "url": "wss://x"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
            with pytest.raises(SetupCheckError) as refused:
                await check_slack(http, bot_token="xoxb-1", app_token="xapp-1")
        assert "missing the users:read scope" in str(refused.value)
        assert "Reinstall to Workspace" in str(refused.value)

    async def test_an_app_from_the_manifest_has_every_scope_it_needs(self) -> None:
        assert set(own_app_setup.REQUIRED_SLACK_SCOPES) <= set(BOT_SCOPES)


class TestWhatLinkingAnAccountNeeds:
    """Confirming a link takes a tap on the app's message (Interactivity), or
    `/link-account` (the command and its scope), and the app has to message the
    person first (`im:write`). An app made from the manifest has all of it."""

    def test_the_manifest_turns_on_everything_linking_uses(self) -> None:
        manifest = own_app_setup.slack_manifest({})

        assert manifest["settings"]["interactivity"] == {"is_enabled": True}
        assert manifest["settings"]["socket_mode_enabled"] is True
        assert "message.im" in manifest["settings"]["event_subscriptions"]["bot_events"]
        commands = {c["command"] for c in manifest["features"]["slash_commands"]}
        assert {"/link-account", "/unlink-account"} <= commands
        scopes = set(manifest["oauth_config"]["scopes"]["bot"])
        assert {"commands", "im:write", "users:read"} <= scopes
        assert set(own_app_setup.REQUIRED_SLACK_SCOPES) <= scopes

    async def test_an_app_without_the_command_scope_is_told_before_connecting(
        self,
    ) -> None:
        granted = ",".join(s for s in BOT_SCOPES if s not in ("commands", "im:write"))

        def handle(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/auth.test":
                return httpx.Response(
                    200,
                    json={"ok": True, "team_id": "T123"},
                    headers={"x-oauth-scopes": granted},
                )
            return httpx.Response(200, json={"ok": True, "url": "wss://x"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
            with pytest.raises(SetupCheckError) as refused:
                await check_slack(http, bot_token="xoxb-1", app_token="xapp-1")
        assert "missing the commands, im:write scopes" in str(refused.value)
        assert "Interactivity" in str(refused.value)
