"""Rooms of a client app's own kind, and the cards a chat message carries —
against real Postgres, through the shared harness.

A client app that makes its rooms with a `roomKind` lists only rooms of that
kind; every listing that names no kind (Switch Console's) leaves them out, on
the list routes and on both event streams alike.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import select

from switch_core.db.models import (
    Agent,
    AgentSessionActivityItem,
    Message,
    User,
)
from switch_core.gateway.chats import chat_activity_events, chat_events
from switch_core.session_activity.listener import Change
from tests.switch_core.gateway.conftest import _Harness

TENANT = "00000000-0000-0000-0000-000000000000"
CARD = {
    "root": "card",
    "elements": {
        "card": {"type": "Card", "props": {"title": "Result"}, "children": ["t"]},
        "t": {"type": "Text", "props": {"text": "Done."}, "children": []},
    },
}


async def _kinded_chat(
    chats: _Harness, user: User, agent: Agent, request_id: str, room_kind: str
) -> str:
    response = await chats.client.post(
        "/chats",
        json={"agentIds": [agent.id], "requestId": request_id, "roomKind": room_kind},
        headers=chats.as_user(user),
    )
    assert response.status_code == 200, response.text
    assert response.json()["chat"]["roomKind"] == room_kind
    return str(response.json()["chat"]["roomId"])


async def _listed(chats: _Harness, user: User, query: str = "") -> list[str]:
    response = await chats.client.get(f"/chats{query}", headers=chats.as_user(user))
    assert response.status_code == 200, response.text
    return [chat["roomId"] for chat in response.json()["chats"]]


class _Events:
    def __init__(self, stream: AsyncIterator[bytes]) -> None:
        self.stream = stream

    async def next(self, timeout: float = 3.0) -> tuple[str, Any]:
        while True:
            frame = (await asyncio.wait_for(anext(self.stream), timeout)).decode()
            if frame.startswith(":"):
                continue
            event_line, data_line = frame.strip().split("\n")
            return event_line.removeprefix("event: "), json.loads(
                data_line.removeprefix("data: ")
            )

    async def until_ready(self) -> list[tuple[str, Any]]:
        frames = []
        while (frame := await self.next())[0] != "ready":
            frames.append(frame)
        return frames


async def _always_current() -> bool:
    return True


def _chat_stream(
    chats: _Harness, user: User, after: dict[str, int], room_kind: str | None
) -> _Events:
    return _Events(
        chat_events(
            chats.service,
            TENANT,
            user,
            after,
            room_kind=room_kind,
            ping_seconds=60.0,
            recheck_seconds=60.0,
            session_current=_always_current,
        )
    )


def _activity_stream(chats: _Harness, user: User, room_kind: str | None) -> _Events:
    return _Events(
        chat_activity_events(
            chats.service,
            TENANT,
            user,
            room_kind=room_kind,
            ping_seconds=60.0,
            recheck_seconds=60.0,
            queue_max=64,
            session_current=_always_current,
        )
    )


async def test_a_room_kind_lists_only_where_that_kind_is_asked_for(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    plain = await chats.new_chat(chats.alice, agent, "c1")
    lab = await _kinded_chat(chats, chats.alice, agent, "c2", "lab-app")
    other = await _kinded_chat(chats, chats.alice, agent, "c3", "other")

    assert await _listed(chats, chats.alice) == [plain]
    assert await _listed(chats, chats.alice, "?roomKind=lab-app") == [lab]
    assert await _listed(chats, chats.alice, "?roomKind=other") == [other]
    assert await _listed(chats, chats.alice, "?roomKind=nothing") == []

    [summary] = (
        await chats.client.get("/chats", headers=chats.as_user(chats.alice))
    ).json()["chats"]
    assert summary["roomKind"] is None

    # A room of any kind is still the member's own room on the per-room routes.
    page = await chats.client.get(
        f"/chats/{lab}/messages", headers=chats.as_user(chats.alice)
    )
    assert page.status_code == 200


async def test_archived_chats_are_filtered_by_kind_too(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    plain = await chats.new_chat(chats.alice, agent, "c1")
    lab = await _kinded_chat(chats, chats.alice, agent, "c2", "lab-app")
    for room_id in (plain, lab):
        archived = await chats.client.post(
            f"/chats/{room_id}/archive", headers=chats.as_user(chats.alice)
        )
        assert archived.status_code == 204, archived.text

    async def archived(query: str) -> list[str]:
        response = await chats.client.get(
            f"/chats/archived{query}", headers=chats.as_user(chats.alice)
        )
        return [chat["roomId"] for chat in response.json()["chats"]]

    assert await archived("") == [plain]
    assert await archived("?roomKind=lab-app") == [lab]


@pytest.mark.parametrize("room_kind", ["Lab", "lab app", "-lab", "x" * 41, ""])
async def test_a_room_kind_must_be_a_short_lowercase_slug(
    chats: _Harness, room_kind: str
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    created = await chats.client.post(
        "/chats",
        json={"agentIds": [agent.id], "requestId": "c1", "roomKind": room_kind},
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 422
    assert created.json()["detail"]["code"] == "BAD_ROOM_KIND"

    listed = await chats.client.get(
        "/chats", params={"roomKind": room_kind}, headers=chats.as_user(chats.alice)
    )
    assert listed.status_code == 422
    assert listed.json()["detail"]["code"] == "BAD_ROOM_KIND"


async def test_a_retried_create_must_repeat_its_room_kind(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _kinded_chat(chats, chats.alice, agent, "c1", "lab-app")
    assert await _kinded_chat(chats, chats.alice, agent, "c1", "lab-app") == room_id

    changed = await chats.client.post(
        "/chats",
        json={"agentIds": [agent.id], "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )
    assert changed.status_code == 409, changed.text


async def test_each_chat_stream_follows_only_the_rooms_of_its_kind(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    plain = await chats.new_chat(chats.alice, agent, "c1")
    lab = await _kinded_chat(chats, chats.alice, agent, "c2", "lab-app")

    console = _chat_stream(chats, chats.alice, {}, None)
    app = _chat_stream(chats, chats.alice, {}, "lab-app")
    assert [(n, d["roomId"]) for n, d in await console.until_ready()] == [
        ("chat", plain)
    ]
    [(name, summary)] = await app.until_ready()
    assert (name, summary["roomId"], summary["roomKind"]) == ("chat", lab, "lab-app")

    for room_id, txn in ((lab, "s1"), (plain, "s2")):
        sent = await chats.send(chats.alice, room_id, txn, f"hello {txn}")
        assert sent.status_code == 200, sent.text
        await chats.listener.ring(room_id)

    name, message = await app.next()
    assert (name, message["roomId"], message["body"]) == ("message", lab, "hello s1")
    name, message = await console.next()
    assert (name, message["roomId"], message["body"]) == ("message", plain, "hello s2")
    with pytest.raises(TimeoutError):
        await app.next(timeout=0.3)
    with pytest.raises(TimeoutError):
        await console.next(timeout=0.3)
    await console.stream.aclose()  # type: ignore[attr-defined]
    await app.stream.aclose()  # type: ignore[attr-defined]


async def test_a_room_of_another_kind_named_in_after_is_removed(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    lab = await _kinded_chat(chats, chats.alice, agent, "c1", "lab-app")

    console = _chat_stream(chats, chats.alice, {lab: 0}, None)
    assert await console.until_ready() == [
        ("chat.removed", {"roomId": lab, "reason": "access"})
    ]
    await console.stream.aclose()  # type: ignore[attr-defined]


async def _step(agent: Agent, room_id: str, turn_id: str) -> AgentSessionActivityItem:
    return AgentSessionActivityItem(
        tenant_id=TENANT,
        agent_id=agent.id,
        session_id="s1",
        turn_id=turn_id,
        item_id="turn",
        kind="turn",
        revision=1,
        status="running",
        title="",
        text="",
        room_id=room_id,
        occurred_at=datetime.now(UTC),
    )


async def test_each_activity_stream_follows_only_the_rooms_of_its_kind(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    plain = await chats.new_chat(chats.alice, agent, "c1")
    lab = await _kinded_chat(chats, chats.alice, agent, "c2", "lab-app")
    console = _activity_stream(chats, chats.alice, None)
    app = _activity_stream(chats, chats.alice, "lab-app")
    assert (await console.next())[0] == "ready"
    assert (await app.next())[0] == "ready"

    async with chats.factory() as session:
        session.add(await _step(agent, lab, "t1"))
        session.add(await _step(agent, plain, "t2"))
        await session.commit()
    for room_id, turn_id in ((lab, "t1"), (plain, "t2")):
        await chats.activity.change(
            Change(
                kind="activity",
                tenant_id=TENANT,
                agent_id=agent.id,
                session_id="s1",
                key=turn_id,
                room_id=room_id,
                row=None,
            )
        )

    name, item = await app.next()
    assert (name, item["roomId"], item["turnId"]) == ("activity", lab, "t1")
    name, item = await console.next()
    assert (name, item["roomId"], item["turnId"]) == ("activity", plain, "t2")
    with pytest.raises(TimeoutError):
        await app.next(timeout=0.3)
    with pytest.raises(TimeoutError):
        await console.next(timeout=0.3)
    await console.stream.aclose()  # type: ignore[attr-defined]
    await app.stream.aclose()  # type: ignore[attr-defined]


async def test_a_message_shows_the_card_it_carries(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    sent_ids = []
    for txn in ("s1", "s2"):
        sent = await chats.send(chats.alice, room_id, txn, f"text {txn}")
        assert sent.status_code == 200, sent.text
        sent_ids.append(sent.json()["messages"][0]["messageId"])
    async with chats.factory() as session:
        row = (
            await session.execute(
                select(Message).where(Message.transport_event_id == sent_ids[1])
            )
        ).scalar_one()
        row.content = {**row.content, "com.switch.ui": CARD}
        await session.commit()

    page = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.alice)
    )
    by_id = {m["messageId"]: m for m in page.json()["messages"]}
    assert by_id[sent_ids[0]]["ui"] is None
    assert by_id[sent_ids[1]]["ui"] == CARD
