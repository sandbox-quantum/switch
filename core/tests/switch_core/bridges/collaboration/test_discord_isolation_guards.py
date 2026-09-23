"""The four isolation guards on the shared, multi-tenant Discord connection.

Each guard has a test that fails without it. G1 (per-event scoping, no tenant
cached, resolved fresh) and G3 (no default tenant, unmapped guild dropped) live
in `test_discord_gateway_routing.py`, where the routing they guard is. G4's
intent half is in `test_discord_gateway.py`. This file pins the two remaining
faces: G4's drop-before-routing and G2's tenant-scoped identity.
"""

from __future__ import annotations

from typing import Any

import discord

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.discord.connection import DiscordConnection


def _connection() -> DiscordConnection:
    return DiscordConnection(
        bot_token="bot-token",
        intents=discord.Intents.none(),
        command_guild_id=None,
    )


def _message(guild_id: int | None) -> Any:
    guild = None if guild_id is None else type("_G", (), {"id": guild_id})()
    return type("_M", (), {"guild": guild})()


# ── G4 — no guild-less routing ───────────────────────────────────────────────


async def test_a_dm_is_dropped_before_routing() -> None:
    """A guild-less message reaches no handler when the DM slot is empty, which
    is how the shared connection is wired — a DM carries no guild to attribute
    to a tenant."""
    conn = _connection()
    routed: list[Any] = []

    async def catch_all(message: Any) -> None:
        routed.append(message)

    conn.set_guild_message_handler(catch_all)
    # No DM handler set (the shared connection leaves it unset).
    on_message = conn._make_on_message()

    await on_message(_message(None))  # a DM
    assert routed == []

    await on_message(_message(42))  # a guild message still routes
    assert len(routed) == 1


# ── G2 — tenant-scoped identity ──────────────────────────────────────────────


async def test_each_guilds_bridge_has_its_own_identity_caches() -> None:
    """The same Discord user in two tenants' guilds yields two independent
    records: each guild is served by its own adapter (one install = one tenant,
    decision D2), so a user-id-keyed cache on one is not shared with the other.
    The database side is scoped the same way — puppet and external-user rows are
    written under each bridge's tenant through row-level security."""
    tenant_a = DiscordAdapter(
        config=DiscordConnectionConfig(guild_id="1", event_delivery="shared")
    )
    tenant_b = DiscordAdapter(
        config=DiscordConnectionConfig(guild_id="2", event_delivery="shared")
    )

    tenant_a._user_names[999] = "alice-in-a"

    assert tenant_a._user_names is not tenant_b._user_names
    assert 999 not in tenant_b._user_names
