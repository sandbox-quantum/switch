"""Registration sets the new agent's default addressing policy (CHOO-2137)."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    default_agent_policy,
    owner_and_owner_agents_policy,
    owner_only_policy,
    parse_policy,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
    register,
)


async def _policy_of(
    svc: AgentCore,
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
) -> dict | None:
    async with session_factory() as session:
        agent = await svc.agent_store.get(session, agent_id)
    assert agent is not None
    return agent.addressing_policy


class TestRegistrationDefaultPolicy:
    async def test_new_agent_admits_its_owner_and_the_owners_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(svc, "fresh", owner_id)

        raw = await _policy_of(svc, session_factory, agent_id)
        assert raw == default_agent_policy().model_dump()
        assert raw == owner_and_owner_agents_policy().model_dump()
        policy = parse_policy(raw)
        assert policy.is_open() is False

        def allows(**sender: object) -> bool:
            return policy.allows(
                room_id="any-room",
                group_id=None,
                owner_user_id=owner_id,
                **sender,  # type: ignore[arg-type]
            )

        # The owner gets in from anywhere, and so do the owner's own agents.
        assert allows(
            sender_kind="user",
            sender_id="ext-3",
            sender_user_ids=[owner_id],
            sender_owner_user_id=None,
        )
        assert allows(
            sender_kind="agent",
            sender_id="sibling-agent",
            sender_user_ids=[],
            sender_owner_user_id=owner_id,
        )
        # Other people and their agents do not.
        assert not allows(
            sender_kind="user",
            sender_id="ext-4",
            sender_user_ids=["someone-else"],
            sender_owner_user_id=None,
        )
        assert not allows(
            sender_kind="agent",
            sender_id="other-agent",
            sender_user_ids=[],
            sender_owner_user_id="someone-else",
        )

    async def test_an_explicit_owner_only_choice_is_kept(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(
            svc, "private", owner_id, addressing_policy=owner_only_policy([])
        )

        raw = await _policy_of(svc, session_factory, agent_id)
        assert raw == owner_only_policy([]).model_dump()
        assert (
            parse_policy(raw).allows(
                room_id="any-room",
                group_id=None,
                sender_kind="agent",
                sender_id="sibling-agent",
                sender_user_ids=[],
                sender_owner_user_id=owner_id,
                owner_user_id=owner_id,
            )
            is False
        )

    async def test_no_policy_leaves_the_agent_open(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # An agent the deployment offers everyone is owned by someone only in
        # the bookkeeping sense.
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(svc, "shared", owner_id, addressing_policy=None)

        raw = await _policy_of(svc, session_factory, agent_id)
        assert raw is None
        assert parse_policy(raw).is_open() is True

    async def test_reregistration_leaves_the_policy_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(svc, "kept", owner_id, addressing_policy=None)

        async with session_factory() as session:
            await svc.agent_store.update(
                session,
                agent_id,
                addressing_policy={"rules": [{"users": ["ext-3"], "agents": []}]},
            )
            await session.commit()

        again = await register(svc, "kept", owner_id, overwrite=True)
        assert again == agent_id
        raw = await _policy_of(svc, session_factory, agent_id)
        assert raw == {"rules": [{"users": ["ext-3"], "agents": []}]}
