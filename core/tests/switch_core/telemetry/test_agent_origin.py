"""Telling switch-buddy apart from other agents in telemetry, and the room
schedule events, against real Postgres.

An agent's origin is read from the server's own record of the template run
that made it, so these build that record the way a run does
(`TemplateInstallStore.create`) rather than naming an agent "switch-buddy".
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID as TENANT_ZERO,
)
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    Room,
    RoomSchedule,
    User,
)
from switch_core.db.stores.template_install_store import (
    NewInstallResource,
    TemplateInstallStore,
)
from switch_core.room_schedules import (
    RoomScheduler,
    report_schedule_created,
    report_schedule_removed,
)
from switch_core.telemetry.catalogue import validate
from switch_core.telemetry.messages import MessageTelemetry
from switch_core.telemetry.origins import (
    BUDDY_TEMPLATE_ID,
    agent_origins,
    is_buddy,
    most_specific,
    origin_of,
)
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord
from switch_core.transport.observer import ParticipantMessage
from tests.telemetry_records import declared


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _service(sink: _RecordingSink) -> TelemetryService:
    return TelemetryService(
        sink=sink,
        enabled=True,
        client_id="deployment-uuid",
        version="1.0.0",
        telemetry_environment="prod",
        telemetry_internal=False,
        deployment_kind="self_hosted",
    )


async def _agent(session: AsyncSession) -> Agent:
    slug = uuid.uuid4().hex[:10]
    owner = User(name="owner", email=f"owner-{slug}@test", role="user")
    session.add(owner)
    await session.flush()
    client = Client(
        transport_user_id=f"@agent-{slug}:test", display_name="agent", type="agent"
    )
    key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{slug}",
        encrypted_key="",
        label="test",
        type="agent",
    )
    session.add_all([client, key])
    await session.flush()
    agent = Agent(
        name=f"agent-{slug[:6]}",
        description="d",
        agent_type="session_addressable",
        connector_type="claude",
        integration_profile={},
        client_id=client.id,
        api_key_id=key.id,
        owner_id=owner.id,
        metadata_={"known_agent_type": "claude-code"},
    )
    session.add(agent)
    await session.flush()
    return agent


async def _installed(
    session: AsyncSession, agent: Agent, *, source: str, template_id: str
) -> None:
    await TemplateInstallStore().create(
        session,
        owner_id=agent.owner_id,
        source=source,
        template_id=template_id,
        template_name=template_id,
        revision=1,
        inputs={},
        builtins={},
        resources=[
            NewInstallResource(
                key=f"agent-{uuid.uuid4().hex[:6]}",
                agent_id=agent.id,
                room_id=None,
                fingerprints={},
            )
        ],
    )


class TestOrigins:
    def test_an_install_names_the_origin(self) -> None:
        assert origin_of("official", BUDDY_TEMPLATE_ID) == "buddy"
        assert origin_of("official", "official:sprint-room") == "official_template"
        # A saved template's id is a row id, whatever it is called.
        assert origin_of("saved", "switch-buddy") == "other"
        assert origin_of(None, None) == "other"

    def test_the_most_specific_origin_wins(self) -> None:
        assert most_specific("other", "buddy") == "buddy"
        assert most_specific("buddy", "official_template") == "buddy"
        assert most_specific("official_template", "other") == "official_template"

    async def test_agents_are_read_from_their_installs(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            buddy = await _agent(session)
            await _installed(
                session, buddy, source="official", template_id=BUDDY_TEMPLATE_ID
            )
            sprint = await _agent(session)
            await _installed(
                session, sprint, source="official", template_id="official:sprint-room"
            )
            saved = await _agent(session)
            await _installed(session, saved, source="saved", template_id="row-id")
            plain = await _agent(session)
            await session.commit()

            assert await agent_origins(
                session, [buddy.id, sprint.id, saved.id, plain.id]
            ) == {
                buddy.id: "buddy",
                sprint.id: "official_template",
                saved.id: "other",
                plain.id: "other",
            }
            assert await is_buddy(session, buddy.id)
            assert not await is_buddy(session, plain.id)
            assert not await is_buddy(session, None)


async def _room_with(session: AsyncSession, agent: Agent) -> Room:
    room = Room(
        name=f"room-{uuid.uuid4().hex[:6]}",
        description="d",
        transport_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
        channel_type="channel_private",
    )
    session.add(room)
    await session.flush()
    session.add(ClientRoom(client_id=agent.client_id, room_id=room.id))
    await session.flush()
    return room


class TestMessagesCarryTheOrigin:
    async def test_buddy_speaking_and_being_asked_say_buddy(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            buddy = await _agent(session)
            await _installed(
                session, buddy, source="official", template_id=BUDDY_TEMPLATE_ID
            )
            room = await _room_with(session, buddy)
            await session.commit()
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(
            ParticipantMessage(
                tenant_id=TENANT_ZERO,
                room_id=room.id,
                sender_client_id=buddy.client_id,
                sender_role="agent",
                sender_is_app=False,
                has_attachment=False,
                in_thread=False,
            )
        )
        messages.agent_addressed(
            tenant_id=TENANT_ZERO,
            room_id=room.id,
            sender_transport_user_id="@someone:test",
            from_platform=True,
            from_app=False,
            agent_metadata=buddy.metadata_,
            agent_live=True,
            has_attachment=False,
            agent_client_id=buddy.client_id,
        )
        async with asyncio.timeout(10):
            await messages._queue.join()
        await messages.aclose()
        await service.aclose()

        origins = {
            record.name: declared(record)["agent_origin"] for record in sink.sent
        }
        assert origins == {
            "switch_core.message_sent": "buddy",
            "switch_core.agent_message_received": "buddy",
        }

    async def test_a_person_speaking_carries_no_origin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent = await _agent(session)
            room = await _room_with(session, agent)
            await session.commit()
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(
            ParticipantMessage(
                tenant_id=TENANT_ZERO,
                room_id=room.id,
                sender_client_id="someone",
                sender_role="human",
                sender_is_app=False,
                has_attachment=False,
                in_thread=False,
            )
        )
        async with asyncio.timeout(10):
            await messages._queue.join()
        await messages.aclose()
        await service.aclose()

        assert "agent_origin" not in declared(sink.sent[0])


def _schedule(room: Room, author: Agent | None, owner_id: str, cron: str | None):
    return RoomSchedule(
        room_id=room.id,
        author_id=owner_id,
        author_agent_id=author.id if author is not None else None,
        agent_ids=["a", "b"],
        text="post the digest",
        cron=cron,
        run_at=None if cron else datetime.now(UTC) + timedelta(hours=1),
        timezone="Europe/London",
        paused=False,
        next_run_at=datetime.now(UTC) + timedelta(hours=1),
    )


class TestRoomScheduleEvents:
    async def test_a_schedule_buddy_sets_up_is_reported_once_committed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        sink = _RecordingSink()
        service = _service(sink)
        async with session_factory() as session:
            buddy = await _agent(session)
            await _installed(
                session, buddy, source="official", template_id=BUDDY_TEMPLATE_ID
            )
            room = await _room_with(session, buddy)
            schedule = _schedule(room, buddy, buddy.owner_id, "0 9 * * 1-5")
            session.add(schedule)
            await session.flush()
            await report_schedule_created(session, service, schedule)
            assert sink.sent == []
            await session.commit()
        await service.aclose()

        assert [(r.name, declared(r)) for r in sink.sent] == [
            (
                "switch_core.room_schedule_created",
                {
                    "schedule_kind": "recurring",
                    "set_by": "agent",
                    "by_buddy": True,
                    "agent_count": 2,
                },
            )
        ]

    async def test_a_rolled_back_delete_reports_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        sink = _RecordingSink()
        service = _service(sink)
        async with session_factory() as session:
            agent = await _agent(session)
            room = await _room_with(session, agent)
            schedule = _schedule(room, None, agent.owner_id, None)
            session.add(schedule)
            await session.commit()
            await report_schedule_removed(
                session, service, schedule, change="deleted", removed_by="user"
            )
            await session.rollback()
        await service.aclose()

        assert sink.sent == []

    async def test_a_person_pausing_one_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        sink = _RecordingSink()
        service = _service(sink)
        async with session_factory() as session:
            agent = await _agent(session)
            room = await _room_with(session, agent)
            schedule = _schedule(room, None, agent.owner_id, None)
            session.add(schedule)
            await session.commit()
            await report_schedule_removed(
                session, service, schedule, change="paused", removed_by="user"
            )
            schedule.paused = True
            await session.commit()
        await service.aclose()

        (record,) = sink.sent
        properties = declared(record)
        assert record.name == "switch_core.room_schedule_removed"
        assert properties["change"] == "paused"
        assert properties["schedule_kind"] == "once"
        assert properties["by_buddy"] is False
        assert properties["age_days"] >= 0


class TestRoomScheduleFired:
    @pytest.mark.parametrize(
        ("outcome", "reason"),
        [
            ("posted", "none"),
            ("paused", "author_lost_room"),
            ("paused", "setter_left"),
            ("paused", "no_agents"),
            ("skipped", "room_read_only"),
        ],
    )
    async def test_every_outcome_the_scheduler_reports_is_declared(
        self, outcome: str, reason: str
    ) -> None:
        sink = _RecordingSink()
        service = _service(sink)
        scheduler = RoomScheduler(
            session_factory=None,  # type: ignore[arg-type]
            client_lifecycle=None,  # type: ignore[arg-type]
            telemetry=service,
        )
        now = datetime.now(UTC)
        schedule = RoomSchedule(cron=None, run_at=now)

        scheduler._report_fired(schedule, True, outcome, reason, now, now)
        await service.aclose()

        (record,) = sink.sent
        assert declared(record) == {
            "outcome": outcome,
            "reason": reason,
            "schedule_kind": "once",
            "by_buddy": True,
            "late": False,
        }

    async def test_a_run_sent_well_after_it_was_due_is_late(self) -> None:
        sink = _RecordingSink()
        service = _service(sink)
        scheduler = RoomScheduler(
            session_factory=None,  # type: ignore[arg-type]
            client_lifecycle=None,  # type: ignore[arg-type]
            telemetry=service,
        )
        now = datetime.now(UTC)

        scheduler._report_fired(
            RoomSchedule(cron="0 9 * * *"),
            False,
            "posted",
            "none",
            now - timedelta(hours=1),
            now,
        )

        await service.aclose()
        assert declared(sink.sent[0])["late"] is True
        assert declared(sink.sent[0])["schedule_kind"] == "recurring"


class TestDeclared:
    def test_the_new_properties_validate(self) -> None:
        validate(
            "agent_registered",
            {
                "agent_type": "auto_session",
                "known_agent_type": "claude-code",
                "registration_path": "gateway",
                "has_parent": False,
                "created_by_buddy": True,
            },
        )
        validate(
            "session_started",
            {
                "start_source": "room",
                "known_agent_type": "claude-code",
                "agent_origin": "buddy",
            },
        )
