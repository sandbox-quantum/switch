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
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import switch_core.official_templates as official_templates_package
from switch_core.addressing import (
    default_agent_policy,
    owner_only_policy,
    parse_policy,
)
from switch_core.bridges.agent.commands import _cmd_agent_change
from switch_core.bridges.agent.mcp.server import mcp
from switch_core.bridges.agent.operations import agent_management as agent_ops
from switch_core.bridges.agent.operations import all_operations, definitions
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.agent_management import (
    disable_agent_management,
)
from switch_core.bridges.agent.protocol.agent_detail import addressing_policy_for
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.clients import agent_admin
from switch_core.clients.actor import SystemActor
from switch_core.clients.agent_admin import AgentRequests
from switch_core.clients.command_consumer import CommandConsumer
from switch_core.db.models import (
    Agent,
    AgentDefinition,
    ApiKey,
    AuditEvent,
    Client,
    Room,
    ServiceGrant,
    Template,
    TemplateInstall,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.template_install_store import TemplateInstallStore
from switch_core.delivery.send_limits import MessageTooLong
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway import rooms as gateway_rooms
from switch_core.gateway.rooms import router as rooms_router
from switch_core.official_templates import (
    current_revision,
    official_template,
    revisions,
)
from switch_core.transport import RoomRef
from tests.switch_core.connections.github_seed import connect_github
from tests.switch_core.management.harness import (
    TEST_KEYRING,
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


@dataclass
class OwnersDesk:
    """The room an agent asks its owner in, as the process wiring sets it up:
    what Switch posts there, and `!agent-change` sent by whoever a test says,
    answered by the command the Switch app runs."""

    harness: Harness
    room_id: str
    transport_room_id: str
    host: CommandConsumer
    posted: list[str] = field(default_factory=list)
    replies: list[str] = field(default_factory=list)

    async def in_person(self, user: User) -> str:
        """The sender id of `user` writing in Switch Console."""
        sender = f"@{user.name}-member:test"
        async with self.harness.session_factory() as session:
            if await ClientStore().get_by_transport_user_id(session, sender) is None:
                session.add(
                    Client(
                        transport_user_id=sender,
                        display_name=user.name,
                        type=MEMBER_CLIENT_TYPE,
                        user_id=user.id,
                    )
                )
                await session.commit()
        return sender

    async def send(self, sender: str, args: str) -> str:
        await _cmd_agent_change(
            self.host,  # type: ignore[arg-type]
            RoomRef(room_id=self.transport_room_id),
            SimpleNamespace(  # type: ignore[arg-type]
                command="agent-change",
                args=args,
                user_id=sender,
                user_name="someone",
                thread_id=None,
            ),
            False,
        )
        return self.replies[-1]


@pytest.fixture
async def desk(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> OwnersDesk:
    async with harness.session_factory() as session:
        room = Room(transport_room_id="!desk:test", name="desk", description="desk")
        session.add(room)
        await session.commit()
        room_id = room.id

    async def connected() -> str:
        return room_id

    monkeypatch.setattr(definitions, "require_connected_room", connected)
    monkeypatch.setattr(agent_ops, "require_connected_room", connected)
    harness.protocol.agent_requests = AgentRequests()
    host = object.__new__(CommandConsumer)
    seat = OwnersDesk(
        harness=harness, room_id=room_id, transport_room_id="!desk:test", host=host
    )

    admin = object.__new__(SystemActor)

    async def send_admin(_room: str, body: str, **_kw: Any) -> str:
        seat.posted.append(body)
        return "$posted"

    admin.send_admin = send_admin  # type: ignore[method-assign]
    harness.protocol.client_lifecycle.get_by_type = (  # type: ignore[attr-defined]
        lambda client_type, _tenant: [admin] if client_type == "admin" else []
    )

    async def reply_command(_room: str, body: str, **_kw: Any) -> None:
        seat.replies.append(body)

    async def resolve_room_meta(_transport_room_id: str) -> Any:
        return SimpleNamespace(room_id=room_id)

    host.actor = SimpleNamespace(  # type: ignore[assignment]
        session_factory=harness.session_factory, client_store=ClientStore()
    )
    host._agent_requests = harness.protocol.agent_requests
    host._agent_store = AgentStore()
    host._room_store = RoomStore()
    host._room_role_store = RoomRoleStore()
    host._external_user_store = ExternalUserStore()
    host._connections = harness.protocol.connections
    host._resolve_room_meta = resolve_room_meta  # type: ignore[method-assign]
    host.reply_command = reply_command  # type: ignore[method-assign]
    return seat


async def _audited(harness: Harness, action: str) -> list[AuditEvent]:
    async with harness.session_factory() as session:
        return list(
            (
                await session.execute(
                    select(AuditEvent)
                    .where(AuditEvent.action == action)
                    .order_by(AuditEvent.occurred_at)
                )
            )
            .scalars()
            .all()
        )


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
                provider("claude", auth_problem="Said before a given login worked."),
                provider("codex", auth="missing", auth_problem="In the OS keyring."),
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
                    "problem": None,
                },
                {
                    "provider": "codex",
                    "installed": True,
                    "version": "1.0.0",
                    "auth": "missing",
                    "problem": "In the OS keyring.",
                },
                {
                    "provider": "cursor",
                    "installed": False,
                    "version": None,
                    "auth": "ok",
                    "problem": None,
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
        assert created.addressing_policy == default_agent_policy().model_dump()
        # The agent that made it, which has the same owner, can address it.
        assert parse_policy(created.addressing_policy).allows(
            room_id="any-room",
            group_id=None,
            sender_kind="agent",
            sender_id=agent_id,
            sender_user_ids=[],
            sender_owner_user_id=owner.id,
            owner_user_id=owner.id,
        )
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
        assert row.definition["directory"] == f"{WORKSPACES_DIR}/builder"
        assert row.definition["auto_mode"] is True
        assert row.definition["auto_approve"] is False
        binding = harness.protocol.connections.controllers.binding(created.id)
        assert binding is not None
        assert binding.controller_id == controller.controller_id

    async def test_auto_mode_can_be_left_off(
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
            _create_body("laptop", auto_mode=False),
        )

        assert response.status_code == 200, response.text
        new_id = response.json()["result"]["agent_id"]
        definition = (await _assigned(client, controller))[new_id]["definition"]
        assert (definition["auto_mode"], definition["auto_approve"]) == (False, False)

    @pytest.mark.parametrize(("written", "expected"), [(None, False), (True, True)])
    async def test_an_opencode_agent_asks_unless_auto_mode_is_asked_for(
        self,
        harness: Harness,
        client: httpx.AsyncClient,
        written: bool | None,
        expected: bool,
    ) -> None:
        # OpenCode's auto mode reviews nothing before a command runs.
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller, providers=[provider("opencode")])
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        given = {} if written is None else {"auto_mode": written}

        response = await _call(
            client,
            agent_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", provider="opencode", **given),
        )

        assert response.status_code == 200, response.text
        new_id = response.json()["result"]["agent_id"]
        definition = (await _assigned(client, controller))[new_id]["definition"]
        assert (definition["auto_mode"], definition["auto_approve"]) == (
            expected,
            False,
        )

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
            (
                [
                    provider(
                        "claude",
                        auth="missing",
                        auth_problem="An administrator pins where it keeps logins.",
                    )
                ],
                "provider_login_missing",
                "claude cannot be used on machine 'laptop'; your owner needs to fix "
                "this there: An administrator pins where it keeps logins.",
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
        climbing = await _call(
            client,
            agent_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", directory="/work/../etc"),
        )

        assert climbing.status_code == 400, climbing.text
        assert climbing.json()["detail"].startswith("Nothing was created: ")
        assert "'..' segment" in climbing.json()["detail"]
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
            "auto_mode": True,
            "auto_approve": False,
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

    async def test_an_agent_cannot_change_itself(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        for change in (
            {"auto_approve": True},
            {"addressing": "anyone"},
            {"description": "Mine now"},
        ):
            response = await _call(
                client,
                helper_id,
                "update_agent_detail",
                bearer(key),
                {"agent_id": helper_id, **change},
            )

            assert response.status_code == 403, response.text
            assert "can't change its own settings" in response.json()["detail"]
        row = await _agent_row(harness, "helper")
        assert row is not None
        assert row.description != "Mine now"

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
                "desired_state": "stopped",
            },
        )

        assert response.status_code == 200, response.text
        result = response.json()["result"]
        assert "awaiting_confirmation" not in result
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
        assert after["definition"]["provider"] == "claude"

    async def test_auto_mode_alone_can_be_turned_off_and_on(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")
        in_person = await desk.in_person(owner)

        async def set_auto_mode(on: bool) -> dict[str, Any]:
            response = await _call(
                client,
                helper_id,
                "update_agent_detail",
                bearer(key),
                {"agent_id": new_id, "auto_mode": on},
            )
            assert response.status_code == 200, response.text
            # Off is the safer direction and applies at once; on waits for
            # the owner.
            waits = "awaiting_confirmation" in response.json()["result"]
            assert waits is on
            if waits:
                await desk.send(in_person, "builder confirm")
            [listed] = [
                entry
                for entry in (
                    await _call(client, helper_id, "list_managed_agents", bearer(key))
                ).json()["result"]
                if entry["agent_id"] == new_id
            ]
            return listed

        off = await set_auto_mode(False)
        assigned_off = (await _assigned(client, controller))[new_id]["definition"]
        on = await set_auto_mode(True)
        assigned_on = (await _assigned(client, controller))[new_id]["definition"]

        assert (off["auto_mode"], off["auto_approve"]) == (False, False)
        assert (assigned_off["auto_mode"], assigned_off["auto_approve"]) == (
            False,
            False,
        )
        assert on["auto_mode"] is True
        assert assigned_on["auto_mode"] is True
        assert on["revision"] > off["revision"]

    async def test_an_agent_from_before_auto_mode_keeps_it_off(
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
            older = {k: v for k, v in row.definition.items() if k != "auto_mode"}
            await session.execute(
                update(AgentDefinition)
                .where(AgentDefinition.agent_id == new_id)
                .values(definition=older)
            )
            await session.commit()

        [listed] = (
            await _call(client, helper_id, "list_managed_agents", bearer(key))
        ).json()["result"]
        assigned = (await _assigned(client, controller))[new_id]["definition"]
        viewed = await client.get(
            f"/gateway/management/agents/{new_id}", cookies=cookies_for(owner)
        )
        edited = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "model": "opus"},
        )
        after = (await _assigned(client, controller))[new_id]["definition"]

        assert listed["auto_mode"] is False
        assert assigned["auto_mode"] is False
        assert viewed.status_code == 200, viewed.text
        assert viewed.json()["definition"]["auto_mode"] is False
        assert edited.status_code == 200, edited.text
        assert edited.json()["result"]["managed"]["auto_mode"] is False
        assert (after["model"], after["auto_mode"]) == ("opus", False)

    async def test_moves_the_agent_to_another_machine(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
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
        waiting = await _assigned(client, laptop)
        await desk.send(await desk.in_person(owner), "builder confirm")

        assert response.status_code == 200, response.text
        assert response.json()["result"]["managed"]["machine"]["name"] == "laptop"
        assert new_id in waiting
        [listed] = (
            await _call(client, helper_id, "list_managed_agents", bearer(key))
        ).json()["result"]
        assert listed["machine"] == {
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
            {"advanced_config": {"effort": "high", "maxTurns": 10}}
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
        assert "codex has no setting 'maxTurns'" in leftover.json()["detail"]
        definition = (await _assigned(client, controller))[new_id]["definition"]
        assert definition["provider"] == "claude"
        assert definition["advanced_config"] == {"effort": "high", "maxTurns": 10}


class TestTheOwnerConfirms:
    """An agent may ask to change what another agent may do on its own; only
    the owner, in person, makes it so (`agent_change_requests`)."""

    async def _builder(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> tuple[User, EnrolledController, str, str, str]:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")
        return owner, controller, helper_id, key, new_id

    async def test_bypass_and_a_folder_wait_for_the_owner(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        before = (await _assigned(client, controller))[new_id]

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {
                "agent_id": new_id,
                "auto_approve": True,
                "directory": "/home/ada/.ssh",
                "model": "opus",
                "description": "Reads everything",
            },
        )

        assert response.status_code == 200, response.text
        result = response.json()["result"]
        held = result["awaiting_confirmation"]
        assert held["status"] == "awaiting_confirmation"
        assert held["owner"] == "ada"
        assert held["confirm_with"] == "!agent-change builder confirm"
        assert held["needs_confirmation_for"] == ["auto_approve", "directory"]
        assert set(held["fields"]) == {"auto_approve", "directory", "model"}
        assert "ada" in held["message"]
        # The managed change waits whole; the description is not managed.
        assert result["description"] == "Reads everything"
        assert result["managed"]["auto_approve"] is False
        assert result["managed"]["model"] is None
        after = (await _assigned(client, controller))[new_id]
        assert after["revision"] == before["revision"]
        assert after["definition"]["auto_approve"] is False
        [notice] = desk.posted
        assert "asks to change" in notice
        assert "bypass mode on" in notice
        assert "`/home/ada/.ssh`" in notice
        assert "`!agent-change builder confirm`" in notice
        [asked] = await _audited(harness, "agent.change_requested")
        assert asked.target_id == new_id
        assert asked.actor_user_id is None
        assert asked.details["requested_by_agent_id"] == helper_id
        assert asked.details["needs_confirmation_for"] == ["auto_approve", "directory"]

    async def test_the_owner_confirming_makes_it_so(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True, "directory": "/srv/builds"},
        )

        shown = await desk.send(await desk.in_person(owner), "builder")
        reply = await desk.send(await desk.in_person(owner), "@builder confirm")

        assert "bypass mode on" in shown
        assert reply.startswith("Changed `builder`, as helper asked")
        definition = (await _assigned(client, controller))[new_id]["definition"]
        assert (definition["auto_approve"], definition["directory"]) == (
            True,
            "/srv/builds",
        )
        [confirmed] = await _audited(harness, "agent.change_confirmed")
        assert confirmed.actor_user_id == owner.id
        assert confirmed.details["requested_by_agent_name"] == "helper"
        assert await desk.send(await desk.in_person(owner), "builder confirm") == (
            "No change to `builder` is waiting to be confirmed in this room. A "
            "change an agent asks for lapses after 2 minutes."
        )

    async def test_nobody_but_the_owner_confirms(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        admin = await add_member(harness.session_factory, "root")
        async with harness.session_factory() as session:
            await session.execute(
                update(User).where(User.id == admin.id).values(role="admin")
            )
            helper = await session.get(Agent, helper_id)
            assert helper is not None
            helper_client = await session.get(Client, helper.client_id)
            assert helper_client is not None
            await session.commit()
        await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True},
        )

        by_itself = await desk.send(helper_client.transport_user_id, "builder confirm")
        by_an_admin = await desk.send(await desk.in_person(admin), "builder confirm")
        by_nobody = await desk.send("@nobody:test", "builder drop")

        for refused in (by_itself, by_an_admin, by_nobody):
            assert "Only the agent's owner" in refused
            assert "Nothing was changed" in refused
        assert (await _assigned(client, controller))[new_id]["definition"][
            "auto_approve"
        ] is False
        assert desk.host._agent_requests.waiting_change(desk.room_id, "builder")

    @pytest.mark.parametrize(
        ("suspended", "told"),
        [
            ("owner", "Your account is suspended"),
            ("helper", "`helper`, which asked for it, is suspended"),
            ("builder", "`builder` is suspended"),
        ],
    )
    async def test_nothing_is_made_once_someone_in_it_is_suspended(
        self,
        harness: Harness,
        client: httpx.AsyncClient,
        desk: OwnersDesk,
        suspended: str,
        told: str,
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True},
        )
        async with harness.session_factory() as session:
            table, row_id = {
                "owner": (User, owner.id),
                "helper": (Agent, helper_id),
                "builder": (Agent, new_id),
            }[suspended]
            await session.execute(
                update(table)
                .where(table.id == row_id)
                .values(suspended_at=datetime.now(UTC), suspended_by_role="admin")
            )
            await session.commit()

        reply = await desk.send(await desk.in_person(owner), "builder confirm")

        assert reply == (
            f"⚠️ {told}, so the change helper asked for was dropped. Nothing was "
            "changed."
        )
        assert desk.host._agent_requests.waiting_change(desk.room_id, "builder") is None
        assert (await _assigned(client, controller))[new_id]["definition"][
            "auto_approve"
        ] is False
        assert await _audited(harness, "agent.change_confirmed") == []

    async def test_nothing_waits_in_a_room_that_takes_no_commands(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        """A frozen room takes no `!agent-change`, so nothing is held there
        for the owner to confirm."""
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        async with harness.session_factory() as session:
            await session.execute(
                update(Room)
                .where(Room.id == desk.room_id)
                .values(frozen_at=datetime.now(UTC))
            )
            await session.commit()

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True},
        )

        assert response.status_code == 403, response.text
        assert "is frozen" in response.json()["detail"]
        assert desk.posted == []
        assert desk.host._agent_requests.waiting_change(desk.room_id, "builder") is None

    async def test_the_owner_may_drop_it(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True},
        )

        reply = await desk.send(await desk.in_person(owner), "builder drop")

        assert reply.startswith("Dropped the change helper asked for")
        assert desk.host._agent_requests.waiting_change(desk.room_id, "builder") is None
        assert (await _assigned(client, controller))[new_id]["definition"][
            "auto_approve"
        ] is False

    async def test_it_lapses(
        self,
        harness: Harness,
        client: httpx.AsyncClient,
        desk: OwnersDesk,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        now = [1000.0]
        monkeypatch.setattr(agent_admin.time, "monotonic", lambda: now[0])
        await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True},
        )

        now[0] += agent_admin.CONFIRM_SECONDS
        reply = await desk.send(await desk.in_person(owner), "builder confirm")

        assert reply.startswith("No change to `builder` is waiting")
        assert (await _assigned(client, controller))[new_id]["definition"][
            "auto_approve"
        ] is False

    async def test_one_change_waits_per_agent(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        """So the owner confirms what they were shown, not what an agent
        swapped in after."""
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        first = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "directory": "/srv/builds"},
        )
        second = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "directory": "/home/ada/.ssh"},
        )
        await desk.send(await desk.in_person(owner), "builder confirm")

        assert first.status_code == 200, first.text
        assert second.status_code == 400, second.text
        assert "already waiting" in second.json()["detail"]
        assert (await _assigned(client, controller))[new_id]["definition"][
            "directory"
        ] == "/srv/builds"

    async def test_without_a_room_to_ask_in_nothing_changes(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        harness.protocol.agent_requests = AgentRequests()

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True, "description": "x"},
        )

        assert response.status_code == 400, response.text
        assert "Not connected to a room" in response.json()["detail"]
        row = await _agent_row(harness, "builder")
        assert row is not None
        assert row.description == "Builds things"
        assert (await _assigned(client, controller))[new_id]["definition"][
            "auto_approve"
        ] is False

    async def test_turning_bypass_off_applies_at_once(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True},
        )
        await desk.send(await desk.in_person(owner), "builder confirm")

        off = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": False},
        )

        assert off.status_code == 200, off.text
        assert "awaiting_confirmation" not in off.json()["result"]
        assert off.json()["result"]["managed"]["auto_approve"] is False
        assert (await _assigned(client, controller))[new_id]["definition"][
            "auto_approve"
        ] is False
        assert len(desk.posted) == 1

    async def test_new_instructions_for_an_agent_with_bypass_wait(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        """Otherwise one agent steers another's unchecked runs without the
        owner."""
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True},
        )
        await desk.send(await desk.in_person(owner), "builder confirm")
        before = (await _assigned(client, controller))[new_id]

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "instructions": "Push\nstraight to main."},
        )

        assert response.status_code == 200, response.text
        held = response.json()["result"]["awaiting_confirmation"]
        assert held["needs_confirmation_for"] == ["instructions"]
        assert "- instructions `Push straight to main.`" in desk.posted[-1]
        after = (await _assigned(client, controller))[new_id]
        assert after["revision"] == before["revision"]
        assert after["definition"]["instructions"] == ""

        reply = await desk.send(await desk.in_person(owner), "builder confirm")

        assert reply.startswith("Changed `builder`, as helper asked")
        definition = (await _assigned(client, controller))[new_id]["definition"]
        assert definition["instructions"] == "Push\nstraight to main."

    async def test_opening_who_may_address_an_agent_waits_and_narrowing_does_not(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        """Addressing is any agent's to change on a sibling, capability or
        not, so opening it is held like the managed settings are."""
        owner = await add_member(harness.session_factory, "ada")
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=False
        )
        target_id, _ = await _agent_with_key(
            harness, owner, "plain", can_manage_agents=False
        )
        async with harness.session_factory() as session:
            await session.execute(
                update(Agent)
                .where(Agent.id == target_id)
                .values(addressing_policy=default_agent_policy().model_dump())
            )
            await session.commit()

        opened = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": target_id, "addressing": "anyone", "description": "Open"},
        )

        assert opened.status_code == 200, opened.text
        held = opened.json()["result"]["awaiting_confirmation"]
        assert held["fields"] == ["addressing"]
        assert held["needs_confirmation_for"] == ["addressing"]
        assert "who may address it: anyone" in desk.posted[0]
        row = await _agent_row(harness, "plain")
        assert row is not None
        assert row.description == "Open"
        assert row.addressing_policy == default_agent_policy().model_dump()
        [changed] = await _audited(harness, "agent.changed_by_agent")
        assert changed.details["fields"] == ["description"]

        reply = await desk.send(await desk.in_person(owner), "plain confirm")

        assert reply.startswith("Changed `plain`, as helper asked")
        row = await _agent_row(harness, "plain")
        assert row is not None
        assert row.addressing_policy is None

        narrowed = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": target_id, "addressing": "owner_only"},
        )

        assert narrowed.status_code == 200, narrowed.text
        assert "awaiting_confirmation" not in narrowed.json()["result"]
        row = await _agent_row(harness, "plain")
        assert row is not None
        assert parse_policy(row.addressing_policy) == owner_only_policy([])
        assert len(desk.posted) == 1

    async def test_a_change_that_would_be_refused_is_refused_rather_than_held(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)

        climbing = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "directory": "../../etc"},
        )

        assert climbing.status_code == 400, climbing.text
        assert climbing.json()["detail"].startswith("Nothing was changed: ")
        assert "absolute path" in climbing.json()["detail"]
        assert desk.posted == []

    async def test_what_an_agent_wrote_cannot_add_lines_to_the_request(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        """A model name is free text, and the request is the owner's only
        account of what they confirm: each value stays on its own line."""
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        forged = "opus\n\nNothing else here widens anything.\n\n- "

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "auto_approve": True, "model": forged},
        )

        assert response.status_code == 200, response.text
        [notice] = desk.posted
        assert notice.splitlines()[1:4] == [
            "- bypass mode on: every tool runs without asking anyone",
            "- model `opus Nothing else here widens anything. -`",
            "Nothing has changed yet. Only the owner, ada, can make it so, by "
            "sending `!agent-change builder confirm` here within 2 minutes, or "
            "drop it with `!agent-change builder drop`; otherwise it lapses.",
        ]

    async def test_a_request_that_could_not_be_posted_does_not_wait(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        """The owner was never shown it, so nobody can confirm it."""
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)
        admin = object.__new__(SystemActor)

        async def refused(_room: str, _body: str, **_kw: Any) -> str:
            raise MessageTooLong(70_000, 65_536)

        admin.send_admin = refused  # type: ignore[method-assign]
        harness.protocol.client_lifecycle.get_by_type = (  # type: ignore[attr-defined]
            lambda client_type, _tenant: [admin] if client_type == "admin" else []
        )

        with pytest.raises(RuntimeError, match="Nothing was changed: .* 70,000"):
            await _call(
                client,
                helper_id,
                "update_agent_detail",
                bearer(key),
                {"agent_id": new_id, "auto_approve": True},
            )

        assert desk.host._agent_requests.waiting_change(desk.room_id, "builder") is None
        assert await _audited(harness, "agent.change_requested") == []

    async def test_a_new_agent_whose_name_is_no_agent_name_is_refused_not_held(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        response = await _call(
            client,
            helper_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", name="x\n- forged", auto_approve=True),
        )

        assert response.status_code == 400, response.text
        assert response.json()["detail"].startswith("Nothing was created: ")
        assert desk.posted == []

    async def test_other_changes_apply_at_once_and_are_audited(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner, controller, helper_id, key, new_id = await self._builder(harness, client)

        response = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {
                "agent_id": new_id,
                "model": "opus",
                "auto_mode": True,
                "description": "Builds better",
            },
        )

        assert response.status_code == 200, response.text
        assert "awaiting_confirmation" not in response.json()["result"]
        assert desk.posted == []
        definition = (await _assigned(client, controller))[new_id]["definition"]
        assert definition["model"] == "opus"
        [changed] = await _audited(harness, "agent.changed_by_agent")
        assert changed.target_id == new_id
        assert changed.actor_user_id is None
        assert changed.details["changed_by_agent_id"] == helper_id
        assert set(changed.details["fields"]) == {"description", "model", "auto_mode"}
        [created] = await _audited(harness, "agent.created_by_agent")
        assert created.target_id == new_id
        assert created.details["created_by_agent_name"] == "helper"

    async def test_a_new_agent_with_bypass_or_its_own_folder_waits(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        bypass = await _call(
            client,
            helper_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", auto_approve=True),
        )
        folder = await _call(
            client,
            helper_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", name="reader", directory="/home/ada/project"),
        )
        own = await _call(
            client,
            helper_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", name="plain", directory=f"{WORKSPACES_DIR}/plain"),
        )

        assert bypass.status_code == 200, bypass.text
        assert bypass.json()["result"]["status"] == "awaiting_confirmation"
        assert bypass.json()["result"]["machine"] == {
            "id": controller.controller_id,
            "name": "laptop",
        }
        assert folder.json()["result"]["needs_confirmation_for"] == ["directory"]
        assert await _agent_row(harness, "builder") is None
        assert await _agent_row(harness, "reader") is None
        assert own.json()["result"]["name"] == "plain"
        assert len(desk.posted) == 2
        assert "asks to create the agent `builder`" in desk.posted[0]

        reply = await desk.send(await desk.in_person(owner), "builder confirm")

        assert reply.startswith("Created `builder`, as helper asked")
        created = await _agent_row(harness, "builder")
        assert created is not None
        assert (await _assigned(client, controller))[created.id]["definition"][
            "auto_approve"
        ] is True
        [confirmed] = await _audited(harness, "agent.change_confirmed")
        assert confirmed.details["agent_name"] == "builder"

    async def test_a_new_agent_with_the_providers_own_bypass_waits(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        """`permissionMode: bypassPermissions` skips every check as bypass
        mode does, so it waits for the owner on its own, with no bypass mode
        and no folder beside it."""
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        response = await _call(
            client,
            helper_id,
            "create_agent",
            bearer(key),
            _create_body(
                "laptop", advanced_config={"permissionMode": "bypassPermissions"}
            ),
        )

        assert response.status_code == 200, response.text
        held = response.json()["result"]
        assert held["status"] == "awaiting_confirmation"
        assert held["needs_confirmation_for"] == ["advanced_config"]
        assert held["confirm_with"] == "!agent-change builder confirm"
        assert await _agent_row(harness, "builder") is None
        assert await _audited(harness, "agent.created_by_agent") == []
        [notice] = desk.posted
        assert "asks to create the agent `builder`" in notice
        assert "permissionMode=bypassPermissions" in notice

        reply = await desk.send(await desk.in_person(owner), "builder confirm")

        assert reply.startswith("Created `builder`, as helper asked")
        created = await _agent_row(harness, "builder")
        assert created is not None
        definition = (await _assigned(client, controller))[created.id]["definition"]
        assert definition["advanced_config"] == {"permissionMode": "bypassPermissions"}
        assert definition["auto_approve"] is False

    async def test_the_providers_own_bypass_on_an_agent_waits(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
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
                "advanced_config": {"permissionMode": "bypassPermissions"},
            },
        )

        assert response.status_code == 200, response.text
        result = response.json()["result"]
        held = result["awaiting_confirmation"]
        assert held["needs_confirmation_for"] == ["advanced_config"]
        assert result["managed"]["advanced_config"] == {}
        after = (await _assigned(client, controller))[new_id]
        assert after["revision"] == before["revision"]
        assert after["definition"]["advanced_config"] == {}
        [notice] = desk.posted
        assert "permissionMode=bypassPermissions" in notice

        await desk.send(await desk.in_person(owner), "builder confirm")

        confirmed = (await _assigned(client, controller))[new_id]["definition"]
        assert confirmed["advanced_config"] == {"permissionMode": "bypassPermissions"}

    async def test_the_providers_own_auto_mode_waits_and_turning_it_off_does_not(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        """`permissionMode: auto` lets the provider's own review decide, as
        `auto_mode` does, so turning it on waits as turning `auto_mode` on
        does."""
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        new_id = await _created(client, helper_id, key, "laptop")
        before = (await _assigned(client, controller))[new_id]

        on = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "advanced_config": {"permissionMode": "auto"}},
        )

        assert on.status_code == 200, on.text
        held = on.json()["result"]["awaiting_confirmation"]
        assert held["needs_confirmation_for"] == ["advanced_config"]
        after = (await _assigned(client, controller))[new_id]
        assert after["revision"] == before["revision"]
        assert after["definition"]["advanced_config"] == {}
        [notice] = desk.posted
        assert "permissionMode=auto" in notice

        await desk.send(await desk.in_person(owner), "builder confirm")
        confirmed = (await _assigned(client, controller))[new_id]["definition"]
        assert confirmed["advanced_config"] == {"permissionMode": "auto"}

        off = await _call(
            client,
            helper_id,
            "update_agent_detail",
            bearer(key),
            {"agent_id": new_id, "advanced_config": {"permissionMode": "default"}},
        )

        assert off.status_code == 200, off.text
        assert "awaiting_confirmation" not in off.json()["result"]
        assert off.json()["result"]["managed"]["advanced_config"] == {
            "permissionMode": "default"
        }
        assert len(desk.posted) == 1

    async def test_a_new_agent_in_the_providers_own_auto_mode_is_made_at_once(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        """As a new agent in auto mode is: it is made in auto mode unless it
        says otherwise."""
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        response = await _call(
            client,
            helper_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", advanced_config={"permissionMode": "auto"}),
        )

        assert response.status_code == 200, response.text
        created = response.json()["result"]
        assert created["name"] == "builder"
        definition = (await _assigned(client, controller))[created["agent_id"]][
            "definition"
        ]
        assert definition["advanced_config"] == {"permissionMode": "auto"}
        assert desk.posted == []

    async def test_a_new_agent_that_would_be_refused_is_refused_rather_than_held(
        self, harness: Harness, client: httpx.AsyncClient, desk: OwnersDesk
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        helper_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )

        offline = await _call(
            client,
            helper_id,
            "create_agent",
            bearer(key),
            _create_body("nowhere", auto_approve=True),
        )
        taken = await _call(
            client,
            helper_id,
            "create_agent",
            bearer(key),
            _create_body("laptop", name="helper", auto_approve=True),
        )

        assert offline.status_code == 400, offline.text
        assert (
            "has no machine with the id or name 'nowhere'" in (offline.json()["detail"])
        )
        assert taken.status_code == 400, taken.text
        assert "already exists" in taken.json()["detail"]
        assert desk.posted == []


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


SOLO_TEMPLATE = """\
params:
  where: { type: machine, default: [$first] }
agent:
  name: solo
  description: Works alone
  instructions: Work alone.
  provider: claude
  directory: "{$agents_dir}/{agent}"
  isolation: isolated
  addressing: owner-agents
  repo: https://github.com/acme/widgets
  connections:
    - { service: github, repos: [acme/widgets] }
"""


class _NoRooms:
    """The room half of the template engine, for templates with no room:
    only the builtins an agent's fields may read."""

    async def builtins_for(self, **kwargs: Any) -> dict[str, str]:
        return {"$creator": kwargs["name"], "$creator_email": kwargs["email"]}

    async def resolve_defaults(
        self, text: str, inputs: dict[str, Any] | None, **kwargs: Any
    ) -> dict[str, Any] | None:
        return inputs


async def _template(harness: Harness, owner: User, content: str) -> str:
    harness.protocol.config.template_max_bytes = 64 * 1024  # type: ignore[attr-defined]
    harness.protocol.config.feature_flags = {
        "agent_management": True,
        "switch_buddy": False,
        "additional_agent_providers": True,
    }  # type: ignore[attr-defined]
    harness.protocol.room_yaml_service = _NoRooms  # type: ignore[assignment,method-assign]
    async with harness.session_factory() as session:
        template = Template(
            owner_id=owner.id,
            name="solo",
            description="One agent",
            kind="agent",
            content=content,
        )
        session.add(template)
        await session.commit()
        return template.id


@pytest.fixture
def _short_listen(monkeypatch: pytest.MonkeyPatch) -> None:
    """No agent client starts in these tests; do not wait long for one."""
    monkeypatch.setattr(definitions, "LISTEN_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(gateway_rooms, "LISTEN_TIMEOUT_SECONDS", 0.1)


@pytest.mark.usefixtures("_short_listen")
class TestRunTemplateCreatesManagedAgents:
    """A template run through the real management service and broker: the
    agent is created on the owner's machine with its definition, addressing
    and GitHub grant, or refused with management's reason and nothing made."""

    async def test_creates_the_agent_with_its_definition_and_grant(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        harness.protocol.service_broker = harness.broker
        owner = await add_member(harness.session_factory, "ada")
        async with harness.session_factory() as session:
            await connect_github(session, owner.id, TEST_KEYRING)
            await session.commit()
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        template_id = await _template(harness, owner, SOLO_TEMPLATE)

        response = await _call(
            client,
            agent_id,
            "run_template",
            bearer(key),
            {"template_id": template_id},
        )

        assert response.status_code == 200, response.text
        (created,) = response.json()["result"]["created_agents"]
        assert created["name"] == "solo"
        assert created["machine"] == {"id": controller.controller_id, "name": "laptop"}
        agent = await _agent_row(harness, "solo")
        assert agent is not None and agent.owner_id == owner.id
        assert agent.addressing_policy == addressing_policy_for(
            "owner_and_owner_agents"
        )
        async with harness.session_factory() as session:
            row = (
                await session.execute(
                    select(AgentDefinition).where(AgentDefinition.agent_id == agent.id)
                )
            ).scalar_one()
            grant = (
                await session.execute(
                    select(ServiceGrant).where(ServiceGrant.agent_id == agent.id)
                )
            ).scalar_one()
        assert row.controller_id == controller.controller_id
        assert row.definition["isolation"] == "isolated"
        assert row.definition["auto_mode"] is True
        assert row.definition["directory"] == f"{WORKSPACES_DIR}/solo"
        assert (
            "clone https://github.com/acme/widgets into it"
            in row.definition["instructions"]
        )
        assert (grant.service, grant.resources) == (
            "github",
            {"installation_id": 123, "repository_ids": [456]},
        )
        assert harness.vendor.resolved == [["acme/widgets"]]

    async def test_an_offline_machine_refuses_with_managements_reason(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        template_id = await _template(
            harness,
            owner,
            SOLO_TEMPLATE.replace(
                "  connections:\n    - { service: github, repos: [acme/widgets] }\n", ""
            ),
        )

        response = await _call(
            client,
            agent_id,
            "run_template",
            bearer(key),
            {"template_id": template_id, "inputs": {"where": controller.controller_id}},
        )

        assert response.status_code == 400, response.text
        detail = response.json()["detail"]
        assert detail.startswith("Nothing was created.")
        assert "(controller_offline)" in detail
        assert await _agent_row(harness, "solo") is None

    async def test_a_grant_the_owner_cannot_make_refuses_before_creating(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        harness.protocol.service_broker = harness.broker
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        agent_id, key = await _agent_with_key(
            harness, owner, "helper", can_manage_agents=True
        )
        template_id = await _template(harness, owner, SOLO_TEMPLATE)

        response = await _call(
            client, agent_id, "run_template", bearer(key), {"template_id": template_id}
        )

        assert response.status_code == 400, response.text
        detail = response.json()["detail"]
        # Never connected GitHub: the broker's reason, and no agent.
        assert "solo: github: Connect GitHub" in detail
        assert await _agent_row(harness, "solo") is None


def _gateway_agent(machine: str, name: str = "solo", **overrides: Any) -> dict:
    return {
        "slot": name,
        "name": name,
        "description": "Works alone",
        "display_name": None,
        "instructions": "Work alone.",
        "provider": "claude",
        "machine": machine,
        "model": None,
        "advanced_config": {},
        "isolation": "shared",
        "auto_approve": False,
        "directory": None,
        "addressing": "owner",
        "connections": [],
        **overrides,
    }


@pytest.mark.usefixtures("_short_listen")
class TestTheConsoleRunsATemplateWithAgents:
    """`POST /gateway/rooms/from-template`, the Use page's one request: the
    person's own machines, checked whole, refused with every problem."""

    @pytest.fixture(autouse=True)
    def _rooms(self, harness: Harness) -> None:
        harness.gateway_app.include_router(rooms_router, prefix="/rooms")
        harness.gateway_app.dependency_overrides[gw_deps.get_room_yaml_service] = (
            lambda: _NoRooms()
        )

    async def test_creates_the_agents_on_the_persons_machine(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)

        response = await client.post(
            "/gateway/rooms/from-template",
            json={
                "agents": [
                    _gateway_agent("laptop"),
                    _gateway_agent(
                        controller.controller_id,
                        name="pair",
                        isolation="isolated",
                        addressing="anyone",
                        auto_mode=False,
                    ),
                ],
                "yaml": None,
                "template_name": "duo",
            },
            cookies=cookies_for(owner),
        )

        assert response.status_code == 201, response.text
        body = response.json()
        assert [a["name"] for a in body["created_agents"]] == ["solo", "pair"]
        assert body["room"] is None
        pair = await _agent_row(harness, "pair")
        assert pair is not None and pair.owner_id == owner.id
        assert pair.addressing_policy is None
        solo = await _agent_row(harness, "solo")
        assert solo is not None
        assigned = await _assigned(client, controller)
        # `solo` is sent without `auto_mode`, as an older Console sends it.
        assert assigned[solo.id]["definition"]["auto_mode"] is True
        assert assigned[pair.id]["definition"]["auto_mode"] is False

    async def test_an_opencode_agent_sent_without_auto_mode_asks(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller, providers=[provider("opencode")])

        response = await client.post(
            "/gateway/rooms/from-template",
            json={
                "agents": [_gateway_agent("laptop", provider="opencode")],
                "yaml": None,
                "template_name": "solo",
            },
            cookies=cookies_for(owner),
        )

        assert response.status_code == 201, response.text
        solo = await _agent_row(harness, "solo")
        assert solo is not None
        assigned = await _assigned(client, controller)
        assert assigned[solo.id]["definition"]["auto_mode"] is False

    async def test_refuses_with_every_problem_and_creates_nothing(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(
            client, controller, providers=[provider("claude", auth="missing")]
        )

        response = await client.post(
            "/gateway/rooms/from-template",
            json={
                "agents": [
                    _gateway_agent("laptop"),
                    _gateway_agent("nowhere", name="pair"),
                    _gateway_agent("laptop", name="Bad Name"),
                ],
                "yaml": None,
                "template_name": "trio",
            },
            cookies=cookies_for(owner),
        )

        assert response.status_code == 409, response.text
        body = response.json()
        assert body["code"] == "agents_not_created"
        assert {(p["slot"], p["code"]) for p in body["problems"]} == {
            ("solo", "provider_login_missing"),
            ("pair", "not_found"),
            ("Bad Name", "invalid_name"),
        }
        assert await _agent_row(harness, "solo") is None


DOCUMENT_TEMPLATE = """\
version: 2
params:
  name: { type: string, default: Helper }
  machine: { type: machine, default: [$first] }
resources:
  helper:
    type: agent
    display_name: "{name}"
    instructions: Help.
    provider: claude
    machine: "{machine}"
    directory: "{$agents_dir}/{helper.name}"
    addressing: anyone
"""


@pytest.mark.usefixtures("_short_listen")
class TestTheConsoleRunsAVersion2Template:
    """`POST /gateway/rooms/from-template-document`: the server works the
    agents out of the document and the inputs, on the person's machines."""

    @pytest.fixture(autouse=True)
    def _rooms(self, harness: Harness) -> None:
        harness.gateway_app.include_router(rooms_router, prefix="/rooms")
        harness.gateway_app.dependency_overrides[gw_deps.get_room_yaml_service] = (
            lambda: _NoRooms()
        )

    async def test_creates_the_agent_on_the_first_machine_that_can_run_it(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)

        response = await client.post(
            "/gateway/rooms/from-template-document",
            json={
                "template": DOCUMENT_TEMPLATE,
                "inputs": {"name": "Ada helper"},
                "template_name": "helper",
            },
            cookies=cookies_for(owner),
        )

        assert response.status_code == 201, response.text
        (created,) = response.json()["created_agents"]
        assert created["name"] == "ada-helper"
        assert created["machine"]["name"] == "laptop"
        agent = await _agent_row(harness, "ada-helper")
        assert agent is not None and agent.addressing_policy is None

    async def test_no_machine_that_can_run_it_is_refused_with_the_reason(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(
            client, controller, providers=[provider("claude", auth="expired")]
        )

        response = await client.post(
            "/gateway/rooms/from-template-document",
            json={"template": DOCUMENT_TEMPLATE, "template_name": "helper"},
            cookies=cookies_for(owner),
        )

        assert response.status_code == 409, response.text
        body = response.json()
        assert {p["code"] for p in body["problems"]} == {"machine_unresolved"}
        assert "claude is not signed in on laptop" in body["detail"]


_OFFICIAL = Path(official_templates_package.__file__).parent


async def _installs(harness: Harness, template_id: str) -> list[Any]:
    async with harness.session_factory() as session:
        installs = await TemplateInstallStore().of_template(session, template_id)
        return [
            (install, await TemplateInstallStore().resources(session, install.id))
            for install in installs
        ]


def _buddy_document() -> str:
    buddy = official_template("official:switch-buddy", switch_buddy=True)
    assert buddy is not None
    return buddy.content


@pytest.mark.usefixtures("_short_listen")
class TestARunOfAKnownTemplateIsRecorded:
    """`POST /gateway/rooms/from-template-document` records the agents a run
    of a template it can vouch for created, to be updated from it later:
    the template the request names when the document is exactly that one,
    or an official template whose document it is word for word."""

    @pytest.fixture(autouse=True)
    def _rooms(self, harness: Harness) -> None:
        harness.gateway_app.include_router(rooms_router, prefix="/rooms")
        harness.gateway_app.dependency_overrides[gw_deps.get_room_yaml_service] = (
            lambda: _NoRooms()
        )

    async def _run(
        self,
        harness: Harness,
        client: httpx.AsyncClient,
        owner: User,
        document: str,
        **extra: Any,
    ) -> httpx.Response:
        controller = await enroll_console(harness, client, owner, name="laptop")
        await _online(client, controller)
        return await client.post(
            "/gateway/rooms/from-template-document",
            json={"template": document, "template_name": "t", **extra},
            cookies=cookies_for(owner),
        )

    async def test_switch_buddy_is_recorded_from_its_document_alone(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")

        response = await self._run(
            harness,
            client,
            owner,
            _buddy_document(),
            inputs={"agent_name": "switch-buddy-ada", "provider": "claude"},
        )

        assert response.status_code == 201, response.text
        ((install, resources),) = await _installs(harness, "official:switch-buddy")
        (created,) = response.json()["created_agents"]
        assert (install.source, install.owner_id, install.revision) == (
            "official",
            owner.id,
            current_revision("switch-buddy"),
        )
        assert install.inputs["agent_name"] == "switch-buddy-ada"
        (resource,) = resources
        assert (resource.key, resource.agent_id) == ("buddy", created["agent_id"])
        assert (
            resource.fingerprints
            == revisions.entry_for(_OFFICIAL / "switch-buddy")["agents"]["buddy"]
        )

    async def test_a_saved_template_named_by_id_is_recorded_at_its_version(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.session_factory() as session:
            template = Template(
                owner_id=owner.id,
                name="helper",
                description="d",
                kind="agent",
                content=DOCUMENT_TEMPLATE,
                version=3,
            )
            session.add(template)
            await session.commit()

        response = await self._run(
            harness, client, owner, DOCUMENT_TEMPLATE, template_id=template.id
        )

        assert response.status_code == 201, response.text
        ((install, resources),) = await _installs(harness, template.id)
        assert (install.source, install.template_name, install.revision) == (
            "saved",
            "helper",
            3,
        )
        assert [r.key for r in resources] == ["helper"]

    async def test_a_document_changed_from_the_template_it_names_is_not_recorded(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")

        response = await self._run(
            harness,
            client,
            owner,
            _buddy_document().replace("Your assistant", "My assistant"),
            inputs={"agent_name": "switch-buddy-ada", "provider": "claude"},
            template_id="official:switch-buddy",
        )

        assert response.status_code == 201, response.text
        assert await _installs(harness, "official:switch-buddy") == []

    async def test_a_document_of_no_known_template_is_not_recorded(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")

        response = await self._run(harness, client, owner, DOCUMENT_TEMPLATE)

        assert response.status_code == 201, response.text
        async with harness.session_factory() as session:
            assert (await session.execute(select(TemplateInstall))).first() is None

    async def test_a_template_the_caller_cannot_read_is_not_found(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        other = await add_member(harness.session_factory, "bob")
        async with harness.session_factory() as session:
            template = Template(
                owner_id=other.id,
                name="private",
                description="d",
                kind="agent",
                content=DOCUMENT_TEMPLATE,
                read_visibility="private",
            )
            session.add(template)
            await session.commit()

        response = await self._run(
            harness, client, owner, DOCUMENT_TEMPLATE, template_id=template.id
        )

        assert response.status_code == 404, response.text
        assert await _agent_row(harness, "helper") is None
