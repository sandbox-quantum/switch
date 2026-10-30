"""Listing chats and a stream's periodic recheck cost a fixed number of
statements whatever the number of rooms, and fetch rows only for rooms, not
for their history; a recheck still finds a message whose notification was
missed. Measured at the engine (`statement_counts.py`)."""

from __future__ import annotations

from switch_core.gateway.chats import _ChatStream
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.statement_counts import StatementCounts

TENANT = "00000000-0000-0000-0000-000000000000"


async def _chat(chats: _Harness, request_id: str) -> str:
    created = await chats.client.post(
        "/chats",
        json={"agentIds": [], "memberUserIds": [chats.bob.id], "requestId": request_id},
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 200, created.text
    room_id = str(created.json()["chat"]["roomId"])
    for index in range(3):
        sent = await chats.send(chats.bob, room_id, f"{request_id}-{index}", "hello")
        assert sent.status_code == 200
    return room_id


async def test_listing_and_rechecking_do_not_grow_with_rooms(
    chats: _Harness, statement_counts: StatementCounts
) -> None:
    measured: dict[int, tuple[int, int, int, int]] = {}
    for count in range(1, 21):
        await _chat(chats, f"c{count}")
        if count not in (1, 20):
            continue
        with statement_counts.scope(f"list-{count}") as listing:
            response = await chats.client.get(
                "/chats", headers=chats.as_user(chats.alice)
            )
            assert response.status_code == 200
        stream = _ChatStream(chats.service, TENANT, chats.alice, {})
        await stream.refresh(None, initial=True)
        with statement_counts.scope(f"idle-{count}") as idle:
            frames, alive = await stream.refresh(None, initial=False)
        stream.close()
        assert alive and frames == []
        measured[count] = (listing.count, listing.rows, idle.count, idle.rows)

    one, twenty = measured[1], measured[20]
    assert twenty[0] == one[0], measured
    assert twenty[2] == one[2], measured
    # Rows: a handful per room (the room, its two people, its last message,
    # its unread count), never its history of four messages.
    assert twenty[1] <= one[1] + 6 * 19, measured
    assert twenty[3] <= one[3] + 19, measured


async def test_a_recheck_still_finds_a_message_whose_notice_was_missed(
    chats: _Harness,
) -> None:
    quiet = await _chat(chats, "quiet")
    busy = await _chat(chats, "busy")
    stream = _ChatStream(chats.service, TENANT, chats.alice, {})
    await stream.refresh(None, initial=True)
    # Sent with no notification rung, as when one is lost.
    sent = await chats.send(chats.bob, busy, "late", "are you there?")
    assert sent.status_code == 200

    frames, _ = await stream.refresh(None, initial=False)
    stream.close()
    bodies = [frame.decode() for frame in frames]
    assert len(bodies) == 1 and "are you there?" in bodies[0]
    assert quiet not in bodies[0]
