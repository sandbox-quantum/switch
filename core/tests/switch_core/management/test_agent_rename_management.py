"""Renaming an agent, as agent management sees it.

Two halves. `update_agent_detail` takes a `name` and renames through
`AgentCore.rename_agent`, keeping the display name unless one is passed with
it. And a managed agent's machine has to hear about the new name: the
controller gets a new revision, and a definition that names no working folder
has the old default pinned, because the controller would otherwise derive a
new, empty folder from the new name.

Through the real bearer middleware and operations door, against Postgres.
"""

from __future__ import annotations

import posixpath
from collections.abc import AsyncIterator, Iterator
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations import context as op_context
from switch_core.db.models import TENANT_ZERO_ID, Agent, AgentDefinition
from switch_core.management.service import _inside_workspaces
from tests.switch_core.management.harness import (
    WORKSPACES_DIR,
    Harness,
    add_member,
    bearer,
    build_harness,
    enroll_console,
)
from tests.switch_core.management.test_agent_operations import (
    _agent_with_key,
    _assigned,
    _call,
    _created,
    _online,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Iterator[Harness]:
    harness = build_harness(session_factory)
    previous = op_context._protocol
    op_context.init_operations_protocol(harness.protocol)
    try:
        yield harness
    finally:
        op_context._protocol = previous


@pytest.fixture
async def client(harness: Harness) -> AsyncIterator[httpx.AsyncClient]:
    async with harness.client() as client:
        yield client


async def _set_display_name(harness: Harness, agent_id: str, label: str) -> None:
    async with harness.session_factory() as session:
        await session.execute(
            update(Agent).where(Agent.id == agent_id).values(display_name=label)
        )
        await session.commit()


async def _agent(harness: Harness, agent_id: str) -> Agent:
    async with harness.session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        return agent


async def _definition(harness: Harness, agent_id: str) -> AgentDefinition | None:
    async with harness.session_factory() as session:
        result = await session.execute(
            select(AgentDefinition).where(AgentDefinition.agent_id == agent_id)
        )
        return result.scalar_one_or_none()


async def _forget_directory(harness: Harness, agent_id: str) -> None:
    """A definition from before the machine reported its workspaces folder:
    no directory of its own, so the controller derives one from the name."""
    async with harness.session_factory() as session:
        row = (
            await session.execute(
                select(AgentDefinition).where(AgentDefinition.agent_id == agent_id)
            )
        ).scalar_one()
        row.definition = {**row.definition, "directory": None}
        await session.commit()


class TestTheToolRenames:
    async def test_a_name_and_display_name_change_together(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=False
        )
        target_id, _ = await _agent_with_key(
            harness, owner, "notes-taker", can_manage_agents=False
        )
        await _set_display_name(harness, target_id, "Notes Taker")

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {
                "agent_id": target_id,
                "name": "meeting-scribe",
                "display_name": "Meeting Scribe",
            },
        )

        assert response.status_code == 200, response.text
        result = response.json()["result"]
        assert result["name"] == "meeting-scribe"
        assert result["display_name"] == "Meeting Scribe"
        assert result["renamed"] == {
            "old_name": "notes-taker",
            "bridge_failures": [],
            "templates_mentioning_old_name": [],
        }
        agent = await _agent(harness, target_id)
        assert (agent.name, agent.display_name) == ("meeting-scribe", "Meeting Scribe")

    async def test_the_display_name_stays_when_none_is_passed(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=False
        )
        target_id, _ = await _agent_with_key(
            harness, owner, "notes-taker", can_manage_agents=False
        )
        await _set_display_name(harness, target_id, "Scribe")

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": target_id, "name": "meeting-scribe"},
        )

        assert response.status_code == 200, response.text
        result = response.json()["result"]
        assert (result["name"], result["display_name"]) == ("meeting-scribe", "Scribe")
        assert result["renamed"]["old_name"] == "notes-taker"

    async def test_the_same_name_reports_no_rename(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=False
        )
        target_id, _ = await _agent_with_key(
            harness, owner, "notes-taker", can_manage_agents=False
        )

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {
                "agent_id": target_id,
                "name": "notes-taker",
                "description": "Takes notes",
            },
        )

        assert response.status_code == 200, response.text
        result = response.json()["result"]
        assert "renamed" not in result
        assert result["description"] == "Takes notes"

    async def test_a_refused_rename_changes_nothing_managed(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")
        before = (await _assigned(client, controller))[new_id]

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {
                "agent_id": new_id,
                "name": "everyone",
                "model": "opus",
                "description": "changed",
            },
        )

        assert response.status_code == 400, response.text
        assert "reserved" in response.json()["detail"]
        after = (await _assigned(client, controller))[new_id]
        assert after == before
        agent = await _agent(harness, new_id)
        assert (agent.name, agent.description) == ("builder", "Builds things")

    async def test_a_name_another_agent_has_is_refused_as_a_client_error(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=False
        )
        target_id, _ = await _agent_with_key(
            harness, owner, "notes-taker", can_manage_agents=False
        )

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": target_id, "name": "helper"},
        )

        assert 400 <= response.status_code < 500, response.text
        assert (await _agent(harness, target_id)).name == "notes-taker"

    async def test_a_failed_managed_change_does_not_leave_the_rename_behind(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        """The error says "Nothing was changed", so nothing may have been."""
        owner = await add_member(harness.session_factory, "ada")
        laptop = await enroll_console(harness, client, owner, name="laptop")
        await enroll_console(harness, client, owner, name="desktop")
        await _online(client, laptop)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "name": "meeting-scribe", "machine": "desktop"},
        )

        assert response.status_code == 400, response.text
        assert response.json()["detail"].startswith("Nothing was changed: ")
        assert (await _agent(harness, new_id)).name == "builder"


class TestTheMachineHearsOfTheRename:
    async def test_the_rename_reaches_the_controller_with_the_folder_kept(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")
        await _forget_directory(harness, new_id)
        revision_before = await _controller_revision(harness, controller.controller_id)

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "name": "meeting-scribe"},
        )

        assert response.status_code == 200, response.text
        entry = (await _assigned(client, controller))[new_id]
        assert entry["definition"]["name"] == "meeting-scribe"
        assert entry["definition"]["directory"] == posixpath.join(
            WORKSPACES_DIR, "builder"
        )
        assert (
            await _controller_revision(harness, controller.controller_id)
            > revision_before
        )

    async def test_an_unset_folder_is_pinned_to_the_old_default(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")
        await _forget_directory(harness, new_id)
        revision_before = await _controller_revision(harness, controller.controller_id)

        await harness.management.agent_renamed(TENANT_ZERO_ID, new_id, "builder")

        row = await _definition(harness, new_id)
        assert row is not None
        assert row.definition["directory"] == posixpath.join(WORKSPACES_DIR, "builder")
        assert (
            await _controller_revision(harness, controller.controller_id)
            > revision_before
        )

    async def test_an_explicit_folder_is_left_alone(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")
        async with harness.session_factory() as session:
            row = (
                await session.execute(
                    select(AgentDefinition).where(AgentDefinition.agent_id == new_id)
                )
            ).scalar_one()
            row.definition = {**row.definition, "directory": "/work/mine"}
            await session.commit()
        revision_before = await _controller_revision(harness, controller.controller_id)

        await harness.management.agent_renamed(TENANT_ZERO_ID, new_id, "builder")

        row = await _definition(harness, new_id)
        assert row is not None
        assert row.definition["directory"] == "/work/mine"
        assert (
            await _controller_revision(harness, controller.controller_id)
            > revision_before
        )

    async def test_an_unmanaged_agent_is_left_alone(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await _agent_with_key(
            harness, owner, "plain", can_manage_agents=False
        )

        await harness.management.agent_renamed(TENANT_ZERO_ID, agent_id, "old-plain")

        assert await _definition(harness, agent_id) is None


async def _controller_revision(harness: Harness, controller_id: str) -> int:
    async with harness.session_factory() as session:
        controller = await harness.management.service.controllers.get(
            session, TENANT_ZERO_ID, controller_id
        )
        assert controller is not None
        return controller.assignment_revision


class TestAMoveAfterARename:
    """A rename pins the folder under the old name, so a later move to
    another machine must still see it as the old machine's workspace."""

    @staticmethod
    def _controller(root: str, os_name: str = "darwin") -> Any:
        return SimpleNamespace(
            status={"machine": {"workspaces_dir": root}}, platform={"os": os_name}
        )

    def test_a_folder_named_for_any_agent_is_the_machines_workspace(self) -> None:
        laptop = self._controller("/Users/ada/.switch/workspaces")
        assert _inside_workspaces(laptop, "/Users/ada/.switch/workspaces/notes-taker")
        assert _inside_workspaces(laptop, "/Users/ada/.switch/workspaces/notes-taker/")

    def test_a_folder_elsewhere_is_the_owners_choice(self) -> None:
        laptop = self._controller("/Users/ada/.switch/workspaces")
        assert not _inside_workspaces(laptop, "/Users/ada/code/project")
        assert not _inside_workspaces(
            laptop, "/Users/ada/.switch/workspaces/notes-taker/sub"
        )

    def test_windows_paths(self) -> None:
        pc = self._controller("C:\\Users\\ada\\workspaces", os_name="windows")
        assert _inside_workspaces(pc, "C:\\Users\\ada\\workspaces\\notes-taker")
        assert not _inside_workspaces(pc, "D:\\projects\\notes-taker")

    def test_a_machine_that_never_said_where_is_not_matched(self) -> None:
        unknown = SimpleNamespace(status=None, platform=None)
        assert not _inside_workspaces(unknown, "/anywhere/notes-taker")
