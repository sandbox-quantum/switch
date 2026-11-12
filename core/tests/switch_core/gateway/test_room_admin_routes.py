"""A room's room admins through the gateway: listing them, making someone one
(`PUT /rooms/{id}/admins/{user}`), taking it away, and what a room admin may
then do, through the real routes on Postgres."""

from __future__ import annotations

import uuid

from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import Client, ClientRoom, Room, User
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.gateway import dependencies as gw_deps
from tests.switch_core.gateway.test_room_auto_route import _app as _rooms_app
from tests.switch_core.gateway.test_room_auto_route import _as, _user


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    app = _rooms_app(session_factory)
    app.dependency_overrides[gw_deps.get_room_group_store] = RoomGroupStore
    return app


async def _room(session_factory: async_sessionmaker[AsyncSession], owner: User) -> str:
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="design-review",
            description="",
            owner_id=owner.id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add(room)
        await session.commit()
        return room.id


async def _join(
    session_factory: async_sessionmaker[AsyncSession], room_id: str, user: User
) -> None:
    async with session_factory() as session:
        client = Client(
            transport_user_id=f"@{user.name}-{uuid.uuid4().hex[:6]}:test",
            display_name=user.name,
            type=MEMBER_CLIENT_TYPE,
            user_id=user.id,
        )
        session.add(client)
        await session.flush()
        session.add(ClientRoom(client_id=client.id, room_id=room_id))
        await session.commit()


async def test_the_owner_makes_someone_a_room_admin_who_then_changes_the_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    olivia = await _user(session_factory, f"olivia-{uuid.uuid4().hex[:4]}", "member")
    max_ = await _user(session_factory, f"max-{uuid.uuid4().hex[:4]}", "member")
    room_id = await _room(session_factory, olivia)
    await _join(session_factory, room_id, max_)
    app = _app(session_factory)

    async with _as(app, max_) as client:
        before = (await client.get(f"/rooms/{room_id}")).json()
        refused = await client.put(f"/rooms/{room_id}/auto-route", json={"on": True})
    assert before["viewer_is_room_admin"] is False
    assert before["can_write"] is False
    assert refused.status_code == 403

    async with _as(app, olivia) as client:
        made = await client.put(f"/rooms/{room_id}/admins/{max_.id}")
        listed = await client.get(f"/rooms/{room_id}/admins")
    assert made.status_code == 200, made.text
    assert [a["user_id"] for a in made.json()["room_admins"]] == [max_.id]
    assert made.json()["can_manage_admins"] is True
    assert [(a["user_id"], a["name"], a["granted_by"]) for a in listed.json()] == [
        (max_.id, max_.name, olivia.id)
    ]

    async with _as(app, max_) as client:
        after = (await client.get(f"/rooms/{room_id}")).json()
        changed = await client.put(f"/rooms/{room_id}/auto-route", json={"on": True})
    assert after["viewer_is_room_admin"] is True
    assert (after["can_write"], after["can_archive"], after["can_remove_members"]) == (
        True,
        True,
        True,
    )
    assert (after["can_manage"], after["can_manage_admins"], after["can_transfer"]) == (
        False,
        False,
        False,
    )
    assert changed.status_code == 200, changed.text


async def test_a_room_admin_cannot_choose_others_but_can_step_down(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    olivia = await _user(session_factory, f"olivia-{uuid.uuid4().hex[:4]}", "member")
    max_ = await _user(session_factory, f"max-{uuid.uuid4().hex[:4]}", "member")
    bea = await _user(session_factory, f"bea-{uuid.uuid4().hex[:4]}", "member")
    room_id = await _room(session_factory, olivia)
    await _join(session_factory, room_id, max_)
    await _join(session_factory, room_id, bea)
    app = _app(session_factory)
    async with _as(app, olivia) as client:
        await client.put(f"/rooms/{room_id}/admins/{max_.id}")

    async with _as(app, max_) as client:
        refused = await client.put(f"/rooms/{room_id}/admins/{bea.id}")
        stepped = await client.delete(f"/rooms/{room_id}/admins/{max_.id}")
    assert refused.status_code == 403
    assert "owner or a workspace admin" in refused.json()["detail"]
    assert stepped.status_code == 200, stepped.text
    assert stepped.json()["room_admins"] == []
    assert stepped.json()["viewer_is_room_admin"] is False


async def test_a_workspace_admin_may_and_someone_outside_cannot_be_one(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    olivia = await _user(session_factory, f"olivia-{uuid.uuid4().hex[:4]}", "member")
    ada = await _user(session_factory, f"ada-{uuid.uuid4().hex[:4]}", "admin")
    outsider = await _user(session_factory, f"out-{uuid.uuid4().hex[:4]}", "member")
    room_id = await _room(session_factory, olivia)

    async with _as(_app(session_factory), ada) as client:
        refused = await client.put(f"/rooms/{room_id}/admins/{outsider.id}")
    assert refused.status_code == 400
    assert refused.json()["detail"].startswith("Only people in the room")


async def test_the_room_list_reports_room_admin_flags(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    olivia = await _user(session_factory, f"olivia-{uuid.uuid4().hex[:4]}", "member")
    max_ = await _user(session_factory, f"max-{uuid.uuid4().hex[:4]}", "member")
    room_id = await _room(session_factory, olivia)
    await _join(session_factory, room_id, max_)
    app = _app(session_factory)
    async with _as(app, olivia) as client:
        await client.put(f"/rooms/{room_id}/admins/{max_.id}")

    async with _as(app, max_) as client:
        rooms = (await client.get("/rooms")).json()
    [summary] = [r for r in rooms if r["id"] == room_id]
    assert summary["viewer_is_room_admin"] is True
    assert summary["can_write"] is True
    assert summary["can_manage"] is False
