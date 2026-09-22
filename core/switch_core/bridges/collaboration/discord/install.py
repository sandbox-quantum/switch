"""Installing the distributed Discord app into a customer's server (guild).

The counterpart to `DISCORD_SETUP.md`'s self-registered app, and a different
Discord application from it. See `docs/old/bridges/DISCORD_DISTRIBUTED_APP.md`
for the registration walkthrough; `SCOPES` and `PERMISSIONS` below are pinned in
that document too, and a test compares them so the two cannot drift.

Two structural differences from Slack's installer run through everything here,
and both come from one fact — Discord grants no per-install credential:

- `redeem` returns a **tokenless** grant. The code exchange tells us the guild
  the bot was added to (its id and name) and hands back a user token we do not
  need; the bot authenticates to every guild with the one deployment-level
  application token, which is config and never rides inside an install.
- There is **no webhook**. Discord delivers messages and interactions over the
  Gateway, so the inbound half of the `MessagingAppInstaller` ABC —
  `verify_webhook`, `parse_webhook`, `workspace_of_event`, `revocation_of_event`
  — has nothing to implement. Those are stubbed to raise: nothing routes
  `/messaging/discord/events` traffic, so they are never reached, and splitting
  the ABC into an install half and a webhook half is deferred until a second
  non-webhook platform makes it pay off. `revoke` is stubbed for the same
  reason — a tokenless install has nothing to revoke and `disconnect` never
  calls it.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, ClassVar
from urllib.parse import urlencode

import httpx

from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallError,
    WebhookEndpoint,
)

logger = logging.getLogger(__name__)

AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
TOKEN_URL = "https://discord.com/api/oauth2/token"

#: The OAuth scopes the *Add to Server* URL asks for. `bot` adds the bot to the
#: guild; `applications.commands` is what lets Switch register its in-room
#: commands as native slash commands. Pinned in DISCORD_DISTRIBUTED_APP.md and
#: compared by a test.
SCOPES: tuple[str, ...] = ("bot", "applications.commands")

#: The least-privilege guild permissions the authorize URL requests, as named
#: bits summed into the bitfield Discord takes. Each is a capability the adapter
#: actually exercises — nothing here is speculative, and adding one is a
#: decision this table records. The permission table in DISCORD_DISTRIBUTED_APP.md
#: lists the same bits, and a test pins the resulting integer.
_PERMISSION_BITS: dict[str, int] = {
    "view_channel": 1 << 10,
    "send_messages": 1 << 11,
    "create_public_threads": 1 << 35,  # open a thread off a message (_ensure_thread)
    "send_messages_in_threads": 1 << 38,
    "manage_webhooks": 1 << 29,  # mint the per-channel webhook agents post under
    "manage_channels": 1 << 4,  # provision channel access / private rooms
    "manage_roles": 1 << 28,  # per-agent mentionable role for @-autocomplete
    "read_message_history": 1 << 16,
    "attach_files": 1 << 15,
    "add_reactions": 1 << 6,  # mark the message an agent is working on
}

#: The decimal bitfield the authorize URL carries in `permissions`.
PERMISSIONS: int = sum(_PERMISSION_BITS.values())


class DiscordAppInstaller(MessagingAppInstaller):
    platform: ClassVar[str] = "discord"

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        application_id: str,
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        # Held so a caller can reason about which app the connection speaks for;
        # the bot token itself is deployment config injected into the shared
        # connection, not the installer's to hold.
        self._application_id = application_id

    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        return f"{AUTHORIZE_URL}?" + urlencode(
            {
                "client_id": self._client_id,
                "scope": " ".join(SCOPES),
                "permissions": str(PERMISSIONS),
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "state": state,
            }
        )

    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        """Exchange the code for the guild the bot was added to.

        Returns a tokenless grant: the response carries a user access token we
        do not keep, and — because the `bot` scope was authorized — a `guild`
        object naming the server the bot now belongs to, which is the only thing
        the install records.
        """
        async with httpx.AsyncClient() as http:
            response = await http.post(
                TOKEN_URL,
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        if response.status_code != httpx.codes.OK:
            raise MessagingInstallError(
                f"Discord refused the install ({response.status_code}): "
                f"{response.text[:200]}"
            )
        try:
            payload: dict[str, Any] = response.json()
        except ValueError as error:
            raise MessagingInstallError(
                "Discord accepted the install but returned a body that is not "
                "JSON, so there is nothing to record. Nothing was saved."
            ) from error

        guild = payload.get("guild")
        if not isinstance(guild, dict):
            raise MessagingInstallError(
                "Discord accepted the install but returned no guild, which means "
                "the bot was not added to a server (the `bot` scope was dropped, "
                "or the user cancelled). Nothing was saved."
            )
        guild_id = guild.get("id")
        if not isinstance(guild_id, str) or not guild_id:
            raise MessagingInstallError(
                "Discord returned a guild with no id, so the install cannot be "
                "attributed to a server. Nothing was saved."
            )
        name = guild.get("name")
        return InstallGrant(
            external_workspace_id=guild_id,
            workspace_name=name if isinstance(name, str) and name else guild_id,
            # The one that makes this a Discord grant: no per-install token.
            bot_token=None,
            scopes=payload.get("scope") or "",
        )

    def connection_config(self, grant: InstallGrant) -> dict[str, object]:
        return {
            "guild_id": grant.external_workspace_id,
            # The difference between the two Discord apps, mirroring Slack's
            # `event_delivery`. Under `shared` the bridge opens no connection of
            # its own and carries no token; leaving it out would validate as a
            # self-registered bridge missing its bot token and fail at
            # registration rather than at anything a reader would look at.
            "event_delivery": "shared",
        }

    # ── The webhook half the ABC declares and Discord does not have ───────────
    #
    # Discord delivers over the Gateway (DISCORD_DISTRIBUTED_APP.md, "the one
    # public URL"), so none of these carries real traffic: no
    # `/messaging/discord/events` event is ours to read, and `disconnect` skips
    # `revoke` for a tokenless install.
    #
    # `verify_webhook` is the one an unauthenticated stranger can reach — it runs
    # first for any POST to `/messaging/discord/{events,interactive,commands}`.
    # It raises `MessagingInstallError`, which the route turns into a 404 (the
    # same answer as an unregistered platform), rather than an unhandled error
    # that would be a repeatable 500 plus a traceback for anyone who found the
    # URL. The rest raise loudly: they are only reachable from code that would
    # have had to wire a Discord webhook up by mistake.

    async def revoke(self, *, bot_token: str) -> None:
        raise NotImplementedError(
            "a Discord install has no per-install token to revoke; the bot token "
            "is deployment config shared by every install"
        )

    def verify_webhook(self, *, headers: Mapping[str, str], body: bytes) -> None:
        raise MessagingInstallError(
            "the distributed Discord app has no webhook; events arrive over the Gateway"
        )

    def parse_webhook(
        self, *, endpoint: WebhookEndpoint, headers: Mapping[str, str], body: bytes
    ) -> InboundWebhook:
        raise NotImplementedError(
            "the distributed Discord app has no webhook; events arrive over the Gateway"
        )

    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        raise NotImplementedError(
            "the distributed Discord app has no webhook; a guild id is read off "
            "the Gateway event, not an HTTP payload"
        )

    def revocation_of_event(self, payload: Mapping[str, object]) -> str | None:
        raise NotImplementedError(
            "the distributed Discord app has no webhook; a removal is a Gateway "
            "event, not an HTTP payload"
        )
