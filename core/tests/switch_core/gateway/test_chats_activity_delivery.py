"""Delivering one activity update to a viewer checks access to that one room
and reads only the step that moved, whatever the viewer's number of rooms or
the turn's length; a viewer taken out of the room gets nothing more, and an
announcement from before steps were named still delivers."""

from __future__ import annotations

from dataclasses import replace

from sqlalchemy import delete

from switch_core.db.models import Agent, ClientRoom, TenantMember
from switch_core.gateway.chats import _activity_frames
from switch_core.session_activity.listener import Change
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_routes import _step, _turn_change
from tests.switch_core.statement_counts import StatementCounts

TENANT = "00000000-0000-0000-0000-000000000000"


def _step_change(agent: Agent, room_id: str, item_id: str, revision: int) -> Change:
    return replace(
        _turn_change(agent, room_id, "t1"), item_id=item_id, revision=revision
    )


async def _long_turn_in_one_of_many_rooms(chats: _Harness) -> tuple[Agent, str]:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c0")
    for index in range(1, 20):
        await chats.new_chat(chats.alice, agent, f"c{index}")
    await _step(chats, agent, room_id, "t1", "turn", 1)
    for index in range(50):
        await _step(chats, agent, room_id, "t1", f"tool-{index}", 1)
    return agent, room_id


async def test_one_update_reads_one_room_and_one_step(
    chats: _Harness, statement_counts: StatementCounts
) -> None:
    agent, room_id = await _long_turn_in_one_of_many_rooms(chats)
    sent: dict[tuple[str, str, str, str], int] = {}

    with statement_counts.scope("step") as step:
        frames = await _activity_frames(
            chats.service,
            TENANT,
            chats.alice,
            _step_change(agent, room_id, "tool-7", 1),
            sent,
        )
    assert frames is not None and len(frames) == 1
    # The tenant binding, the access check for this room, and the one step.
    assert (step.count, step.rows) == (3, 3)

    # The same revision again, as a burst of announcements delivers it: no read.
    with statement_counts.scope("again") as again:
        frames = await _activity_frames(
            chats.service,
            TENANT,
            chats.alice,
            _step_change(agent, room_id, "tool-7", 1),
            sent,
        )
    assert frames == [] and again.count == 0

    # Without a step named (an older announcement): the turn is reread.
    with statement_counts.scope("turn") as turn:
        frames = await _activity_frames(
            chats.service, TENANT, chats.alice, _turn_change(agent, room_id, "t1"), sent
        )
    assert frames is not None and len(frames) == 50
    assert turn.count == 3


async def test_a_viewer_taken_out_of_the_room_gets_nothing_more(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    await _step(chats, agent, room_id, "t1", "turn", 1)
    sent: dict[tuple[str, str, str, str], int] = {}
    first = await _activity_frames(
        chats.service, TENANT, chats.bob, _step_change(agent, room_id, "turn", 1), sent
    )
    assert first is not None and len(first) == 1

    async with chats.factory() as session:
        client = await chats.service.member_client(session, chats.bob.id)
        assert client is not None
        await session.execute(
            delete(ClientRoom).where(
                ClientRoom.client_id == client.id, ClientRoom.room_id == room_id
            )
        )
        await session.commit()
    await _step(chats, agent, room_id, "t1", "turn", 2)
    assert (
        await _activity_frames(
            chats.service,
            TENANT,
            chats.bob,
            _step_change(agent, room_id, "turn", 2),
            sent,
        )
        == []
    )

    async with chats.factory() as session:
        await session.execute(
            delete(TenantMember).where(TenantMember.user_id == chats.bob.id)
        )
        await session.commit()
    assert (
        await _activity_frames(
            chats.service,
            TENANT,
            chats.bob,
            _step_change(agent, room_id, "turn", 3),
            sent,
        )
        is None
    )
