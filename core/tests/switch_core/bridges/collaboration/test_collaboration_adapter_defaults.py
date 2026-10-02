"""The base `CollaborationAdapter` behaviour every platform inherits unless it
overrides it.

Exercised through `MattermostAdapter`, which overrides none of these: it holds
nothing on the platform that outlives a bridge, offers no choice of which
teams it is in, and has nothing a platform-side check or an admin's attention
would ever need to say.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


def _adapter() -> MattermostAdapter:
    return MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )


async def test_withdrawing_is_a_no_op_for_a_bridge_that_holds_nothing_on_the_platform() -> (
    None
):
    assert await _adapter().withdraw() is None


def test_an_adapter_does_not_place_its_app_in_teams_by_default() -> None:
    assert _adapter().places_app_in_teams is False


async def test_a_config_edit_is_not_checked_against_the_platform_by_default() -> None:
    assert await _adapter().check_config_edit({"url": "http://mm2"}) is None


async def test_nothing_needs_a_workspace_admins_attention_by_default() -> None:
    assert await _adapter().attention() is None
