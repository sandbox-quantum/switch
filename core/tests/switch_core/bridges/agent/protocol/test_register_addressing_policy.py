"""Registration sets the new agent's default addressing policy (CHOO-2137)."""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    default_agent_policy,
    owner_and_owner_agents_policy,
    owner_only_policy,
    parse_policy,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import TENANT_ZERO_ID, ApiKey
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    PROFILE,
    make_owner,
    make_service,
    register,
)


async def _seed_registration_key(
    session_factory: async_sessionmaker[AsyncSession], owner_id: str, token: str
) -> None:
    """A real `api_keys` row for `token`.

    `register_agent_with_token` resolves the token's tenant through
    `tenant_of_api_key` — a `SECURITY DEFINER` SQL function reading the real
    table — before it ever reaches `svc.api_key_store`, which these tests
    stub (`_stub_key`) to control the row `register_agent_with_token` sees
    once the tenant is known. Stubbing the store cannot stand in for this
    row too: the tenant lookup has no store to intercept.
    """
    async with session_factory() as session:
        session.add(
            ApiKey(
                user_id=owner_id,
                key_hash=hashlib.sha256(token.encode()).hexdigest(),
                encrypted_key="enc",
                label="reg",
                type="registration",
            )
        )
        await session.commit()


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
        # A service the deployment offers everyone (a server-side connector
        # agent) is owned by someone only in the bookkeeping sense.
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


class TestRegisterWithTokenPassesThrough:
    async def test_token_registration_uses_the_default_policy(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        await _seed_registration_key(session_factory, owner_id, "tok")
        captured: dict[str, object] = {}

        async def _register_agent(**kwargs: object) -> object:
            captured.update(kwargs)
            return SimpleNamespace(agent_id="a1", api_key="k", oauth_client_id=None)

        svc.register_agent = _register_agent  # type: ignore[assignment, method-assign]
        svc.api_key_store = SimpleNamespace(  # type: ignore[assignment]
            get_by_hash=_stub_key(owner_id)
        )

        await svc.register_agent_with_token(
            registration_token="tok",
            name="tokenised",
            description="d",
            connector_type="test",
            integration_profile=PROFILE,
        )
        assert captured["addressing_policy"] == default_agent_policy()

    async def test_token_registration_forwards_the_overrides(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        await _seed_registration_key(session_factory, owner_id, "tok")
        captured: dict[str, object] = {}

        async def _register_agent(**kwargs: object) -> object:
            captured.update(kwargs)
            return SimpleNamespace(agent_id="a1", api_key="k", oauth_client_id=None)

        svc.register_agent = _register_agent  # type: ignore[assignment, method-assign]
        svc.api_key_store = SimpleNamespace(  # type: ignore[assignment]
            get_by_hash=_stub_key(owner_id)
        )

        await svc.register_agent_with_token(
            registration_token="tok",
            name="tokenised",
            description="d",
            connector_type="test",
            integration_profile=PROFILE,
            addressing_policy=owner_only_policy(["dispatcher"]),
        )
        assert captured["addressing_policy"] == owner_only_policy(["dispatcher"])


def _stub_key(owner_id: str):  # type: ignore[no-untyped-def]
    async def _get_by_key(_session: AsyncSession, _token: str) -> object:
        # Carries a `tenant_id` because registration binds the token's tenant
        # for the write it delegates to — see `register_agent_with_token`.
        return SimpleNamespace(
            user_id=owner_id, type="registration", tenant_id=TENANT_ZERO_ID
        )

    return _get_by_key
