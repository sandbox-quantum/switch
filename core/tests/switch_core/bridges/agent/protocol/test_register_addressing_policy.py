"""Registration sets the new agent's default addressing policy (CHOO-2137)."""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import parse_policy
from switch_core.bridges.agent.protocol.service import ProtocolService
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
    """Creates the Client row `_create_agent` attaches the Agent to; the real
    lifecycle also starts a Matrix sync loop, which a policy test does not need."""

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
    return svc


async def _make_owner(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(name="owner", email="owner@test", role="user", password_hash="x")
        session.add(user)
        await session.commit()
        return user.id


async def _register(
    svc: ProtocolService, name: str, owner_id: str, **kwargs: object
) -> str:
    result = await svc.register_agent(
        name=name,
        description=f"{name} desc",
        connector_type="test",
        integration_profile=_PROFILE,
        owner_id=owner_id,
        **kwargs,  # type: ignore[arg-type]
    )
    return result.agent_id


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
        svc = _service(session_factory)
        owner_id = await _make_owner(session_factory)
        agent_id = await _register(svc, "fresh", owner_id)

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
        svc = _service(session_factory)
        owner_id = await _make_owner(session_factory)
        agent_id = await _register(
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
        svc = _service(session_factory)
        owner_id = await _make_owner(session_factory)
        agent_id = await _register(svc, "shared", owner_id, owner_only=False)

        raw = await _policy_of(svc, session_factory, agent_id)
        assert raw is None
        assert parse_policy(raw).is_open() is True

    async def test_reregistration_leaves_the_policy_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        owner_id = await _make_owner(session_factory)
        agent_id = await _register(svc, "kept", owner_id, owner_only=False)

        async with session_factory() as session:
            await svc.agent_store.update(
                session,
                agent_id,
                addressing_policy={"rules": [{"users": ["ext-3"], "agents": []}]},
            )
            await session.commit()

        again = await _register(svc, "kept", owner_id, overwrite=True)
        assert again == agent_id
        raw = await _policy_of(svc, session_factory, agent_id)
        assert raw == {"rules": [{"users": ["ext-3"], "agents": []}]}


class TestRegisterWithTokenPassesThrough:
    async def test_token_registration_defaults_to_owner_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        owner_id = await _make_owner(session_factory)
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
            integration_profile=_PROFILE,
        )
        assert captured["owner_only"] is True
        assert captured["addressable_by_agent_ids"] is None

    async def test_token_registration_forwards_the_overrides(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        owner_id = await _make_owner(session_factory)
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
            integration_profile=_PROFILE,
            owner_only=False,
            addressable_by_agent_ids=["dispatcher"],
        )
        assert captured["owner_only"] is False
        assert captured["addressable_by_agent_ids"] == ["dispatcher"]


def _stub_key(owner_id: str):  # type: ignore[no-untyped-def]
    async def _get_by_key(_session: AsyncSession, _token: str) -> object:
        return SimpleNamespace(user_id=owner_id, type="registration")

    return _get_by_key
