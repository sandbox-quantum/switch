from __future__ import annotations

import asyncio
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)

GUILD_ID = 900


def _adapter() -> DiscordAdapter:
    return DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeRole:
    pass


class _FakeMember:
    def __init__(self, user_id: int) -> None:
        self.id = user_id


class _FakeCreatedChannel:
    def __init__(self, channel_id: int, guild: _FakeGuild) -> None:
        self.id = channel_id
        self.guild = guild
        self.permission_grants: list[tuple[Any, dict[str, Any]]] = []

    async def set_permissions(self, target: Any, **kwargs: Any) -> None:
        self.permission_grants.append((target, kwargs))


class _FakeGuild:
    def __init__(self) -> None:
        self.id = GUILD_ID
        self.default_role = _FakeRole()
        self.me = _FakeMember(42)
        self.created: list[dict[str, Any]] = []
        self.members: dict[int, _FakeMember] = {}
        self._next_channel_id = 100

    async def create_text_channel(self, **kwargs: Any) -> _FakeCreatedChannel:
        self.created.append(kwargs)
        self._next_channel_id += 1
        return _FakeCreatedChannel(self._next_channel_id, self)

    def get_member(self, user_id: int) -> _FakeMember | None:
        return self.members.get(user_id)

    async def fetch_member(self, user_id: int) -> _FakeMember:
        member = self.members.get(user_id)
        if member is None:
            raise _not_found()
        return member


class _FakeClient:
    def __init__(
        self, guild: _FakeGuild, channels: dict[int, Any] | None = None
    ) -> None:
        self._guild = guild
        self._channels = channels or {}

    def get_guild(self, guild_id: int) -> _FakeGuild | None:
        return self._guild if guild_id == self._guild.id else None

    def get_channel(self, channel_id: int) -> Any | None:
        return self._channels.get(channel_id)

    async def fetch_channel(self, channel_id: int) -> Any:
        channel = self._channels.get(channel_id)
        if channel is None:
            raise _not_found()
        return channel


class _FakeResponse:
    status = 404
    reason = "Not Found"


def _not_found() -> discord.NotFound:
    return discord.NotFound(_FakeResponse(), "not found")


class _FakePrivateChannel:
    def __init__(self, channel_id: int, guild: _FakeGuild, private: bool) -> None:
        self.id = channel_id
        self.guild = guild
        self._private = private
        self.permission_grants: list[tuple[Any, dict[str, Any]]] = []

    def overwrites_for(self, role: Any) -> Any:
        class _Overwrite:
            view_channel = False if self._private else None

        return _Overwrite()

    async def set_permissions(self, target: Any, **kwargs: Any) -> None:
        if isinstance(target, _FakeMember) and target.id == 666:
            raise discord.HTTPException(_FakeResponse(), "boom")
        self.permission_grants.append((target, kwargs))


def _wire(
    adapter: DiscordAdapter, guild: _FakeGuild, channels: dict[int, Any] | None = None
) -> None:
    adapter._client = _FakeClient(guild, channels)  # type: ignore[assignment]


# ── create_channel ───────────────────────────────────────────────────────────


def test_create_public_channel_sanitizes_name_and_sets_topic() -> None:
    adapter = _adapter()
    guild = _FakeGuild()
    _wire(adapter, guild)

    channel_id = _run(adapter.create_channel("My Feature Room!", "workstream topic"))

    assert channel_id == "101"
    created = guild.created[0]
    assert created["name"] == "my-feature-room"
    assert created["topic"] == "workstream topic"
    assert created["overwrites"] == {}


def test_create_private_channel_denies_everyone_and_allows_bot() -> None:
    adapter = _adapter()
    guild = _FakeGuild()
    _wire(adapter, guild)

    _run(adapter.create_channel("secret", "t", channel_type="channel_private"))

    overwrites = guild.created[0]["overwrites"]
    assert overwrites[guild.default_role].view_channel is False
    assert overwrites[guild.me].view_channel is True


def test_create_group_or_direct_channel_rejected() -> None:
    adapter = _adapter()
    _wire(adapter, _FakeGuild())

    for channel_type in ("group", "direct"):
        with pytest.raises(ValueError, match="initiated from the messaging platform"):
            _run(adapter.create_channel("x", "t", channel_type=channel_type))  # type: ignore[arg-type]


def test_create_dm_channel_provisions_private_channel_with_user() -> None:
    adapter = _adapter()
    guild = _FakeGuild()
    guild.members[7] = _FakeMember(7)
    _wire(adapter, guild)

    channel_id = _run(
        adapter.create_dm_channel(
            agent_name="my-agent", user_name="louis", user_external_id="7"
        )
    )

    assert channel_id == "101"
    created = guild.created[0]
    assert created["name"] == "dm-louis-my-agent"
    assert created["overwrites"][guild.default_role].view_channel is False


# ── add_users_to_channel ─────────────────────────────────────────────────────


def test_add_users_to_private_channel_grants_view_per_user() -> None:
    adapter = _adapter()
    guild = _FakeGuild()
    guild.members[7] = _FakeMember(7)
    guild.members[8] = _FakeMember(8)
    channel = _FakePrivateChannel(200, guild, private=True)
    _wire(adapter, guild, {200: channel})

    _run(adapter.add_users_to_channel("200", ["louis", "ana"], ["7", "8"]))

    granted_ids = [target.id for target, _ in channel.permission_grants]
    assert granted_ids == [7, 8]
    assert all(
        kwargs == {"view_channel": True} for _, kwargs in channel.permission_grants
    )


def test_add_users_failure_is_isolated_per_user() -> None:
    adapter = _adapter()
    guild = _FakeGuild()
    guild.members[666] = _FakeMember(666)
    guild.members[8] = _FakeMember(8)
    channel = _FakePrivateChannel(200, guild, private=True)
    _wire(adapter, guild, {200: channel})

    _run(adapter.add_users_to_channel("200", ["bad", "ana"], ["666", "8"]))

    assert [target.id for target, _ in channel.permission_grants] == [8]


def test_add_users_to_public_channel_is_noop() -> None:
    adapter = _adapter()
    guild = _FakeGuild()
    guild.members[7] = _FakeMember(7)
    channel = _FakePrivateChannel(200, guild, private=False)
    _wire(adapter, guild, {200: channel})

    _run(adapter.add_users_to_channel("200", ["louis"], ["7"]))

    assert channel.permission_grants == []


# ── Deeplinks ────────────────────────────────────────────────────────────────


def test_channel_deeplink_built_from_guild_and_channel() -> None:
    adapter = _adapter()

    link = _run(adapter.channel_deeplink("12345"))

    assert link == f"https://discord.com/channels/{GUILD_ID}/12345"
    assert _run(adapter.channel_deeplink("")) is None
