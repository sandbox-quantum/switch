from types import SimpleNamespace
from typing import Any, cast

from switch_core.agent_icon import generated_icon_choices
from switch_core.gateway.agents import list_icon_choices


def _config(third_party_avatars_enabled: bool) -> Any:
    return SimpleNamespace(third_party_avatars_enabled=third_party_avatars_enabled)


async def test_offers_the_server_generated_icons_page_by_page() -> None:
    user = cast(Any, SimpleNamespace(id="user-1"))
    first = await list_icon_choices(
        _user=user, config=_config(True), name="pm-agent", page=0
    )
    later = await list_icon_choices(
        _user=user, config=_config(True), name="pm-agent", page=2
    )
    assert first == {"choices": generated_icon_choices("pm-agent", 0)}
    assert later == {"choices": generated_icon_choices("pm-agent", 2)}


async def test_offers_none_when_third_party_avatars_are_off() -> None:
    user = cast(Any, SimpleNamespace(id="user-1"))
    off = await list_icon_choices(
        _user=user, config=_config(False), name="pm-agent", page=0
    )
    assert off == {"choices": []}
