"""An agent is not shown a linked room it may not see: the link would name a
private room."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.operations.definitions import _decorate_linked_rooms


class _Session:
    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False


def _link(room_id: str) -> dict[str, Any]:
    return {
        "target_room_id": room_id,
        "target_room_name": room_id,
        "target_room_description": "",
        "label": "see also",
    }


async def test_links_to_rooms_the_agent_may_not_see_are_left_out() -> None:
    async def rooms_for_agent(_session: object, _agent_id: str) -> list[Any]:
        return [SimpleNamespace(id="joined")]

    async def visible(
        _session: object, _agent_id: str, *, include_archived: bool
    ) -> list[Any]:
        assert include_archived
        return [SimpleNamespace(id="joined"), SimpleNamespace(id="public")]

    protocol = SimpleNamespace(
        session_factory=_Session,
        room_store=SimpleNamespace(get_rooms_for_agent=rooms_for_agent),
        rooms_visible_to=visible,
    )

    out = await _decorate_linked_rooms(
        protocol,  # type: ignore[arg-type]
        "agent-1",
        [_link("joined"), _link("public"), _link("hidden")],
    )

    assert [(e["target_room_id"], e["access"]) for e in out] == [
        ("joined", "member"),
        ("public", "not_member"),
    ]
