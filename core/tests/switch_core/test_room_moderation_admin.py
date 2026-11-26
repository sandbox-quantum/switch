"""`switch-room-moderation`, as an operator runs it: on the restricted role
row-level security applies to, bound to no workspace. `owner` only arranges
fixtures and reads results."""

from __future__ import annotations

import argparse

import pytest
from sqlalchemy import select

from switch_core.config import SwitchConfig
from switch_core.db.audit import AuditAction
from switch_core.db.models import TENANT_ZERO_ID, AuditEvent, ClientRoom, Message
from switch_core.room_moderation import ModerationTargetNotFound
from switch_core.room_moderation_admin import (
    REMOVED_BY,
    RoomModerationAdminError,
    remove,
)
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness
from tests.routing import add_member, make_agent, make_room

pytestmark = pytest.mark.no_ambient_tenant


def _config() -> SwitchConfig:
    return SwitchConfig(
        db_host="unused",
        db_port="5432",
        db_user="unused",
        db_password="unused",
        db_name="unused",
        id_server_name="test",
        agent_registration_token="unused",
        secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        gateway_admin_email="admin@switch.local",
        gateway_admin_password="unused",
    )


def _arguments(**kw: object) -> argparse.Namespace:
    return argparse.Namespace(**{"workspace": TENANT_ZERO_ID, "request": "INC-9", **kw})


async def test_an_agent_is_taken_out_of_every_room(rls_harness: RLSHarness) -> None:
    owner = rls_harness.owner
    with tenant_scope(TENANT_ZERO_ID):
        agent, client = await make_agent(owner, "suspect")
        rooms = [await make_room(owner, f"room-{i}") for i in range(2)]
        for room in rooms:
            await add_member(owner, room, client, agent=agent)

    result = await remove(
        _config(),
        rls_harness.restricted,
        rls_harness.restricted_engine,
        _arguments(command="remove-agent", agent_id=agent.id),
    )

    assert sorted(room.id for room in result.rooms) == sorted(r.id for r in rooms)
    async with owner() as session:
        assert (
            list(
                await session.scalars(
                    select(ClientRoom).where(ClientRoom.client_id == client.id)
                )
            )
            == []
        )
        departures = list(
            await session.scalars(
                select(Message).where(
                    Message.sender_client_id == client.id,
                    Message.event_type == "m.room.member",
                )
            )
        )
        [event] = list(
            await session.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.MEMBER_REMOVED_FROM_ALL_ROOMS.value
                )
            )
        )
    assert sorted(row.room_id for row in departures) == sorted(r.id for r in rooms)
    assert {row.content["removed_by"] for row in departures} == {REMOVED_BY}
    assert event.actor_user_id is None
    assert event.details["request"] == "INC-9"


async def test_an_unknown_workspace_or_agent_is_refused(
    rls_harness: RLSHarness,
) -> None:
    with pytest.raises(RoomModerationAdminError):
        await remove(
            _config(),
            rls_harness.restricted,
            rls_harness.restricted_engine,
            _arguments(command="remove-agent", agent_id="x", workspace="nowhere"),
        )
    with pytest.raises(ModerationTargetNotFound):
        await remove(
            _config(),
            rls_harness.restricted,
            rls_harness.restricted_engine,
            _arguments(command="remove-agent", agent_id="no-such-agent"),
        )
