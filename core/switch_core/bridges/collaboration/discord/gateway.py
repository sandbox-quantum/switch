"""The one deployment-level Discord Gateway connection.

The distributed Discord app authenticates to every tenant's guild with a single
application bot token, and one token means one Gateway connection (see
`DISCORD_DISTRIBUTED_APP.md`). This client owns that connection: it holds the
bot token, opens the socket, and **binds no tenant** — each event is routed to a
guild's inert bridge, and every tenant binding happens below, per room.

It is not a bridge and does not go through the collaboration lifecycle. It is a
single deployment-level object in every switch-core process, and the socket is
owned work (`ownership.py`, kind `DISCORD_GATEWAY`): Discord delivers every
event to every socket the bot opens, so one process opens it. Every
shared-delivery bridge is held beside it (`DiscordAdapter.held_with`), since
the events it receives reach a bridge in-process. Every other process logs the
same connection in for Discord's API alone, so the quiet copies of the bridges
there can still serve the requests that reach them. The connection object is
the same one throughout, whichever it is doing, so a bridge attached to it
stays attached when this process takes the socket over or hands it on.

It opens the shared socket with the right intents, routes each guild message,
each global slash invocation and each press on a card's button to the bridge its
guild resolves to (fresh per event, no tenant cached — guards G1/G3), and
registers the command set globally once for the application. Removal / out-of-band-join handling lands after.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

import discord

from switch_core.bridges.agent.commands import Command as InRoomCommand
from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.discord.adapter import (
    ALLOWED_MESSAGE_TYPES,
    DISCORD_GATEWAY,
    DISCORD_GATEWAY_KEY,
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

if TYPE_CHECKING:
    from switch_core.ownership import Fence, OwnedKind, Ownership

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
        # Whether the connection is up, as the socket or for the API alone.
        # Cleared while this process switches between the two; a socket that
        # drops is discord.py's to reconnect, on the same connection object.
        self._live = False
        # The connect, or the log-in for the API alone, under way in the
        # background, retried until it succeeds.
        self._task: asyncio.Task[None] | None = None
        # The socket as owned work, once `own` has registered it.
        self._owned: OwnedKind | None = None
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

    def attach_if_live(self, adapter: PlatformAdapter) -> None:
        """Hand a starting Discord bridge the shared connection, if it is up.

        Called as each bridge starts, before anything in it runs, so a new
        install can post and search straight away rather than after the first
        message in its guild. Not before the connection is up: the bridge would
        run its start-time provisioning against a client that is not there,
        and the attach on connect would then be a no-op that never re-runs it.
        Those bridges are attached when the connection first comes up instead.
        """
        if self._live and isinstance(adapter, DiscordAdapter):
            adapter.attach_shared_connection(self._connection)

    async def start(self) -> None:
        # One handler for every guild's messages, and one for every press on a
        # card's button: each event resolves its guild to a tenant fresh, so
        # nothing about which tenant a guild belongs to is cached on the
        # connection (guard G1). The DM handler is deliberately left unset
        # (guard G4).
        self._connection.set_guild_message_handler(self._on_guild_message)
        self._connection.set_interaction_handler(self._on_interaction)
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
        """Connect, retrying the initial connect with backoff, then attach."""
        await self._bring_up(listen=True)

    async def _bring_up(self, *, listen: bool) -> None:
        """Open the socket, or log in for the API alone, retrying with backoff
        until it succeeds, then attach the bridges.

        Run in the background so a configured-but-unreachable Discord app
        never blocks or fails boot, or a take-over. Only the *initial* connect
        is retried here — once it is up, discord.py reconnects transient drops
        on its own (the same connection object, so attached bridges keep
        working). On success `on_connected` fires, which walks the running
        bridges and attaches the ones on a shared connection.
        """
        delay = _INITIAL_RETRY_DELAY
        while True:
            try:
                if listen:
                    await self.start()
                else:
                    await self._connection.login()
                break
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "Discord shared %s failed to start; Discord installs are "
                    "inert until it does. Retrying in %.0fs",
                    "Gateway connection" if listen else "API log-in",
                    delay,
                )
                await self._connection.close()
                await asyncio.sleep(delay)
                delay = min(delay * 2, _MAX_RETRY_DELAY)
        # Before the walk, with no await between: a bridge starting from here
        # on is attached as it starts, and every one started before is in the
        # walk, so none falls between the two.
        self._live = True
        await self._on_connected(self._connection)

    def own(self, ownership: Ownership) -> None:
        """Make the socket owned work: opened in the one process that holds
        it, and by the next once that one stops or dies. Before the
        ownership's first balance, so a process that holds it at boot opens
        it there and then."""
        self._owned = ownership.kind(
            DISCORD_GATEWAY, start=self._take_over, stop=self._hand_over
        )
        self._owned.want(DISCORD_GATEWAY_KEY)

    def start_quietly(self) -> None:
        """After the ownership's first balance: unless this process holds the
        socket, log the connection in for the API alone."""
        if self._task is None and (self._owned is None or not self._owned.held()):
            self._task = asyncio.create_task(
                self._bring_up(listen=False), name="discord-api-login"
            )

    async def _take_over(self, key: str, fence: Fence) -> None:
        """This process now holds the socket: open it in place of the log-in
        for the API alone. In the background, as at boot."""
        logger.info("Taking over the Discord shared Gateway connection")
        await self._close()
        self._task = asyncio.create_task(
            self._bring_up(listen=True), name="discord-gateway-start"
        )

    async def _hand_over(self, key: str) -> None:
        """This process no longer holds the socket: close it, so it delivers
        nothing more here before the next holder opens its own, then log in
        again for the API alone, unless the process is shutting down."""
        logger.info("Handing the Discord shared Gateway connection over")
        await self._close()
        if self._owned is not None and not self._owned.stopping:
            self._task = asyncio.create_task(
                self._bring_up(listen=False), name="discord-api-login"
            )

    async def _close(self) -> None:
        """Stop whatever is being brought up, and close the connection.

        Closed even when the bring-up failed after connecting, in
        `on_connected`, and its error is raised from here: the ownership logs
        a hand-over that raises and releases the socket's lease all the same,
        and the next holder opens a socket of its own.
        """
        task, self._task = self._task, None
        try:
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        finally:
            self._live = False
            await self._connection.close()

    async def stop(self) -> None:
        await self._close()

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
        no Switch install, so those are refused rather than dropped.
        """
        with no_tenant():
            adapter = await self._interaction_adapter(
                interaction,
                outside_a_server="This command only works inside a server.",
            )
            if adapter is not None:
                await adapter.dispatch_slash(interaction, command, values)

    async def _on_interaction(self, interaction: discord.Interaction) -> None:
        """Route one press on a card's button to the bridge its guild resolves to.

        The connection hands every interaction here, slash invocations
        included; those reach `_on_slash` through the command tree instead, so
        only presses are taken. A press from a guild no longer installed (a
        card left behind after a disconnect) is refused like a slash command.
        """
        if interaction.type is not discord.InteractionType.component:
            return
        with no_tenant():
            adapter = await self._interaction_adapter(
                interaction,
                outside_a_server="This button only works inside a server.",
            )
            if adapter is not None:
                await adapter.dispatch_interaction(interaction)

    async def _interaction_adapter(
        self, interaction: discord.Interaction, *, outside_a_server: str
    ) -> DiscordAdapter | None:
        """The bridge an interaction's guild resolves to, attached, or None.

        Resolved fresh per event, and called with no tenant bound, like the
        message path (G1). An interaction that resolves to no bridge is
        answered with an ephemeral refusal rather than dropped: Discord shows
        "interaction failed" for one left unacknowledged.
        """
        guild_id = interaction.guild_id
        if guild_id is None:
            await self._refuse(interaction, outside_a_server)
            return None
        try:
            target = await self._install_service.resolve_by_workspace(
                platform=_PLATFORM, workspace_id=str(guild_id)
            )
        except (WebhookWorkspaceUnknown, WebhookBridgeUnavailable) as exc:
            logger.info(
                "Refusing a Discord interaction from guild %s: %s", guild_id, exc
            )
            await self._refuse(interaction, "Switch is not connected to this server.")
            return None

        adapter = target.adapter
        if not isinstance(adapter, DiscordAdapter):
            logger.error(
                "Bridge %s for Discord guild %s is not a Discord adapter (%s); "
                "refusing the interaction",
                target.bridge_id,
                guild_id,
                type(adapter).__name__,
            )
            await self._refuse(interaction, "Switch is not connected to this server.")
            return None

        adapter.attach_shared_connection(self._connection)
        return adapter

    @staticmethod
    async def _refuse(interaction: discord.Interaction, message: str) -> None:
        try:
            await interaction.response.send_message(message, ephemeral=True)
        except discord.HTTPException:
            logger.exception("Failed to refuse a Discord interaction")

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
