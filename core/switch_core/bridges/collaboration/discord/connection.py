from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any

import discord
from discord import app_commands

logger = logging.getLogger(__name__)

_READY_TIMEOUT = 30.0


class DiscordConnection:
    """Owns the Discord Gateway socket, separate from per-guild message handling.

    A `DiscordConnection` holds the `discord.Client`, the application command
    tree, the connect task and the bot's own user id, and it owns the socket
    lifecycle: login, the readiness race, slash-command sync and shutdown.
    `DiscordAdapter` composes one and reads its client through here rather than
    holding the socket itself.

    Splitting the socket out of the adapter is the first step toward a single
    shared, multi-tenant connection: the adapter is per guild, but the socket is
    per bot token, so the two have genuinely different lifetimes. Intents are
    supplied by the caller — the seam a shared connection uses to request a
    different set (e.g. dropping DM intents, gating message content) without the
    socket owner deciding them.

    `command_guild_id` scopes slash-command registration. When set, commands are
    published guild-scoped (immediate, and confined to that guild); when None,
    they are registered globally (per application, across every guild).
    """

    def __init__(
        self,
        *,
        bot_token: str,
        intents: discord.Intents,
        command_guild_id: int | None,
    ) -> None:
        self._bot_token = bot_token
        self._intents = intents
        self._command_guild_id = command_guild_id
        self._client: discord.Client | None = None
        self._tree: app_commands.CommandTree[Any] | None = None
        self._connect_task: asyncio.Task[None] | None = None
        self._bot_user_id: int = 0
        # Inbound message routing. A guild's messages go to the handler
        # registered for its id; a direct message (no guild) goes to the DM
        # handler if one is set, and is dropped otherwise. The self-registered
        # adapter registers one guild handler plus the DM handler; a shared
        # multi-tenant connection registers a handler per installed guild and
        # leaves the DM slot empty, so DMs — which carry no guild to attribute
        # them to a tenant — are dropped.
        self._message_handlers: dict[
            int, Callable[[discord.Message], Awaitable[None]]
        ] = {}
        # A single handler for *every* guild's messages, used by the shared
        # multi-tenant connection: it routes each event by resolving the guild
        # to its tenant fresh, rather than keeping a per-guild registry that
        # would cache which tenant a guild belongs to on the connection. When
        # set it takes precedence over the per-guild registry (a connection is
        # only ever one shape or the other).
        self._guild_message_handler: (
            Callable[[discord.Message], Awaitable[None]] | None
        ) = None
        self._dm_handler: Callable[[discord.Message], Awaitable[None]] | None = None
        # A press on a card's button (a component interaction). One handler for
        # the whole socket: the self-registered adapter sets its own; a shared
        # connection sets a router that resolves the interaction's guild to a
        # bridge. Unset means presses are dropped.
        self._interaction_handler: (
            Callable[[discord.Interaction], Awaitable[None]] | None
        ) = None
        # The bot being removed from / added to a guild. Only the shared
        # connection wires these; the self-registered adapter serves the one
        # guild it was configured with.
        self._guild_remove_handler: (
            Callable[[discord.Guild], Awaitable[None]] | None
        ) = None
        self._guild_join_handler: Callable[[discord.Guild], Awaitable[None]] | None = (
            None
        )

    def set_interaction_handler(
        self, handler: Callable[[discord.Interaction], Awaitable[None]] | None
    ) -> None:
        self._interaction_handler = handler

    def register_message_handler(
        self, guild_id: int, handler: Callable[[discord.Message], Awaitable[None]]
    ) -> None:
        self._message_handlers[guild_id] = handler

    def unregister_message_handler(self, guild_id: int) -> None:
        self._message_handlers.pop(guild_id, None)

    def set_guild_message_handler(
        self, handler: Callable[[discord.Message], Awaitable[None]] | None
    ) -> None:
        self._guild_message_handler = handler

    def set_guild_lifecycle_handlers(
        self,
        *,
        on_remove: Callable[[discord.Guild], Awaitable[None]],
        on_join: Callable[[discord.Guild], Awaitable[None]],
    ) -> None:
        """Handlers for the bot being removed from / added to a guild.

        Used by the shared connection to end an install when its guild removes
        the bot, and to note an out-of-band join. Set before `connect`; the
        self-registered adapter, which serves one guild it was configured with,
        leaves them unset.
        """
        self._guild_remove_handler = on_remove
        self._guild_join_handler = on_join

    def set_dm_handler(
        self, handler: Callable[[discord.Message], Awaitable[None]] | None
    ) -> None:
        self._dm_handler = handler

    @property
    def client(self) -> discord.Client:
        if self._client is None:
            raise RuntimeError("Discord client not connected")
        return self._client

    @property
    def client_or_none(self) -> discord.Client | None:
        return self._client

    @property
    def bot_user_id(self) -> int:
        return self._bot_user_id

    async def connect(
        self,
        *,
        commands: list[app_commands.Command[Any, ..., Any]],
    ) -> None:
        """Open the Gateway connection and block until it is ready.

        Message handlers are registered separately (before or after this call)
        via `register_message_handler` / `set_dm_handler`, and are looked up
        live per message — so a shared connection can register a guild's handler
        the moment its install resolves, after the socket is already open.

        Raises if the connection fails or does not become ready within
        `_READY_TIMEOUT`. On timeout the half-open client is torn down; on a
        connect-task failure it is left as-is for the caller's `close()`.
        """
        client = discord.Client(intents=self._intents)
        client.event(self._make_on_message())
        # Presses on a card's buttons. Registered alongside the command tree
        # rather than through it: the tree is handed application-command
        # interactions only, and a component interaction is dispatched as the
        # plain `interaction` event whether or not anything is listening. Routed
        # through the handler set via `set_interaction_handler`, or dropped when
        # none is set.
        client.event(self._make_on_interaction())
        if self._guild_remove_handler is not None:
            client.event(self._make_on_guild_remove())
        if self._guild_join_handler is not None:
            client.event(self._make_on_guild_join())
        self._tree = app_commands.CommandTree(client)
        guild = (
            discord.Object(id=self._command_guild_id)
            if self._command_guild_id is not None
            else None
        )
        for command in commands:
            # Bound to the guild when scoped — see _sync_slash_commands. Adding
            # them globally when a guild sync follows would leave that sync with
            # an empty payload, registering nothing at all.
            if guild is not None:
                self._tree.add_command(command, guild=guild)
            else:
                self._tree.add_command(command)
        self._client = client

        await client.login(self._bot_token)
        self._connect_task = asyncio.create_task(
            client.connect(), name=f"discord-gateway-{self._command_guild_id}"
        )
        ready = asyncio.ensure_future(client.wait_until_ready())
        done, _ = await asyncio.wait(
            {ready, self._connect_task},
            timeout=_READY_TIMEOUT,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if self._connect_task in done:
            ready.cancel()
            exc = self._connect_task.exception()
            raise RuntimeError("Discord gateway connection failed") from exc
        if ready not in done:
            ready.cancel()
            await self.close()
            raise RuntimeError(f"Discord gateway not ready after {_READY_TIMEOUT:.0f}s")

        assert client.user is not None
        self._bot_user_id = client.user.id
        logger.info(
            "Discord gateway connected as %s (guild %s)",
            client.user,
            self._command_guild_id,
        )
        await self._sync_slash_commands()

    async def _sync_slash_commands(self) -> None:
        """Publish the in-room command set as application commands.

        Guild-scoped when `command_guild_id` is set — which the self-registered
        adapter always is, since it serves one guild. Guild commands apply
        immediately, where global ones propagate for up to an hour, and global
        registration is per-application — so on an instance running several
        single-guild Discord bridges it would leak each bridge's commands into
        the others' guilds, where they could only fail. Syncing is a bulk
        overwrite, so re-running it on every start reconciles renames and
        removals rather than accumulating them.

        Any sync failure is logged and left non-fatal — hence the broad catch:
        the bridge still works over `!`-commands and messages, and dropping the
        whole bridge over a missing `applications.commands` scope is a worse
        outcome than running without the slash surface. The degradation is
        visible in the logs rather than silent.
        """
        if self._tree is None:
            return
        try:
            if self._command_guild_id is not None:
                synced = await self._tree.sync(
                    guild=discord.Object(id=self._command_guild_id)
                )
            else:
                synced = await self._tree.sync()
        except Exception:
            logger.exception(
                "Failed to sync Discord slash commands for guild %s — the bridge "
                "will run without them (check the bot's applications.commands scope)",
                self._command_guild_id,
            )
            return
        logger.info(
            "Synced %d Discord slash commands to guild %s",
            len(synced),
            self._command_guild_id,
        )

    def _make_on_message(
        self,
    ) -> Callable[[discord.Message], Coroutine[Any, Any, None]]:
        # client.event registers by function __name__, so hand it a closure
        # named exactly like the gateway event.
        async def on_message(message: discord.Message) -> None:
            # Route to the handler registered for this message's guild, or the
            # DM handler for a guild-less message. Look up live per message so
            # handlers registered after connect() still receive events. An event
            # for a guild (or a DM) with no registered handler is dropped.
            guild = message.guild
            if guild is None:
                handler = self._dm_handler
            elif self._guild_message_handler is not None:
                handler = self._guild_message_handler
            else:
                handler = self._message_handlers.get(guild.id)
            if handler is None:
                return
            try:
                await handler(message)
            except Exception:
                logger.exception("Failed to handle inbound Discord message")

        return on_message

    def _make_on_interaction(
        self,
    ) -> Callable[[discord.Interaction], Coroutine[Any, Any, None]]:
        async def on_interaction(interaction: discord.Interaction) -> None:
            # Look up live so a handler set after connect() still receives
            # presses; a press with no handler set is dropped.
            handler = self._interaction_handler
            if handler is None:
                return
            try:
                await handler(interaction)
            except Exception:
                logger.exception("Failed to handle a press on a Discord card")

        return on_interaction

    def _make_on_guild_remove(
        self,
    ) -> Callable[[discord.Guild], Coroutine[Any, Any, None]]:
        async def on_guild_remove(guild: discord.Guild) -> None:
            handler = self._guild_remove_handler
            if handler is None:
                return
            try:
                await handler(guild)
            except Exception:
                logger.exception("Failed to handle Discord guild removal")

        return on_guild_remove

    def _make_on_guild_join(
        self,
    ) -> Callable[[discord.Guild], Coroutine[Any, Any, None]]:
        async def on_guild_join(guild: discord.Guild) -> None:
            handler = self._guild_join_handler
            if handler is None:
                return
            try:
                await handler(guild)
            except Exception:
                logger.exception("Failed to handle Discord guild join")

        return on_guild_join

    async def close(self) -> None:
        if self._client:
            try:
                await self._client.close()
            except Exception:
                pass
        task = self._connect_task
        self._connect_task = None
        if task:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._client = None
        self._tree = None
        logger.info("Discord connection closed")
