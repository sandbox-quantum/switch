"""Two-tenant behaviour for the multi-tenancy Phase 1 schema (CHOO-2623).

Every fixture in the rest of the suite runs against a single tenant (tenant
zero), so none of it can tell a composite foreign key from a single-column
one, or a per-tenant unique constraint from a global one — the two schemas
behave identically until a second tenant exists. These tests are the ones
that actually create one.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    Document,
    ReferenceType,
    Room,
    RoomGroup,
    Tenant,
    User,
)

TENANT_A = "tenant-a"
TENANT_B = "tenant-b"


async def _make_tenant(session: AsyncSession, tenant_id: str) -> Tenant:
    tenant = Tenant(id=tenant_id, slug=tenant_id, name=tenant_id)
    session.add(tenant)
    await session.flush()
    return tenant


async def _make_user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    return user


async def _make_client(
    session: AsyncSession, tenant_id: str, matrix_user_id: str
) -> Client:
    client = Client(
        tenant_id=tenant_id,
        matrix_user_id=matrix_user_id,
        display_name=matrix_user_id,
        type="agent",
    )
    session.add(client)
    await session.flush()
    return client


async def _make_api_key(
    session: AsyncSession, tenant_id: str, user_id: str, label: str
) -> ApiKey:
    api_key = ApiKey(
        tenant_id=tenant_id,
        user_id=user_id,
        key_hash=f"hash-{tenant_id}-{label}",
        encrypted_key="enc",
        label=label,
        type="agent",
    )
    session.add(api_key)
    await session.flush()
    return api_key


async def _make_agent(
    session: AsyncSession,
    tenant_id: str,
    name: str,
    owner_id: str,
    *,
    parent_agent_id: str | None = None,
) -> Agent:
    client = await _make_client(session, tenant_id, f"@{tenant_id}-{name}:test")
    api_key = await _make_api_key(session, tenant_id, owner_id, name)
    agent = Agent(
        tenant_id=tenant_id,
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner_id,
        parent_agent_id=parent_agent_id,
    )
    session.add(agent)
    await session.flush()
    return agent


class TestCrossTenantForeignKeyRejected:
    async def test_child_row_disagreeing_with_parent_tenant_is_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An agent in tenant B naming a client that actually belongs to
        tenant A must fail at the database, via `fk_agents_client` — the
        composite key is the thing that makes this unrepresentable, not
        application code that happens to always pass matching ids."""
        async with session_factory() as session:
            tenant_a = await _make_tenant(session, TENANT_A)
            tenant_b = await _make_tenant(session, TENANT_B)
            owner = await _make_user(session, "cross-tenant-owner")
            client_in_a = await _make_client(session, tenant_a.id, "@mismatch:test")
            api_key_in_b = await _make_api_key(
                session, tenant_b.id, owner.id, "mismatched"
            )
            await session.commit()

            mismatched_agent = Agent(
                tenant_id=tenant_b.id,
                name="mismatched",
                description="disagrees with its own client's tenant",
                agent_type="always_on",
                connector_type="claude_code",
                integration_profile={"connection_model": "always_on"},
                client_id=client_in_a.id,
                api_key_id=api_key_in_b.id,
                owner_id=owner.id,
            )
            session.add(mismatched_agent)
            with pytest.raises(IntegrityError):
                await session.flush()


class TestPerTenantUniqueness:
    async def test_same_agent_name_in_two_tenants(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            tenant_a = await _make_tenant(session, TENANT_A)
            tenant_b = await _make_tenant(session, TENANT_B)
            owner = await _make_user(session, "reviewer-owner")

            agent_a = await _make_agent(session, tenant_a.id, "reviewer", owner.id)
            agent_b = await _make_agent(session, tenant_b.id, "reviewer", owner.id)
            await session.commit()

            assert agent_a.id != agent_b.id
            assert agent_a.name == agent_b.name == "reviewer"

    async def test_same_matrix_user_id_in_two_tenants(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            tenant_a = await _make_tenant(session, TENANT_A)
            tenant_b = await _make_tenant(session, TENANT_B)

            client_a = await _make_client(session, tenant_a.id, "@shared:test")
            client_b = await _make_client(session, tenant_b.id, "@shared:test")
            await session.commit()

            assert client_a.id != client_b.id
            assert client_a.matrix_user_id == client_b.matrix_user_id == "@shared:test"

    async def test_same_matrix_room_id_in_two_tenants(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            tenant_a = await _make_tenant(session, TENANT_A)
            tenant_b = await _make_tenant(session, TENANT_B)

            room_a = Room(
                tenant_id=tenant_a.id,
                matrix_room_id="!shared:test",
                name="room",
                description="room desc",
            )
            room_b = Room(
                tenant_id=tenant_b.id,
                matrix_room_id="!shared:test",
                name="room",
                description="room desc",
            )
            session.add_all([room_a, room_b])
            await session.commit()

            assert room_a.id != room_b.id
            assert room_a.matrix_room_id == room_b.matrix_room_id == "!shared:test"

    async def test_each_tenant_can_have_its_own_default_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            tenant_a = await _make_tenant(session, TENANT_A)
            tenant_b = await _make_tenant(session, TENANT_B)
            client_a = await _make_client(session, tenant_a.id, "@bridge-a:test")
            client_b = await _make_client(session, tenant_b.id, "@bridge-b:test")

            bridge_a = CollaborationBridge(
                tenant_id=tenant_a.id,
                type="slack",
                display_name="Bridge A",
                client_id=client_a.id,
                status="active",
                is_default=True,
            )
            bridge_b = CollaborationBridge(
                tenant_id=tenant_b.id,
                type="slack",
                display_name="Bridge B",
                client_id=client_b.id,
                status="active",
                is_default=True,
            )
            session.add_all([bridge_a, bridge_b])
            await session.commit()

            assert bridge_a.is_default is True
            assert bridge_b.is_default is True

    async def test_second_default_bridge_in_same_tenant_still_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The partial unique index is per-tenant now, not gone: two defaults
        in the *same* tenant must still collide."""
        async with session_factory() as session:
            tenant_a = await _make_tenant(session, TENANT_A)
            client_1 = await _make_client(session, tenant_a.id, "@bridge-1:test")
            client_2 = await _make_client(session, tenant_a.id, "@bridge-2:test")

            first = CollaborationBridge(
                tenant_id=tenant_a.id,
                type="slack",
                display_name="First",
                client_id=client_1.id,
                status="active",
                is_default=True,
            )
            session.add(first)
            await session.commit()

            second = CollaborationBridge(
                tenant_id=tenant_a.id,
                type="slack",
                display_name="Second",
                client_id=client_2.id,
                status="active",
                is_default=True,
            )
            session.add(second)
            with pytest.raises(IntegrityError):
                await session.flush()

    async def test_reference_types_accepts_same_slug_in_two_tenants(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            tenant_a = await _make_tenant(session, TENANT_A)
            tenant_b = await _make_tenant(session, TENANT_B)
            owner = await _make_user(session, "reftype-owner")

            type_a = ReferenceType(
                tenant_id=tenant_a.id,
                type="doc",
                owner_id=owner.id,
                read_visibility="private",
                write_visibility="private",
                display_name="Doc",
                instructions="Use doc links.",
                value_hint="Paste a URL.",
            )
            type_b = ReferenceType(
                tenant_id=tenant_b.id,
                type="doc",
                owner_id=owner.id,
                read_visibility="private",
                write_visibility="private",
                display_name="Doc",
                instructions="Use doc links.",
                value_hint="Paste a URL.",
            )
            session.add_all([type_a, type_b])
            await session.commit()

            assert type_a.tenant_id != type_b.tenant_id
            assert type_a.type == type_b.type == "doc"


class TestSetNullOnDeleteKeepsTenantIdIntact:
    """`ON DELETE SET NULL (<col>)` names its column so the delete only nulls
    that column, never `tenant_id` — a plain multi-column `SET NULL` would
    null both and then fail the `NOT NULL` constraint on `tenant_id`, which
    is exactly the bug this form exists to avoid (see the design doc's
    "Composite foreign keys" section). These three keys have no other test
    exercising the database's own `ON DELETE` behaviour directly: existing
    coverage either goes through store methods that reparent explicitly
    before deleting (room groups) or covers a different key (`rooms.group_id`,
    `messages.sender_client_id`)."""

    async def test_deleting_parent_agent_nulls_only_parent_agent_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            tenant = await _make_tenant(session, TENANT_A)
            tenant_id = tenant.id
            owner = await _make_user(session, "set-null-agent-owner")
            parent = await _make_agent(session, tenant_id, "parent-agent", owner.id)
            child = await _make_agent(
                session,
                tenant_id,
                "child-agent",
                owner.id,
                parent_agent_id=parent.id,
            )
            await session.commit()
            child_id = child.id

            await session.execute(delete(Agent).where(Agent.id == parent.id))
            await session.commit()
            session.expire_all()

            refreshed = await session.get(Agent, child_id)
            assert refreshed is not None
            assert refreshed.parent_agent_id is None
            assert refreshed.tenant_id == tenant_id

    async def test_deleting_creator_agent_nulls_only_created_by_agent_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            tenant = await _make_tenant(session, TENANT_A)
            tenant_id = tenant.id
            owner = await _make_user(session, "set-null-doc-owner")
            creator = await _make_agent(session, tenant_id, "creator-agent", owner.id)
            document = Document(
                tenant_id=tenant_id,
                owner_id=owner.id,
                room_id=None,
                created_by_agent_id=creator.id,
                read_visibility="private",
                write_visibility="private",
                name="doc",
                description="doc desc",
                instructions="doc instructions",
                content="doc content",
            )
            session.add(document)
            await session.commit()
            document_id = document.id

            await session.execute(delete(Agent).where(Agent.id == creator.id))
            await session.commit()
            session.expire_all()

            refreshed = await session.get(Document, document_id)
            assert refreshed is not None
            assert refreshed.created_by_agent_id is None
            assert refreshed.tenant_id == tenant_id

    async def test_deleting_parent_group_nulls_only_parent_group_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Deletes the parent group directly (unlike `RoomGroupStore.delete`,
        which reparents children first) so the FK's own `SET NULL` is what is
        under test, not the store's promote-on-delete behaviour."""
        async with session_factory() as session:
            tenant = await _make_tenant(session, TENANT_A)
            tenant_id = tenant.id
            parent = RoomGroup(tenant_id=tenant_id, name="parent-group")
            session.add(parent)
            await session.flush()
            child = RoomGroup(
                tenant_id=tenant_id, name="child-group", parent_group_id=parent.id
            )
            session.add(child)
            await session.commit()
            child_id = child.id

            await session.execute(delete(RoomGroup).where(RoomGroup.id == parent.id))
            await session.commit()
            session.expire_all()

            refreshed = await session.get(RoomGroup, child_id)
            assert refreshed is not None
            assert refreshed.parent_group_id is None
            assert refreshed.tenant_id == tenant_id
