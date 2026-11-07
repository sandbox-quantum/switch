"""Invites are judged in the funnel.

`RoomService.create_room` and `RoomService.add_agents_to_room` are where
every invite path ends — the chat command, the MCP tool, the gateway, a
template run, a platform join — so these tests pin the judgement there,
against a real Postgres: a stranger cannot seat an owner-only agent, the
owner can, an agent already in the room is never re-judged (a tightened
policy does not empty the room), and a platform join that names nobody
lets a restricted agent in but reports it unverified for the caller to
disclose.

Assembled the way `test_room_service_pool_holds.py` assembles its service:
the real stores over the test database, with the transport faked.
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    ExternalUser,
    Room,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.invites import (
    InviteRefused,
    PlatformInviter,
    UserInviter,
)
from switch_core.room_service import RoomCreateConfig, RoomService

OWNER_ONLY = owner_only_policy([]).model_dump()


class _Provisioning:
    def __init__(self) -> None:
        self.created: list[str] = []
        self.deleted: list[str] = []

    async def create_room(self, name: str, description: str) -> str:
        transport_id = f"!{uuid.uuid4().hex}:test"
        self.created.append(transport_id)
        return transport_id

    async def invite_to_room(
        self, transport_room_id: str, transport_user_id: str
    ) -> None:
        return None

    async def kick_user(self, transport_room_id: str, transport_user_id: str) -> None:
        return None

    async def delete_room(self, transport_room_id: str) -> None:
        self.deleted.append(transport_room_id)


class _RunningClients:
    def __init__(self, by_agent: dict[str, Any]) -> None:
        self._by_agent = by_agent
        self._by_id = {c.client_id: c for c in by_agent.values()}

    def get_by_agent_id(self, agent_id: str) -> Any:
        return self._by_agent.get(agent_id)

    def get(self, client_id: str) -> Any:
        return self._by_id.get(client_id)

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


def _service(
    session_factory: async_sessionmaker[AsyncSession], running: dict[str, Any]
) -> RoomService:
    svc = object.__new__(RoomService)
    svc._session_factory = session_factory  # type: ignore[assignment]
    svc._room_store = RoomStore()  # type: ignore[assignment]
    svc._agent_store = AgentStore()  # type: ignore[assignment]
    svc._provisioning = _Provisioning()  # type: ignore[assignment]
    svc._client_lifecycle = _RunningClients(running)  # type: ignore[assignment]
    svc._collab_lifecycle = SimpleNamespace(get=lambda bridge_id: None)  # type: ignore[assignment]
    svc._collab_bridge_store = SimpleNamespace()  # type: ignore[assignment]
    svc._resource_service = SimpleNamespace()  # type: ignore[assignment]
    svc._room_cache = SimpleNamespace(  # type: ignore[assignment]
        invalidate=lambda tenant_id, room_id: None
    )
    return svc


async def _user(session: AsyncSession, name: str) -> User:
    user = User(
        name=name,
        email=f"{name}-{uuid.uuid4().hex[:8]}@test",
        role="user",
        password_hash="x",
    )
    session.add(user)
    await session.flush()
    session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member"))
    await session.flush()
    return user


async def _agent(
    session: AsyncSession,
    name: str,
    *,
    owner_id: str,
    policy: dict | None,
    running: dict[str, Any],
) -> Agent:
    key = ApiKey(
        user_id=owner_id,
        key_hash=f"hash-{name}-{uuid.uuid4().hex[:8]}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(transport_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description="d",
        agent_type="session_addressable",
        connector_type="claude_code",
        integration_profile={},
        client_id=client.id,
        api_key_id=key.id,
        owner_id=owner_id,
        addressing_policy=policy,
    )
    session.add(agent)
    await session.flush()
    running[agent.id] = SimpleNamespace(
        client_id=client.id, transport_user_id=client.transport_user_id
    )
    return agent


async def _seed(
    session_factory: async_sessionmaker[AsyncSession],
) -> SimpleNamespace:
    """An owner, a stranger, the owner's owner-only agent, and a room."""
    running: dict[str, Any] = {}
    async with session_factory() as session:
        owner = await _user(session, "owner")
        stranger = await _user(session, "stranger")
        agent = await _agent(
            session,
            "guarded.bot",
            owner_id=owner.id,
            policy=OWNER_ONLY,
            running=running,
        )
        room = Room(transport_room_id="!r:test", name="room", description="d")
        session.add(room)
        await session.flush()
        await session.commit()
        return SimpleNamespace(
            owner_id=owner.id,
            stranger_id=stranger.id,
            agent_id=agent.id,
            room_id=room.id,
            running=running,
        )


async def _room_count(session_factory: async_sessionmaker[AsyncSession]) -> int:
    async with session_factory() as session:
        return int(await session.scalar(select(func.count()).select_from(Room)) or 0)


async def _members(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> list[str]:
    async with session_factory() as session:
        return await RoomStore().get_agent_ids(session, room_id)


class TestCreateRoomInvites:
    async def test_a_stranger_cannot_create_a_room_with_a_guarded_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seed = await _seed(session_factory)
        svc = _service(session_factory, seed.running)
        before = await _room_count(session_factory)

        with pytest.raises(InviteRefused) as caught:
            await svc.create_room(
                RoomCreateConfig(
                    name="nope",
                    description="d",
                    agent_ids=[seed.agent_id],
                    internal_only=True,
                ),
                invited_by=UserInviter(seed.stranger_id),
            )

        assert caught.value.agent_ids == [seed.agent_id]
        assert "doesn't take instructions from you" in str(caught.value)
        # Nothing was created for a refused invite.
        assert await _room_count(session_factory) == before

    async def test_a_policy_tightened_after_preflight_leaves_no_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seed = await _seed(session_factory)
        svc = _service(session_factory, seed.running)
        before = await _room_count(session_factory)
        async with session_factory() as session:
            agent = await AgentStore().get(session, seed.agent_id)
            assert agent is not None
            agent.addressing_policy = None
            await session.commit()

        check_invites = svc._check_invites

        async def tighten_after_preflight(*args: Any, **kwargs: Any) -> Any:
            result = await check_invites(*args, **kwargs)
            async with session_factory() as session:
                agent = await AgentStore().get(session, seed.agent_id)
                assert agent is not None
                agent.addressing_policy = OWNER_ONLY
                await session.commit()
            return result

        svc._check_invites = tighten_after_preflight  # type: ignore[method-assign]

        with pytest.raises(InviteRefused):
            await svc.create_room(
                RoomCreateConfig(
                    name="nope",
                    description="d",
                    agent_ids=[seed.agent_id],
                    internal_only=True,
                ),
                invited_by=UserInviter(seed.stranger_id),
            )

        assert await _room_count(session_factory) == before
        assert len(svc._provisioning.deleted) == 1  # type: ignore[attr-defined]

    async def test_the_owner_can_create_a_room_with_their_guarded_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seed = await _seed(session_factory)
        svc = _service(session_factory, seed.running)

        result = await svc.create_room(
            RoomCreateConfig(
                name="mine",
                description="d",
                agent_ids=[seed.agent_id],
                internal_only=True,
            ),
            invited_by=UserInviter(seed.owner_id),
        )

        assert await _members(session_factory, result.room.id) == [seed.agent_id]
        assert result.invite_unverified == []


class TestAddAgentsInvites:
    async def test_a_stranger_cannot_add_a_guarded_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seed = await _seed(session_factory)
        svc = _service(session_factory, seed.running)

        with pytest.raises(InviteRefused):
            await svc.add_agents_to_room(
                seed.room_id,
                agent_ids=[seed.agent_id],
                invited_by=UserInviter(seed.stranger_id),
            )

        assert await _members(session_factory, seed.room_id) == []

    async def test_the_owner_can_add_their_guarded_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seed = await _seed(session_factory)
        svc = _service(session_factory, seed.running)

        outcome = await svc.add_agents_to_room(
            seed.room_id,
            agent_ids=[seed.agent_id],
            invited_by=UserInviter(seed.owner_id),
        )

        assert outcome.unverified == []
        assert await _members(session_factory, seed.room_id) == [seed.agent_id]

    async def test_a_policy_update_waits_for_the_invite_transaction(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seed = await _seed(session_factory)
        svc = _service(session_factory, seed.running)
        invite_has_lock = asyncio.Event()
        finish_invite = asyncio.Event()
        async with session_factory() as session:
            agent = await AgentStore().get(session, seed.agent_id)
            assert agent is not None
            agent.addressing_policy = None
            await session.commit()

        async def hold_membership_transaction(_session: AsyncSession) -> None:
            invite_has_lock.set()
            await finish_invite.wait()

        invite = asyncio.create_task(
            svc.add_agents_to_room(
                seed.room_id,
                agent_ids=[seed.agent_id],
                invited_by=UserInviter(seed.owner_id),
                with_agents=hold_membership_transaction,
            )
        )
        await asyncio.wait_for(invite_has_lock.wait(), timeout=5)

        async def tighten_policy() -> None:
            async with session_factory() as session:
                agent = await AgentStore().get(session, seed.agent_id)
                assert agent is not None
                agent.addressing_policy = OWNER_ONLY
                await session.commit()

        update = asyncio.create_task(tighten_policy())
        await asyncio.sleep(0.1)
        assert not update.done()
        finish_invite.set()
        await invite
        await update

        assert await _members(session_factory, seed.room_id) == [seed.agent_id]

    async def test_an_agent_already_in_the_room_is_not_rejudged(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Tightening a policy — or a stranger repeating an add — never
        # empties a room: only agents about to be added are judged.
        seed = await _seed(session_factory)
        svc = _service(session_factory, seed.running)
        await svc.add_agents_to_room(
            seed.room_id,
            agent_ids=[seed.agent_id],
            invited_by=UserInviter(seed.owner_id),
        )

        outcome = await svc.add_agents_to_room(
            seed.room_id,
            agent_ids=[seed.agent_id],
            invited_by=UserInviter(seed.stranger_id),
        )

        assert outcome.refused == []
        assert await _members(session_factory, seed.room_id) == [seed.agent_id]


class TestPlatformJoinInvites:
    async def test_an_unnamed_adder_lets_the_agent_in_unverified(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seed = await _seed(session_factory)
        svc = _service(session_factory, seed.running)

        outcome = await svc.add_agents_to_room(
            seed.room_id,
            agent_ids=[seed.agent_id],
            invited_by=PlatformInviter("bridge-1", None),
        )

        assert [a.id for a in outcome.unverified] == [seed.agent_id]
        assert await _members(session_factory, seed.room_id) == [seed.agent_id]

    async def test_a_named_adder_is_judged_as_themselves(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seed = await _seed(session_factory)
        svc = _service(session_factory, seed.running)
        async with session_factory() as session:
            bridge_client = Client(
                transport_user_id="@bridge:test", display_name="b", type="bridge"
            )
            human_client = Client(
                transport_user_id="@stranger:test",
                display_name="s",
                type="external_user",
            )
            session.add_all([bridge_client, human_client])
            await session.flush()
            bridge = CollaborationBridge(
                type="mattermost",
                display_name="MM",
                client_id=bridge_client.id,
                status="active",
            )
            session.add(bridge)
            await session.flush()
            account = ExternalUser(
                bridge_id=bridge.id,
                external_user_id="U-STRANGER",
                external_username="stranger",
                client_id=human_client.id,
            )
            session.add(account)
            await session.flush()
            store = ExternalUserStore()
            request = await store.request_link(
                session,
                account,
                seed.stranger_id,
                requested_by_user_id=seed.stranger_id,
            )
            await store.confirm_link_request(session, request)
            await session.commit()
            bridge_id = bridge.id

        with pytest.raises(InviteRefused):
            await svc.add_agents_to_room(
                seed.room_id,
                agent_ids=[seed.agent_id],
                invited_by=PlatformInviter(bridge_id, "U-STRANGER"),
            )

        assert await _members(session_factory, seed.room_id) == []
