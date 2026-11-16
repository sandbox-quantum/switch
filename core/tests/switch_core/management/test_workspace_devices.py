"""A workspace's admins see every device and managed agent in it, and remove
any of them; everyone else sees and acts on their own. Removing a device
takes its agents off it. A cloud device is Switch's to name and remove.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import ControllerRelease
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    AgentDefinition,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.management.notifier import CREDENTIAL_REVOKED
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
    enroll_daemon,
    ensure_connected,
    provider,
    report_status,
    status_report,
)

WORKSPACE = "/gateway/management/workspace"

_RELEASE = ControllerRelease(
    version="0.31.0",
    url="https://example.com/switch-agent-controller-0.31.0.tgz",
    sha256="b" * 64,
)


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

    async def test_an_offline_device_runs_nothing_it_can_say(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller, _agent = await _device_with_agent(harness, client, ada, "scout")
            async with harness.session_factory() as session:
                await session.execute(
                    update(AgentController)
                    .where(AgentController.id == controller.controller_id)
                    .values(disconnected_at=datetime.now(UTC))
                )
                await session.commit()
            listed = await client.get(WORKSPACE, cookies=cookies_for(ada))

        [device] = listed.json()["devices"]
        assert device["state"] == "offline"
        assert (device["agents_total"], device["agents_running"]) == (1, 0)

    async def test_each_device_says_how_it_is_doing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # What an admin needs to tell a device that is fine from one that is
        # not: its connection, its release, each provider's install and
        # sign-in, and an agent's reason and whether it is still updating.
        harness = build_harness(session_factory, controller_release=_RELEASE)
        ada = await add_member(harness.session_factory, "ada")
        carol = await _admin(harness.session_factory, "carol")
        async with harness.client() as client:
            controller, agent_id = await _device_with_agent(
                harness, client, ada, "scout"
            )
            await report_status(
                client,
                controller,
                3,
                providers=[
                    provider("claude"),
                    provider("codex", auth="expired", auth_problem="token expired"),
                    provider("opencode", installed=False, auth="missing"),
                ],
                agents=[
                    {
                        "agent_id": agent_id,
                        "applied_revision": 0,
                        "process": "crashed",
                        "reason": "exit_code",
                        "detail": "exited with 1",
                        "attached": True,
                        "sessions": {"active": 0, "ids": []},
                        "restarts_10m": 3,
                        "oom_kills": 0,
                        "directory": f"{WORKSPACES_DIR}/scout",
                        "since": "2026-01-01T00:00:00Z",
                    }
                ],
            )
            listed = await client.get(WORKSPACE, cookies=cookies_for(carol))

        [device] = listed.json()["devices"]
        assert device["connection"]["connected_at"] is not None
        assert device["connection"]["disconnect_reason"] is None
        # Switch Console updates its own controller, so no release is named.
        assert (device["release"], device["updated_by_console"]) == (None, True)
        reports = {entry["provider"]: entry for entry in device["provider_reports"]}
        assert (reports["claude"]["installed"], reports["claude"]["auth"]) == (
            True,
            "ok",
        )
        assert reports["codex"]["auth"] == "expired"
        assert reports["codex"]["auth_problem"] == "token expired"
        assert reports["opencode"]["installed"] is False
        assert device["providers"] == ["claude", "codex", "opencode"]
        [agent] = listed.json()["managed_agents"]
        assert (agent["process"], agent["process_reason"], agent["process_detail"]) == (
            "crashed",
            "exit_code",
            "exited with 1",
        )
        assert agent["updating"] is True

    async def test_a_report_passes_on_its_named_fields_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A device's status takes keys this server doesn't know; none of them,
        # nor more than a short run of its own words, reaches whoever sees it.
        harness = build_harness(session_factory, controller_release=_RELEASE)
        ada = await add_member(harness.session_factory, "ada")
        carol = await _admin(harness.session_factory, "carol")
        async with harness.client() as client:
            controller, _agent = await _device_with_agent(harness, client, ada, "scout")
            report = status_report(
                3,
                providers=[
                    {
                        **provider("claude", auth="expired"),
                        "auth_problem": "x" * 5000,
                        "home": "/home/ada/.config",
                    }
                ],
            )
            report["update"] = {
                "target": _RELEASE.version,
                "state": "failed",
                "problem": "disk full",
                "proxy": "http://user:secret@proxy.example.test",
            }
            await ensure_connected(client, controller)
            reported = await client.put(
                f"/v1/management/controllers/{controller.controller_id}/status",
                json=report,
                headers=controller.headers,
            )
            assert reported.status_code < 300, reported.text
            listed = await client.get(WORKSPACE, cookies=cookies_for(carol))

        [device] = listed.json()["devices"]
        [report] = device["provider_reports"]
        assert set(report) == {
            "provider",
            "installed",
            "version",
            "auth",
            "auth_source",
            "checked_at",
            "reason",
            "auth_problem",
        }
        assert len(report["auth_problem"]) == 500
        assert device["update"] == {
            "target": _RELEASE.version,
            "state": "failed",
            "problem": "disk full",
        }

    async def test_a_headless_device_says_whether_it_runs_the_release(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        harness = build_harness(session_factory, controller_release=_RELEASE)
        ada = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            await enroll_daemon(harness, client, ada)
            listed = await client.get(WORKSPACE, cookies=cookies_for(ada))

        [device] = listed.json()["devices"]
        assert device["updated_by_console"] is False
        assert device["release"] == {
            "wanted": _RELEASE.version,
            "running": device["version"],
            "current": device["version"] == _RELEASE.version,
        }
        assert device["connection"] is None

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

    async def test_two_removals_at_once_remove_it_once(
        self, harness: Harness, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The second waits for the first, then finds it removed: the device
        is not revoked, and its agents not taken off, twice over."""
        ada = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller, _agent = await _device_with_agent(harness, client, ada, "scout")
        service = harness.management.service
        controller_id = controller.controller_id
        subscription = service.notifier.subscribe(controller_id)
        caplog.set_level(logging.INFO, logger="switch_core.management.service")

        async def remove_alongside() -> None:
            async with tenant_session(
                harness.session_factory, TENANT_ZERO_ID
            ) as session:
                await service.remove_controller(
                    session, TENANT_ZERO_ID, controller_id, owner_id=None
                )

        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as first:
            assert await service.controllers.locked(
                first, TENANT_ZERO_ID, controller_id
            )
            second = asyncio.create_task(remove_alongside())
            await asyncio.sleep(0.5)
            assert not second.done()
            await service.remove_controller(
                first, TENANT_ZERO_ID, controller_id, owner_id=None
            )
        await second

        assert [event for event, _ in subscription.drain()] == [CREDENTIAL_REVOKED]
        removals = [
            record.getMessage()
            for record in caplog.records
            if record.getMessage().startswith(
                f"Revoked agent controller {controller_id}"
            )
        ]
        assert removals == [
            f"Revoked agent controller {controller_id}, taking 1 agent(s) off it"
        ]

    async def test_an_agent_on_someone_elses_device_still_names_it(
        self, harness: Harness
    ) -> None:
        """Placing never puts an agent on another person's device, but nothing
        in the tables stops it; the list still answers."""
        ada = await add_member(harness.session_factory, "ada")
        grace = await add_member(harness.session_factory, "grace")
        async with harness.client() as client:
            _device, agent_id = await _device_with_agent(harness, client, ada, "scout")
            graces = await enroll_console(harness, client, grace, name="grace-laptop")
            async with harness.session_factory() as session:
                await session.execute(
                    update(AgentDefinition)
                    .where(AgentDefinition.agent_id == agent_id)
                    .values(controller_id=graces.controller_id)
                )
                await session.commit()
            listed = await client.get(WORKSPACE, cookies=cookies_for(ada))

        assert listed.status_code == 200, listed.text
        [agent] = listed.json()["managed_agents"]
        assert agent["controller_name"] == "grace-laptop"

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
