"""`create_room` takes the client app a room is for: it asks for the room with
that kind and with follow-ups off, and an agent sees the kind on a room."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import create_room
from switch_core.bridges.agent.protocol.agent_core import (
    _describe_room,
    inherited_room_kind,
)
from switch_core.chats import ROOM_KIND_KEY
from switch_core.db.models import Room
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomCreateConfig, RoomCreateResult


@pytest.fixture
def asked(env):
    """What `create_room` asked the protocol for, by keyword."""
    protocol = env["protocol"]
    seen: list[dict[str, Any]] = []

    async def create_moderation_room(**kwargs: Any) -> RoomCreateResult:
        seen.append(kwargs)
        return await protocol.room_service.create_room(
            RoomCreateConfig(
                name=kwargs["name"],
                description=kwargs["description"],
                agent_names=kwargs["agent_names"],
            )
        )

    protocol.create_moderation_room = create_moderation_room
    token = set_call_context(
        CallContext(agent_id=env["agent_id"], session_key=None, session=None)
    )
    yield seen
    reset_call_context(token)


@pytest.mark.asyncio
async def test_a_room_for_a_client_app_is_asked_for_with_its_kind_and_follow_ups_off(
    asked,
) -> None:
    await create_room(
        name="for the app",
        description="",
        agent_names=["claude-code.alice"],
        room_kind="reaqt",
    )
    assert (asked[0]["room_kind"], asked[0]["follow_ups_off"]) == ("reaqt", True)


@pytest.mark.asyncio
async def test_an_ordinary_room_is_asked_for_with_no_kind(asked) -> None:
    await create_room(
        name="ordinary", description="", agent_names=["claude-code.alice"]
    )
    assert (asked[0]["room_kind"], asked[0]["follow_ups_off"]) == (None, False)


@pytest.mark.asyncio
async def test_a_kind_that_is_not_a_slug_is_refused(asked) -> None:
    with pytest.raises(ValueError, match="lowercase slug"):
        await create_room(
            name="bad",
            description="",
            agent_names=["claude-code.alice"],
            room_kind="Not A Slug",
        )


def _room(metadata: dict[str, Any] | None) -> Room:
    return Room(
        id="r1",
        name="room",
        description="",
        transport_room_id="t1",
        metadata_=metadata,
    )


def test_an_agent_sees_the_kind_of_a_room_for_a_client_app() -> None:
    kinds = [
        _describe_room(_room({ROOM_KIND_KEY: "reaqt"})).room_kind,
        _describe_room(_room({"created_by_kind": "agent"})).room_kind,
        _describe_room(_room(None)).room_kind,
    ]
    assert kinds == ["reaqt", None, None]


@pytest.mark.asyncio
async def test_a_room_made_from_a_client_apps_room_takes_its_kind(
    session_factory,
) -> None:
    rooms = RoomStore()
    async with session_factory() as session:
        app_room = await rooms.create(
            session,
            Room(
                transport_room_id="!app:test",
                name="app",
                description="",
                metadata_={ROOM_KIND_KEY: "reaqt"},
            ),
        )
        plain = await rooms.create(
            session,
            Room(transport_room_id="!plain:test", name="plain", description=""),
        )
        await session.commit()
        kinds = [
            await inherited_room_kind(session, app_room.id),
            await inherited_room_kind(session, plain.id),
            await inherited_room_kind(session, None),
        ]
    assert kinds == ["reaqt", None, None]
