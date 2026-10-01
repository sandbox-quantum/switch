"""Member searches have a budget on each Discord socket.

A search is a Gateway send, and discord.py holds every send past 110 a minute
until the minute is up. On the shared connection that is every organisation's
budget at once, so searches are capped below it and refused outright once the
cap is spent: the person searching is told to try again, instead of waiting on
a search that times out.
"""

from __future__ import annotations

from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.adapter import DirectorySearchBusy
from switch_core.bridges.collaboration.discord import connection as connection_module
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.discord.connection import (
    _MEMBER_SEARCHES_PER_WINDOW,
    DiscordConnection,
)


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    fake = _Clock()
    monkeypatch.setattr(connection_module, "_clock", fake)
    return fake


def _connection() -> DiscordConnection:
    return DiscordConnection(
        bot_token="t", intents=discord.Intents.none(), command_guild_id=None
    )


def _spend(connection: DiscordConnection) -> None:
    for _ in range(_MEMBER_SEARCHES_PER_WINDOW):
        connection.take_member_search()


def test_searches_within_the_budget_go_through(clock: _Clock) -> None:
    _spend(_connection())


def test_the_next_one_is_refused_and_says_when_to_retry(clock: _Clock) -> None:
    connection = _connection()
    _spend(connection)
    clock.now += 20

    with pytest.raises(DirectorySearchBusy) as refused:
        connection.take_member_search()

    assert refused.value.retry_after == pytest.approx(40)
    assert "try again in 40 seconds" in str(refused.value)


def test_the_budget_comes_back_as_the_window_moves(clock: _Clock) -> None:
    connection = _connection()
    _spend(connection)
    clock.now += 60

    connection.take_member_search()


async def test_a_spent_budget_stops_the_search_before_it_reaches_discord(
    clock: _Clock,
) -> None:
    connection = _connection()
    _spend(connection)
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(guild_id="900", event_delivery="shared")
    )
    adapter.attach_shared_connection(connection)

    async def _no_guild() -> Any:
        raise AssertionError("searched Discord with the budget spent")

    adapter._get_guild = _no_guild  # type: ignore[method-assign]

    with pytest.raises(DirectorySearchBusy):
        await adapter.search_directory_users("lou")
