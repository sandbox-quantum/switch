"""The room page refuses to put an agent in a room for someone it does not take
instructions from (#805), says why, and invites as that signed-in user.

The route coroutines are called directly with a room service that records who
is inviting or refuses; the refusal happens before any store is touched."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.gateway.rooms import create_room, post_room_agents
from switch_core.gateway.schemas import RoomAgentsRequest, RoomCreateRequest
from switch_core.invites import Inviter, InviteRefused, UserInviter

_REFUSAL = (
    "helper doesn't take instructions from you, so it wasn't added. Its owner "
    "(Alice) can invite it, or can change who it takes instructions from."
)


class _RoomService:
    def __init__(self, refusal: InviteRefused | None) -> None:
        self._refusal = refusal
        self.invited_by: list[Inviter] = []

    async def create_room(self, config: Any, *, invited_by: Inviter) -> Any:
        self.invited_by.append(invited_by)
        if self._refusal is not None:
            raise self._refusal
        raise _Reached

    async def add_agents_to_room(self, room_id: str, **kwargs: Any) -> None:
        self.invited_by.append(kwargs["invited_by"])
        if self._refusal is not None:
            raise self._refusal
        raise _Reached


class _Reached(Exception):
    """The route went on past the invite."""


def _refusal() -> InviteRefused:
    return InviteRefused(_REFUSAL, ["a1"], ["helper"])


def _user() -> Any:
    return type("U", (), {"id": "u1"})()


async def _create(service: _RoomService) -> None:
    await create_room(
        req=RoomCreateRequest(
            name="r", description="d", internal_only=True, agent_names=["helper"]
        ),
        session=None,  # type: ignore[arg-type]
        room_service=service,  # type: ignore[arg-type]
        room_store=None,  # type: ignore[arg-type]
        bridge_store=None,  # type: ignore[arg-type]
        external_user_store=None,  # type: ignore[arg-type]
        protocol=None,  # type: ignore[arg-type]
        user=_user(),
    )


async def _add(service: _RoomService, monkeypatch: pytest.MonkeyPatch) -> None:
    async def released(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr("switch_core.gateway.rooms._require_room_released", released)
    await post_room_agents(
        room_id="room-1",
        req=RoomAgentsRequest(agent_ids=["a1"]),
        session=None,  # type: ignore[arg-type]
        room_service=service,  # type: ignore[arg-type]
        room_store=None,  # type: ignore[arg-type]
        bridge_store=None,  # type: ignore[arg-type]
        external_user_store=None,  # type: ignore[arg-type]
        protocol=None,  # type: ignore[arg-type]
        user=_user(),
        is_admin=False,
    )


async def test_creating_a_room_with_an_agent_that_refuses_is_a_403_saying_why() -> None:
    service = _RoomService(_refusal())
    with pytest.raises(HTTPException) as raised:
        await _create(service)
    assert raised.value.status_code == 403
    assert raised.value.detail == _REFUSAL


async def test_adding_an_agent_that_refuses_is_a_403_saying_why(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _RoomService(_refusal())
    with pytest.raises(HTTPException) as raised:
        await _add(service, monkeypatch)
    assert raised.value.status_code == 403
    assert raised.value.detail == _REFUSAL


async def test_both_routes_invite_as_the_signed_in_user(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _RoomService(None)
    with pytest.raises(_Reached):
        await _create(service)
    with pytest.raises(_Reached):
        await _add(service, monkeypatch)
    assert service.invited_by == [UserInviter("u1"), UserInviter("u1")]
