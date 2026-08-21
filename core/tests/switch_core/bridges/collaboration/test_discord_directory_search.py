"""Discord member search backs identity claiming (CHOO-2137).

Without it the adapter falls through to the base class, which reports that the
platform has no searchable directory — so someone on Discord could only be
linked after they had spoken, even though Discord can answer the question.
"""

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


def _adapter(guild: Any) -> DiscordAdapter:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    adapter._get_guild = lambda: _completed(guild)  # type: ignore[method-assign]
    return adapter


async def _completed(value: Any) -> Any:
    return value


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeMember:
    def __init__(
        self, user_id: int, name: str, display_name: str, *, bot: bool = False
    ) -> None:
        self.id = user_id
        self.name = name
        self.display_name = display_name
        self.bot = bot


class _FakeGuild:
    def __init__(self, members: list[_FakeMember] | Exception) -> None:
        self._members = members
        self.queries: list[tuple[str, int]] = []

    async def query_members(self, *, query: str, limit: int) -> list[_FakeMember]:
        self.queries.append((query, limit))
        if isinstance(self._members, Exception):
            raise self._members
        return self._members


def test_members_map_to_directory_users() -> None:
    guild = _FakeGuild([_FakeMember(11, "adalovelace", "Ada L")])
    found = _run(_adapter(guild).search_directory_users("lou"))

    assert len(found) == 1
    person = found[0]
    # The id and username must be exactly what the inbound path records as the
    # sender, or a claim made here would never match an arriving message.
    assert person.external_user_id == "11"
    assert person.username == "adalovelace"
    assert person.display_name == "Ada L"
    # Discord's bot API never discloses a member's email.
    assert person.email is None


def test_query_is_passed_to_discord() -> None:
    guild = _FakeGuild([])
    _run(_adapter(guild).search_directory_users("  lou  "))
    # Trimmed, and within Discord's accepted 5..100 limit range.
    assert guild.queries == [("lou", 100)]


def test_bots_are_excluded() -> None:
    guild = _FakeGuild(
        [
            _FakeMember(1, "a-human", "A Human"),
            _FakeMember(2, "some-bot", "Some Bot", bot=True),
        ]
    )
    found = _run(_adapter(guild).search_directory_users("a"))
    # A bot cannot own an agent, so offering it as "you" is never right.
    assert [p.username for p in found] == ["a-human"]


def test_results_are_sorted_by_display_name() -> None:
    guild = _FakeGuild(
        [
            _FakeMember(1, "zoe", "Zoe"),
            _FakeMember(2, "adam", "adam"),
            _FakeMember(3, "mia", "Mia"),
        ]
    )
    found = _run(_adapter(guild).search_directory_users("x"))
    assert [p.display_name for p in found] == ["adam", "Mia", "Zoe"]


def test_blank_query_does_not_hit_discord() -> None:
    guild = _FakeGuild([_FakeMember(1, "someone", "Someone")])
    assert _run(_adapter(guild).search_directory_users("   ")) == []
    assert guild.queries == []


class _FakeResponse:
    status = 500
    reason = "Internal Server Error"


def _errors() -> list[BaseException]:
    """The three failures `Guild.query_members` documents, minus ValueError,
    which only fires on parameters this adapter hard-codes correctly."""
    return [
        discord.ClientException("presences intent is not enabled"),
        discord.HTTPException(_FakeResponse(), "boom"),
        TimeoutError(),
    ]


@pytest.mark.parametrize("index", range(3))
def test_failures_surface_as_runtime_error(index: int) -> None:
    # The gateway going quiet or refusing must reach the caller as a bridge
    # failure, not an empty list that reads as "nobody by that name".
    guild = _FakeGuild(_errors()[index])
    with pytest.raises(RuntimeError):
        _run(_adapter(guild).search_directory_users("lou"))
