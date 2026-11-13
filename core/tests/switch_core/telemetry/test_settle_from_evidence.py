"""Milestones a deployment passed while telemetry was off are claimed from the
database's evidence, so switching it on does not announce them as firsts.

Against real Postgres: the evidence is rows, and the claims are a primary-key
collision.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    DeploymentIdentity,
    Message,
    Room,
    TelemetrySnapshotWatermark,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.telemetry.deployment import (
    CONNECTOR_ADDED_PREFIX,
    claim_milestone,
    milestone_claimed,
    settle_from_evidence,
)
from switch_core.telemetry.setup import _milestones_passed as _setup_milestones_passed
from switch_core.telemetry.setup import build_telemetry
from switch_core.telemetry.snapshot import milestones_passed


async def _settle(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    switched_on: bool,
    activated_before: datetime | None = None,
) -> list[str]:
    return await settle_from_evidence(
        session_factory,
        lambda: milestones_passed(session_factory, activated_before=activated_before),
        switched_on=switched_on,
    )


async def _room_used_by_a_person(
    session_factory: async_sessionmaker[AsyncSession], *, person_type: str
) -> None:
    """A room a person made, with an agent in it, where the person spoke and
    the agent answered. `person_type` is the person's client: `user` on a
    messaging platform, `member` in Switch Console."""
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        owner = User(
            name="owner", email=f"owner-{suffix}@test", role="user", password_hash="x"
        )
        session.add(owner)
        await session.commit()
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        key = ApiKey(
            user_id=owner.id,
            key_hash=f"hash-{suffix}",
            encrypted_key="enc",
            label="test",
            type="agent",
        )
        person = Client(
            transport_user_id=f"@person-{suffix}:test",
            display_name="p",
            type=person_type,
        )
        agent_client = Client(
            transport_user_id=f"@agent-{suffix}:test", display_name="a", type="agent"
        )
        room = Room(
            transport_room_id=f"!{suffix}:test",
            name=f"room-{suffix}",
            description="",
            metadata_={"created_by_kind": "user"},
        )
        session.add_all([key, person, agent_client, room])
        await session.flush()
        session.add(
            Agent(
                name=f"agent-{suffix}",
                description="d",
                agent_type="session_addressable",
                connector_type="http",
                integration_profile={},
                client_id=agent_client.id,
                api_key_id=key.id,
            )
        )
        session.add(ClientRoom(client_id=agent_client.id, room_id=room.id))
        for seq, sender in enumerate((person, agent_client), start=1):
            session.add(
                Message(
                    room_id=room.id,
                    seq=seq,
                    transport_event_id=f"$evt-{suffix}-{seq}",
                    sender_id=sender.transport_user_id,
                    sender_client_id=sender.id,
                    event_type="m.room.message",
                    msgtype="m.text",
                    body="hello",
                    content={"body": "hello"},
                    sent_at=datetime.now(UTC) - timedelta(days=30 - seq),
                )
            )
        await session.commit()


async def _connector(
    session_factory: async_sessionmaker[AsyncSession], *, preconfigured: bool
) -> str:
    suffix = uuid.uuid4().hex[:8]
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        bridge_client = Client(
            transport_user_id=f"@bridge-{suffix}:test", display_name="b", type="bridge"
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Slack",
            client_id=bridge_client.id,
            status="active",
            preconfigured=preconfigured,
        )
        session.add(bridge)
        await session.commit()
        return bridge.id


async def test_a_new_deployment_has_nothing_to_settle(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    assert await _settle(session_factory, switched_on=True) == []
    assert await milestone_claimed(session_factory, "first_room_created") == "false"


async def test_what_a_deployment_already_did_is_claimed_without_reporting(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _room_used_by_a_person(session_factory, person_type="user")

    settled = await _settle(session_factory, switched_on=False)

    assert sorted(settled) == [
        "first_agent_connected",
        "first_agent_registered",
        "first_agent_session",
        "first_room_active",
        "first_room_created",
    ]
    assert await claim_milestone(session_factory, "first_room_created") is False
    assert await milestone_claimed(session_factory, "deployment_installed") == "false"


async def test_a_room_used_from_switch_console_chat_was_active(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _room_used_by_a_person(session_factory, person_type="member")

    settled = await _settle(session_factory, switched_on=False)

    assert "first_room_active" in settled
    assert "first_agent_session" in settled


async def test_it_runs_once_unless_telemetry_is_switched_on_again(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Once claims are taken while off, only a room first used while off
    still needs it, and that is only seen at the boot that switches it on."""
    assert await _settle(session_factory, switched_on=False) == []
    await _room_used_by_a_person(session_factory, person_type="user")

    assert await _settle(session_factory, switched_on=False) == []
    assert "first_room_active" in await _settle(session_factory, switched_on=True)


async def test_a_room_first_used_since_reporting_started_is_left_to_the_snapshot(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Upgrading a server that already reports: a room it first used since the
    last snapshot pass is reported by the next one, not settled away here."""
    await _room_used_by_a_person(session_factory, person_type="user")

    settled = await _settle(
        session_factory,
        switched_on=False,
        activated_before=datetime.now(UTC) - timedelta(days=60),
    )

    assert "first_room_active" not in settled
    assert "first_room_created" in settled


async def test_a_room_counts_from_when_it_went_live_not_its_first_message(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A room goes live when it has both a person's message and an agent: a
    person spoke before the cutoff, but the agent only came after, so the
    snapshot pass reports it and the settlement must leave it alone."""
    await _room_used_by_a_person(session_factory, person_type="user")

    settled = await _settle(
        session_factory,
        switched_on=False,
        activated_before=datetime.now(UTC) - timedelta(days=28, hours=12),
    )

    assert "first_room_active" not in settled


async def test_an_upgraded_server_settles_what_went_live_before_its_last_pass(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Reporting since long ago, last pass yesterday: a room that went live
    in between was never reported (the old definition ignored it, or the pass
    missed it), and the next pass only looks after yesterday. Settled."""
    await _room_used_by_a_person(session_factory, person_type="member")
    async with session_factory() as session:
        await session.execute(delete(TelemetrySnapshotWatermark))
        session.add(
            TelemetrySnapshotWatermark(
                id=1, last_sent_at=datetime.now(UTC) - timedelta(days=1)
            )
        )
        await session.commit()

    passed = await _setup_milestones_passed(
        session_factory,
        enabled=True,
        enabled_since=datetime.now(UTC) - timedelta(days=90),
    )

    assert "first_room_active" in passed


async def test_only_a_connector_a_person_added_that_connected_counts(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    bundled = await _connector(session_factory, preconfigured=True)
    configured_only = await _connector(session_factory, preconfigured=False)
    await claim_milestone(session_factory, f"{CONNECTOR_ADDED_PREFIX}{bundled}")

    assert await _settle(session_factory, switched_on=True) == []

    connected = await _connector(session_factory, preconfigured=False)
    await claim_milestone(session_factory, f"{CONNECTOR_ADDED_PREFIX}{connected}")
    assert configured_only != connected
    assert await _settle(session_factory, switched_on=True) == ["first_connector_added"]


async def test_booting_with_telemetry_settles_and_starts_its_clock(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """`build_telemetry`, as `main` runs it: the first boot with telemetry on
    records when it was switched on, which the service dates the past from,
    and claims what the deployment had already done before anything can
    report it."""
    async with session_factory() as session:
        await session.execute(delete(DeploymentIdentity))
        session.add(
            DeploymentIdentity(
                id=1,
                client_id=str(uuid.uuid4()),
                installed_at=datetime.now(UTC) - timedelta(days=60),
            )
        )
        await session.commit()
    await _room_used_by_a_person(session_factory, person_type="user")
    config = SwitchConfig(
        db_host="h",
        db_port="5432",
        db_user="u",
        db_password="p",
        db_name="d",
        matrix_server_name="test",
        agent_registration_token="t",
        secret_keys="test:" + "x" * 40,
        gateway_admin_email="a@b.test",
        gateway_admin_password="pw",
        telemetry_enabled=True,
        telemetry_endpoint="http://127.0.0.1:9",
    )

    service, _, http = await build_telemetry(config, session_factory, "1.0.0")
    try:
        reporting_since = service.reporting_since
        assert reporting_since is not None
        assert reporting_since > datetime.now(UTC) - timedelta(minutes=5)
        assert await milestone_claimed(session_factory, "first_room_created") == (
            "true"
        )
        assert await milestone_claimed(session_factory, "deployment_installed") == (
            "false"
        )
    finally:
        await service.aclose()
        if http is not None:
            await http.aclose()
