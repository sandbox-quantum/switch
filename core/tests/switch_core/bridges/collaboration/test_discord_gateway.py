"""The shared, deployment-level Discord Gateway connection.

Stage 4a: the connection exists with the right intents and command scope, binds
no tenant, and never opens the door to a direct message (guard G4 begins here —
no DM intent and no DM handler). Attaching bridges, routing and removal come
later; this pins the foundation.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.discord.gateway import DiscordGatewayClient


def _gateway(
    *, message_content: bool = False, members: bool = False
) -> DiscordGatewayClient:
    return DiscordGatewayClient(
        bot_token="bot-token",
        message_content=message_content,
        members=members,
    )


def test_it_requests_no_dm_intent_and_privileged_intents_default_off() -> None:
    """G4 starts here (no DM intent). message_content and members are both
    privileged and off by default so the connection opens unapproved."""
    intents = _gateway().connection._intents
    assert intents.guilds is True
    assert intents.guild_messages is True
    assert intents.dm_messages is False
    assert intents.message_content is False
    assert intents.members is False


def test_message_content_can_be_turned_on() -> None:
    assert _gateway(message_content=True).connection._intents.message_content is True


def test_members_can_be_turned_on_independently() -> None:
    """Its own flag, approved separately from message content."""
    intents = _gateway(members=True).connection._intents
    assert intents.members is True
    assert intents.message_content is False


def test_commands_register_globally_not_per_guild() -> None:
    """Decision #7: one application-wide command set, not one per guild."""
    assert _gateway().connection._command_guild_id is None


def test_no_dm_handler_is_wired() -> None:
    """A DM carries no guild, so it cannot be attributed to a tenant; the slot
    is left empty so any that arrive are dropped (G4)."""
    assert _gateway().connection._dm_handler is None
