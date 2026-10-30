"""The base `PlatformAdapter` behaviour every platform inherits unless it
overrides it.

Exercised through `DiscordAdapter`, which overrides none of these.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)


def _adapter() -> DiscordAdapter:
    return DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id="1")
    )


async def test_withdrawing_is_a_no_op_for_a_bridge_that_holds_nothing_on_the_platform() -> (
    None
):
    assert await _adapter().withdraw() is None


def test_an_adapter_does_not_place_its_app_in_teams_by_default() -> None:
    assert _adapter().places_app_in_teams is False


async def test_a_config_edit_is_not_checked_against_the_platform_by_default() -> None:
    assert await _adapter().check_config_edit({"guild_id": "2"}) is None


async def test_nothing_needs_a_workspace_admins_attention_by_default() -> None:
    assert await _adapter().attention() is None
