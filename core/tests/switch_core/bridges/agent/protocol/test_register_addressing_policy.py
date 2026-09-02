"""Registration sets the new agent's default addressing policy (CHOO-2137)."""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import parse_policy
from switch_core.bridges.agent.protocol.service import ProtocolService
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    PROFILE,
    make_owner,
    make_service,
    register,
)


async def _policy_of(
    svc: ProtocolService,
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
) -> dict | None:
    async with session_factory() as session:
        agent = await svc.agent_store.get(session, agent_id)
    assert agent is not None
    return agent.addressing_policy


class TestRegistrationDefaultPolicy:
    async def test_new_agent_is_owner_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(svc, "fresh", owner_id)

        raw = await _policy_of(svc, session_factory, agent_id)
        policy = parse_policy(raw)
        assert policy.is_open() is False
        assert policy.requires_owner_identity() is True
        # The owner gets in from anywhere; nobody else does.
        assert (
            policy.allows(
                room_id="any-room",
                group_id=None,
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=[owner_id],
                sender_owner_user_id=None,
                owner_user_id=owner_id,
            )
            is True
        )
        assert (
            policy.allows(
                room_id="any-room",
                group_id=None,
                sender_kind="agent",
                sender_id="other-agent",
                sender_user_ids=[],
                sender_owner_user_id=None,
                owner_user_id=owner_id,
            )
            is False
        )

    async def test_addressable_by_agent_ids_are_admitted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(
            svc, "dispatched", owner_id, addressable_by_agent_ids=["dispatcher"]
        )

        policy = parse_policy(await _policy_of(svc, session_factory, agent_id))
        assert (
            policy.allows(
                room_id="any-room",
                group_id=None,
                sender_kind="agent",
                sender_id="dispatcher",
                sender_user_ids=[],
                sender_owner_user_id=None,
                owner_user_id=owner_id,
            )
            is True
        )
        assert (
            policy.allows(
                room_id="any-room",
                group_id=None,
                sender_kind="agent",
                sender_id="stranger",
                sender_user_ids=[],
                sender_owner_user_id=None,
                owner_user_id=owner_id,
            )
            is False
        )

    async def test_owner_only_false_leaves_the_agent_open(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A service the deployment offers everyone (a server-side connector
        # agent) is owned by someone only in the bookkeeping sense.
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(svc, "shared", owner_id, owner_only=False)

        raw = await _policy_of(svc, session_factory, agent_id)
        assert raw is None
        assert parse_policy(raw).is_open() is True

    async def test_reregistration_leaves_the_policy_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
        agent_id = await register(svc, "kept", owner_id, owner_only=False)

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
    async def test_token_registration_defaults_to_owner_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
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
        assert captured["owner_only"] is True
        assert captured["addressable_by_agent_ids"] is None

    async def test_token_registration_forwards_the_overrides(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        owner_id = await make_owner(session_factory)
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
            owner_only=False,
            addressable_by_agent_ids=["dispatcher"],
        )
        assert captured["owner_only"] is False
        assert captured["addressable_by_agent_ids"] == ["dispatcher"]


def _stub_key(owner_id: str):  # type: ignore[no-untyped-def]
    async def _get_by_key(_session: AsyncSession, _token: str) -> object:
        return SimpleNamespace(user_id=owner_id, type="registration")

    return _get_by_key
