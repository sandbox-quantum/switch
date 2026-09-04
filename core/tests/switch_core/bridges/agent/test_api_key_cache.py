"""The bearer-token memo in front of the auth query (CHOO pool exhaustion).

Resolving a token is the highest-frequency database read in the server, so it
is memoised — but it is still authentication, and the properties that keep it
honest are the ones worth pinning: a failure is never remembered, an entry dies
on rotation rather than on expiry, and the memo cannot grow without bound.
"""

from __future__ import annotations

import hashlib
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.bridges.agent.protocol.connections import HEARTBEAT_TTL_SECONDS
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    TaskProtocolConfig,
)
from switch_core.config import SwitchConfig
from switch_core.db.models import Agent, ApiKey, Client, User
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


class _CountingSessionFactory:
    """Wraps the real factory and counts how many sessions are opened.

    A session is a pool checkout, so this is the number the incident is about.
    """

    def __init__(self, inner: async_sessionmaker[AsyncSession]) -> None:
        self._inner = inner
        self.opened = 0

    def __call__(self) -> Any:
        self.opened += 1
        return self._inner()


class _FakeClientLifecycle:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self.started: list[str] = []

    async def create_client(self, *, client_type: str, display_name: str) -> Client:
        async with self._session_factory() as session:
            client = Client(
                matrix_user_id=f"@{display_name}:test",
                display_name=display_name,
                type=client_type,
                password="x",
            )
            session.add(client)
            await session.commit()
            return client

    def start_client(self, client: Client) -> None:
        self.started.append(client.id)

    async def stop(self, client_id: str) -> None:
        return None

    async def remove(self, client_id: str) -> None:
        return None


class _NoBridges:
    def all_bridges(self) -> list[object]:
        return []


def _middleware(session_factory: Any, cache: ApiKeyCache) -> BearerAuthMiddleware:
    async def _app(scope: Any, receive: Any, send: Any) -> None:
        return None

    return BearerAuthMiddleware(
        _app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=cache,
        session_factory=session_factory,
    )


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _seed_agent(
    session_factory: async_sessionmaker[AsyncSession],
    token: str,
    *,
    name: str = "bot",
    key_type: str = "agent",
    with_agent: bool = True,
) -> str:
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
        session.add(user)
        await session.flush()
        key = ApiKey(
            user_id=user.id,
            key_hash=_hash(token),
            encrypted_key="enc",
            label=name,
            type=key_type,
        )
        session.add(key)
        await session.flush()
        agent_id = ""
        if with_agent:
            client = Client(
                matrix_user_id=f"@{name}:test",
                display_name=name,
                type="agent",
                password="x",
            )
            session.add(client)
            await session.flush()
            agent = Agent(
                name=name,
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=user.id,
            )
            session.add(agent)
            await session.flush()
            agent_id = agent.id
        await session.commit()
        return agent_id


class TestCacheUnit:
    def test_a_ttl_at_or_above_the_heartbeat_ttl_is_refused(self) -> None:
        # Past the heartbeat TTL a revoked credential could still authenticate
        # a connection the server has already declared dead.
        with pytest.raises(ValueError, match="heartbeat TTL"):
            ApiKeyCache(ttl_seconds=HEARTBEAT_TTL_SECONDS, max_entries=8)

    def test_a_negative_ttl_is_refused(self) -> None:
        with pytest.raises(ValueError, match="must not be negative"):
            ApiKeyCache(ttl_seconds=-1, max_entries=8)

    def test_zero_entries_is_refused(self) -> None:
        with pytest.raises(ValueError, match="at least 1"):
            ApiKeyCache(ttl_seconds=1, max_entries=0)

    def test_ttl_zero_stores_nothing(self) -> None:
        cache = ApiKeyCache(ttl_seconds=0, max_entries=8)
        cache.put("h", SimpleNamespace(), SimpleNamespace())  # type: ignore[arg-type]

        assert cache.enabled is False
        assert cache.get("h") is None

    def test_the_oldest_entry_is_evicted_past_the_bound(self) -> None:
        cache = ApiKeyCache(ttl_seconds=5, max_entries=2)
        for i in range(3):
            cache.put(f"h{i}", SimpleNamespace(), SimpleNamespace(id=f"a{i}"))  # type: ignore[arg-type]

        assert cache.get("h0") is None
        assert cache.get("h1") is not None
        assert cache.get("h2") is not None

    def test_an_entry_expires(self, monkeypatch: pytest.MonkeyPatch) -> None:
        now = [1000.0]
        monkeypatch.setattr(
            "switch_core.bridges.agent.api_key_cache.time.monotonic", lambda: now[0]
        )
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        cache.put("h", SimpleNamespace(), SimpleNamespace(id="a"))  # type: ignore[arg-type]

        now[0] = 1004.9
        assert cache.get("h") is not None
        now[0] = 1005.0
        assert cache.get("h") is None

    def test_invalidate_agent_drops_every_token_for_that_agent(self) -> None:
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        cache.put("old", SimpleNamespace(), SimpleNamespace(id="a1"))  # type: ignore[arg-type]
        cache.put("new", SimpleNamespace(), SimpleNamespace(id="a1"))  # type: ignore[arg-type]
        cache.put("other", SimpleNamespace(), SimpleNamespace(id="a2"))  # type: ignore[arg-type]

        cache.invalidate_agent("a1")

        assert cache.get("old") is None
        assert cache.get("new") is None
        assert cache.get("other") is not None


class TestResolutionHitsAndMisses:
    async def test_a_hit_does_not_touch_the_database(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_agent(session_factory, "tok")
        counting = _CountingSessionFactory(session_factory)
        counting.opened = 0
        mw = _middleware(counting, ApiKeyCache(ttl_seconds=5, max_entries=8))

        first_key, first_agent = await mw._resolve_api_key("tok")
        after_miss = counting.opened
        second_key, second_agent = await mw._resolve_api_key("tok")

        assert first_agent is not None
        assert after_miss == 1
        assert counting.opened == 1, "the second resolution must be answered in memory"
        assert second_agent is not None
        assert second_agent.id == first_agent.id
        assert second_key is not None and first_key is not None
        assert second_key.id == first_key.id

    async def test_one_checkout_resolves_key_and_agent_together(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_agent(session_factory, "tok")
        counting = _CountingSessionFactory(session_factory)
        counting.opened = 0
        mw = _middleware(counting, ApiKeyCache(ttl_seconds=0, max_entries=8))

        await mw._resolve_api_key("tok")

        assert counting.opened == 1

    async def test_an_unknown_token_is_never_cached(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A token that does not resolve must reach Postgres every time, or a
        # key that starts existing would keep failing — and, far worse, the
        # memo would become a place to park an attacker-chosen string.
        counting = _CountingSessionFactory(session_factory)
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        mw = _middleware(counting, cache)

        assert await mw._resolve_api_key("nope") == (None, None)
        assert await mw._resolve_api_key("nope") == (None, None)

        assert counting.opened == 2
        assert cache.get(_hash("nope")) is None

    async def test_a_registration_token_is_not_cached(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_agent(
            session_factory,
            "reg",
            name="regkey",
            key_type="registration",
            with_agent=False,
        )
        counting = _CountingSessionFactory(session_factory)
        counting.opened = 0
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        mw = _middleware(counting, cache)

        key, agent = await mw._resolve_api_key("reg")
        await mw._resolve_api_key("reg")

        assert key is not None and key.type == "registration"
        assert agent is None
        assert counting.opened == 2
        assert cache.get(_hash("reg")) is None

    async def test_an_agent_key_with_no_agent_is_not_cached(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_agent(session_factory, "orphan", name="orphan", with_agent=False)
        counting = _CountingSessionFactory(session_factory)
        counting.opened = 0
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        mw = _middleware(counting, cache)

        key, agent = await mw._resolve_api_key("orphan")
        await mw._resolve_api_key("orphan")

        assert key is not None
        assert agent is None
        assert counting.opened == 2
        assert cache.get(_hash("orphan")) is None

    async def test_a_disabled_cache_reads_every_time(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_agent(session_factory, "tok")
        counting = _CountingSessionFactory(session_factory)
        counting.opened = 0
        mw = _middleware(counting, ApiKeyCache(ttl_seconds=0, max_entries=8))

        await mw._resolve_api_key("tok")
        await mw._resolve_api_key("tok")

        assert counting.opened == 2

    async def test_an_expired_entry_reads_again(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        await _seed_agent(session_factory, "tok")
        now = [1000.0]
        monkeypatch.setattr(
            "switch_core.bridges.agent.api_key_cache.time.monotonic", lambda: now[0]
        )
        counting = _CountingSessionFactory(session_factory)
        counting.opened = 0
        mw = _middleware(counting, ApiKeyCache(ttl_seconds=5, max_entries=8))

        await mw._resolve_api_key("tok")
        now[0] = 1006.0
        await mw._resolve_api_key("tok")

        assert counting.opened == 2


class TestInvalidation:
    async def test_deleting_an_agent_drops_its_cached_token(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        agent_id = await _seed_agent(session_factory, "tok")
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        mw = _middleware(session_factory, cache)
        await mw._resolve_api_key("tok")
        assert cache.get(_hash("tok")) is not None

        svc = _protocol_service(session_factory, cache)
        await svc.delete_agent(agent_id=agent_id)

        assert cache.get(_hash("tok")) is None
        # Deleting the agent leaves its api_keys row behind, so the token still
        # names a key — but it no longer names an agent, which is what the
        # middleware turns into a 401.
        _, agent = await mw._resolve_api_key("tok")
        assert agent is None
        assert cache.get(_hash("tok")) is None

    async def test_rotating_a_key_drops_the_cached_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Re-registration issues a new key and deletes the old row. Without
        # invalidation the retired credential keeps authenticating for the
        # whole TTL, which is the failure mode this cache must not introduce.
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        svc = _protocol_service(session_factory, cache)
        async with session_factory() as session:
            owner = User(name="o", email="o@test", role="user", password_hash="x")
            session.add(owner)
            await session.commit()
            owner_id = owner.id

        first = await svc.register_agent(
            name="bot",
            description="d",
            connector_type="claude_code",
            integration_profile=_PROFILE,
            owner_id=owner_id,
        )
        mw = _middleware(session_factory, cache)
        _, agent = await mw._resolve_api_key(first.api_key)
        assert agent is not None
        assert cache.get(_hash(first.api_key)) is not None

        second = await svc.register_agent(
            name="bot",
            description="d",
            connector_type="claude_code",
            integration_profile=_PROFILE,
            owner_id=owner_id,
            overwrite=True,
        )

        assert cache.get(_hash(first.api_key)) is None
        assert await mw._resolve_api_key(first.api_key) == (None, None)
        _, rotated = await mw._resolve_api_key(second.api_key)
        assert rotated is not None


def _protocol_service(
    session_factory: async_sessionmaker[AsyncSession], cache: ApiKeyCache
) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.api_key_store = ApiKeyStore()  # type: ignore[attr-defined]
    svc.api_key_cache = cache  # type: ignore[attr-defined]
    svc.client_lifecycle = _FakeClientLifecycle(session_factory)  # type: ignore[attr-defined]
    svc.collab_lifecycle = _NoBridges()  # type: ignore[attr-defined]
    svc.event_buffer = SimpleNamespace(remove=lambda _agent_id: None)  # type: ignore[attr-defined]
    svc.config = SimpleNamespace(jwt_secret_key="test-secret")  # type: ignore[attr-defined]
    return svc


_CONFIG_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_password="pw",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    jwt_secret_key="jwt",
    gateway_admin_email="admin@example.com",
    gateway_admin_password="pw",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_CONFIG_KWARGS, **overrides})  # type: ignore[arg-type]


class TestAuthCacheConfig:
    def test_the_default_ttl_is_under_the_heartbeat_ttl(self) -> None:
        assert _config().agent_auth_cache_ttl_seconds < HEARTBEAT_TTL_SECONDS

    def test_zero_is_allowed_and_disables_the_cache(self) -> None:
        assert _config(agent_auth_cache_ttl_seconds=0).agent_auth_cache_ttl_seconds == 0

    def test_a_negative_ttl_fails_at_startup(self) -> None:
        with pytest.raises(ValueError, match="AGENT_AUTH_CACHE_TTL_SECONDS"):
            _config(agent_auth_cache_ttl_seconds=-1)

    def test_an_unbounded_cache_fails_at_startup(self) -> None:
        with pytest.raises(ValueError, match="AGENT_AUTH_CACHE_MAX_ENTRIES"):
            _config(agent_auth_cache_max_entries=0)
