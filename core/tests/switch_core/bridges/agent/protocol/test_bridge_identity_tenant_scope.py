"""Bridge-identity provisioning and teardown are confined to the tenant that
owns the agent (CHOO-2687).

Before this fix, both `_create_bridge_identities` and `_remove_bridge_identities`
looped over every running bridge on the instance
(`CollaborationBridgeLifecycleService.all_bridges()`), which is a flat,
cross-tenant dict:

- Registering an agent under tenant A called `create_agent_identity` on
  tenant B's bridges too — creating a Mattermost bot, Slack user group, or
  Discord role for tenant A's agent on a platform tenant B owns, leaking the
  agent's name and description across the tenant boundary.
- Deleting an agent under tenant A called `remove_agent_identity` on tenant
  B's bridges too — and by name, so deleting an agent in tenant A would
  delete the platform bot/group/role of a *same-named* agent belonging to
  tenant B. Destructive, not just a leak.

No query is involved in either (it's an in-memory iteration followed by
outbound platform API calls), so row-level security cannot catch it.

These tests pin the fix: only the owning tenant's bridges are asked to
create or remove the identity.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import TENANT_ZERO_ID, Client, Tenant
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
    register,
)

TENANT_B = "bridge-identity-tenant-b"


class _FakeAdapter:
    def __init__(self) -> None:
        self.identities_created: list[tuple[str, str]] = []
        self.identities_removed: list[str] = []

    async def create_agent_identity(self, name: str, description: str) -> None:
        self.identities_created.append((name, description))

    async def remove_agent_identity(self, name: str) -> None:
        self.identities_removed.append(name)


class _FakeBridge:
    def __init__(self, tenant_id: str) -> None:
        self.tenant_id = tenant_id
        self.adapter = _FakeAdapter()


class _MultiTenantBridges:
    """Stand-in for `CollaborationBridgeLifecycleService` carrying bridges from
    more than one tenant, mirroring the real service's flat `_bridges` dict
    and its per-tenant filtering."""

    def __init__(self, bridges: list[_FakeBridge]) -> None:
        self._bridges = bridges

    def all_bridges(self) -> list[_FakeBridge]:
        return list(self._bridges)

    def bridges_for_tenant(self, tenant_id: str) -> list[_FakeBridge]:
        return [b for b in self._bridges if b.tenant_id == tenant_id]


async def _seed_tenant(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        session.add(Tenant(id=TENANT_B, slug=TENANT_B, name=TENANT_B))
        await session.commit()


class TestBridgeIdentityTenantScope:
    async def test_other_tenants_bridge_is_not_given_the_new_agents_identity(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The `session_factory` fixture binds tenant zero as the ambient
        # tenant for the whole test, so registering here is "tenant A".
        await _seed_tenant(session_factory)

        tenant_a_bridge = _FakeBridge(tenant_id=TENANT_ZERO_ID)
        tenant_b_bridge = _FakeBridge(tenant_id=TENANT_B)

        svc = make_service(session_factory)
        svc.collab_lifecycle = _MultiTenantBridges(  # type: ignore[attr-defined]
            [tenant_a_bridge, tenant_b_bridge]
        )

        owner = await make_owner(session_factory)
        await register(svc, "cross-tenant-bot", owner)

        assert tenant_a_bridge.adapter.identities_created == [
            ("cross-tenant-bot", "cross-tenant-bot desc")
        ]
        assert tenant_b_bridge.adapter.identities_created == []


class _StoppableClientLifecycle:
    """`registration_harness.FakeClientLifecycle`, plus the `stop`/`remove`
    calls `delete_agent` makes that registration alone never reaches."""

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

    async def stop(self, client_id: str) -> None:
        return None

    async def remove(self, client_id: str) -> None:
        return None


class TestBridgeIdentityRemovalTenantScope:
    async def test_other_tenants_bridge_is_not_stripped_of_a_same_named_identity(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Tenant A deletes an agent named "shared-name"; tenant B happens to
        # have its own, unrelated agent of the same name on its own bridge.
        # Deleting tenant A's agent must not touch tenant B's bridge identity.
        await _seed_tenant(session_factory)

        tenant_a_bridge = _FakeBridge(tenant_id=TENANT_ZERO_ID)
        tenant_b_bridge = _FakeBridge(tenant_id=TENANT_B)

        svc = make_service(session_factory)
        svc.collab_lifecycle = _MultiTenantBridges(  # type: ignore[attr-defined]
            [tenant_a_bridge, tenant_b_bridge]
        )
        svc.client_lifecycle = _StoppableClientLifecycle(session_factory)  # type: ignore[attr-defined]
        svc.event_buffer = EventBuffer()  # type: ignore[attr-defined]

        owner = await make_owner(session_factory)
        agent_id = await register(svc, "shared-name", owner)
        # The registration call above already exercised create_agent_identity;
        # clear it so this test's assertions are about removal alone.
        tenant_a_bridge.adapter.identities_created.clear()
        tenant_b_bridge.adapter.identities_created.clear()

        await svc.delete_agent(agent_id=agent_id)

        assert tenant_a_bridge.adapter.identities_removed == ["shared-name"]
        assert tenant_b_bridge.adapter.identities_removed == []
