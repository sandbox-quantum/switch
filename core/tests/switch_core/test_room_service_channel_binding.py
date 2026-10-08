"""A room bound to an existing channel by id binds only a channel the bridge
calls its own.

Binding decides where a room's messages are posted, and on a connection shared
between organisations the bot can see every organisation's channels. So a
caller-supplied id is put to the bridge before anything is created; a channel
the platform delivered to the bridge is not, because it reached this bridge by
being its own. The move path (`change_bridge`) is covered beside its other
tests.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import ChannelNotBindable
from switch_core.room_service import RoomCreateConfig
from tests.switch_core.test_room_service_change_bridge import (
    _build_service,
    _FakeCollaborationCore,
)


class _Reached(Exception):
    """Raised by the first step after the check, to show it was passed."""


def _service(events: list[Any]) -> tuple[Any, _FakeCollaborationCore]:
    bridge = _FakeCollaborationCore(events, transport_user_id="@bot:switch.local")
    bridge.adapter.not_bindable.add("chan-elsewhere")
    svc, _ = _build_service(
        room=SimpleNamespace(),
        agent_ids=[],
        agent_names={},
        bridges={"bridge-1": bridge},
        events=events,
    )

    async def create_matrix_room(*_: Any, **__: Any) -> str:
        raise _Reached

    svc._provisioning.create_room = create_matrix_room
    return svc, bridge


def _config(created_by_kind: str) -> RoomCreateConfig:
    return RoomCreateConfig(
        name="Work",
        description="",
        bridge_id="bridge-1",
        external_channel_id="chan-elsewhere",
        channel_type="channel_public",
        created_by_kind=created_by_kind,  # type: ignore[arg-type]
    )


@pytest.mark.parametrize("kind", ["user", "agent"])
async def test_a_channel_the_bridge_refuses_is_not_bound(kind: str) -> None:
    events: list[Any] = []
    svc, _ = _service(events)

    with pytest.raises(ChannelNotBindable):
        await svc.create_room(_config(kind))

    assert events == [("require_bindable", "chan-elsewhere")]


async def test_a_channel_the_platform_delivered_is_not_asked_about() -> None:
    events: list[Any] = []
    svc, _ = _service(events)

    with pytest.raises(_Reached):
        await svc.create_room(_config("system"))

    assert ("require_bindable", "chan-elsewhere") not in events
