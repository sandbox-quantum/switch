"""The agent operations that create rooms and use templates, over a fake
protocol: real PostgreSQL and the real template engine and run guards, no
Matrix. Shared by the create_room_from_yaml and template tool tests.
"""

from __future__ import annotations

import uuid
from functools import partial
from types import SimpleNamespace
from typing import Any

import pytest_asyncio
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.admin_client import AdminClient
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    Room,
    User,
    room_agents,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.room_service import RoomCreateConfig, RoomCreateResult
from switch_core.rooms_yaml import RoomYamlService


class FakeRoomService:
    """DB-only stand-in, the same as test_rooms_yaml.py's."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        agent_store: AgentStore,
    ) -> None:
        self._sf = session_factory
        self._agents = agent_store

    async def create_room(self, config: RoomCreateConfig) -> RoomCreateResult:
        async with self._sf() as session:
            agent_ids: list[str] = []
            if config.agent_names:
                agents = await self._agents.get_by_names(session, config.agent_names)
                name_to_id = {a.name: a.id for a in agents}
                missing = [n for n in config.agent_names if n not in name_to_id]
                if missing:
                    raise ValueError(f"Unknown agents: {', '.join(missing)}")
                agent_ids = [name_to_id[n] for n in config.agent_names]

            room = Room(
                matrix_room_id=f"!{uuid.uuid4().hex}:test.local",
                name=config.name,
                description=config.description,
                channel_type=config.channel_type or "channel_public",
                bridge_id=config.bridge_id,
                instructions=config.instructions,
                created_by=config.created_by,
                created_by_agent_id=config.created_by_agent_id,
                parent_room_id=config.parent_room_id,
                run_id=config.run_id,
                kickoff_hash=config.kickoff_hash,
                template_name=config.template_name,
                owner_id=config.owner_id,
                read_visibility=config.read_visibility,
                write_visibility=config.write_visibility,
                group_id=config.group_id,
            )
            session.add(room)
            await session.flush()
            for aid in agent_ids:
                await session.execute(
                    insert(room_agents).values(room_id=room.id, agent_id=aid)
                )
            await session.commit()
            return RoomCreateResult(room=room, failed_attachments=[])


async def _make_agent(
    session: AsyncSession, name: str, user_id: str, owner_id: str | None
) -> Agent:
    api_key = ApiKey(
        user_id=user_id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{name}:test.local",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner_id,
    )
    session.add(agent)
    await session.flush()
    return agent


class RecordingAdminClient(AdminClient):
    """Records the platform messages a kickoff sends; has no transport."""

    def __init__(self) -> None:  # noqa: D107 - test double, no super().__init__
        self.sent: list[dict[str, Any]] = []
        self.notices: list[dict[str, Any]] = []

    async def wait_joined(self, room_id: str, timeout: float) -> bool:
        return True

    async def send_platform_message(  # type: ignore[override]
        self,
        room_id: str,
        body: str,
        *,
        thread_root_id=None,
        on_behalf_of=None,
        reply_in_channel=False,
    ) -> str | None:
        self.sent.append({"body": body, "on_behalf_of": on_behalf_of})
        return "$kickoff"

    async def send_notice(self, room_id: str, body: str) -> None:
        self.notices.append({"room": room_id, "body": body})


class FakeLifecycle:
    def __init__(self, admin: AdminClient) -> None:
        self.admin = admin

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return [self.admin] if client_type == "admin" else []

    def get_by_agent_id(self, agent_id: str) -> None:
        return None


@pytest_asyncio.fixture
async def env(session_factory: async_sessionmaker[AsyncSession]):
    """Seed a user and two agents, and wire a fake protocol for the operation."""
    agent_store = AgentStore()
    resource_service = ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )
    admin = RecordingAdminClient()
    fake_protocol = SimpleNamespace(
        client_lifecycle=FakeLifecycle(admin),
        session_factory=session_factory,
        agent_store=agent_store,
        user_store=UserStore(),
        room_service=FakeRoomService(session_factory, agent_store),
        resource_service=resource_service,
        room_store=RoomStore(),
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        room_group_store=RoomGroupStore(),
        room_role_store=RoomRoleStore(),
        connections={},
    )
    # Runs are the real service's; only its collaborators are fakes.
    fake_protocol.run_service = partial(ProtocolService.run_service, fake_protocol)
    # The same wiring `ProtocolService.room_yaml_service` does, over the fakes.
    fake_protocol.room_yaml_service = lambda: RoomYamlService(
        room_service=fake_protocol.room_service,
        resource_service=fake_protocol.resource_service,
        room_store=fake_protocol.room_store,
        agent_store=fake_protocol.agent_store,
        bridge_store=fake_protocol.bridge_store,
        external_user_store=fake_protocol.external_user_store,
        room_role_store=fake_protocol.room_role_store,
        session_factory=fake_protocol.session_factory,
        room_group_store=fake_protocol.room_group_store,
        client_lifecycle=fake_protocol.client_lifecycle,
    )

    async with session_factory() as session:
        user = User(name="alice", email="alice@example.com", role="member")
        session.add(user)
        await session.flush()
        user_id = user.id
        agent = await _make_agent(session, "claude-code.alice", user_id, user_id)
        await _make_agent(session, "claude-code.bob", user_id, user_id)
        orphan = await _make_agent(session, "orphan", user_id, None)
        await session.commit()
        agent_id = agent.id
        orphan_id = orphan.id

    old_protocol = op_context._protocol
    op_context.init_operations_protocol(fake_protocol)  # type: ignore[arg-type]
    try:
        yield {
            "agent_id": agent_id,
            "orphan_id": orphan_id,
            "user_id": user_id,
            "session_factory": session_factory,
            "admin": admin,
            "protocol": fake_protocol,
        }
    finally:
        op_context._protocol = old_protocol
