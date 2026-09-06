"""Re-registration is confined to the owner's own tenant (CHOO security fix).

Agent names are a global namespace, so before this guard any user could mint a
registration token and re-register another user's agent by name with
``overwrite=True``: they received a live agent API key for the victim's agent
(whose ``owner_id`` was left unchanged), and the victim's key was deleted. These
tests pin the fix: a cross-owner overwrite is refused, while a same-owner
re-register (the connector-restart path) still works.
"""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import (
    AgentExistsError,
    ProtocolService,
)
from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    TaskProtocolConfig,
)
from switch_core.db.models import Client, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore

_PROFILE = IntegrationProfile(
    connection_model="session_passive",
    message_exchange=True,
    pre_invocation_mediation=[],
    post_invocation_mediation=[],
    event_reporting=[],
    task_protocol=TaskProtocolConfig(can_delegate=False, can_accept=False),
)


class _FakeClientLifecycle:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create_client(self, *, client_type: str, display_name: str) -> Client:
        async with self._session_factory() as session:
            client = Client(
                matrix_user_id=f"@{display_name}:test",
                display_name=display_name,
                type=client_type,
            )
            session.add(client)
            await session.commit()
            return client

    def start_client(self, client: Client) -> None:
        pass


class _NoBridges:
    def all_bridges(self) -> list[object]:
        return []


def _service(session_factory: async_sessionmaker[AsyncSession]) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.api_key_store = ApiKeyStore()  # type: ignore[attr-defined]
    svc.client_lifecycle = _FakeClientLifecycle(session_factory)  # type: ignore[attr-defined]
    svc.collab_lifecycle = _NoBridges()  # type: ignore[attr-defined]
    svc.config = SimpleNamespace(jwt_secret_key="test-secret")  # type: ignore[attr-defined]
    # Duck-typed: the attribute exists on ProtocolService after the api-key
    # cache landed on main; a no-op stand-in keeps this test valid on both
    # sides of that merge.
    svc.api_key_cache = SimpleNamespace(invalidate_agent=lambda *a, **k: None)  # type: ignore[attr-defined]
    return svc


async def _make_user(
    session_factory: async_sessionmaker[AsyncSession], name: str, email: str
) -> str:
    async with session_factory() as session:
        user = User(name=name, email=email, role="user", password_hash="x")
        session.add(user)
        await session.commit()
        return user.id


async def _register(svc: ProtocolService, name: str, owner_id: str, **kw: object):
    return await svc.register_agent(
        name=name,
        description=f"{name} desc",
        connector_type="test",
        integration_profile=_PROFILE,
        owner_id=owner_id,
        **kw,  # type: ignore[arg-type]
    )


class TestReregistrationOwnerGuard:
    async def test_cross_owner_overwrite_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        victim = await _make_user(session_factory, "victim", "victim@test")
        attacker = await _make_user(session_factory, "attacker", "attacker@test")

        victim_result = await _register(svc, "acme-bot", victim)
        victim_key_hash = hashlib.sha256(victim_result.api_key.encode()).hexdigest()

        with pytest.raises(AgentExistsError):
            await _register(svc, "acme-bot", attacker, overwrite=True)

        async with session_factory() as session:
            agent = await svc.agent_store.get(session, victim_result.agent_id)
            assert agent is not None
            assert agent.owner_id == victim
            # The victim's original key is still live and still owned by them.
            live_key = await svc.api_key_store.get(session, agent.api_key_id)
            assert live_key is not None
            assert live_key.user_id == victim
            assert live_key.key_hash == victim_key_hash

    async def test_same_owner_overwrite_still_works(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        owner = await _make_user(session_factory, "owner", "owner@test")

        first = await _register(svc, "acme-bot", owner)
        again = await _register(svc, "acme-bot", owner, overwrite=True)

        # Same agent row, rotated key, still owned by the same user.
        assert again.agent_id == first.agent_id
        assert again.api_key != first.api_key
        async with session_factory() as session:
            agent = await svc.agent_store.get(session, first.agent_id)
            assert agent is not None
            assert agent.owner_id == owner
            live_key = await svc.api_key_store.get(session, agent.api_key_id)
            assert live_key is not None
            assert live_key.user_id == owner
            assert (
                live_key.key_hash == hashlib.sha256(again.api_key.encode()).hexdigest()
            )
            # The old key was rotated out.
            stale = await svc.api_key_store.get_by_hash(
                session, hashlib.sha256(first.api_key.encode()).hexdigest()
            )
            assert stale is None
