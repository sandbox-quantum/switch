"""Setting up a Slack app of your own, with as little by hand as Slack allows.

A self-hosted Switch cannot use the official Switch app, so whoever runs it
creates a Slack app and pastes its tokens. Slack creates an app from a
manifest, and its create-app page takes one in its address: `slack_manifest`
is that manifest, built from what this server actually uses (its scopes,
events and in-room commands), so the app comes out configured. `check_slack`
then reads the workspace from the bot token and confirms the app-level token
opens a Socket Mode connection.

Discord has nothing like a manifest, so its setup stays the guide.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from switch_core.bridges.agent.commands import COMMANDS
from switch_core.bridges.collaboration.slack.install import BOT_SCOPES

SLACK_API = "https://slack.com/api"
SLACK_CREATE_APP = "https://api.slack.com/apps"

#: What the app is called in Slack; Slack allows 35 characters.
SLACK_APP_NAME = "Agent Switch"

#: The message events Switch reads, in every kind of conversation the bot is in.
SLACK_BOT_EVENTS = ("message.channels", "message.groups", "message.im", "message.mpim")

#: Slack refuses a slash command description longer than this.
_SLACK_DESCRIPTION_MAX = 100


class SetupCheckError(Exception):
    """A token the platform refused, said in words for the person pasting it."""


def _short(description: str) -> str:
    sentence = description.split(". ")[0].rstrip(".")
    if len(sentence) <= _SLACK_DESCRIPTION_MAX:
        return sentence
    return sentence[: _SLACK_DESCRIPTION_MAX - 1].rstrip() + "…"


def slack_manifest() -> dict[str, Any]:
    """The manifest of a Slack app that does everything this server uses."""
    commands = []
    for command in COMMANDS:
        # A command with no description is one kept out of the listing.
        if not command.description.strip():
            continue
        entry: dict[str, Any] = {
            "command": f"/{command.name}",
            "description": _short(command.description),
            # An argument names an agent or role by its @-mention, which Slack
            # only hands over as an id when the command escapes it.
            "should_escape": bool(command.args_spec),
        }
        if command.args_spec:
            entry["usage_hint"] = " ".join(f"<{arg.name}>" for arg in command.args_spec)
        commands.append(entry)
    return {
        "display_information": {"name": SLACK_APP_NAME},
        "features": {
            "app_home": {
                "home_tab_enabled": True,
                "messages_tab_enabled": False,
                "messages_tab_read_only_enabled": False,
            },
            "bot_user": {"display_name": SLACK_APP_NAME, "always_online": False},
            "agent_view": {
                "agent_description": (
                    "Switch agents. Mention one by name in a channel and it answers "
                    "there; its progress appears on the message while it works."
                )
            },
            "slash_commands": commands,
        },
        "oauth_config": {"scopes": {"bot": list(BOT_SCOPES)}},
        "settings": {
            "event_subscriptions": {"bot_events": list(SLACK_BOT_EVENTS)},
            "interactivity": {"is_enabled": True},
            "org_deploy_enabled": False,
            "socket_mode_enabled": True,
            "token_rotation_enabled": False,
        },
    }


def slack_create_url(manifest: dict[str, Any]) -> str:
    """Slack's create-app page, filled in with `manifest`."""
    return f"{SLACK_CREATE_APP}?" + urlencode(
        {"new_app": "1", "manifest_json": json.dumps(manifest, separators=(",", ":"))}
    )


@dataclass(frozen=True)
class SlackCheck:
    workspace_id: str
    workspace_name: str
    bot_name: str


async def check_slack(
    http: httpx.AsyncClient, *, bot_token: str, app_token: str
) -> SlackCheck:
    """The workspace the bot token is for, once both tokens work."""
    if not bot_token.startswith("xoxb-"):
        raise SetupCheckError(
            "The bot token starts with xoxb-. Copy it from OAuth & Permissions, "
            "after installing the app to your workspace."
        )
    if not app_token.startswith("xapp-"):
        raise SetupCheckError(
            "The app-level token starts with xapp-. Make one under Basic "
            "Information, App-Level Tokens, with the connections:write scope."
        )
    auth = await _slack_call(http, "auth.test", bot_token)
    if not auth.get("ok"):
        raise SetupCheckError(
            f"Slack refused the bot token ({auth.get('error', 'unknown error')}). "
            "Install the app to your workspace again and copy the new token."
        )
    socket = await _slack_call(http, "apps.connections.open", app_token)
    if not socket.get("ok"):
        raise SetupCheckError(
            f"Slack refused the app-level token ({socket.get('error', 'unknown error')}). "
            "Check it has the connections:write scope and that Socket Mode is on."
        )
    return SlackCheck(
        workspace_id=str(auth["team_id"]),
        workspace_name=str(auth.get("team", "")),
        bot_name=str(auth.get("user", "")),
    )


async def _slack_call(
    http: httpx.AsyncClient, method: str, token: str
) -> dict[str, Any]:
    try:
        response = await http.post(
            f"{SLACK_API}/{method}", headers={"Authorization": f"Bearer {token}"}
        )
    except httpx.HTTPError as error:
        raise SetupCheckError(f"Could not reach Slack: {error}") from error
    body = response.json()
    return body if isinstance(body, dict) else {}
