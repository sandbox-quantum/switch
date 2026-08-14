"""Tests for declarative multi-room engagement provisioning
(switch_core.engagements_yaml).

Exercised against a real PostgreSQL instance (per the project rule). Matrix /
bridge side effects are out of scope, so ``RoomService.create_room`` is replaced
by a DB-only fake that creates the room row and honours the fields the
engagement layer relies on (group_id, agents, roles) — enough for group
membership, link creation, preflight, and best-effort logic to be tested for
real. Links are created through the real ``ResourceService`` against real room
rows the fake writes.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    Room,
    RoomGroup,
    RoomLink,
    RoomRole,
    User,
    room_agents,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.engagements_yaml import EngagementYamlService
from switch_core.room_service import RoomCreateConfig, RoomCreateResult
from switch_core.rooms_yaml import RoomYamlService


class FakeRoomService:
    """DB-only stand-in for RoomService.create_room, honouring the fields the
    engagement layer depends on: fail-loud agent resolution, room-row creation
    (with group_id), and role attachment."""

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
                owner_id=config.owner_id,
                group_id=config.group_id,
                read_visibility=config.read_visibility,
                write_visibility=config.write_visibility,
            )
            session.add(room)
            await session.flush()
            for aid in agent_ids:
                await session.execute(
                    insert(room_agents).values(room_id=room.id, agent_id=aid)
                )
            for spec in config.roles or []:
                session.add(
                    RoomRole(
                        room_id=room.id,
                        name=spec.name,
                        instructions=spec.instructions,
                        exclusive=spec.exclusive,
                    )
                )
            await session.commit()
            return RoomCreateResult(room=room, failed_attachments=[])


async def _make_agent(session: AsyncSession, name: str, user_id: str) -> Agent:
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
        password="x",
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
    )
    session.add(agent)
    await session.flush()
    return agent


@pytest_asyncio.fixture
async def env(session_factory: async_sessionmaker[AsyncSession]):
    """Seed a user + a manager and worker agent, and wire up the service."""
    resource_service = ResourceService(
        reference_store=ReferenceStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )
    agent_store = AgentStore()
    room_group_store = RoomGroupStore()
    room_yaml = RoomYamlService(
        room_service=FakeRoomService(session_factory, agent_store),  # type: ignore[arg-type]
        resource_service=resource_service,
        room_store=RoomStore(),
        agent_store=agent_store,
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        room_role_store=RoomRoleStore(),
        session_factory=session_factory,
    )
    svc = EngagementYamlService(
        room_yaml=room_yaml,
        room_group_store=room_group_store,
        resource_service=resource_service,
        agent_store=agent_store,
        bridge_store=CollaborationBridgeStore(),
        session_factory=session_factory,
    )

    async with session_factory() as session:
        user = User(name="alice", email="alice@example.com", role="member")
        session.add(user)
        await session.flush()
        user_id = user.id
        await _make_agent(session, "claude-code.manager", user_id)
        await _make_agent(session, "claude-code.worker", user_id)
        await session.commit()

    return {
        "svc": svc,
        "resource_service": resource_service,
        "session_factory": session_factory,
        "user_id": user_id,
    }


def _svc(env) -> EngagementYamlService:
    return env["svc"]


# ── parse ──────────────────────────────────────────────────────────────────


def test_parse_minimal(env):
    spec = _svc(env).parse(
        """
        engagement:
          group:
            name: "Team"
          rooms:
            - key: hub
              name: "Hub"
              description: "d"
        """
    )
    assert spec.group.name == "Team"
    assert [r.key for r in spec.rooms] == ["hub"]
    assert spec.links == []


def test_parse_rejects_missing_engagement_key(env):
    with pytest.raises(ValueError, match="top-level 'engagement:'"):
        _svc(env).parse("group:\n  name: x\n")


def test_parse_rejects_malformed_yaml(env):
    with pytest.raises(ValueError, match="Invalid YAML"):
        _svc(env).parse("engagement: [unclosed\n")


def test_parse_rejects_no_rooms(env):
    with pytest.raises(ValueError, match="at least one room"):
        _svc(env).parse(
            """
            engagement:
              group: { name: "T" }
              rooms: []
            """
        )


def test_parse_rejects_duplicate_room_keys(env):
    with pytest.raises(ValueError, match="duplicate room keys: hub"):
        _svc(env).parse(
            """
            engagement:
              group: { name: "T" }
              rooms:
                - { key: hub, name: "A", description: "d" }
                - { key: hub, name: "B", description: "d" }
            """
        )


def test_parse_rejects_link_to_unknown_key(env):
    with pytest.raises(ValueError, match="unknown room key 'ghost'"):
        _svc(env).parse(
            """
            engagement:
              group: { name: "T" }
              rooms:
                - { key: hub, name: "A", description: "d" }
              links:
                - { from: hub, to: ghost, label: "x" }
            """
        )


def test_parse_rejects_self_link(env):
    with pytest.raises(ValueError, match="point a room at itself"):
        _svc(env).parse(
            """
            engagement:
              group: { name: "T" }
              rooms:
                - { key: hub, name: "A", description: "d" }
              links:
                - { from: hub, to: hub, label: "x" }
            """
        )


def test_parse_rejects_users_without_bridge(env):
    with pytest.raises(ValueError, match="attaches users but has no bridge"):
        _svc(env).parse(
            """
            engagement:
              group: { name: "T" }
              rooms:
                - key: hub
                  name: "A"
                  description: "d"
                  users: ["bob"]
            """
        )


# ── provision ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provision_creates_group_rooms_and_links(env):
    spec = _svc(env).parse(
        """
        engagement:
          group:
            name: "FlintAI Optimize and Prove"
            description: "engagement group"
          rooms:
            - key: workforce
              name: "Workforce Hub"
              description: "planning"
              agents: ["claude-code.manager"]
              roles:
                - { name: planner, instructions: "plan", exclusive: true }
            - key: feature
              name: "Feature Hub"
              description: "features"
              agents: ["claude-code.worker"]
          links:
            - { from: workforce, to: feature, label: "feature work" }
            - { from: feature, to: workforce, label: "parent hub" }
        """
    )
    result = await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)

    assert result.group_name == "FlintAI Optimize and Prove"
    assert len(result.rooms) == 2
    assert len(result.created_links) == 2
    assert result.failed_links == []

    sf = env["session_factory"]
    async with sf() as session:
        group = await session.get(RoomGroup, result.group_id)
        assert group is not None
        # Both rooms filed under the engagement group.
        room_ids = [r.room_id for r in result.rooms]
        for rid in room_ids:
            room = await session.get(Room, rid)
            assert room.group_id == result.group_id
        # Both directed links persisted.
        links = (await session.execute(select(RoomLink))).scalars().all()
        assert len(links) == 2


@pytest.mark.asyncio
async def test_provision_unknown_agent_fails_loud_before_group(env):
    spec = _svc(env).parse(
        """
        engagement:
          group: { name: "Should Not Exist" }
          rooms:
            - key: hub
              name: "Hub"
              description: "d"
              agents: ["claude-code.ghost"]
        """
    )
    with pytest.raises(ValueError, match="Unknown agents: claude-code.ghost"):
        await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)

    # Preflight ran before the group was created — no orphan group left behind.
    async with env["session_factory"]() as session:
        groups = (await session.execute(select(RoomGroup))).scalars().all()
        assert all(g.name != "Should Not Exist" for g in groups)


@pytest.mark.asyncio
async def test_provision_unknown_bridge_fails_loud(env):
    spec = _svc(env).parse(
        """
        engagement:
          group: { name: "T" }
          rooms:
            - key: hub
              name: "Hub"
              description: "d"
              bridge: "No Such Bridge"
        """
    )
    with pytest.raises(ValueError, match="Unknown bridge: 'No Such Bridge'"):
        await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)


@pytest.mark.asyncio
async def test_provision_duplicate_link_is_best_effort(env):
    spec = _svc(env).parse(
        """
        engagement:
          group: { name: "Dup Links" }
          rooms:
            - { key: a, name: "A", description: "d" }
            - { key: b, name: "B", description: "d" }
          links:
            - { from: a, to: b, label: "first" }
            - { from: a, to: b, label: "again" }
        """
    )
    result = await _svc(env).provision(spec, user_id=env["user_id"], is_admin=False)
    # First link created; the duplicate is reported, not raised, and does not
    # roll back the successful one.
    assert len(result.created_links) == 1
    assert len(result.failed_links) == 1
    assert result.failed_links[0]["from"] == "a"
    assert result.failed_links[0]["to"] == "b"

    async with env["session_factory"]() as session:
        links = (await session.execute(select(RoomLink))).scalars().all()
        assert len(links) == 1
        assert links[0].label == "first"
