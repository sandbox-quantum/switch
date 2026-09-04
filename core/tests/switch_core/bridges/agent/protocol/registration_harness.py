"""A ProtocolService wired up far enough to run `register_agent`.

Registration touches a Matrix client lifecycle and the collaboration bridges;
tests about what registration *records* need neither, so the service is built
by hand with fakes in place of both.
"""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    TaskProtocolConfig,
)
from switch_core.db.models import Client, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore

PROFILE = IntegrationProfile(
    connection_model="session_passive",
    message_exchange=True,
    pre_invocation_mediation=[],
    post_invocation_mediation=[],
    event_reporting=[],
    task_protocol=TaskProtocolConfig(can_delegate=False, can_accept=False),
)


class FakeClientLifecycle:
    """Creates the Client row `_create_agent` attaches the Agent to, recording
    the display name it was asked for; the real lifecycle also starts a Matrix
    sync loop, which these tests do not need."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self.requested_display_names: list[str] = []
        self.started: list[str] = []

    async def create_client(self, *, client_type: str, display_name: str) -> Client:
        self.requested_display_names.append(display_name)
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
        self.started.append(client.id)


class NoBridges:
    def all_bridges(self) -> list[object]:
        return []


def make_service(
    session_factory: async_sessionmaker[AsyncSession],
) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.api_key_store = ApiKeyStore()  # type: ignore[attr-defined]
    svc.api_key_cache = ApiKeyCache(ttl_seconds=5.0, max_entries=8)  # type: ignore[attr-defined]
    svc.client_lifecycle = FakeClientLifecycle(session_factory)  # type: ignore[attr-defined]
    svc.collab_lifecycle = NoBridges()  # type: ignore[attr-defined]
    svc.config = SimpleNamespace(jwt_secret_key="test-secret")  # type: ignore[attr-defined]
    return svc


async def make_owner(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(name="owner", email="owner@test", role="user", password_hash="x")
        session.add(user)
        await session.commit()
        return user.id


async def register(
    svc: ProtocolService, name: str, owner_id: str, **kwargs: object
) -> str:
    result = await svc.register_agent(
        name=name,
        description=f"{name} desc",
        connector_type="test",
        integration_profile=PROFILE,
        owner_id=owner_id,
        **kwargs,  # type: ignore[arg-type]
    )
    return result.agent_id
