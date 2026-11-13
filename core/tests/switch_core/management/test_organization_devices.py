"""Organization › Devices: an organization's admins see every device and
managed agent across its workspaces, each saying which workspace it is in,
and remove any of them there. Nobody else does, and a workspace of another
organization is answered as one that does not exist.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentController,
    AgentDefinition,
    Organization,
    OrganizationMember,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    create_managed_agent,
    enroll_console,
    provider,
    report_status,
)

DEVICES = "/gateway/organizations/current/devices"
WORKSPACES = "/gateway/organizations/current/workspaces"


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _org_admin(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> User:
    """A member of tenant zero who is its organization's `org_admin`."""
    user = await add_member(session_factory, name)
    async with session_factory() as session:
        session.add(
            OrganizationMember(
                organization_id=TENANT_ZERO_ID, user_id=user.id, role="org_admin"
            )
        )
        await session.commit()
    return user


async def _workspace(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    organization_id: str = TENANT_ZERO_ID,
) -> str:
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        if organization_id != TENANT_ZERO_ID:
            session.add(
                Organization(id=organization_id, slug=organization_id, name="Other")
            )
            await session.flush()
        session.add(
            Tenant(
                id=tenant_id, slug=tenant_id, name=name, organization_id=organization_id
            )
        )
        await session.commit()
    return tenant_id


async def _managed_agent(
    harness: Harness, client: httpx.AsyncClient, owner: User
) -> tuple[str, str]:
    """`owner`'s device in tenant zero, with one managed agent on it: their
    ids."""
    device = await enroll_console(harness, client, owner, name="ada-laptop")
    await report_status(client, device, 1, providers=[provider("claude")])
    created = await create_managed_agent(
        client, owner, name="scout", controller_id=device.controller_id
    )
    assert created.status_code == 201, created.text
    return device.controller_id, created.json()["agent_id"]


class TestTheList:
    async def test_every_workspaces_devices_and_agents_say_which_workspace(
        self, harness: Harness
    ) -> None:
        lab = await _workspace(harness.session_factory, "Lab")
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob", lab)
        olga = await _org_admin(harness.session_factory, "olga")
        async with harness.client() as client:
            ada_device, ada_agent = await _managed_agent(harness, client, ada)
            bob_device = await enroll_console(
                harness, client, bob, name="lab-box", tenant_id=lab
            )
            listed = await client.get(DEVICES, cookies=cookies_for(olga))

        assert listed.status_code == 200, listed.text
        devices = {row["id"]: row for row in listed.json()["devices"]}
        assert {
            row["name"]: (row["workspace_id"], row["workspace_name"], row["owner_name"])
            for row in devices.values()
        } == {
            "ada-laptop": (TENANT_ZERO_ID, "Default", "ada"),
            "lab-box": (lab, "Lab", "bob"),
        }
        assert devices[ada_device]["can_remove"] is True
        assert devices[bob_device.controller_id]["can_remove"] is True
        [agent] = listed.json()["managed_agents"]
        assert (agent["agent_id"], agent["workspace_name"]) == (ada_agent, "Default")
        assert agent["can_delete"] is True

    async def test_nobody_but_its_organization_admins_reads_it(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            refused = await client.get(DEVICES, cookies=cookies_for(ada))

        assert refused.status_code == 403


class TestRemoving:
    async def test_a_device_in_another_workspace_is_removed_there(
        self, harness: Harness
    ) -> None:
        lab = await _workspace(harness.session_factory, "Lab")
        bob = await add_member(harness.session_factory, "bob", lab)
        olga = await _org_admin(harness.session_factory, "olga")
        async with harness.client() as client:
            device = await enroll_console(
                harness, client, bob, name="lab-box", tenant_id=lab
            )
            removed = await client.delete(
                f"{WORKSPACES}/{lab}/devices/{device.controller_id}",
                cookies=cookies_for(olga),
            )
            listed = await client.get(DEVICES, cookies=cookies_for(olga))

        assert removed.status_code == 200, removed.text
        assert listed.json()["devices"] == []
        async with tenant_session(harness.session_factory, lab) as session:
            controller = await session.get(AgentController, device.controller_id)
        assert controller is not None and controller.revoked_at is not None

    async def test_an_agent_stops_being_managed_and_stays(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        olga = await _org_admin(harness.session_factory, "olga")
        async with harness.client() as client:
            _, agent_id = await _managed_agent(harness, client, ada)
            stopped = await client.delete(
                f"{WORKSPACES}/{TENANT_ZERO_ID}/managed-agents/{agent_id}",
                cookies=cookies_for(olga),
            )
            listed = await client.get(DEVICES, cookies=cookies_for(olga))

        assert stopped.status_code == 200, stopped.text
        assert listed.json()["managed_agents"] == []
        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            definition = await session.scalar(
                select(AgentDefinition).where(AgentDefinition.agent_id == agent_id)
            )
            agent = await session.get(Agent, agent_id)
        assert definition is None
        assert agent is not None

    async def test_one_not_in_the_workspace_named_or_another_organization_is_not_found(
        self, harness: Harness
    ) -> None:
        lab = await _workspace(harness.session_factory, "Lab")
        elsewhere = await _workspace(
            harness.session_factory, "Elsewhere", f"org-{uuid.uuid4().hex[:8]}"
        )
        ada = await add_member(harness.session_factory, "ada")
        olga = await _org_admin(harness.session_factory, "olga")
        async with harness.client() as client:
            device = await enroll_console(harness, client, ada)
            wrong_workspace = await client.delete(
                f"{WORKSPACES}/{lab}/devices/{device.controller_id}",
                cookies=cookies_for(olga),
            )
            other_organization = await client.delete(
                f"{WORKSPACES}/{elsewhere}/devices/{device.controller_id}",
                cookies=cookies_for(olga),
            )
            by_a_member = await client.delete(
                f"{WORKSPACES}/{TENANT_ZERO_ID}/devices/{device.controller_id}",
                cookies=cookies_for(ada),
            )

        assert wrong_workspace.status_code == 404
        assert other_organization.status_code == 404
        assert by_a_member.status_code == 403
        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            controller = await session.get(AgentController, device.controller_id)
        assert controller is not None and controller.revoked_at is None
