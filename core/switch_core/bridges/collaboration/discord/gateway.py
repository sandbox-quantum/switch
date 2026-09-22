"""The one deployment-level Discord Gateway connection.

The distributed Discord app authenticates to every tenant's guild with a single
application bot token, and one token means one Gateway connection (see
`DISCORD_DISTRIBUTED_APP.md`). This client owns that connection: it holds the
bot token, opens the socket, and **binds no tenant** — each event is routed to a
guild's inert bridge, and every tenant binding happens below, per room.

It is not a bridge and does not go through the collaboration lifecycle. It is a
single deployment-level object, started at boot alongside the bridges and living
in the one switch-core pod (a forced singleton), so there is never a second
owner of the socket and no leader election to arrange.

It opens the shared socket with the right intents, routes each guild message
and each global slash invocation to the bridge its guild resolves to (fresh per
event, no tenant cached — guards G1/G3), and registers the command set globally
once for the application. Removal / out-of-band-join handling lands after.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import discord

from switch_core.bridges.agent.commands import Command as InRoomCommand
from switch_core.bridges.collaboration.discord.adapter import (
    ALLOWED_MESSAGE_TYPES,
    DiscordAdapter,
)
from switch_core.bridges.collaboration.discord.connection import DiscordConnection
from switch_core.bridges.collaboration.discord.slash import build_app_commands
from switch_core.bridges.collaboration.install_service import (
    MessagingInstallService,
    WebhookBridgeUnavailable,
    WebhookWorkspaceUnknown,
)
from switch_core.tenant_context import no_tenant

logger = logging.getLogger(__name__)

_PLATFORM = "discord"

# Backoff for the initial connect: the socket is not up yet and nothing routes
# until it is, so keep retrying rather than leaving Discord dark for the process
# life. Transient drops after the first connect are discord.py's own to reconnect.
_INITIAL_RETRY_DELAY = 5.0
_MAX_RETRY_DELAY = 300.0


class DiscordGatewayClient:
    def __init__(
        self,
        *,
        bot_token: str,
        message_content: bool,
        members: bool,
        install_service: MessagingInstallService,
        on_connected: Callable[[DiscordConnection], Awaitable[None]],
    ) -> None:
        self._message_content = message_content
        self._members = members
        self._install_service = install_service
        # Fired once, after the first successful connect: boot walks the running
        # bridges and attaches the ones on a shared connection (see main.py).
        self._on_connected = on_connected
        # command_guild_id=None → commands register globally, once for the
        # application across every guild (decision #7); guild-scoped registration
        # is the self-registered adapter's, which serves one guild.
        self._connection = DiscordConnection(
            bot_token=bot_token,
            intents=self._build_intents(message_content, members),
            command_guild_id=None,
        )

    @staticmethod
    def _build_intents(message_content: bool, members: bool) -> discord.Intents:
        """The least intents a multi-tenant shared connection needs.

        No `dm_messages`: a DM carries no guild, so it cannot be attributed to a
        tenant, and the connection leaves its DM handler unset so any that
        arrive are dropped (guard G4).

        `message_content` and `members` are both *privileged* and default off:
        requesting either unapproved closes the connection past Discord's
        ~100-guild verification threshold, which the distributed app crosses
        quickly. Off, the connection still opens — the bot sees messages that
        mention it and its own, and member lookups fall back to API fetches;
        each is turned on independently once the app is verified for it.
        """
        intents = discord.Intents.none()
        intents.guilds = True
        intents.guild_messages = True
        intents.message_content = message_content
        intents.members = members
        return intents

    @property
    def connection(self) -> DiscordConnection:
        return self._connection

    async def start(self) -> None:
        # One handler for every guild's messages: each event resolves its guild
        # to a tenant fresh, so nothing about which tenant a guild belongs to is
        # cached on the connection (guard G1). The DM handler is deliberately
        # left unset (guard G4). No commands yet — global slash routing lands in
        # a later stage.
        self._connection.set_guild_message_handler(self._on_guild_message)
        self._connection.set_guild_lifecycle_handlers(
            on_remove=self._on_guild_remove,
            on_join=self._on_guild_join,
        )
        # Commands register globally, once for the application, and each
        # invocation is routed to a bridge by the guild it carries (decision #7).
        await self._connection.connect(commands=build_app_commands(self._on_slash))
        logger.info(
            "Discord shared Gateway connection started (message_content=%s)",
            self._message_content,
        )

    async def start_with_retry(self) -> None:
        """Connect, retrying the initial connect with backoff, then attach.

        Run as a supervised background task so a configured-but-unreachable
        Discord app never blocks or fails boot. Only the *initial* connect is
        retried here — once it is up, discord.py reconnects transient drops on
        its own (the same connection object, so attached bridges keep working).
        On the first success `on_connected` fires, which walks the running
        bridges and attaches the ones on a shared connection.
        """
        delay = _INITIAL_RETRY_DELAY
        while True:
            try:
                await self.start()
                break
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "Discord shared Gateway connection failed to start; Discord "
                    "installs are inert until it connects. Retrying in %.0fs",
                    delay,
                )
                await self._connection.close()
                await asyncio.sleep(delay)
                delay = min(delay * 2, _MAX_RETRY_DELAY)
        await self._on_connected(self._connection)

    async def stop(self) -> None:
        await self._connection.close()

    async def _on_guild_message(self, message: discord.Message) -> None:
        """Route one guild message to the bridge its guild resolves to.

        Runs with **no tenant bound** and resolves the guild fresh on every
        event (G1): the shared connection is multi-tenant and long-lived, so a
        tenant is never cached on it and each event is scoped from scratch.
        A guild with no active install resolves to nothing and is dropped, never
        routed to a default or first tenant (G3) — the system fails closed.
        Each handler below binds the tenant of the room it acts on, matching the
        socket and webhook delivery paths.
        """
        guild = message.guild
        if guild is None:
            # The connection only routes guild messages here, so this is
            # defensive; a DM would have gone to the (unset) DM handler.
            return
        # Drop the events that need no tenant and no DB before resolving one:
        # the bot's own posts (loop prevention) and non-post message types
        # (pins, joins, boosts, …). The adapter drops the same set again on its
        # own path, plus the webhook-echo drop it alone can make; this only
        # spares the shared, multi-tenant socket a resolution per skipped event.
        if message.author.id == self._connection.bot_user_id:
            return
        if message.type not in ALLOWED_MESSAGE_TYPES:
            return
        with no_tenant():
            try:
                target = await self._install_service.resolve_by_workspace(
                    platform=_PLATFORM, workspace_id=str(guild.id)
                )
            except (WebhookWorkspaceUnknown, WebhookBridgeUnavailable) as exc:
                logger.info("Dropping Discord message for guild %s: %s", guild.id, exc)
                return

            adapter = target.adapter
            if not isinstance(adapter, DiscordAdapter):
                logger.error(
                    "Bridge %s for Discord guild %s is not a Discord adapter (%s); "
                    "dropping the message",
                    target.bridge_id,
                    guild.id,
                    type(adapter).__name__,
                )
                return

            # Inert until now: hand it the shared connection so its inbound
            # handling and outbound posting run against the one socket.
            adapter.attach_shared_connection(self._connection)
            await adapter.dispatch_inbound(message)

    async def _on_slash(
        self,
        interaction: discord.Interaction,
        command: InRoomCommand,
        values: dict[str, Any],
    ) -> None:
        """Route one global slash invocation to the bridge its guild resolves to.

        Global commands appear in every guild the bot is in, including ones with
        no Switch install, so an invocation from an unmapped guild is answered
        with an ephemeral refusal rather than dropped — Discord shows
        "interaction failed" for one left unacknowledged. Resolved fresh per
        event and dispatched with no tenant bound, like the message path (G1).
        """
        guild_id = interaction.guild_id
        if guild_id is None:
            await self._refuse_slash(
                interaction, "This command only works inside a server."
            )
            return
        with no_tenant():
            try:
                target = await self._install_service.resolve_by_workspace(
                    platform=_PLATFORM, workspace_id=str(guild_id)
                )
            except (WebhookWorkspaceUnknown, WebhookBridgeUnavailable) as exc:
                logger.info(
                    "Refusing Discord slash command for guild %s: %s", guild_id, exc
                )
                await self._refuse_slash(
                    interaction, "Switch is not connected to this server."
                )
                return

            adapter = target.adapter
            if not isinstance(adapter, DiscordAdapter):
                logger.error(
                    "Bridge %s for Discord guild %s is not a Discord adapter (%s); "
                    "refusing the slash command",
                    target.bridge_id,
                    guild_id,
                    type(adapter).__name__,
                )
                await self._refuse_slash(
                    interaction, "Switch is not connected to this server."
                )
                return

            adapter.attach_shared_connection(self._connection)
            await adapter.dispatch_slash(interaction, command, values)

    @staticmethod
    async def _refuse_slash(interaction: discord.Interaction, message: str) -> None:
        try:
            await interaction.response.send_message(message, ephemeral=True)
        except discord.HTTPException:
            logger.exception("Failed to refuse a Discord slash interaction")

    async def _on_guild_remove(self, guild: discord.Guild) -> None:
        """The bot was removed from a guild: end that guild's install.

        Routed through the platform-initiated end path — the same one a Slack
        `app_uninstalled` takes — which marks the install inactive and detaches
        its bridge but revokes nothing (decision #8; there is no per-install
        token to revoke). A guild no tenant has installed resolves to nobody and
        is a no-op there, so a removal we were never serving is harmless.
        """
        await self._install_service.revoked(
            platform=_PLATFORM,
            workspace_id=str(guild.id),
            reason="the bot was removed from the Discord server",
        )

    async def _on_guild_join(self, guild: discord.Guild) -> None:
        """The bot was added to a guild.

        Nothing is provisioned here: only a recorded install (via the OAuth
        flow) makes a guild's events route anywhere, and a guild with none is
        ignored — its messages resolve to nobody and are dropped (G3). A guild
        added outside the install flow therefore does nothing but this line,
        which is what makes an out-of-band join visible rather than silent.
        """
        logger.info(
            "The Discord bot was added to guild %s (%s); it serves Switch only "
            "once an install has been recorded for it",
            guild.id,
            getattr(guild, "name", "?"),
        )
