"""An owner hears about their agent even when no shared room would tell them.

Through the shared harness, against real Postgres: the notices chat is an ordinary
private chat, so what matters is that it belongs to the owner and stays one place.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

from switch_core.db.models import Room
from switch_core.invites import Inviter
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
