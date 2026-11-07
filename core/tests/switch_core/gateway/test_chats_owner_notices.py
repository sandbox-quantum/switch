"""An owner hears about their agent even when no shared room would tell them.

Through the shared harness, against real Postgres: the notices chat is an ordinary
private chat, so what matters is that it belongs to the owner and stays one place.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

from switch_core.chats.service import ChatError
from switch_core.db.models import Client, Room
from switch_core.invites import Inviter, InviteRefused
from tests.switch_core.gateway.conftest import _Harness


@pytest.fixture
def posted(chats: _Harness, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    notices: list[tuple[str, str]] = []

    async def post_notice(room: Room, body: str) -> None:
        notices.append((room.id, body))

    monkeypatch.setattr(chats.room_service, "post_notice", post_notice)
    return notices


async def test_an_owner_is_told_in_a_private_chat_of_their_own(
    chats: _Harness, posted: list[tuple[str, str]]
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    chats.service.group_chats_enabled = False

    await chats.service.tell_owner(agent, "something you should know")

    ((room_id, body),) = posted
    assert body == "something you should know"
    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        assert room.name == "Switch notices"
        assert room.owner_id == chats.alice.id
        assert room.read_visibility == "private"
        assert room.write_visibility == "private"


async def test_every_notice_lands_in_the_same_chat(
    chats: _Harness, posted: list[tuple[str, str]]
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)

    await chats.service.tell_owner(helper, "one")
    await chats.service.tell_owner(other, "two")

    assert posted[0][0] == posted[1][0]
    async with chats.factory() as session:
        rooms = await session.execute(select(Room).where(Room.name == "Switch notices"))
        assert len(rooms.scalars().all()) == 1


async def test_each_owner_has_their_own_notices(
    chats: _Harness, posted: list[tuple[str, str]]
) -> None:
    mine = await chats.agent("mine", owner=chats.alice)
    theirs = await chats.agent("theirs", owner=chats.bob)

    await chats.service.tell_owner(mine, "for alice")
    await chats.service.tell_owner(theirs, "for bob")

    assert posted[0][0] != posted[1][0]


async def test_a_notice_posts_as_switch_and_fails_loudly_if_it_cannot(
    chats: _Harness,
) -> None:
    room = SimpleNamespace(id="r1", tenant_id="t1", transport_room_id="!r:test")

    with pytest.raises(RuntimeError, match="no admin client"):
        await chats.room_service.post_notice(room, "hi")  # type: ignore[arg-type]

    sent: list[dict[str, Any]] = []

    async def send_message(room_id: str, body: str, **kw: Any) -> str | None:
        sent.append({"room_id": room_id, "body": body, **kw})
        return "$event" if len(sent) == 1 else None

    admin = SimpleNamespace(send_message=send_message)
    chats.lifecycle.get_by_type = lambda *_: [admin]  # type: ignore[method-assign]

    await chats.room_service.post_notice(room, "hi")  # type: ignore[arg-type]
    assert sent[0]["room_id"] == "!r:test"
    assert sent[0]["metered"] is False

    with pytest.raises(RuntimeError, match="could not be posted"):
        await chats.room_service.post_notice(room, "again")  # type: ignore[arg-type]


async def test_with_nothing_wired_telling_an_owner_is_an_error(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)

    with pytest.raises(RuntimeError, match="Nothing is wired"):
        await chats.room_service.tell_owner(agent, "hi")


async def test_a_chat_with_an_agent_you_may_not_use_is_still_refused_first(
    chats: _Harness,
) -> None:
    agent = await chats.agent(
        "private", owner=chats.alice, policy={"rules": [{"owner": True, "users": []}]}
    )
    refused = await chats.room_service.refused_agents(
        Inviter.person(chats.bob.id), [agent.id], room_id="", group_id=None
    )
    assert [each.id for each in refused] == [agent.id]
    assert (
        await chats.room_service.refused_agents(
            Inviter.person(chats.alice.id), [agent.id], room_id="", group_id=None
        )
        == []
    )


async def _real_admin(chats: _Harness) -> list[str]:
    """An admin client with a real row, so the chat is made as it is in production,
    with only the sending itself recorded."""
    sent: list[str] = []
    async with chats.factory() as session:
        client = Client(
            transport_user_id="@admin:test", display_name="Switch", type="admin"
        )
        session.add(client)
        await session.commit()
        client_id = client.id

    async def send_message(_room_id: str, body: str, **_kw: Any) -> str:
        sent.append(body)
        return "$event"

    admin = SimpleNamespace(
        client_id=client_id,
        transport_user_id="@admin:test",
        send_message=send_message,
    )
    chats.lifecycle.get_by_type = (  # type: ignore[method-assign]
        lambda kind, _tenant: [admin] if kind == "admin" else []
    )
    return sent


async def _listed(chats: _Harness) -> list[str]:
    response = await chats.client.get("/chats", headers=chats.as_user(chats.alice))
    assert response.status_code == 200, response.text
    body = response.json()
    rows = body["chats"] if isinstance(body, dict) else body
    return [row["name"] for row in rows]


async def _notices_room(chats: _Harness) -> Room:
    async with chats.factory() as session:
        return (
            await session.execute(select(Room).where(Room.name == "Switch notices"))
        ).scalar_one()


async def test_the_owner_can_see_the_notices_chat_even_with_group_chats_off(
    chats: _Harness,
) -> None:
    sent = await _real_admin(chats)
    agent = await chats.agent("helper", owner=chats.alice)
    chats.service.group_chats_enabled = False

    await chats.service.tell_owner(agent, "one")

    assert sent == ["one"]
    assert await _listed(chats) == ["Switch notices"]


async def test_a_notice_brings_an_archived_notices_chat_back(chats: _Harness) -> None:
    sent = await _real_admin(chats)
    agent = await chats.agent("helper", owner=chats.alice)
    await chats.service.tell_owner(agent, "one")
    room = await _notices_room(chats)
    await chats.service.archive(room.tenant_id, chats.alice, room.id)
    assert await _listed(chats) == []

    await chats.service.tell_owner(agent, "two")

    assert sent == ["one", "two"]
    assert await _listed(chats) == ["Switch notices"]
    assert (await _notices_room(chats)).id == room.id


async def test_a_notice_reaches_an_owner_who_left_the_notices_chat(
    chats: _Harness,
) -> None:
    sent = await _real_admin(chats)
    agent = await chats.agent("helper", owner=chats.alice)
    await chats.service.tell_owner(agent, "one")
    room = await _notices_room(chats)
    left = await chats.client.delete(
        f"/chats/{room.id}/members/{chats.alice.id}",
        headers=chats.as_user(chats.alice),
    )
    assert left.status_code == 204

    await chats.service.tell_owner(agent, "two")

    assert sent == ["one", "two"]
    assert await _listed(chats) == ["Switch notices"]


async def test_someone_who_left_the_workspace_is_not_put_back(chats: _Harness) -> None:
    await _real_admin(chats)
    agent = await chats.agent("helper", owner=chats.carol)

    with pytest.raises(ChatError, match="not in this workspace"):
        await chats.service.tell_owner(agent, "one")


@pytest.mark.parametrize(
    ("raised", "status", "code"),
    [
        (
            lambda agent: InviteRefused([agent], Inviter.person("u")),
            403,
            "AGENT_NOT_ALLOWED",
        ),
        (lambda _agent: ValueError("gone"), 422, "AGENT_NOT_ADDED"),
    ],
    ids=["refused", "gone"],
)
async def test_a_late_failure_adding_to_a_chat_is_an_answer_not_a_crash(
    chats: _Harness,
    monkeypatch: pytest.MonkeyPatch,
    raised: Any,
    status: int,
    code: str,
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, helper, "late")

    async def fail(*_args: Any, **_kw: Any) -> None:
        raise raised(other)

    monkeypatch.setattr(chats.room_service, "add_agents_to_room", fail)
    response = await chats.client.post(
        f"/chats/{room_id}/agents",
        json={"agentId": other.id},
        headers=chats.as_user(chats.alice),
    )

    assert response.status_code == status
    assert response.json()["detail"]["code"] == code


async def test_a_late_refusal_creating_a_chat_is_an_answer_not_a_crash(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)

    async def fail(*_args: Any, **_kw: Any) -> None:
        raise InviteRefused([helper], Inviter.person("u"))

    monkeypatch.setattr(chats.room_service, "create_room", fail)
    response = await chats.create_chat(chats.alice, helper, "late-create")

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "AGENT_NOT_ALLOWED"
