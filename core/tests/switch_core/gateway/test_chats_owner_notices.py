"""Reaching an owner privately when a notice cannot be posted where they are.

A restricted agent that a platform added without saying who asked is disclosed
in the channel when the owner has an account there, and in a private chat when
they don't. These pin that chat: one per owner, reused across notices, and
brought back if it was archived.
"""

from __future__ import annotations

from sqlalchemy import select

from switch_core.chats.service import OWNER_NOTICES_REQUEST_ID
from switch_core.db.models import Room
from tests.switch_core.gateway.conftest import _Harness


async def _notice_rooms(chats: _Harness, owner_id: str) -> list[Room]:
    async with chats.factory() as session:
        rows = await session.execute(
            select(Room).where(Room.owner_id == owner_id).order_by(Room.created_at)
        )
        return [
            room
            for room in rows.scalars().all()
            if str((room.metadata_ or {}).get("chat_operation_id", "")).startswith(
                f"{OWNER_NOTICES_REQUEST_ID}:"
            )
        ]


def _capture_notices(chats: _Harness) -> list[tuple[str, str]]:
    """Take the posting out of the picture; rooms and messages are the subject."""
    notices: list[tuple[str, str]] = []

    async def post_notice(room: Room, body: str) -> str | None:
        notices.append((room.id, body))
        return "m1"

    chats.room_service.post_notice = post_notice  # type: ignore[method-assign]
    return notices


async def test_a_notice_makes_one_private_chat_for_the_owner(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.bob)
    notices = _capture_notices(chats)

    await chats.service.tell_owner(agent, "first")

    (room,) = await _notice_rooms(chats, chats.bob.id)
    assert room.name == "Switch notices"
    assert room.read_visibility == "private"
    assert room.write_visibility == "private"
    assert notices == [(room.id, "first")]


async def test_a_second_notice_reuses_the_chat(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.bob)
    notices = _capture_notices(chats)

    await chats.service.tell_owner(agent, "first")
    await chats.service.tell_owner(agent, "second")

    (room,) = await _notice_rooms(chats, chats.bob.id)
    assert notices == [(room.id, "first"), (room.id, "second")]


async def test_each_owner_gets_their_own_chat(chats: _Harness) -> None:
    """The unique index behind the request id is per tenant, not per owner."""
    bob_agent = await chats.agent("helper", owner=chats.bob)
    alice_agent = await chats.agent("other", owner=chats.alice)
    _capture_notices(chats)

    await chats.service.tell_owner(bob_agent, "for bob")
    await chats.service.tell_owner(alice_agent, "for alice")

    (bob_room,) = await _notice_rooms(chats, chats.bob.id)
    (alice_room,) = await _notice_rooms(chats, chats.alice.id)
    assert bob_room.id != alice_room.id


async def test_an_archived_chat_is_brought_back(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.bob)
    notices = _capture_notices(chats)
    await chats.service.tell_owner(agent, "first")
    (room,) = await _notice_rooms(chats, chats.bob.id)

    await chats.room_service.set_room_archived(room.id, True)
    await chats.service.tell_owner(agent, "again")

    (again,) = await _notice_rooms(chats, chats.bob.id)
    assert again.id == room.id
    assert again.archived_at is None
    assert notices == [(room.id, "first"), (room.id, "again")]


async def test_an_ownerless_agent_tells_nobody(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.bob)
    agent.owner_id = None
    notices = _capture_notices(chats)

    await chats.service.tell_owner(agent, "nobody to tell")

    assert notices == []
