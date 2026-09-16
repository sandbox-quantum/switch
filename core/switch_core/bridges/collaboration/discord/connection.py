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
        on_message: Callable[[discord.Message], Awaitable[None]],
    ) -> None:
        """Open the Gateway connection and block until it is ready.

        Raises if the connection fails or does not become ready within
        `_READY_TIMEOUT`. On timeout the half-open client is torn down; on a
        connect-task failure it is left as-is for the caller's `close()`.
        """
        client = discord.Client(intents=self._intents)
        client.event(self._make_on_message(on_message))
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
        self, handler: Callable[[discord.Message], Awaitable[None]]
    ) -> Callable[[discord.Message], Coroutine[Any, Any, None]]:
        # client.event registers by function __name__, so hand it a closure
        # named exactly like the gateway event.
        async def on_message(message: discord.Message) -> None:
            try:
                await handler(message)
            except Exception:
                logger.exception("Failed to handle inbound Discord message")

        return on_message

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
