"""Agents acting on their owner's agent management: machines and managed agents.

`list_machines`, `get_advanced_config`, `create_agent` and
`list_managed_agents` exist only once
management is installed, are refused to an agent whose owner has not turned on
its "can manage agents" capability (however the call authenticated), and act
for the agent's owner on that owner's machines alone. Through the real bearer
middleware and operations door, against Postgres.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.mcp.server import mcp
from switch_core.bridges.agent.operations import all_operations
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.agent_management import (
    disable_agent_management,
)
from switch_core.db.models import (
    Agent,
    AgentDefinition,
    ApiKey,
    Client,
    User,
)
from tests.switch_core.management.harness import (
    WORKSPACES_DIR,
    EnrolledController,
    Harness,
    add_member,
    bearer,
    build_harness,
    cookies_for,
    enroll_console,
    place_agent,
    provider,
    report_status,
)

MANAGEMENT_OPERATIONS = {
    "list_machines",
    "get_advanced_config",
    "create_agent",
    "list_managed_agents",
}


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


async def _agent_with_key(
    harness: Harness, owner: User | None, name: str, *, can_manage_agents: bool
) -> tuple[str, str]:
    """An agent with a real API key. Returns its id and the key."""
    key = secrets.token_urlsafe(32)
    async with harness.session_factory() as session:
        holder = owner or await _member(session, f"{name}-former-owner")
        client = Client(
            type="agent", transport_user_id=f"@{name}:test", display_name=name
        )
        api_key = ApiKey(
            type="agent",
            key_hash=hashlib.sha256(key.encode()).hexdigest(),
            encrypted_key="",
            label=name,
            user_id=holder.id,
        )
        session.add_all([client, api_key])
        await session.flush()
        agent = Agent(
            name=name,
            description=f"{name} desc",
            agent_type="auto_session",
            connector_type="claude_code",
            integration_profile={"connection_model": "auto_session"},
            client_id=client.id,
            api_key_id=api_key.id,
            owner_id=owner.id if owner is not None else None,
            can_manage_agents=can_manage_agents,
        )
        session.add(agent)
        await session.commit()
        return agent.id, key


async def _member(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    return user


async def _call(
    client: httpx.AsyncClient,
    agent_id: str,
    operation: str,
    headers: dict[str, str],
    body: dict[str, Any] | None = None,
) -> httpx.Response:
    return await client.post(
        f"/agents/{agent_id}/ops/{operation}", json=body or {}, headers=headers
    )


async def _online(
    client: httpx.AsyncClient,
    controller: EnrolledController,
    *,
    seq: int = 1,
    providers: list[dict[str, Any]] | None = None,
    agents: list[dict[str, Any]] | None = None,
) -> None:
    response = await report_status(
        client,
        controller,
        seq,
        providers=providers if providers is not None else [provider("claude")],
        agents=agents,
    )
    assert response.status_code == 200, response.text


def _create_body(machine: str, name: str = "builder", **overrides: Any) -> dict:
    return {
        "name": name,
        "description": "Builds things",
        "machine": machine,
        "provider": "claude",
        **overrides,
    }


async def _agent_row(harness: Harness, name: str) -> Agent | None:
    async with harness.session_factory() as session:
        result = await session.execute(select(Agent).where(Agent.name == name))
        return result.scalar_one_or_none()


def _agent_status(agent_id: str, process: str, **extra: Any) -> dict[str, Any]:
    return {
        "agent_id": agent_id,
        "applied_revision": 1,
        "process": process,
        "attached": process == "running",
        "sessions": {"active": 0, "ids": []},
        "restarts_10m": 0,
        "oom_kills": 0,
        "since": "2026-01-01T00:00:00Z",
        **extra,
    }


class TestTheOperationsExistOnlyWithManagement:
    async def test_listed_and_served_once_management_is_installed(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        listed = await client.get(f"/agents/{agent_id}/ops", headers=bearer(key))
        tools = {tool.name for tool in await mcp.list_tools()}

        assert listed.status_code == 200
        assert MANAGEMENT_OPERATIONS <= set(listed.json()["operations"])
        assert MANAGEMENT_OPERATIONS <= tools

    async def test_absent_from_both_doors_without_it(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        disable_agent_management()
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        listed = await client.get(f"/agents/{agent_id}/ops", headers=bearer(key))
        called = await _call(client, agent_id, "list_machines", bearer(key))
        tools = {tool.name for tool in await mcp.list_tools()}

        assert not MANAGEMENT_OPERATIONS & set(listed.json()["operations"])
        assert called.status_code == 404
        assert not MANAGEMENT_OPERATIONS & tools
        assert not MANAGEMENT_OPERATIONS & set(all_operations())


class TestTheCapability:
    @pytest.mark.parametrize(
        ("operation", "body"),
        [
            ("list_machines", {}),
            ("get_advanced_config", {"provider": "claude"}),
            ("list_managed_agents", {}),
            ("create_agent", _create_body("laptop")),
        ],
    )
    async def test_refused_without_it(
        self,
        harness: Harness,
        client: httpx.AsyncClient,
        operation: str,
        body: dict[str, Any],
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner)
        await _online(client, controller)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=False
        )

        response = await _call(client, agent_id, operation, bearer(key), body)

        assert response.status_code == 403, response.text
        assert (
            "Ask your owner to enable 'can manage agents' for helper"
            in response.json()["detail"]
        )
        assert await _agent_row(harness, "builder") is None

    async def test_an_agent_with_no_owner_is_refused(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        agent_id, key = await _agent_with_key(
            harness, None, "orphan", can_manage_agents=True
        )

        response = await _call(client, agent_id, "list_machines", bearer(key))

        assert response.status_code == 403
        assert "has no owner" in response.json()["detail"]

    async def test_a_controller_acting_as_the_agent_needs_it_too(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner)
        agent_id = await place_agent(client, controller, name="reviewer")
        as_agent = {**controller.headers, "X-Switch-Agent-Id": agent_id}

        refused = await _call(client, agent_id, "list_machines", as_agent)
        async with harness.session_factory() as session:
            await session.execute(
                update(Agent).where(Agent.id == agent_id).values(can_manage_agents=True)
            )
            await session.commit()
        allowed = await _call(client, agent_id, "list_machines", as_agent)

        assert refused.status_code == 403, refused.text
        assert "can manage agents" in refused.json()["detail"]
        assert allowed.status_code == 200, allowed.text
        assert [m["id"] for m in allowed.json()["result"]] == [controller.controller_id]


class TestListMachines:
    async def test_the_owners_machines_only_without_revoked_ones(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        stranger = await add_member(harness.session_factory, "grace")
        laptop = await enroll_console(harness, client, owner, name="laptop")
        await enroll_console(harness, client, owner, name="desktop")
        gone = await enroll_console(harness, client, owner, name="old")
        await enroll_console(harness, client, stranger, name="theirs")
        revoked = await client.delete(
            f"/gateway/management/controllers/{gone.controller_id}",
            cookies=cookies_for(owner),
        )
        assert revoked.status_code == 200
        described = await client.patch(
            f"/gateway/management/controllers/{laptop.controller_id}",
            json={"description": "The build box"},
            cookies=cookies_for(owner),
        )
        assert described.status_code == 200, described.text
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        await _online(
            client,
            laptop,
            providers=[
                provider("claude"),
                provider("codex", auth="missing"),
                provider("cursor", installed=False),
            ],
            agents=[
                _agent_status("a", "running"),
                _agent_status("b", "running"),
                _agent_status("c", "crashed", reason="crash_loop"),
            ],
        )

        response = await _call(client, agent_id, "list_machines", bearer(key))

        assert response.status_code == 200, response.text
        machines = {m["name"]: m for m in response.json()["result"]}
        assert set(machines) == {"laptop", "desktop"}
        assert machines["laptop"] == {
            "id": laptop.controller_id,
            "name": "laptop",
            "description": "The build box",
            "kind": "console",
            "state": "online",
            "last_seen_at": machines["laptop"]["last_seen_at"],
            "providers": [
                {
                    "provider": "claude",
                    "installed": True,
                    "version": "1.0.0",
                    "auth": "ok",
                },
                {
                    "provider": "codex",
                    "installed": True,
                    "version": "1.0.0",
                    "auth": "missing",
                },
                {
                    "provider": "cursor",
                    "installed": False,
                    "version": None,
                    "auth": "ok",
                },
            ],
            "agents_running": 2,
        }
        assert machines["laptop"]["last_seen_at"] is not None
        assert machines["desktop"]["state"] == "unknown"
        assert machines["desktop"]["providers"] == []
        assert machines["desktop"]["agents_running"] is None
        assert machines["desktop"]["description"] is None


class TestCreateAgent:
    async def test_creates_an_agent_owned_by_the_owner_on_the_named_machine(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        response = await _call(
            client,
            agent_id,
            "create_agent",
            bearer(key),
            _create_body(
                "laptop",
                instructions="Build it.",
                directory="/work/builder",
                model="sonnet",
                advanced_config={"effort": "high", "tools": ["Read", "Grep"]},
                display_name="Builder",
            ),
        )

        assert response.status_code == 200, response.text
        result = response.json()["result"]
        created = await _agent_row(harness, "builder")
        assert created is not None
        assert result["agent_id"] == created.id
        assert result["name"] == "builder"
        assert result["machine"] == {"id": controller.controller_id, "name": "laptop"}
        assert result["desired_state"] == "running"
        assert "list_managed_agents" in result["hint"]
        assert created.owner_id == owner.id
        assert created.display_name == "Builder"
        assert created.can_manage_agents is False
        assert created.addressing_policy == owner_only_policy([]).model_dump()
        async with harness.session_factory() as session:
            row = (
                await session.execute(
                    select(AgentDefinition).where(
                        AgentDefinition.agent_id == created.id
                    )
                )
            ).scalar_one()
        assert row.owner_id == owner.id
        assert row.controller_id == controller.controller_id
        assert row.desired_state == "running"
        assert row.definition["provider"] == "claude"
        assert row.definition["model"] == "sonnet"
        assert row.definition["advanced_config"] == {
            "effort": "high",
            "tools": ["Read", "Grep"],
        }
        assert row.definition["instructions"] == "Build it."
        assert row.definition["directory"] == "/work/builder"
        assert row.definition["auto_approve"] is False
        binding = harness.protocol.connections.controllers.binding(created.id)
        assert binding is not None
        assert binding.controller_id == controller.controller_id

    async def test_by_id_and_stopped(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        response = await _call(
            client,
            agent_id,
            "create_agent",
            bearer(key),
            _create_body(controller.controller_id, start=False),
        )

        assert response.status_code == 200, response.text
        assert response.json()["result"]["desired_state"] == "stopped"

    async def test_another_owners_machine_reads_as_missing(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        stranger = await add_member(harness.session_factory, "grace")
        theirs = await enroll_console(harness, client, stranger, name="theirs")
        await _online(client, theirs)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        by_id = await _call(
            client,
            agent_id,
            "create_agent",
            bearer(key),
            _create_body(theirs.controller_id),
        )
        by_name = await _call(
            client, agent_id, "create_agent", bearer(key), _create_body("theirs")
        )
        missing = await _call(
            client, agent_id, "create_agent", bearer(key), _create_body("nowhere")
        )

        assert by_id.status_code == by_name.status_code == missing.status_code == 400
        assert by_id.json()["detail"] == missing.json()["detail"].replace(
            "nowhere", theirs.controller_id
        )
        assert "no machine with the id or name" in by_name.json()["detail"]
        assert await _agent_row(harness, "builder") is None

    async def test_an_ambiguous_name_lists_the_candidates(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        first = await enroll_console(harness, client, owner, name="laptop")
        second = await enroll_console(harness, client, owner, name="laptop")
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        response = await _call(
            client, agent_id, "create_agent", bearer(key), _create_body("laptop")
        )

        assert response.status_code == 400
        detail = response.json()["detail"]
        assert "2 machines named 'laptop'" in detail
        assert first.controller_id in detail
        assert second.controller_id in detail
        assert await _agent_row(harness, "builder") is None

    async def test_a_revoked_namesake_is_not_a_candidate(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        old = await enroll_console(harness, client, owner, name="laptop")
        new = await enroll_console(harness, client, owner, name="laptop")
        await client.delete(
            f"/gateway/management/controllers/{old.controller_id}",
            cookies=cookies_for(owner),
        )
        await _online(client, new)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        response = await _call(
            client, agent_id, "create_agent", bearer(key), _create_body("laptop")
        )

        assert response.status_code == 200, response.text
        assert response.json()["result"]["machine"]["id"] == new.controller_id

    @pytest.mark.parametrize(
        ("providers", "code", "phrase"),
        [
            (None, "controller_offline", "has not reported recently"),
            (
                [provider("claude", installed=False)],
                "provider_not_installed",
                "claude is not installed on machine 'laptop'",
            ),
            (
                [provider("claude", auth="missing")],
                "provider_login_missing",
                "claude is not logged in on machine 'laptop'",
            ),
            (
                [provider("claude", auth="expired")],
                "provider_login_expired",
                "the claude login on machine 'laptop' has expired",
            ),
        ],
    )
    async def test_placement_refusals_are_relayable_and_leave_nothing(
        self,
        harness: Harness,
        client: httpx.AsyncClient,
        providers: list[dict[str, Any]] | None,
        code: str,
        phrase: str,
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        if providers is not None:
            await _online(client, controller, providers=providers)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        response = await _call(
            client, agent_id, "create_agent", bearer(key), _create_body("laptop")
        )

        assert response.status_code == 400, response.text
        detail = response.json()["detail"]
        assert detail.startswith("Nothing was created: ")
        assert phrase in detail
        assert f"({code})" in detail
        assert await _agent_row(harness, "builder") is None

    async def test_a_revoked_machine_by_id_is_refused(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        await client.delete(
            f"/gateway/management/controllers/{controller.controller_id}",
            cookies=cookies_for(owner),
        )
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        response = await _call(
            client,
            agent_id,
            "create_agent",
            bearer(key),
            _create_body(controller.controller_id),
        )

        assert response.status_code == 400
        assert "(controller_revoked)" in response.json()["detail"]
        assert await _agent_row(harness, "builder") is None

    async def test_an_invalid_definition_or_taken_name_is_refused(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        bad_provider = await _call(
            client,
            agent_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", provider="vim"),
        )
        taken = await _call(
            client,
            agent_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", name="helper"),
        )

        assert bad_provider.status_code == 400
        assert "provider" in bad_provider.json()["detail"]
        assert "(validation_error)" not in bad_provider.json()["detail"]
        assert await _agent_row(harness, "builder") is None
        assert taken.status_code == 400
        assert "(validation_error)" in taken.json()["detail"]
        assert "helper" in taken.json()["detail"]


class TestListManagedAgents:
    async def test_shows_what_was_created_and_how_it_is_doing(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        stranger = await add_member(harness.session_factory, "grace")
        controller = await enroll_console(harness, client, owner, name="laptop")
        theirs = await enroll_console(harness, client, stranger, name="theirs")
        await place_agent(client, theirs, name="not-yours")
        await _online(client, controller)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        created = await _call(
            client, agent_id, "create_agent", bearer(key), _create_body("laptop")
        )
        new_id = created.json()["result"]["agent_id"]

        before = await _call(client, agent_id, "list_managed_agents", bearer(key))
        await _online(
            client,
            controller,
            seq=2,
            agents=[_agent_status(new_id, "crashed", reason="crash_loop")],
        )
        after = await _call(client, agent_id, "list_managed_agents", bearer(key))

        assert before.status_code == 200, before.text
        [entry] = before.json()["result"]
        assert entry == {
            "agent_id": new_id,
            "name": "builder",
            "display_name": None,
            "description": "Builds things",
            "provider": "claude",
            "model": None,
            "advanced_config": {},
            "directory": f"{WORKSPACES_DIR}/builder",
            "machine": {
                "id": controller.controller_id,
                "name": "laptop",
                "state": "online",
            },
            "desired_state": "running",
            "actual": None,
            "revision": entry["revision"],
        }
        [reported] = after.json()["result"]
        assert reported["actual"] == {
            "process": "crashed",
            "reason": "crash_loop",
            "detail": None,
            "applied_revision": 1,
            "since": "2026-01-01T00:00:00Z",
            "directory": None,
        }


async def _assigned(
    client: httpx.AsyncClient, controller: EnrolledController
) -> dict[str, dict[str, Any]]:
    response = await client.get(
        f"/v1/management/controllers/{controller.controller_id}/assignment",
        headers=controller.headers,
    )
    assert response.status_code == 200, response.text
    return {entry["agent_id"]: entry for entry in response.json()["agents"]}


async def _created(
    client: httpx.AsyncClient, helper_id: str, key: str, machine: str
) -> str:
    response = await _call(
        client, helper_id, "create_agent", bearer(key), _create_body(machine)
    )
    assert response.status_code == 200, response.text
    return response.json()["result"]["agent_id"]


class TestUpdateAgentDetail:
    async def test_profile_fields_change_on_any_agent_without_the_capability(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=False
        )
        target_id, _ = await _agent_with_key(
            harness, owner, "plain", can_manage_agents=False
        )

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {
                "agent_id": target_id,
                "description": "Plain agent",
                "display_name": "Plain",
                "icon_url": "https://example.com/plain.png",
                "addressing": "anyone",
            },
        )

        assert response.status_code == 200, response.text
        result = response.json()["result"]
        assert result["description"] == "Plain agent"
        assert result["display_name"] == "Plain"
        assert result["icon_url"] == "https://example.com/plain.png"
        assert result["managed"] is None
        row = await _agent_row(harness, "plain")
        assert row is not None
        assert row.addressing_policy is None

    async def test_a_definition_edit_bumps_the_revision_and_reaches_the_machine(
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
                "description": "Builds better things",
                "model": "opus",
                "advanced_config": {"effort": "high"},
                "instructions": "Build carefully.",
                "auto_approve": True,
                "directory": "/work/next",
                "desired_state": "stopped",
            },
        )

        assert response.status_code == 200, response.text
        result = response.json()["result"]
        assert result["description"] == "Builds better things"
        managed = result["managed"]
        assert managed["model"] == "opus"
        assert managed["advanced_config"] == {"effort": "high"}
        assert managed["desired_state"] == "stopped"
        assert managed["revision"] > before["revision"]
        after = (await _assigned(client, controller))[new_id]
        assert after["revision"] == managed["revision"]
        assert after["desired_state"] == "stopped"
        assert after["definition"]["model"] == "opus"
        assert after["definition"]["advanced_config"] == {"effort": "high"}
        assert after["definition"]["instructions"] == "Build carefully."
        assert after["definition"]["auto_approve"] is True
        assert after["definition"]["directory"] == "/work/next"
        assert after["definition"]["provider"] == "claude"

    async def test_moves_the_agent_to_another_machine(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        laptop = await enroll_console(harness, client, owner, name="laptop")
        desktop = await enroll_console(harness, client, owner, name="desktop")
        await _online(client, laptop)
        await _online(client, desktop)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "machine": "desktop"},
        )

        assert response.status_code == 200, response.text
        assert response.json()["result"]["managed"]["machine"] == {
            "id": desktop.controller_id,
            "name": "desktop",
            "state": "online",
        }
        assert new_id not in await _assigned(client, laptop)
        assert new_id in await _assigned(client, desktop)
        binding = harness.protocol.connections.controllers.binding(new_id)
        assert binding is not None
        assert binding.controller_id == desktop.controller_id

    async def test_a_placement_refusal_changes_nothing(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
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
            {"agent_id": new_id, "machine": "desktop", "description": "moved"},
        )

        assert response.status_code == 400, response.text
        detail = response.json()["detail"]
        assert detail.startswith("Nothing was changed: ")
        assert "(controller_offline)" in detail
        assert new_id in await _assigned(client, laptop)
        row = await _agent_row(harness, "builder")
        assert row is not None
        assert row.description == "Builds things"

    async def test_definition_fields_need_the_capability(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        creator_id, creator_key = await _agent_with_key(
            harness, owner, "creator", can_manage_agents=True
        )
        new_id = await _created(client, creator_id, creator_key, "laptop")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=False
        )

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "model": "opus", "description": "changed"},
        )

        assert response.status_code == 403, response.text
        assert (
            "Ask your owner to enable 'can manage agents' for helper"
            in response.json()["detail"]
        )
        row = await _agent_row(harness, "builder")
        assert row is not None
        assert row.description == "Builds things"

    async def test_definition_fields_are_refused_for_an_unmanaged_agent(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        target_id, _ = await _agent_with_key(
            harness, owner, "plain", can_manage_agents=False
        )

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": target_id, "instructions": "Do things."},
        )

        assert response.status_code == 400, response.text
        assert (
            "is not one of your owner's managed agents" in (response.json()["detail"])
        )

    async def test_another_owners_agent_is_refused(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        stranger = await add_member(harness.session_factory, "grace")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        target_id, _ = await _agent_with_key(
            harness, stranger, "theirs", can_manage_agents=False
        )

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": target_id, "description": "mine"},
        )

        assert response.status_code == 403, response.text

    async def test_advanced_config_is_checked_against_the_provider(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(
            client, controller, providers=[provider("claude"), provider("codex")]
        )
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")

        async def update(changes: dict[str, Any]) -> httpx.Response:
            return await _call(
                client,
                helper_id,
                "update_agent_detail",
                bearer(key),
                {"agent_id": new_id, **changes},
            )

        unknown = await update({"advanced_config": {"verbosity": "low"}})
        wrong_type = await update({"advanced_config": {"maxTurns": "ten"}})
        not_an_option = await update({"advanced_config": {"effort": "huge"}})
        on_create = await _call(
            client,
            helper_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", name="other", advanced_config={"color": "teal"}),
        )
        set_for_claude = await update(
            {"advanced_config": {"effort": "high", "permissionMode": "plan"}}
        )
        leftover = await update({"provider": "codex"})

        assert unknown.status_code == 400, unknown.text
        assert "claude has no setting 'verbosity'" in unknown.json()["detail"]
        assert wrong_type.status_code == 400, wrong_type.text
        assert (
            "claude setting 'maxTurns' must be a number"
            in (wrong_type.json()["detail"])
        )
        assert not_an_option.status_code == 400, not_an_option.text
        assert (
            "claude setting 'effort' must be one of" in (not_an_option.json()["detail"])
        )
        assert on_create.status_code == 400, on_create.text
        assert on_create.json()["detail"].startswith("Nothing was created: ")
        assert "claude setting 'color'" in on_create.json()["detail"]
        assert await _agent_row(harness, "other") is None
        assert set_for_claude.status_code == 200, set_for_claude.text
        assert leftover.status_code == 400, leftover.text
        assert "codex has no setting 'permissionMode'" in leftover.json()["detail"]
        definition = (await _assigned(client, controller))[new_id]["definition"]
        assert definition["provider"] == "claude"
        assert definition["advanced_config"] == {
            "effort": "high",
            "permissionMode": "plan",
        }


class TestGetAdvancedConfig:
    async def test_lists_the_providers_fields(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        codex = await _call(
            client, agent_id, "get_advanced_config", bearer(key), {"provider": "codex"}
        )
        cursor = await _call(
            client, agent_id, "get_advanced_config", bearer(key), {"provider": "cursor"}
        )
        unknown = await _call(
            client, agent_id, "get_advanced_config", bearer(key), {"provider": "vim"}
        )

        assert codex.status_code == 200, codex.text
        fields = codex.json()["result"]
        assert [field["key"] for field in fields] == [
            "effort",
            "verbosity",
            "reasoningSummary",
            "webSearch",
        ]
        assert fields[3]["options"] == [
            {"value": "", "label": "Default"},
            {"value": "true", "label": "On"},
            {"value": "false", "label": "Off"},
        ]
        assert cursor.status_code == 200, cursor.text
        assert cursor.json()["result"] == []
        assert unknown.status_code == 400, unknown.text
        assert "unknown provider 'vim'" in unknown.json()["detail"]
