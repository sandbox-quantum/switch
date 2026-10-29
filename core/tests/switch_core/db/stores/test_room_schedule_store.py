from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, Room, RoomSchedule, room_agents
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from tests.switch_core.room_schedule_helpers import (
    add_agent,
    add_room,
    add_user,
    put_in_room,
)

STORE = RoomScheduleStore()


async def _schedule(
    session: AsyncSession,
    room: Room,
    author_id: str,
    agents: list[Agent],
    *,
    next_run_at: datetime | None,
) -> RoomSchedule:
    return await STORE.create(
        session,
        room_id=room.id,
        author_id=author_id,
        author_agent_id=None,
        body="Summarise new issues",
        run_at=None,
        cron="0 9 * * 1-5",
        timezone="Europe/London",
        next_run_at=next_run_at,
        agent_ids=[a.id for a in agents],
    )


class TestRoomScheduleStore:
    async def test_create_list_and_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, "owner")
            room = await add_room(session, "r1", owner_id=owner.id)
            triage = await add_agent(session, "triage", owner=owner)
            scribe = await add_agent(session, "scribe", owner=owner)
            first = await _schedule(
                session, room, owner.id, [triage, scribe], next_run_at=None
            )
            # Listed oldest first; one transaction would stamp both alike.
            await session.commit()
            second = await _schedule(
                session, room, owner.id, [scribe], next_run_at=None
            )
            await session.commit()

            listed = await STORE.list_for_room(session, room.id)
            assert [s.id for s in listed] == [first.id, second.id]
            assert await STORE.agent_ids(session, [first.id, second.id]) == {
                first.id: sorted([triage.id, scribe.id]),
                second.id: [scribe.id],
            }
            assert await STORE.get(session, room.id, first.id) is not None
            other = await add_room(session, "r2", owner_id=owner.id)
            assert await STORE.get(session, other.id, first.id) is None

    async def test_set_and_remove_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, "owner")
            room = await add_room(session, "r1", owner_id=owner.id)
            triage = await add_agent(session, "triage", owner=owner)
            scribe = await add_agent(session, "scribe", owner=owner)
            schedule = await _schedule(
                session, room, owner.id, [triage], next_run_at=None
            )

            await STORE.set_agents(session, schedule.id, [scribe.id, triage.id])
            await STORE.remove_agents(session, schedule.id, [triage.id])
            await session.commit()

            assert await STORE.agent_ids(session, [schedule.id]) == {
                schedule.id: [scribe.id]
            }

    async def test_goes_with_its_agent_and_its_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, "owner")
            room = await add_room(session, "r1", owner_id=owner.id)
            triage = await add_agent(session, "triage", owner=owner)
            scribe = await add_agent(session, "scribe", owner=owner)
            await put_in_room(session, room, triage)
            schedule = await _schedule(
                session, room, owner.id, [triage, scribe], next_run_at=None
            )
            await session.commit()

            await session.delete(scribe)
            await session.commit()
            assert await STORE.agent_ids(session, [schedule.id]) == {
                schedule.id: [triage.id]
            }

            await session.execute(delete(room_agents))
            await session.delete(room)
            await session.commit()
            assert (await session.execute(select(RoomSchedule))).first() is None

    async def test_claim_due_takes_only_due_unpaused_rows(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            owner = await add_user(session, "owner")
            room = await add_room(session, "r1", owner_id=owner.id)
            agent = await add_agent(session, "triage", owner=owner)
            later = await _schedule(
                session, room, owner.id, [agent], next_run_at=now - timedelta(minutes=1)
            )
            earlier = await _schedule(
                session, room, owner.id, [agent], next_run_at=now - timedelta(hours=1)
            )
            paused = await _schedule(
                session, room, owner.id, [agent], next_run_at=now - timedelta(days=1)
            )
            paused.paused = True
            await _schedule(
                session, room, owner.id, [agent], next_run_at=now + timedelta(hours=1)
            )
            await _schedule(session, room, owner.id, [agent], next_run_at=None)
            await session.commit()

        async with session_factory() as session:
            claimed = await STORE.claim_due(session)
            assert claimed is not None and claimed.id == earlier.id
            # While the first transaction holds it, another process skips it
            # and takes the next one due.
            async with session_factory() as other:
                second = await STORE.claim_due(other)
                assert second is not None and second.id == later.id
                async with session_factory() as third:
                    assert await STORE.claim_due(third) is None
