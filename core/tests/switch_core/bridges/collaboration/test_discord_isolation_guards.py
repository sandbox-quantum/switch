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
import pytest

from switch_core.bridges.collaboration.adapter import ChannelNotBindable
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
    The database side is scoped the same way — human actor and external-user rows are
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


# ── A bridge reaches only its own guild's channels ───────────────────────────


class _Webhook:
    id = 7001
    name = "Switch"
    token = "placeholder-webhook-token"

    def __init__(self, sent: list[dict[str, Any]]) -> None:
        self._sent = sent

    async def send(self, content: str = "", **kwargs: Any) -> Any:
        self._sent.append({"content": content, **kwargs})
        channel = type("_Ch", (), {"id": 555})()
        return type("_Sent", (), {"id": 8001, "channel": channel})()


class _Channel:
    """A text channel in `guild_id`, or a DM when that is None. The shared bot
    can see every tenant's channels, because it is in every tenant's guild."""

    id = 555
    parent_id = None

    def __init__(self, guild_id: int | None) -> None:
        self.guild = (
            None
            if guild_id is None
            else type("_G", (), {"id": guild_id, "default_role": None})()
        )
        self.sent: list[dict[str, Any]] = []

    async def webhooks(self) -> list[Any]:
        return []

    async def create_webhook(self, *, name: str) -> _Webhook:
        return _Webhook(self.sent)


def _guild_1_bridge_seeing(channel: _Channel, delivery: str) -> DiscordAdapter:
    config = (
        DiscordConnectionConfig(guild_id="1", event_delivery="shared")
        if delivery == "shared"
        else DiscordConnectionConfig(guild_id="1", bot_token="placeholder-token")
    )
    adapter = DiscordAdapter(config=config)
    client = type("_C", (), {"get_channel": lambda self, _id: channel})()
    adapter._connection = type("_Conn", (), {"client": client})()  # type: ignore[assignment]
    return adapter


@pytest.mark.parametrize("delivery", ["shared", "own_connection"])
async def test_a_channel_in_another_guild_cannot_be_bound(delivery: str) -> None:
    """Binding a room to a channel by id asks the bridge first. Being able to
    see the channel proves nothing on the shared bot, and even a tenant's own
    bot serves one guild per bridge."""
    adapter = _guild_1_bridge_seeing(_Channel(guild_id=2), delivery)

    with pytest.raises(ChannelNotBindable):
        await adapter.require_bindable_channel("555")


async def test_a_channel_in_its_own_guild_can_be_bound() -> None:
    adapter = _guild_1_bridge_seeing(_Channel(guild_id=1), "shared")

    await adapter.require_bindable_channel("555")


async def test_a_dm_cannot_be_bound_on_the_shared_connection() -> None:
    """Shared delivery carries no DMs, so a DM is not this bridge's."""
    adapter = _guild_1_bridge_seeing(_Channel(guild_id=None), "shared")

    with pytest.raises(ChannelNotBindable):
        await adapter.require_bindable_channel("555")


async def test_a_bridge_does_not_post_into_another_guild() -> None:
    """The backstop under binding: every lookup refuses another guild's
    channel, so nothing reaches one even if a room names it."""
    channel = _Channel(guild_id=2)
    adapter = _guild_1_bridge_seeing(channel, "shared")

    await adapter.send_message("555", "OrgA-agent", "hello from org A")

    assert channel.sent == []
