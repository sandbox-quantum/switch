"""The room-schedule routes, called directly against real Postgres: who may
change a room's schedules, and what each change does to the next run."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, Room, User
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.room_schedules import (
    create_room_schedule,
    delete_room_schedule,
    list_room_schedules,
    update_room_schedule,
)
from switch_core.gateway.schemas import (
    RoomScheduleCreateRequest,
    RoomScheduleDetail,
    RoomScheduleUpdateRequest,
)
from tests.switch_core.room_schedule_helpers import (
    add_agent,
    add_room,
    add_user,
    put_in_room,
)

ROOMS = RoomStore()
SCHEDULES = RoomScheduleStore()
USERS = UserStore()


async def _setup(
    session: AsyncSession, *, write_visibility: str = "private"
) -> tuple[User, User, Room, Agent]:
    owner = await add_user(session, "owner")
    other = await add_user(session, "other")
    room = await add_room(
        session, "standup", owner_id=owner.id, write_visibility=write_visibility
    )
    agent = await add_agent(session, "triage", owner=owner)
    await put_in_room(session, room, agent)
    await session.commit()
    return owner, other, room, agent


async def _create(
    session: AsyncSession, room: Room, user: User, req: RoomScheduleCreateRequest
) -> RoomScheduleDetail:
    return await create_room_schedule(
        room.id,
        req,
        session,
        ROOMS,
        SCHEDULES,
        user,
        await USERS.administers(session, user),
    )


async def _update(
    session: AsyncSession,
    room: Room,
    user: User,
    schedule_id: str,
    req: RoomScheduleUpdateRequest,
) -> RoomScheduleDetail:
    return await update_room_schedule(
        room.id,
        schedule_id,
        req,
        session,
        ROOMS,
        SCHEDULES,
        user,
        await USERS.administers(session, user),
    )


def _weekdays(agent: Agent) -> RoomScheduleCreateRequest:
    return RoomScheduleCreateRequest(
        agent_ids=[agent.id],
        body="Summarise new issues",
        cron="0 9 * * 1-5",
        timezone="Europe/London",
    )


class TestRoomScheduleRoutes:
    async def test_owner_creates_lists_edits_and_deletes(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)

            created = await _create(session, room, owner, _weekdays(agent))
            assert created.agent_ids == [agent.id]
            assert created.author_name == "owner"
            assert created.next_run_at is not None
            assert created.next_run_at > datetime.now(UTC)

            soon = datetime.now(UTC) + timedelta(hours=2)
            edited = await _update(
                session,
                room,
                owner,
                created.id,
                RoomScheduleUpdateRequest(run_at=soon, cron=None, body="Standup"),
            )
            assert edited.cron is None and edited.body == "Standup"
            assert edited.next_run_at == soon

            listed = await list_room_schedules(
                room.id, session, ROOMS, SCHEDULES, owner, False
            )
            assert [s.id for s in listed] == [created.id]

            await delete_room_schedule(
                room.id, created.id, session, ROOMS, SCHEDULES, owner, False
            )
            assert (
                await list_room_schedules(
                    room.id, session, ROOMS, SCHEDULES, owner, False
                )
                == []
            )

    async def test_someone_who_cannot_write_the_room_changes_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, other, room, agent = await _setup(session)
            created = await _create(session, room, owner, _weekdays(agent))

            with pytest.raises(HTTPException) as exc:
                await _create(session, room, other, _weekdays(agent))
            assert exc.value.status_code == 403
            with pytest.raises(HTTPException) as exc:
                await _update(
                    session,
                    room,
                    other,
                    created.id,
                    RoomScheduleUpdateRequest(paused=True),
                )
            assert exc.value.status_code == 403
            with pytest.raises(HTTPException) as exc:
                await delete_room_schedule(
                    room.id, created.id, session, ROOMS, SCHEDULES, other, False
                )
            assert exc.value.status_code == 403

    async def test_an_edit_by_someone_else_makes_it_theirs(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, other, room, agent = await _setup(session, write_visibility="public")
            created = await _create(session, room, owner, _weekdays(agent))

            paused = await _update(
                session, room, other, created.id, RoomScheduleUpdateRequest(paused=True)
            )
            assert paused.author_id == owner.id
            edited = await _update(
                session, room, other, created.id, RoomScheduleUpdateRequest(body="Hi")
            )
            assert edited.author_id == other.id

    async def test_resuming_skips_the_runs_missed_while_paused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)
            created = await _create(
                session,
                room,
                owner,
                RoomScheduleCreateRequest(
                    agent_ids=[agent.id], body="Ping", cron="* * * * *", timezone="UTC"
                ),
            )
            await _update(
                session, room, owner, created.id, RoomScheduleUpdateRequest(paused=True)
            )
            schedule = await SCHEDULES.get(session, room.id, created.id)
            assert schedule is not None
            schedule.next_run_at = datetime.now(UTC) - timedelta(hours=1)
            schedule.last_error = "earlier failure"
            await session.commit()

            resumed = await _update(
                session,
                room,
                owner,
                created.id,
                RoomScheduleUpdateRequest(paused=False),
            )
            assert resumed.paused is False and resumed.last_error is None
            assert resumed.next_run_at is not None
            assert resumed.next_run_at > datetime.now(UTC)

    @pytest.mark.parametrize(
        "req",
        [
            {"cron": "0 9 * *", "timezone": "UTC"},
            {"cron": "0 9 * * *", "timezone": "Nowhere/Special"},
            {"run_at": datetime(2020, 1, 1, tzinfo=UTC), "timezone": "UTC"},
            {"timezone": "UTC"},
        ],
    )
    async def test_unusable_timing_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession], req: dict[str, object]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)
            with pytest.raises(HTTPException) as exc:
                await _create(
                    session,
                    room,
                    owner,
                    RoomScheduleCreateRequest.model_validate(
                        {"agent_ids": [agent.id], "body": "Ping", **req}
                    ),
                )
            assert exc.value.status_code == 400

    async def test_agents_must_be_in_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)
            outsider = await add_agent(session, "outsider", owner=owner)
            with pytest.raises(HTTPException) as exc:
                await _create(
                    session,
                    room,
                    owner,
                    RoomScheduleCreateRequest(
                        agent_ids=[agent.id, outsider.id],
                        body="Ping",
                        cron="0 9 * * *",
                        timezone="UTC",
                    ),
                )
            assert exc.value.status_code == 400
            assert outsider.id in str(exc.value.detail)

    async def test_a_schedule_is_reached_only_through_its_own_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)
            created = await _create(session, room, owner, _weekdays(agent))
            elsewhere = await add_room(session, "elsewhere", owner_id=owner.id)
            await session.commit()
            with pytest.raises(HTTPException) as exc:
                await _update(
                    session,
                    elsewhere,
                    owner,
                    created.id,
                    RoomScheduleUpdateRequest(paused=True),
                )
            assert exc.value.status_code == 404

    async def test_a_one_off_is_created_for_its_instant_and_has_no_rule(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)
            at = (datetime.now(UTC) + timedelta(minutes=2)).replace(microsecond=0)
            created = await _create(
                session,
                room,
                owner,
                RoomScheduleCreateRequest(
                    agent_ids=[agent.id], body="Once", run_at=at, timezone="UTC"
                ),
            )
            assert created.cron is None
            assert created.run_at == at and created.next_run_at == at
            assert created.paused is False and created.last_run_at is None

    async def test_a_rule_and_a_one_off_together_are_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)
            with pytest.raises(HTTPException) as exc:
                await _create(
                    session,
                    room,
                    owner,
                    RoomScheduleCreateRequest(
                        agent_ids=[agent.id],
                        body="Both",
                        run_at=datetime.now(UTC) + timedelta(hours=1),
                        cron="0 9 * * *",
                        timezone="UTC",
                    ),
                )
            assert exc.value.status_code == 400

    @pytest.mark.parametrize(
        "req",
        [
            {"agent_ids": [], "body": "Ping"},
            {"agent_ids": ["x"], "body": "   "},
            {"agent_ids": ["x"], "body": ""},
        ],
    )
    def test_a_request_with_no_agents_or_no_text_is_invalid(
        self, req: dict[str, object]
    ) -> None:
        with pytest.raises(ValidationError):
            RoomScheduleCreateRequest.model_validate(
                {**req, "cron": "0 9 * * *", "timezone": "UTC"}
            )

    async def test_a_schedule_that_is_gone_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)
            created = await _create(session, room, owner, _weekdays(agent))
            await delete_room_schedule(
                room.id, created.id, session, ROOMS, SCHEDULES, owner, False
            )
            with pytest.raises(HTTPException) as exc:
                await delete_room_schedule(
                    room.id, created.id, session, ROOMS, SCHEDULES, owner, False
                )
            assert exc.value.status_code == 404
            with pytest.raises(HTTPException) as exc:
                await _update(
                    session,
                    room,
                    owner,
                    created.id,
                    RoomScheduleUpdateRequest(paused=True),
                )
            assert exc.value.status_code == 404

    async def test_pausing_keeps_the_next_run_and_retiming_moves_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)
            created = await _create(session, room, owner, _weekdays(agent))

            paused = await _update(
                session, room, owner, created.id, RoomScheduleUpdateRequest(paused=True)
            )
            assert paused.paused is True
            assert paused.next_run_at == created.next_run_at

            retimed = await _update(
                session,
                room,
                owner,
                created.id,
                RoomScheduleUpdateRequest(cron="30 7 * * *", timezone="Asia/Kolkata"),
            )
            assert retimed.cron == "30 7 * * *" and retimed.timezone == "Asia/Kolkata"
            assert retimed.next_run_at is not None
            assert retimed.next_run_at != created.next_run_at
            # 07:30 IST is 02:00 UTC.
            assert (retimed.next_run_at.hour, retimed.next_run_at.minute) == (2, 0)

    async def test_an_edit_cannot_name_an_agent_outside_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, _, room, agent = await _setup(session)
            outsider = await add_agent(session, "outsider", owner=owner)
            created = await _create(session, room, owner, _weekdays(agent))
            with pytest.raises(HTTPException) as exc:
                await _update(
                    session,
                    room,
                    owner,
                    created.id,
                    RoomScheduleUpdateRequest(agent_ids=[outsider.id]),
                )
            assert exc.value.status_code == 400
            [kept] = await list_room_schedules(
                room.id, session, ROOMS, SCHEDULES, owner, False
            )
            assert kept.agent_ids == [agent.id]

    async def test_someone_who_cannot_see_the_room_cannot_list_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner, other, room, agent = await _setup(session)
            await _create(session, room, owner, _weekdays(agent))
            with pytest.raises(HTTPException) as exc:
                await list_room_schedules(
                    room.id, session, ROOMS, SCHEDULES, other, False
                )
            assert exc.value.status_code in (403, 404)
