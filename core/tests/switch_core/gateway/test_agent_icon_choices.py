from types import SimpleNamespace
from typing import Any, cast

import pytest

from switch_core.agent_icon import generated_icon_choices
from switch_core.gateway.agents import get_avatar_settings, list_icon_choices
from switch_core.gateway.schemas import AvatarSettingsResponse, IconChoicesResponse

_USER = cast(Any, SimpleNamespace(id="user-1"))


def _config(third_party_avatars_enabled: bool) -> Any:
    return SimpleNamespace(third_party_avatars_enabled=third_party_avatars_enabled)


async def test_offers_the_server_generated_icons_page_by_page() -> None:
    first = await list_icon_choices(
        _user=_USER, config=_config(True), name="pm-agent", page=0
    )
    later = await list_icon_choices(
        _user=_USER, config=_config(True), name="pm-agent", page=2
    )
    assert first == IconChoicesResponse(
        choices=generated_icon_choices("pm-agent", 0), third_party_avatars_enabled=True
    )
    assert later == IconChoicesResponse(
        choices=generated_icon_choices("pm-agent", 2), third_party_avatars_enabled=True
    )


async def test_offers_none_when_third_party_avatars_are_off_and_says_why() -> None:
    """An empty page alone reads as "nothing to offer". The flag says the
    server generates none, so a picker can explain itself."""
    off = await list_icon_choices(
        _user=_USER, config=_config(False), name="pm-agent", page=0
    )
    assert off == IconChoicesResponse(choices=[], third_party_avatars_enabled=False)


@pytest.mark.parametrize("enabled", [True, False])
async def test_avatar_settings_report_the_servers_setting(enabled: bool) -> None:
    settings = await get_avatar_settings(_user=_USER, config=_config(enabled))
    assert settings == AvatarSettingsResponse(third_party_avatars_enabled=enabled)
