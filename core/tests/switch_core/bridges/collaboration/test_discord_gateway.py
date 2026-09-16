"""The shared, deployment-level Discord Gateway connection.

Stage 4a: the connection exists with the right intents and command scope, binds
no tenant, and never opens the door to a direct message (guard G4 begins here —
no DM intent and no DM handler). Attaching bridges, routing and removal come
later; this pins the foundation.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.discord.gateway import DiscordGatewayClient


def _gateway(*, message_content: bool = False) -> DiscordGatewayClient:
    return DiscordGatewayClient(bot_token="bot-token", message_content=message_content)


def test_it_requests_no_dm_or_members_intent() -> None:
    """G4 starts here (no DM intent), and members is privileged, so a shared
    multi-tenant connection does not request it either."""
    intents = _gateway().connection._intents
    assert intents.guilds is True
    assert intents.guild_messages is True
    assert intents.dm_messages is False
    assert intents.members is False


def test_message_content_is_off_by_default() -> None:
    assert _gateway().connection._intents.message_content is False


def test_message_content_can_be_turned_on() -> None:
    assert _gateway(message_content=True).connection._intents.message_content is True


def test_commands_register_globally_not_per_guild() -> None:
    """Decision #7: one application-wide command set, not one per guild."""
    assert _gateway().connection._command_guild_id is None


def test_no_dm_handler_is_wired() -> None:
    """A DM carries no guild, so it cannot be attributed to a tenant; the slot
    is left empty so any that arrive are dropped (G4)."""
    assert _gateway().connection._dm_handler is None
