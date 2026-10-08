from types import SimpleNamespace
from typing import Any, cast

from switch_core.agent_icon import generated_icon_choices
from switch_core.gateway.agents import list_icon_choices


async def test_offers_the_server_generated_icons_page_by_page() -> None:
    user = cast(Any, SimpleNamespace(id="user-1"))
    first = await list_icon_choices(_user=user, name="pm-agent", page=0)
    later = await list_icon_choices(_user=user, name="pm-agent", page=2)
    assert first == {"choices": generated_icon_choices("pm-agent", 0)}
    assert later == {"choices": generated_icon_choices("pm-agent", 2)}
