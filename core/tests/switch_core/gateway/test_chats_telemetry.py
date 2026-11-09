"""Switch Console chat is counted like any other room: each post is told to the
message observer once it is committed, as a `member`'s, and a person added to
a chat is reported."""

from __future__ import annotations

from tests.switch_core.gateway.conftest import _Harness
from tests.telemetry_records import recording_telemetry


async def test_a_post_is_told_to_the_message_observer_once(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    sent = await chats.send(chats.alice, room_id, "m1", "hello")
    assert sent.status_code == 200, sent.text
    retried = await chats.send(chats.alice, room_id, "m1", "hello")
    assert retried.status_code == 200, retried.text

    [observed] = chats.observer.observed
    assert observed.room_id == room_id
    assert observed.sender_role == "member"
    assert observed.sender_is_app is False
    assert observed.has_attachment is False
    assert observed.in_thread is False


async def test_a_post_with_several_files_is_one_message(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    for upload_id in ("u1", "u2"):
        staged = await chats.upload(
            chats.alice, room_id, upload_id, b"png", f"{upload_id}.png"
        )
        assert staged.status_code == 200, staged.text

    sent = await chats.send(
        chats.alice, room_id, "s1", "two files", uploadIds=["u1", "u2"]
    )
    assert sent.status_code == 200, sent.text

    [observed] = chats.observer.observed
    assert observed.has_attachment is True


async def test_adding_a_person_is_reported_once(chats: _Harness) -> None:
    """Not again for someone already in it, the chat's own creator
    included."""
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    assert (await chats.invite(chats.alice, room_id, chats.alice)).status_code == 200
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    assert chats.telemetry_sink.events("room_users_added") == [{"user_count": 1}]


# ── Only real changes ────────────────────────────────────────────────────────


async def test_archiving_an_archived_room_reports_nothing_more(
    chats: _Harness,
) -> None:
    telemetry, sink = recording_telemetry()
    chats.room_service._telemetry = telemetry
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    await chats.room_service.set_room_archived(room_id, True)
    await chats.room_service.set_room_archived(room_id, True)

    assert len(sink.events("room_archived")) == 1


async def test_removing_agents_counts_those_that_were_in_the_room(
    chats: _Harness,
) -> None:
    telemetry, sink = recording_telemetry()
    chats.room_service._telemetry = telemetry
    helper = await chats.agent("helper", owner=chats.alice)
    stranger = await chats.agent("stranger", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, helper, "c1")

    await chats.room_service.remove_agents_from_room(room_id, [helper.id, stranger.id])
    await chats.room_service.remove_agents_from_room(room_id, [helper.id])

    assert sink.events("room_agents_removed") == [
        {"agent_count": 1, "removed_by_kind": "user"}
    ]
