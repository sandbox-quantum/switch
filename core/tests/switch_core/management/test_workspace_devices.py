"""A workspace's admins see every device and managed agent in it, and remove
any of them; everyone else sees and acts on their own. Removing a device
takes its agents off it. A cloud device is Switch's to name and remove.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, AgentController, TenantMember, User
from switch_core.management.workspace_devices import device_type
from tests.switch_core.management.harness import (
    WORKSPACES_DIR,
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    create_managed_agent,
    enroll_console,
    provider,
    report_status,
)

WORKSPACE = "/gateway/management/workspace"


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _admin(session_factory: async_sessionmaker[AsyncSession], name: str) -> User:
    user = await add_member(session_factory, name)
    async with session_factory() as session:
        await session.execute(
            update(TenantMember)
            .where(
                TenantMember.tenant_id == TENANT_ZERO_ID,
                TenantMember.user_id == user.id,
            )
            .values(role="admin")
        )
        await session.commit()
    return user


async def _device_with_agent(
    harness: Harness, client: httpx.AsyncClient, owner: User, name: str
) -> tuple[EnrolledController, str]:
    """`owner`'s device, running one managed agent it reports running."""
    controller = await enroll_console(harness, client, owner, name=f"{name}-laptop")
    await report_status(client, controller, 1, providers=[provider("claude")])
    created = await create_managed_agent(
        client, owner, name=name, controller_id=controller.controller_id
    )
    assert created.status_code == 201, created.text
    agent_id = created.json()["agent_id"]
    await report_status(
        client,
        controller,
        2,
        providers=[provider("claude")],
        agents=[
            {
                "agent_id": agent_id,
                "applied_revision": 1,
                "process": "running",
                "attached": True,
                "sessions": {"active": 0, "ids": []},
                "restarts_10m": 0,
                "oom_kills": 0,
                "directory": f"{WORKSPACES_DIR}/{name}",
                "since": "2026-01-01T00:00:00Z",
            }
        ],
    )
    return controller, agent_id


def _flags(row: dict, *names: str) -> tuple[bool, ...]:
    return tuple(row[name] for name in names)


class TestTheWorkspaceList:
    async def test_an_admin_sees_every_device_and_agent_with_its_owner(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        carol = await _admin(harness.session_factory, "carol")
        async with harness.client() as client:
            ada_device, ada_agent = await _device_with_agent(
                harness, client, ada, "scout"
            )
            await enroll_console(harness, client, bob, name="bob-laptop")
            as_admin = await client.get(WORKSPACE, cookies=cookies_for(carol))
            as_ada = await client.get(WORKSPACE, cookies=cookies_for(ada))

        assert as_admin.status_code == 200, as_admin.text
        devices = {row["name"]: row for row in as_admin.json()["devices"]}
        assert set(devices) == {"scout-laptop", "bob-laptop"}
        scout = devices["scout-laptop"]
        assert (scout["owner_id"], scout["owner_name"]) == (ada.id, "ada")
        assert (scout["agents_total"], scout["agents_running"]) == (1, 1)
        assert scout["type"] == "computer"
        assert scout["providers"] == ["claude"]
        assert _flags(scout, "can_edit", "can_recheck", "can_remove") == (
            False,
            False,
            True,
        )
        [agent] = as_admin.json()["managed_agents"]
        assert (agent["agent_id"], agent["owner_name"]) == (ada_agent, "ada")
        assert agent["controller_id"] == ada_device.controller_id
        assert (agent["provider"], agent["process"]) == ("claude", "running")
        assert _flags(agent, "can_edit", "can_delete") == (False, True)

        assert as_ada.status_code == 200, as_ada.text
        [own] = as_ada.json()["devices"]
        assert own["name"] == "scout-laptop"
        assert _flags(own, "can_edit", "can_recheck", "can_remove") == (
            True,
            True,
            True,
        )
        [own_agent] = as_ada.json()["managed_agents"]
        assert _flags(own_agent, "can_edit", "can_delete") == (True, True)

    async def test_a_removed_device_is_left_out(self, harness: Harness) -> None:
        ada = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller, agent_id = await _device_with_agent(
                harness, client, ada, "scout"
            )
            removed = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(ada),
            )
            listed = await client.get(WORKSPACE, cookies=cookies_for(ada))

        assert removed.status_code == 200, removed.text
        assert listed.json()["devices"] == []
        [agent] = listed.json()["managed_agents"]
        assert (agent["agent_id"], agent["controller_id"]) == (agent_id, None)
        assert agent["process"] is None


class TestAnAdminRemoving:
    async def test_a_members_device_comes_off_with_its_agents(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        carol = await _admin(harness.session_factory, "carol")
        async with harness.client() as client:
            controller, agent_id = await _device_with_agent(
                harness, client, ada, "scout"
            )
            removed = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(carol),
            )
            [device] = (
                await client.get(
                    "/gateway/management/controllers", cookies=cookies_for(ada)
                )
            ).json()
            [agent] = (
                await client.get("/gateway/management/agents", cookies=cookies_for(ada))
            ).json()
            refused = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )

        assert removed.status_code == 200, removed.text
        assert device["state"] == "revoked"
        assert (agent["agent_id"], agent["controller_id"]) == (agent_id, None)
        assert agent["desired_state"] == "running"
        assert agent["definition"]["directory"] is None
        assert refused.status_code == 401

    async def test_a_member_cannot_remove_someone_elses_device_or_agent(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        async with harness.client() as client:
            controller, agent_id = await _device_with_agent(
                harness, client, ada, "scout"
            )
            device = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(bob),
            )
            agent = await client.delete(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(bob)
            )
            listed = await client.get(WORKSPACE, cookies=cookies_for(ada))

        assert device.status_code == 404, device.text
        assert agent.status_code == 404, agent.text
        assert [row["state"] for row in listed.json()["devices"]] == ["online"]
        assert [row["agent_id"] for row in listed.json()["managed_agents"]] == [
            agent_id
        ]

    async def test_a_members_agent_stops_being_managed(self, harness: Harness) -> None:
        ada = await add_member(harness.session_factory, "ada")
        carol = await _admin(harness.session_factory, "carol")
        async with harness.client() as client:
            _controller, agent_id = await _device_with_agent(
                harness, client, ada, "scout"
            )
            stopped = await client.delete(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(carol)
            )
            agents = await client.get(
                "/gateway/management/agents", cookies=cookies_for(ada)
            )

        assert stopped.status_code == 200, stopped.text
        assert agents.json() == []


class TestACloudDevice:
    async def test_is_neither_renamed_nor_removed_by_anyone(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        carol = await _admin(harness.session_factory, "carol")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, ada, name="Switch cloud")
            async with harness.session_factory() as session:
                await session.execute(
                    update(AgentController)
                    .where(AgentController.id == controller.controller_id)
                    .values(kind="ec2")
                )
                await session.commit()
            path = f"/gateway/management/controllers/{controller.controller_id}"
            renamed = await client.patch(
                path, json={"name": "mine now"}, cookies=cookies_for(ada)
            )
            by_owner = await client.delete(path, cookies=cookies_for(ada))
            by_admin = await client.delete(path, cookies=cookies_for(carol))
            [own] = (
                await client.get(
                    "/gateway/management/controllers", cookies=cookies_for(ada)
                )
            ).json()
            [row] = (await client.get(WORKSPACE, cookies=cookies_for(carol))).json()[
                "devices"
            ]

        for refused in (renamed, by_owner, by_admin):
            assert refused.status_code == 409, refused.text
            assert refused.json()["error"]["code"] == "cloud_managed"
        assert own["state"] != "revoked"
        assert _flags(own, "can_edit", "can_remove") == (False, False)
        assert row["type"] == "cloud"
        assert _flags(row, "can_edit", "can_remove") == (False, False)


@pytest.mark.parametrize(
    ("kind", "updated_by", "expected"),
    [
        ("ec2", "self", "cloud"),
        ("daemon", "console", "remote_ssh"),
        ("daemon", "self", "computer"),
        ("daemon", None, "computer"),
        ("console", "console", "computer"),
    ],
)
def test_a_device_is_typed_by_what_it_is(
    kind: str, updated_by: str | None, expected: str
) -> None:
    controller = AgentController(
        kind=kind,
        status=None
        if updated_by is None
        else {"controller": {"version": "1", "updated_by": updated_by}},
    )

    assert device_type(controller) == expected
