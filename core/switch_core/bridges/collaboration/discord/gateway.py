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

This module is the foundation: it opens the shared socket with the right intents
and registers no commands yet. Attaching each guild's inert bridge to it, slash
routing, removal handling and the isolation guards land in the stages after.
"""

from __future__ import annotations

import logging

import discord

from switch_core.bridges.collaboration.discord.connection import DiscordConnection

logger = logging.getLogger(__name__)


class DiscordGatewayClient:
    def __init__(self, *, bot_token: str, message_content: bool, members: bool) -> None:
        self._message_content = message_content
        self._members = members
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
        # No commands yet — global slash routing lands in a later stage. The DM
        # handler is deliberately left unset (guard G4).
        await self._connection.connect(commands=[])
        logger.info(
            "Discord shared Gateway connection started (message_content=%s)",
            self._message_content,
        )

    async def stop(self) -> None:
        await self._connection.close()
