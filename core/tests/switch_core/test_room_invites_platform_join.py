"""Judging agents someone added to a channel on the platform itself.

`judge_platform_join` answers as a message from the adding account would be
answered: that account and the Switch users who claimed it. An account Switch
does not know, or one nobody claimed, is never trusted. When the platform does
not say who added an agent, it is let in and reported as unverified. Against a
real Postgres, like the rest of the invite rule.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    AddressingPolicy,
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.db.models import (
    Agent,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
)
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.room_invites import judge_platform_join
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_user,
    _register,
    _service,
)


class _World:
    """A Slack bridge with Olivia's owner-only agent, and three platform
    accounts: Olivia's (`UOLIVIA`), a stranger's (`USTRANGER`), and one nobody
    has claimed (`UNOBODY`)."""

    def __init__(self, bridge_id: str, olivia: str, agent_id: str) -> None:
        self.bridge_id = bridge_id
        self.olivia = olivia
        self.agent_id = agent_id


async def _account(
    session: AsyncSession, bridge_id: str, handle: str, claimant: str | None
) -> None:
    client = Client(
        transport_user_id=f"@{handle}-{uuid.uuid4().hex[:6]}:test",
        display_name=handle,
        type="external_user",
    )
    session.add(client)
    await session.flush()
    account = ExternalUser(
        bridge_id=bridge_id,
        external_user_id=f"U{handle.upper()}",
        external_username=handle,
        client_id=client.id,
    )
    session.add(account)
    await session.flush()
    if claimant is not None:
        session.add(ExternalUserClaim(external_user_id=account.id, user_id=claimant))


async def _set_policy(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    policy: AddressingPolicy | None,
) -> None:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        agent.addressing_policy = policy.model_dump() if policy is not None else None
        await session.commit()


async def _world(
    session_factory: async_sessionmaker[AsyncSession],
    policy: AddressingPolicy | None = None,
) -> _World:
    olivia = await _make_user(session_factory, "olivia")
    stranger = await _make_user(session_factory, "stranger")
    agent_id = await _register(_service(session_factory), "helper", olivia)
    await _set_policy(
        session_factory,
        agent_id,
        policy if policy is not None else owner_only_policy([]),
    )
    async with session_factory() as session:
        consumer = Client(
            transport_user_id=f"@ws-{uuid.uuid4().hex[:6]}:test",
            display_name="ws",
            type="collaboration_bridge",
        )
        session.add(consumer)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack", display_name="Slack", client_id=consumer.id, status="active"
        )
        session.add(bridge)
        await session.flush()
        await _account(session, bridge.id, "olivia", olivia)
        await _account(session, bridge.id, "stranger", stranger)
        await _account(session, bridge.id, "nobody", None)
        await session.commit()
        return _World(bridge.id, olivia, agent_id)


async def _judge(
    session_factory: async_sessionmaker[AsyncSession],
    world: _World,
    added_by: str | None,
) -> Any:
    async with session_factory() as session:
        agent = await session.get(Agent, world.agent_id)
        assert agent is not None
        return await judge_platform_join(
            session,
            ExternalUserStore(),
            targets=[agent],
            room_id="",
            group_id=None,
            bridge_id=world.bridge_id,
            added_by_external_user_id=added_by,
        )


class TestTheRule:
    async def test_the_owner_adding_it_is_admitted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        judgement = await _judge(session_factory, world, "UOLIVIA")
        assert [a.id for a in judgement.admitted] == [world.agent_id]
        assert judgement.refused == [] and judgement.unverified == []

    async def test_a_stranger_adding_it_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        judgement = await _judge(session_factory, world, "USTRANGER")
        assert [a.id for a in judgement.refused] == [world.agent_id]
        assert judgement.admitted == []
        assert not judgement.adder_unlinked

    @pytest.mark.parametrize("added_by", ["UNOBODY", "UNEVERSEEN"])
    async def test_an_account_nobody_claimed_or_switch_never_saw_is_not_trusted(
        self, session_factory: async_sessionmaker[AsyncSession], added_by: str
    ) -> None:
        world = await _world(session_factory)
        judgement = await _judge(session_factory, world, added_by)
        assert [a.id for a in judgement.refused] == [world.agent_id]
        assert judgement.adder_unlinked

    async def test_the_platform_not_saying_who_lets_it_in_unverified(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        judgement = await _judge(session_factory, world, None)
        assert [a.id for a in judgement.admitted] == [world.agent_id]
        assert [a.id for a in judgement.unverified] == [world.agent_id]
        assert judgement.refused == []

    @pytest.mark.parametrize("added_by", [None, "USTRANGER", "UNOBODY"])
    async def test_an_open_agent_admits_anyone_and_discloses_nothing(
        self, session_factory: async_sessionmaker[AsyncSession], added_by: str | None
    ) -> None:
        world = await _world(session_factory)
        await _set_policy(session_factory, world.agent_id, None)
        judgement = await _judge(session_factory, world, added_by)
        assert [a.id for a in judgement.admitted] == [world.agent_id]
        assert judgement.unverified == [] and judgement.refused == []

    async def test_the_owner_still_passes_under_owner_and_owner_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory, owner_and_owner_agents_policy())
        judgement = await _judge(session_factory, world, "UOLIVIA")
        assert [a.id for a in judgement.admitted] == [world.agent_id]
