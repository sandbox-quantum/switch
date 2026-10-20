"""One agent the router cannot decide for costs only that agent.

A row is decided for every agent of its room in the writer's transaction, and
a multi-file post given up on is decided in the sweep's. A decision that
raises for one agent is logged and counted, and the row is written and
decided for the others, as a failure to store one agent's own event already
was. A post the sweep cannot decide at all is put off and tried again later,
and the sweep goes on to the posts after it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, Message, PendingAttachmentGroup
from switch_core.db.session_scope import tenant_session
from switch_core.delivery.recipient import AgentRecipient
from switch_core.delivery.router import MessageRouter
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)


async def test_a_decision_that_raises_for_one_agent_does_not_stop_the_write(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    await add_member(session_factory, room, alice)
    broken, broken_client = await make_agent(session_factory, "broken")
    fine, fine_client = await make_agent(session_factory, "fine")
    await add_member(session_factory, room, broken_client, agent=broken)
    await add_member(session_factory, room, fine_client, agent=fine)

    decide = AgentRecipient.decide_message

    async def raise_for_broken(self: AgentRecipient, *args: Any, **kwargs: Any) -> Any:
        if self.agent.name == "broken":
            raise RuntimeError("a rule that cannot be applied")
        return await decide(self, *args, **kwargs)

    monkeypatch.setattr(AgentRecipient, "decide_message", raise_for_broken)

    await process.say(room, "@broken @fine please look", sender=alice)
    await process.idle()

    async with tenant_session(session_factory, room.tenant_id) as session:
        bodies = list(
            (
                await session.scalars(
                    select(Message.body).where(Message.room_id == room.id)
                )
            ).all()
        )
    assert "@broken @fine please look" in bodies
    assert len(await own_events(session_factory, fine.id)) == 1
    assert await own_events(session_factory, broken.id) == []


async def test_a_post_the_sweep_cannot_decide_does_not_hold_up_the_rest(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    agent, client = await make_agent(session_factory, "agent-a")
    await add_member(session_factory, room, alice)
    await add_member(session_factory, room, client, agent=agent)
    for group in ("grp-stuck", "grp-next"):
        await process.send_file(
            room,
            f"{group}.png",
            sender=alice,
            caption="@agent-a one of two",
            group={"id": group, "index": 0, "total": 2},
        )
    # Both waits are over, the stuck post's first.
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        for group, overdue in (("grp-stuck", 20), ("grp-next", 10)):
            await session.execute(
                update(PendingAttachmentGroup)
                .where(PendingAttachmentGroup.group_id == group)
                .values(
                    deadline=PendingAttachmentGroup.deadline
                    - timedelta(seconds=overdue)
                )
            )
        await session.commit()

    files_of = MessageRouter._files_of

    async def fail_for_stuck(
        self: MessageRouter,
        session: AsyncSession,
        reads: Any,
        group_id: str,
        *rest: Any,
    ) -> Any:
        if group_id == "grp-stuck":
            raise RuntimeError("the post's files cannot be read")
        return await files_of(self, session, reads, group_id, *rest)

    monkeypatch.setattr(MessageRouter, "_files_of", fail_for_stuck)

    assert await process.router.flush_due_groups(TENANT_ZERO_ID) == 1
    await process.idle()

    events = await own_events(session_factory, agent.id)
    assert [e.message_key for e in events] == ["grp-next"]
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        stuck = await session.scalar(
            select(PendingAttachmentGroup).where(
                PendingAttachmentGroup.group_id == "grp-stuck"
            )
        )
        now = await session.scalar(select(func.now()))
    # Kept, and put off rather than tried again at once.
    assert stuck is not None
    assert stuck.deadline > now
