"""A Console chat holds a person to the same limits as every other path: a
message too long is refused with 422, one sent too fast with 429, before
Switch Trust or the router sees it, and nothing is posted."""

from __future__ import annotations

from switch_core.delivery.send_limits import SendLimits
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_trust import _chat


def _limits(chats: _Harness, *, max_message_chars: int, burst: int) -> None:
    chats.service._router.send_limits = SendLimits(
        max_message_chars=max_message_chars,
        burst=burst,
        per_second=0.001,
        clock=lambda: 0.0,
    )


async def test_a_message_over_the_limit_is_refused_before_trust(
    chats: _Harness,
) -> None:
    room_id, trust = await _chat(chats)
    _limits(chats, max_message_chars=50, burst=100)

    sent = await chats.send(chats.alice, room_id, "s1", "x" * 51)

    assert sent.status_code == 422
    detail = sent.json()["detail"]
    assert detail["code"] == "MESSAGE_TOO_LONG"
    assert "51 characters long" in detail["message"]
    assert "at most 50" in detail["message"]
    assert trust.checked == []
    assert await chats.message_rows(room_id) == []


async def test_a_message_pushed_past_the_limit_by_its_trust_note_is_refused(
    chats: _Harness,
) -> None:
    room_id, _trust = await _chat(chats)
    body = "a FLAG here"
    _limits(chats, max_message_chars=len(body) + 5, burst=100)

    sent = await chats.send(chats.alice, room_id, "s1", body)

    assert sent.status_code == 422
    assert sent.json()["detail"]["code"] == "MESSAGE_TOO_LONG"
    assert await chats.message_rows(room_id) == []


async def test_a_person_sending_too_fast_is_refused_and_others_are_not(
    chats: _Harness,
) -> None:
    room_id, trust = await _chat(chats)
    agent = await chats.agent("other-helper", owner=chats.bob)
    bobs_room = await chats.new_chat(chats.bob, agent, "c2")
    _limits(chats, max_message_chars=1000, burst=2)

    assert (await chats.send(chats.alice, room_id, "s1", "one")).status_code == 200
    assert (await chats.send(chats.alice, room_id, "s2", "two")).status_code == 200
    refused = await chats.send(chats.alice, room_id, "s3", "three")

    assert refused.status_code == 429
    detail = refused.json()["detail"]
    assert detail["code"] == "RATE_LIMITED"
    assert "2 at once" in detail["message"]
    assert [content for _, content in trust.checked] == ["one", "two"]
    assert [row.body for row in await chats.message_rows(room_id)] == ["one", "two"]
    assert (await chats.send(chats.bob, bobs_room, "s1", "mine")).status_code == 200
