"""The gateway's room routes say who is inviting, and a refused invite is a 403.

`RoomService` decides whether an invite is allowed (see `invite_policy`). These
tests pin the gateway's half: the signed-in user is the inviter, and the
refusal reaches them with its wording instead of a 400 or a 500. The route
coroutines are called directly with a fake room service, so no database is
needed.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.gateway import rooms as rooms_routes
from switch_core.gateway.rooms import create_room, post_room_agents
from switch_core.gateway.schemas import RoomAgentsRequest, RoomCreateRequest
from switch_core.invite_policy import Inviter, InviteRefused

_REFUSAL = "You can't invite `private-helper`: ask the owner to invite it."


class _RefusingRoomService:
    def __init__(self) -> None:
        self.invited_by: list[Inviter] = []

    async def create_room(self, config: Any) -> Any:
        raise InviteRefused(["private-helper"], _REFUSAL)

    async def add_agents_to_room(self, room_id: str, **kwargs: Any) -> None:
        self.invited_by.append(kwargs["invited_by"])
        raise InviteRefused(["private-helper"], _REFUSAL)


_USER = type("U", (), {"id": "user-1"})()


async def test_creating_a_room_with_an_agent_one_may_not_invite_is_403() -> None:
    with pytest.raises(HTTPException) as caught:
        await create_room(
            req=RoomCreateRequest(
                name="r", description="d", agent_names=["private-helper"]
            ),
            session=None,  # type: ignore[arg-type]
            room_service=_RefusingRoomService(),  # type: ignore[arg-type]
            room_store=None,  # type: ignore[arg-type]
            bridge_store=None,  # type: ignore[arg-type]
            external_user_store=None,  # type: ignore[arg-type]
            protocol=None,  # type: ignore[arg-type]
            user=_USER,  # type: ignore[arg-type]
            is_admin=False,
        )
    assert caught.value.status_code == 403
    assert caught.value.detail == _REFUSAL


async def test_adding_an_agent_on_the_room_page_names_the_user_and_is_403(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _released(*_args: Any, **_kwargs: Any) -> Any:
        # A shared room, whose agents the room page may change.
        return SimpleNamespace(channel_type=None)

    monkeypatch.setattr(rooms_routes, "_require_room_released", _released)
    room_service = _RefusingRoomService()

    with pytest.raises(HTTPException) as caught:
        await post_room_agents(
            room_id="room-1",
            req=RoomAgentsRequest(agent_ids=["agent-private"]),
            session=None,  # type: ignore[arg-type]
            room_service=room_service,  # type: ignore[arg-type]
            room_store=None,  # type: ignore[arg-type]
            bridge_store=None,  # type: ignore[arg-type]
            external_user_store=None,  # type: ignore[arg-type]
            protocol=None,  # type: ignore[arg-type]
            user=_USER,  # type: ignore[arg-type]
            is_admin=False,
        )
    assert caught.value.status_code == 403
    assert caught.value.detail == _REFUSAL
    assert room_service.invited_by == [Inviter.person("user-1")]
