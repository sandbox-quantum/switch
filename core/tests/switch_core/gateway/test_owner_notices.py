"""Unknown-adder joins leave a durable notice for the current agent owner."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, OwnerNotice, Room, Tenant, TenantMember, User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.owner_notices import router
from switch_core.invites import PlatformInviter, UserInviter
from switch_core.room_service import RoomCreateConfig
from switch_core.tenant_context import tenant_scope
from tests.switch_core.test_room_service_invites import (
    _agent,
    _members,
    _seed,
    _service,
)


async def _notices(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[OwnerNotice]:
    async with session_factory() as session:
        return list((await session.scalars(select(OwnerNotice))).all())


async def test_unknown_adder_notifies_in_same_transaction_and_coalesces(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    seed = await _seed(session_factory)
    svc = _service(session_factory, seed.running)

    async def fail_after_add(_session: AsyncSession) -> None:
        raise RuntimeError("roll back")

    with pytest.raises(RuntimeError, match="roll back"):
        await svc.add_agents_to_room(
            seed.room_id,
            agent_ids=[seed.agent_id],
            invited_by=PlatformInviter("bridge", None),
            with_agents=fail_after_add,
        )
    assert await _members(session_factory, seed.room_id) == []
    assert await _notices(session_factory) == []

    await svc.add_agents_to_room(
        seed.room_id,
        agent_ids=[seed.agent_id],
        invited_by=PlatformInviter("bridge", None),
    )
    notices = await _notices(session_factory)
    assert len(notices) == 1
    assert (notices[0].agent_id, notices[0].room_id, notices[0].kind) == (
        seed.agent_id,
        seed.room_id,
        "unverified_agent_invite",
    )
    await svc.add_agents_to_room(
        seed.room_id,
        agent_ids=[seed.agent_id],
        invited_by=PlatformInviter("bridge", None),
    )
    assert len(await _notices(session_factory)) == 1


async def test_creation_notifies_unknown_but_not_known_inviter(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    seed = await _seed(session_factory)
    svc = _service(session_factory, seed.running)
    known = await svc.create_room(
        RoomCreateConfig(
            name="known", description="d", agent_ids=[seed.agent_id], internal_only=True
        ),
        invited_by=UserInviter(seed.owner_id),
    )
    assert known.invite_unverified == []
    assert await _notices(session_factory) == []
    unknown = await svc.create_room(
        RoomCreateConfig(
            name="unknown",
            description="d",
            agent_ids=[seed.agent_id],
            internal_only=True,
        ),
        invited_by=PlatformInviter("bridge", None),
    )
    notices = await _notices(session_factory)
    assert len(notices) == 1
    assert notices[0].room_id == unknown.room.id
    assert notices[0].agent_id == seed.agent_id


async def test_owner_notice_api_filters_owner_and_workspace_and_follows_transfer(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    seed = await _seed(session_factory)
    svc = _service(session_factory, seed.running)
    await svc.add_agents_to_room(
        seed.room_id,
        agent_ids=[seed.agent_id],
        invited_by=PlatformInviter("bridge", None),
    )
    own = (await _notices(session_factory))[0]
    async with session_factory() as session:
        owner = await session.get(User, seed.owner_id)
        stranger = await session.get(User, seed.stranger_id)
        assert owner and stranger
        session.add(
            Tenant(
                id="other-tenant",
                slug="other",
                name="Other",
                organization_id="00000000-0000-0000-0000-000000000000",
            )
        )
        await session.flush()
        session.add(
            TenantMember(tenant_id="other-tenant", user_id=owner.id, role="member")
        )
        await session.commit()
    with tenant_scope("other-tenant"):
        async with session_factory() as session:
            other_agent = await _agent(
                session, "other.bot", owner_id=seed.owner_id, policy=None, running={}
            )
            other_room = Room(
                transport_room_id="!other:test", name="other room", description="d"
            )
            session.add(other_room)
            await session.flush()
            session.add(
                OwnerNotice(
                    id="other-notice",
                    tenant_id="other-tenant",
                    agent_id=other_agent.id,
                    room_id=other_room.id,
                    kind="unverified_agent_invite",
                )
            )
            await session.commit()

    app = FastAPI()
    app.include_router(router)
    current = {"user": owner}
    app.dependency_overrides[get_current_user] = lambda: current["user"]

    async def session_override() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        current["user"] = stranger
        assert (await client.get("/owner-notices")).json() == []
        assert (await client.delete(f"/owner-notices/{own.id}")).status_code == 404
        current["user"] = owner
        data = (await client.get("/owner-notices")).json()
        assert len(data) == 1
        assert data[0]["id"] == own.id
        assert data[0]["owner_id"] == owner.id
        assert data[0]["room_name"] == "room"
        assert set(data[0]) == {
            "id",
            "owner_id",
            "tenant_id",
            "kind",
            "agent_name",
            "room_name",
            "created_at",
        }
        with tenant_scope("other-tenant"):
            other = (await client.get("/owner-notices")).json()
            assert [n["id"] for n in other] == ["other-notice"]
            assert (await client.delete(f"/owner-notices/{own.id}")).status_code == 404

        # The notice follows ownership and reflects current names, rather than
        # retaining potentially erased data or exposing it to a former owner.
        async with session_factory() as session:
            agent = await session.get(Agent, seed.agent_id)
            room = await session.get(Room, seed.room_id)
            assert agent and room
            agent.owner_id = stranger.id
            room.name = "renamed room"
            await session.commit()
        assert (await client.get("/owner-notices")).json() == []
        assert (await client.delete(f"/owner-notices/{own.id}")).status_code == 404
        current["user"] = stranger
        moved = (await client.get("/owner-notices")).json()
        assert len(moved) == 1 and moved[0]["room_name"] == "renamed room"
        assert moved[0]["owner_id"] == stranger.id
        assert (await client.delete(f"/owner-notices/{own.id}")).status_code == 204
        assert (await client.delete(f"/owner-notices/{own.id}")).status_code == 404
        assert (await client.get("/owner-notices")).json() == []


@pytest.mark.parametrize("delete_kind", ["agent", "room"])
async def test_removing_agent_or_room_cascades_notice(
    session_factory: async_sessionmaker[AsyncSession], delete_kind: str
) -> None:
    seed = await _seed(session_factory)
    async with session_factory() as session:
        session.add(
            OwnerNotice(
                agent_id=seed.agent_id,
                room_id=seed.room_id,
                kind="unverified_agent_invite",
            )
        )
        await session.commit()
        if delete_kind == "agent":
            await session.execute(delete(Agent).where(Agent.id == seed.agent_id))
        else:
            await session.execute(delete(Room).where(Room.id == seed.room_id))
        await session.commit()
    assert await _notices(session_factory) == []


async def test_notice_rls_and_cross_tenant_references(rls_harness):
    from sqlalchemy import insert
    from sqlalchemy.exc import DBAPIError

    from switch_core.db.models import TENANT_ZERO_ID
    from switch_core.db.session_scope import tenant_session

    async with rls_harness.owner() as session:
        user = User(
            name="owner", email="rls-owner@example.test", role="user", password_hash="x"
        )
        session.add(user)
        session.add_all(
            [
                Tenant(
                    id="notice-a",
                    slug="notice-a",
                    name="A",
                    organization_id=TENANT_ZERO_ID,
                ),
                Tenant(
                    id="notice-b",
                    slug="notice-b",
                    name="B",
                    organization_id=TENANT_ZERO_ID,
                ),
            ]
        )
        await session.commit()
        user_id = user.id
    ids = {}
    for tenant in ("notice-a", "notice-b"):
        with tenant_scope(tenant):
            async with rls_harness.owner() as session:
                agent = await _agent(
                    session, tenant + ".bot", owner_id=user_id, policy=None, running={}
                )
                room = Room(
                    name=tenant, transport_room_id=f"!{tenant}:test", description="d"
                )
                session.add(room)
                await session.flush()
                session.add(
                    OwnerNotice(
                        agent_id=agent.id,
                        room_id=room.id,
                        kind="unverified_agent_invite",
                    )
                )
                await session.commit()
                ids[tenant] = (agent.id, room.id)
    async with tenant_session(rls_harness.restricted, "notice-a") as session:
        notices = list((await session.scalars(select(OwnerNotice))).all())
        assert len(notices) == 1 and notices[0].agent_id == ids["notice-a"][0]
        with pytest.raises(DBAPIError):
            await session.execute(
                insert(OwnerNotice).values(
                    id="cross-tenant",
                    tenant_id="notice-a",
                    agent_id=ids["notice-b"][0],
                    room_id=ids["notice-a"][1],
                    kind="unverified_agent_invite",
                )
            )
            await session.flush()
        await session.rollback()


async def test_a_later_unverified_rejoin_notifies_after_dismissal(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    seed = await _seed(session_factory)
    svc = _service(session_factory, seed.running)
    await svc.add_agents_to_room(
        seed.room_id,
        agent_ids=[seed.agent_id],
        invited_by=PlatformInviter("bridge", None),
    )
    first = (await _notices(session_factory))[0].id
    async with session_factory() as session:
        await session.execute(delete(OwnerNotice).where(OwnerNotice.id == first))
        await session.commit()
    await svc.remove_agents_from_room(seed.room_id, [seed.agent_id])
    await svc.add_agents_to_room(
        seed.room_id,
        agent_ids=[seed.agent_id],
        invited_by=PlatformInviter("bridge", None),
    )
    pending = await _notices(session_factory)
    assert len(pending) == 1 and pending[0].id != first


async def test_retention_window_removes_old_notices(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    from switch_core.db.stores.retention_store import RetentionStore
    from switch_core.retention.service import RetentionService

    now = datetime.now(UTC)
    seed = await _seed(session_factory)
    await _service(session_factory, seed.running).add_agents_to_room(
        seed.room_id,
        agent_ids=[seed.agent_id],
        invited_by=PlatformInviter("bridge", None),
    )
    async with session_factory() as session:
        await session.execute(
            update(OwnerNotice).values(created_at=now - timedelta(days=31))
        )
        await RetentionStore().set_policy(
            session, message_retention_days=30, user_id=seed.owner_id
        )
        await session.commit()
    result = await RetentionService(session_factory).apply(now, timedelta(minutes=1))
    assert result.failed == ()
    assert await _notices(session_factory) == []
