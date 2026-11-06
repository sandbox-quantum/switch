"""`PATCH /gateway/rooms/{id}` with `show_tool_io`: only the room's owner or an
admin may change it, both `GET` and `PATCH` report it, and turning it off
changes only the room's setting, in the request's own session after
`update_room` has committed its own: the tool text already stored stays,
every read made while the room is off shows none, and it is shown again once
the room turns it back on.

The routes are called directly, as in `test_room_sync_name`, with the real
`_build_room_detail`.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import AgentSessionActivityItem, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway import rooms as rooms_module
from switch_core.gateway.schemas import RoomDetail, RoomUpdateRequest
from tests.switch_core.gateway import test_chats_tool_io_read as read_tests
from tests.switch_core.gateway.conftest import _Harness

_PATCH_SECONDS = 10.0


class _Protocol:
    """What `_build_room_detail` asks of `AgentCore` for a room with no bridge."""

    def __init__(self) -> None:
        self.room_role_store = RoomRoleStore()
        self.agent_store = AgentStore()
        self.connections = AgentConnectionRegistry()

    async def get_agent_statuses_by_ids_in_session(
        self, session: object, room_id: str, agent_ids: list[str]
    ) -> dict[str, object]:
        return {}


async def _patch(
    chats: _Harness, room_id: str, req: RoomUpdateRequest, user: User, is_admin: bool
) -> RoomDetail:
    async with chats.factory() as session:
        return await rooms_module.patch_room(
            room_id,
            req,
            session,
            chats.room_service,
            RoomStore(),
            CollaborationBridgeStore(),
            ExternalUserStore(),
            _Protocol(),  # type: ignore[arg-type]
            user,
            is_admin,
        )


async def _get(chats: _Harness, room_id: str, user: User) -> RoomDetail:
    async with chats.factory() as session:
        return await rooms_module.get_room(
            room_id,
            session,
            RoomStore(),
            CollaborationBridgeStore(),
            ExternalUserStore(),
            _Protocol(),  # type: ignore[arg-type]
            user,
            False,
        )


async def _public_room(chats: _Harness) -> str:
    """A room Alice owns that anyone may write to."""
    async with chats.factory() as session:
        room = Room(
            transport_room_id="!tool-io:test",
            name="tool io",
            description="",
            owner_id=chats.alice.id,
            read_visibility="public",
            write_visibility="public",
        )
        session.add(room)
        await session.commit()
        return room.id


async def _stored(chats: _Harness, room_id: str) -> tuple[bool, str]:
    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        return bool((room.metadata_ or {}).get("show_tool_io")), room.name


async def _texts(chats: _Harness, room_id: str) -> dict[str, str]:
    async with chats.factory() as session:
        rows = await session.execute(
            select(AgentSessionActivityItem.item_id, AgentSessionActivityItem.text)
            .where(AgentSessionActivityItem.room_id == room_id)
            .order_by(AgentSessionActivityItem.item_id)
        )
        return {item: body for item, body in rows.all()}


async def test_an_ordinary_writer_may_not_change_it(chats: _Harness) -> None:
    room_id = await _public_room(chats)
    for value in (True, False):
        with pytest.raises(HTTPException) as refused:
            await _patch(
                chats,
                room_id,
                RoomUpdateRequest(show_tool_io=value, name="bob's"),
                chats.bob,
                False,
            )
        assert refused.value.status_code == 403
    # Refused before anything was written, the name included.
    assert await _stored(chats, room_id) == (False, "tool io")
    # Bob may still edit what plain write access allows.
    detail = await _patch(
        chats, room_id, RoomUpdateRequest(description="d"), chats.bob, False
    )
    assert detail.show_tool_io is False


@pytest.mark.parametrize("who", ["owner", "admin"])
async def test_the_owner_and_an_admin_may_turn_it_on_and_off(
    chats: _Harness, who: str
) -> None:
    room_id = await _public_room(chats)
    user, is_admin = (chats.alice, False) if who == "owner" else (chats.admin, True)
    assert (await _get(chats, room_id, chats.bob)).show_tool_io is False

    on = await _patch(
        chats, room_id, RoomUpdateRequest(show_tool_io=True), user, is_admin
    )
    assert on.show_tool_io is True
    assert (await _get(chats, room_id, chats.bob)).show_tool_io is True
    assert await _stored(chats, room_id) == (True, "tool io")

    off = await _patch(
        chats, room_id, RoomUpdateRequest(show_tool_io=False), user, is_admin
    )
    assert off.show_tool_io is False
    assert (await _get(chats, room_id, chats.bob)).show_tool_io is False
    assert await _stored(chats, room_id) == (False, "tool io")


async def test_turning_it_off_with_a_rename_finishes_and_leaves_stored_text(
    chats: _Harness,
) -> None:
    room_id = await _public_room(chats)
    agent = await chats.agent("helper", owner=chats.alice)
    await _patch(
        chats, room_id, RoomUpdateRequest(show_tool_io=True), chats.alice, False
    )
    async with chats.factory() as session:
        for item_id, kind, body in (
            ("tool-1", "tool-activity", "$ cat .env"),
            ("tool-2", "tool-activity", ""),
            ("msg-1", "assistant-message", "prose"),
        ):
            session.add(
                AgentSessionActivityItem(
                    agent_id=agent.id,
                    session_id="s-1",
                    turn_id="t-1",
                    item_id=item_id,
                    kind=kind,
                    revision=1,
                    status="completed",
                    title="step",
                    text=body,
                    room_id=room_id,
                    occurred_at=datetime(2026, 10, 31, tzinfo=UTC),
                )
            )
        await session.commit()

    # Both writes in one request: `update_room` on its own session, the flag on
    # the request's. Neither may wait on the other (a hang ends at the timeout).
    detail = await asyncio.wait_for(
        _patch(
            chats,
            room_id,
            RoomUpdateRequest(show_tool_io=False, name="x"),
            chats.alice,
            False,
        ),
        _PATCH_SECONDS,
    )

    assert (detail.show_tool_io, detail.name) == (False, "x")
    assert await _stored(chats, room_id) == (False, "x")
    # No stored step is touched by the switch-off.
    assert await _texts(chats, room_id) == {
        "msg-1": "prose",
        "tool-1": "$ cat .env",
        "tool-2": "",
    }
    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        # The rename's own metadata write survived the flag's.
        assert (room.metadata_ or {}).get("name_source") == "custom"


async def test_while_off_no_read_shows_stored_tool_text_and_on_shows_it_again(
    chats: _Harness,
) -> None:
    agent, room_id = await read_tests._room(chats)
    await _patch(
        chats, room_id, RoomUpdateRequest(show_tool_io=True), chats.alice, False
    )
    await read_tests._turn_with_text(chats, agent, room_id)
    assert await read_tests._rest(chats, room_id) == read_tests._ALL_TEXT

    await _patch(
        chats, room_id, RoomUpdateRequest(show_tool_io=False), chats.alice, False
    )
    # Stored as it was; neither the REST read nor the stream shows it.
    assert (await _texts(chats, room_id))["tool-1"] == read_tests._ALL_TEXT["tool-1"]
    assert await read_tests._rest(chats, room_id) == read_tests._NO_TOOL_TEXT
    assert await read_tests._stream(chats, agent, room_id) == read_tests._NO_TOOL_TEXT

    await _patch(
        chats, room_id, RoomUpdateRequest(show_tool_io=True), chats.alice, False
    )
    assert await read_tests._rest(chats, room_id) == read_tests._ALL_TEXT
    assert await read_tests._stream(chats, agent, room_id) == read_tests._ALL_TEXT
