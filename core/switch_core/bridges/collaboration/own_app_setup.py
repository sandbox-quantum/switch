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

#: What Slack's command picker shows for each command. Slack ignores a
#: create-app link much longer than about 7,300 characters, and the manifest
#: rides in that link, so each description is a short phrase; `/help` and
#: `!help` keep the full text. A command missing here falls back to the first
#: sentence of its description.
_SLACK_DESCRIPTIONS: dict[str, str] = {
    "help": "Show the commands",
    "reset": "Reset an agent's session",
    "reset-all-agents": "Reset every agent's session here",
    "compact": "Compact an agent's context",
    "compact-all-agents": "Compact every agent's context here",
    "interrupt": "Stop an agent's current turn",
    "interrupt-all-agents": "Stop every agent's current turn here",
    "list-agents": "List the agents here",
    "agents-status": "Show each agent's status",
    "roles": "List roles and who holds them",
    "list-documents": "List the room's documents",
    "list-references": "List the room's references",
    "list-aliases": "List agent aliases here",
    "follow-ups": "Turn follow-ups on or off",
    "auto-route": "Let Switch pick who answers untagged messages",
    "assign-agent": "Send every message here to one agent",
    "unassign-agent": "Stop sending every message to one agent",
    "add-room-admin": "Make someone a room admin",
    "remove-room-admin": "Remove a room admin",
    "list-room-admins": "Show the room's owner and admins",
    "set-alias": "Give an agent a room alias",
    "remove-alias": "Remove a room alias",
    "invite-agent": "Add an agent to this room",
    "remove-agent": "Remove an agent from this room",
    "remove-user": "Remove a person from this room",
    "link-account": "Link this chat account with a code",
    "unlink-account": "Show or remove your linked Switch users",
    "rename-agent": "Rename an agent",
    "delete-agent": "Delete an agent everywhere",
    "room-url": "Show this room's web address",
    "list-switch-agents": "List every agent on this server",
    "agents-greet": "Have the agents introduce themselves",
}


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
        # Only a command that does something is registered with Slack, and a
        # hidden one or one with no description is kept out of the listing.
        if command.handler is None or command.hidden or not command.description.strip():
            continue
        entry: dict[str, Any] = {
            "command": f"/{command.name}",
            "description": _SLACK_DESCRIPTIONS.get(command.name)
            or _short(command.description),
        }
        if command.args_spec:
            # An argument names an agent or role by its @-mention, which Slack
            # only hands over as an id when the command escapes it. Slack's
            # default is not to escape, so it is left out otherwise.
            entry["should_escape"] = True
            entry["usage_hint"] = " ".join(f"<{arg.name}>" for arg in command.args_spec)
        commands.append(entry)
    return {
        "display_information": {"name": SLACK_APP_NAME},
        "features": {
            # The Messages tab is where the app's direct messages show, read
            # only: Switch sends the prompt that confirms a linked account
            # there (CHOO-4121), and people press its buttons but cannot write
            # to the app, which routes no messages to agents.
            "app_home": {
                "home_tab_enabled": True,
                "messages_tab_enabled": True,
                "messages_tab_read_only_enabled": True,
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
    """Slack's create-app page, filled in with `manifest`.

    Slack quietly drops a manifest from a link much longer than about 7,300
    characters and opens its app list instead, so the link is kept short:
    `/`, `:` and `,`, which a query may carry as they are, are not escaped.
    """
    return f"{SLACK_CREATE_APP}?" + urlencode(
        {"new_app": "1", "manifest_json": json.dumps(manifest, separators=(",", ":"))},
        safe="/:,",
    )


#: Bot scopes Switch cannot do without: reading and posting in channels, and
#: `users:read`, without which linking a person's Slack account fails. An app
#: made from the manifest has them all; one built by hand, or from an older
#: manifest, may not, and is told which to add before it is connected.
REQUIRED_SLACK_SCOPES: tuple[str, ...] = (
    "channels:history",
    "channels:read",
    "chat:write",
    "groups:history",
    "groups:read",
    "users:read",
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
    auth, granted = await _slack_call_with_scopes(http, "auth.test", bot_token)
    if not auth.get("ok"):
        raise SetupCheckError(
            f"Slack refused the bot token ({auth.get('error', 'unknown error')}). "
            "Install the app to your workspace again and copy the new token."
        )
    # Slack lists the token's scopes in a header; an answer without it is
    # not judged.
    if granted is not None:
        missing = [s for s in REQUIRED_SLACK_SCOPES if s not in granted]
        if missing:
            raise SetupCheckError(
                f"The Slack app is missing the {', '.join(missing)} "
                f"{'scope' if len(missing) == 1 else 'scopes'}. In Slack, open "
                "OAuth & Permissions, add "
                f"{'it' if len(missing) == 1 else 'them'} under Bot Token Scopes, "
                "click Reinstall to Workspace, and paste the new bot token here."
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
    body, _scopes = await _slack_call_with_scopes(http, method, token)
    return body


async def _slack_call_with_scopes(
    http: httpx.AsyncClient, method: str, token: str
) -> tuple[dict[str, Any], set[str] | None]:
    """Slack's answer, and the token's scopes from its `x-oauth-scopes`
    header (None when Slack did not send it)."""
    try:
        response = await http.post(
            f"{SLACK_API}/{method}", headers={"Authorization": f"Bearer {token}"}
        )
    except httpx.HTTPError as error:
        raise SetupCheckError(f"Could not reach Slack: {error}") from error
    body = response.json()
    header = response.headers.get("x-oauth-scopes")
    scopes = (
        {s.strip() for s in header.split(",") if s.strip()}
        if header is not None
        else None
    )
    return (body if isinstance(body, dict) else {}), scopes
