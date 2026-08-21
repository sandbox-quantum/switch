"""CHOO-2067 — a platform's refusal to provision a channel must reach the
operator who asked for the room.

Adding a room to a Microsoft Teams bridge whose app registration had no
consented Graph permissions returned a bare `500`. Graph had answered with the
exact permission it wanted, and that sentence went to the log while the person
clicking the button got nothing to act on. The route coroutine is exercised
directly; the failure happens before any store is touched, so no database is
needed.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelCreationUnsupported,
)
from switch_core.gateway.rooms import create_room
from switch_core.gateway.schemas import RoomCreateRequest

_GRAPH_REFUSAL = (
    "create channel 'Switch Test Room' in team team-1 failed (403): "
    "Forbidden: Missing role permissions on the request. API requires one of "
    "'Channel.Create, Teamwork.Migrate.All'."
)


class _RaisingRoomService:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    async def create_room(self, config: Any) -> Any:
        raise self._exc


def _request() -> RoomCreateRequest:
    return RoomCreateRequest(
        name="Switch Test Room",
        description="d",
        channel_type="channel_public",
        bridge_id="bridge-1",
        agent_names=["agent.one"],
    )


async def _call(exc: Exception) -> HTTPException:
    """Invoke the route with a room service that fails, and return the raised
    HTTPException. Every dependency after the failure point is unused."""
    with pytest.raises(HTTPException) as excinfo:
        await create_room(
            req=_request(),
            session=None,  # type: ignore[arg-type]
            room_service=_RaisingRoomService(exc),  # type: ignore[arg-type]
            room_store=None,  # type: ignore[arg-type]
            bridge_store=None,  # type: ignore[arg-type]
            external_user_store=None,  # type: ignore[arg-type]
            protocol=None,  # type: ignore[arg-type]
            user=type("U", (), {"id": "u1"})(),  # type: ignore[arg-type]
        )
    return excinfo.value


async def test_platform_refusal_is_502_carrying_the_platforms_words() -> None:
    exc = await _call(BridgeOperationError(_GRAPH_REFUSAL))

    assert exc.status_code == 502
    # The actionable half — which permission is missing — survives to the caller.
    assert "Channel.Create" in exc.detail
    assert exc.detail == _GRAPH_REFUSAL


async def test_switch_declining_is_still_a_400() -> None:
    # ChannelCreationUnsupported is Switch refusing before it calls out, which
    # is a fault in the request rather than upstream. It must not be swept into
    # the new 502 branch.
    exc = await _call(ChannelCreationUnsupported("channel creation is turned off"))

    assert exc.status_code == 400
    assert "turned off" in exc.detail


async def test_an_ordinary_bug_is_not_dressed_up_as_a_platform_refusal() -> None:
    # The 502 claims the platform answered. A KeyError in our own code did not,
    # so it must keep propagating as an unhandled error rather than being
    # reported to the operator as something for them to fix in Azure.
    with pytest.raises(KeyError):
        await create_room(
            req=_request(),
            session=None,  # type: ignore[arg-type]
            room_service=_RaisingRoomService(KeyError("boom")),  # type: ignore[arg-type]
            room_store=None,  # type: ignore[arg-type]
            bridge_store=None,  # type: ignore[arg-type]
            external_user_store=None,  # type: ignore[arg-type]
            protocol=None,  # type: ignore[arg-type]
            user=type("U", (), {"id": "u1"})(),  # type: ignore[arg-type]
        )
