"""Templates that create managed agents, run by an agent.

Over the same fake protocol as the other template tool tests (real
PostgreSQL, the real template engine and run guards, no Matrix), with a fake
management port standing in for the owner's machines: what it refuses is
what management refuses, and an agent it creates is a real agent row.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import select, update

from switch_core.agent_refusals import AgentRefused
from switch_core.agent_templates import plan_template
from switch_core.bridges.agent.operations import definitions
from switch_core.bridges.agent.operations.agent_management import (
    disable_agent_management,
    enable_agent_management,
)
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import run_template
from switch_core.bridges.agent.protocol.agent_detail import addressing_policy_for
from switch_core.bridges.agent.protocol.agent_management import (
    AgentManagementRefused,
    CheckedPlacement,
    NewManagedAgent,
)
from switch_core.db.models import Agent, Room, Template
from switch_core.db.stores.template_install_store import TemplateInstallStore
from switch_core.official_templates import current_revision
from switch_core.template_installs import fingerprint
from switch_core.template_runs import AgentsNotCreated, RunUndone
from tests.switch_core.bridges.agent.operations.conftest import _make_agent

MACHINES = [
    {
        "id": "m-laptop",
        "name": "laptop",
        "state": "online",
        "providers": [{"provider": "claude", "installed": True, "auth": "ok"}],
    },
    {
        "id": "m-box",
        "name": "box",
        "state": "offline",
        "providers": [{"provider": "codex", "installed": True, "auth": "ok"}],
    },
    {
        "id": "m-server",
        "name": "server",
        "state": "online",
        "providers": [
            {"provider": "claude", "installed": True, "auth": "expired"},
            {"provider": "codex", "installed": True, "auth": "ok"},
        ],
    },
]


class FakeManagement:
    """The owner's machines as management would answer for them. A machine
    that is offline, or lacks a ready provider, refuses the placement with
    management's reason code."""

    def __init__(self, env: dict[str, Any]) -> None:
        self._env = env
        self.created: list[NewManagedAgent] = []
        self.fail_create: set[str] = set()

    def _machine(self, ref: str) -> dict[str, Any]:
        for machine in MACHINES:
            if ref in (machine["id"], machine["name"]):
                return machine
        raise AgentManagementRefused(
            "not_found",
            f"Nothing was created: your owner has no machine with the id or name '{ref}'.",
        )

    async def list_machines(self, tenant_id: str, owner_id: str) -> list[dict]:
        return MACHINES

    async def check_new_agent(
        self, tenant_id: str, owner_id: str, spec: NewManagedAgent
    ) -> CheckedPlacement:
        machine = self._machine(spec.machine)
        if machine["state"] != "online":
            raise AgentManagementRefused(
                "controller_offline",
                f"Nothing was created: machine '{machine['name']}' is not connected "
                "to Switch (controller_offline).",
            )
        entry = next(
            (p for p in machine["providers"] if p["provider"] == spec.provider), None
        )
        if entry is None:
            raise AgentManagementRefused(
                "provider_not_installed",
                f"Nothing was created: {spec.provider} is not installed on machine "
                f"'{machine['name']}' (provider_not_installed).",
            )
        if entry["auth"] == "expired":
            raise AgentManagementRefused(
                "provider_login_expired",
                f"Nothing was created: the {spec.provider} login on machine "
                f"'{machine['name']}' has expired (provider_login_expired).",
            )
        return CheckedPlacement(
            machine_id=machine["id"],
            machine_name=machine["name"],
            workspaces_dir="/home/me/agents",
        )

    async def create_agent(
        self, tenant_id: str, owner_id: str, spec: NewManagedAgent, protocol: Any
    ) -> dict[str, Any]:
        if spec.name in self.fail_create:
            raise AgentManagementRefused(
                "controller_offline",
                f"Nothing was created: machine '{spec.machine}' went offline.",
            )
        self.created.append(spec)
        async with self._env["session_factory"]() as session:
            agent = await _make_agent(session, spec.name, owner_id, owner_id)
            agent.addressing_policy = addressing_policy_for("owner_only")
            await session.commit()
            agent_id = agent.id
        machine = self._machine(spec.machine)
        return {
            "agent_id": agent_id,
            "name": spec.name,
            "machine": {"id": machine["id"], "name": machine["name"]},
            "desired_state": "running",
            "hint": "",
        }


class ListeningActor:
    """A new agent's client, taking events once it has started."""

    def __init__(self, order: list[str], name: str) -> None:
        self._order = order
        self._name = name

    async def wait_receiving(self, timeout: float) -> bool:
        self._order.append(f"listening {self._name}")
        return True


@pytest_asyncio.fixture
async def managed(env, monkeypatch):
    monkeypatch.setattr(definitions, "LISTEN_TIMEOUT_SECONDS", 0.2)
    env["protocol"].config = SimpleNamespace(
        template_max_bytes=64 * 1024,
        feature_flags={"agent_management": True, "switch_buddy": True},
    )
    env["protocol"].telemetry = None
    env["protocol"].service_broker = None
    deleted: list[str] = []

    async def delete_agent(*, agent_id: str) -> None:
        deleted.append(agent_id)
        async with env["session_factory"]() as session:
            agent = await session.get(Agent, agent_id)
            assert agent is not None
            await session.delete(agent)
            await session.commit()

    env["protocol"].delete_agent = delete_agent
    env["deleted"] = deleted
    fake = FakeManagement(env)
    env["management"] = fake
    async with env["session_factory"]() as session:
        await session.execute(
            update(Agent)
            .where(Agent.id == env["agent_id"])
            .values(can_manage_agents=True)
        )
        await session.commit()
    enable_agent_management(fake)  # type: ignore[arg-type]
    try:
        yield env
    finally:
        disable_agent_management()


async def _as(agent_id: str, fn: Any, **kwargs: Any) -> Any:
    token = set_call_context(
        CallContext(agent_id=agent_id, session_key=None, session=None)
    )
    try:
        return await fn(**kwargs)
    finally:
        reset_call_context(token)


async def _stored(env: dict[str, Any], content: str, kind: str = "group") -> str:
    async with env["session_factory"]() as session:
        template = Template(
            owner_id=env["user_id"],
            name=f"team-{uuid.uuid4().hex[:8]}",
            description="team description",
            kind=kind,
            content=content,
        )
        session.add(template)
        await session.commit()
        return template.id


async def _agent_names(env: dict[str, Any]) -> set[str]:
    async with env["session_factory"]() as session:
        return {a.name for a in (await session.execute(select(Agent))).scalars()}


async def _rooms(env: dict[str, Any]) -> list[Room]:
    async with env["session_factory"]() as session:
        return list((await session.execute(select(Room))).scalars())


TEAM = """\
version: 1
params:
  team: { type: string }
  where: { type: machine, default: [$first] }
agents:
  - name: "{team}-lead"
    description: Leads
    instructions: Lead the team.
    provider: claude
    directory: "{$agents_dir}/{agent}"
    addressing: owner-agents
  - name: "{team}-helper"
    description: Helps
    instructions: Help the lead.
    provider: claude
    model: claude-sonnet
    advanced_config: { effort: high }
    directory: "{$agents_dir}/work/{agent}"
    isolation: isolated
room:
  name: "{team}-room"
  description: Where the team works
  agents: ["{team}-lead", "{team}-helper"]
kickoff: "@{team}-lead start."
"""


@pytest.mark.asyncio
async def test_a_team_template_creates_its_agents_then_the_room(managed):
    template_id = await _stored(managed, TEAM)

    result = await _as(
        managed["agent_id"],
        run_template,
        template_id=template_id,
        inputs={"team": "red"},
    )

    assert result["room_name"] == "red-room"
    assert [a["name"] for a in result["created_agents"]] == ["red-lead", "red-helper"]
    assert all(a["machine"]["name"] == "laptop" for a in result["created_agents"])
    lead, helper = managed["management"].created
    # `$first` is the first online machine that can run the provider; the
    # agent's own folder there is the machine's workspace for it.
    assert (lead.machine, lead.provider, lead.directory) == ("m-laptop", "claude", None)
    assert (helper.model, helper.advanced_config, helper.isolation) == (
        "claude-sonnet",
        {"effort": "high"},
        "isolated",
    )
    assert helper.directory == "/home/me/agents/work/red-helper"
    async with managed["session_factory"]() as session:
        created = (
            await session.execute(select(Agent).where(Agent.name == "red-lead"))
        ).scalar_one()
        unspecified = (
            await session.execute(select(Agent).where(Agent.name == "red-helper"))
        ).scalar_one()
    assert created.addressing_policy == addressing_policy_for("owner_and_owner_agents")
    # An agent whose entry says nothing about addressing gets the default.
    assert unspecified.addressing_policy == addressing_policy_for(
        "owner_and_owner_agents"
    )
    (room,) = await _rooms(managed)
    assert room.name == "red-room"
    assert managed["admin"].sent[-1]["body"].startswith("@red-lead start.")


@pytest.mark.asyncio
async def test_no_machine_that_can_run_every_agent_is_named(managed):
    template = TEAM.replace("provider: claude\n    model", "provider: codex\n    model")
    template_id = await _stored(managed, template)

    with pytest.raises(AgentsNotCreated) as e:
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red"},
        )
    assert {p.code for p in e.value.problems} == {"machine_unresolved"}
    # Why each machine could not take them, so nobody has to go and look.
    assert "box is offline" in str(e.value)
    assert "claude is not signed in on server" in str(e.value)


@pytest.mark.asyncio
async def test_a_refusal_names_the_agent_and_nothing_is_created(managed):
    template = TEAM.replace("provider: claude\n    model", "provider: codex\n    model")
    template_id = await _stored(managed, template)

    with pytest.raises(AgentsNotCreated) as e:
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red", "where": "laptop"},
        )

    assert {(p.slot, p.code) for p in e.value.problems} == {
        ("red-helper", "provider_not_installed")
    }
    assert "codex is not installed on machine 'laptop'" in str(e.value)
    assert str(e.value).count("Nothing was created") == 1
    assert e.value.reason == "agents_not_created"
    assert managed["management"].created == []
    assert await _rooms(managed) == []


@pytest.mark.asyncio
async def test_each_placement_refusal_carries_managements_reason(managed):
    template_id = await _stored(managed, TEAM)

    for machine, code in (
        ("box", "controller_offline"),
        ("server", "provider_login_expired"),
        ("nowhere", "not_found"),
    ):
        with pytest.raises(AgentsNotCreated) as e:
            await _as(
                managed["agent_id"],
                run_template,
                template_id=template_id,
                inputs={"team": "red", "where": machine},
            )
        assert {p.code for p in e.value.problems} == {code}, machine
    assert managed["management"].created == []
    assert await _rooms(managed) == []


@pytest.mark.asyncio
async def test_a_name_already_taken_refuses_the_run(managed):
    template_id = await _stored(
        managed, TEAM.replace('name: "{team}-lead"', "name: claude-code.bob")
    )

    with pytest.raises(AgentsNotCreated) as e:
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red"},
        )
    assert {(p.slot, p.code) for p in e.value.problems} == {
        ("claude-code.bob", "name_taken")
    }
    assert managed["management"].created == []


@pytest.mark.asyncio
async def test_without_the_capability_nothing_is_created(managed, caplog):
    async with managed["session_factory"]() as session:
        await session.execute(
            update(Agent)
            .where(Agent.id == managed["agent_id"])
            .values(can_manage_agents=False)
        )
        await session.commit()
    template_id = await _stored(managed, TEAM)

    with pytest.raises(AgentsNotCreated) as e:
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red", "where": "laptop"},
        )
    assert {p.code for p in e.value.problems} == {"cannot_manage_agents"}
    assert "can manage agents" in str(e.value)
    assert managed["management"].created == []


@pytest.mark.asyncio
async def test_agents_are_deleted_again_when_a_later_one_fails(managed):
    managed["management"].fail_create.add("red-helper")
    template_id = await _stored(managed, TEAM)

    with pytest.raises(RunUndone) as e:
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red"},
        )

    assert e.value.reason == "run_undone"
    assert "red-lead" in str(e.value) and "were deleted" in str(e.value)
    assert "red-lead" not in await _agent_names(managed)
    assert await _rooms(managed) == []


@pytest.mark.asyncio
async def test_agents_are_deleted_again_when_the_room_fails(managed):
    async def broken(config: Any) -> Any:
        raise ValueError("the messaging app is down")

    managed["protocol"].room_service.create_room = broken
    template_id = await _stored(managed, TEAM)

    with pytest.raises(RunUndone, match="the rooms could not be created"):
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red"},
        )
    assert len(managed["deleted"]) == 2
    assert not {"red-lead", "red-helper"} & await _agent_names(managed)


@pytest.mark.asyncio
async def test_a_kickoff_to_a_new_agent_that_would_ignore_it_is_refused_first(managed):
    template_id = await _stored(
        managed,
        TEAM.replace("    addressing: owner-agents\n", "    addressing: owner\n"),
    )

    with pytest.raises(AgentRefused) as e:
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red"},
        )
    assert e.value.reason == "kickoff_ignored"
    assert "red-lead" in str(e.value)
    assert "`addressing: owner-agents`" in str(e.value)
    assert managed["management"].created == []


@pytest.mark.asyncio
async def test_an_agent_only_template_creates_the_agent_and_stops(managed):
    template_id = await _stored(
        managed,
        """\
agent:
  name: solo
  instructions: Work alone.
  provider: claude
  machine: laptop
  directory: /srv/solo
""",
        kind="agent",
    )

    result = await _as(managed["agent_id"], run_template, template_id=template_id)

    assert [a["name"] for a in result["created_agents"]] == ["solo"]
    assert managed["management"].created[0].directory == "/srv/solo"
    assert await _rooms(managed) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("written", "expected"), [("true", True), (None, False)])
async def test_a_template_says_whether_its_agent_can_manage_agents(
    managed, written, expected
):
    line = f"  can_manage_agents: {written}\n" if written else ""
    template_id = await _stored(
        managed,
        "agent:\n"
        "  name: helper\n"
        "  instructions: Help.\n"
        "  provider: claude\n"
        "  machine: laptop\n"
        "  directory: /srv/helper\n" + line,
        kind="agent",
    )

    await _as(managed["agent_id"], run_template, template_id=template_id)

    async with managed["session_factory"]() as session:
        agent = (
            await session.execute(select(Agent).where(Agent.name == "helper"))
        ).scalar_one()
    assert agent.can_manage_agents is expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("written", "expected"), [(None, True), ("false", False), ("true", True)]
)
async def test_a_template_agent_runs_in_auto_mode_unless_it_says_not(
    managed, written, expected
):
    line = f"  auto_mode: {written}\n" if written else ""
    template_id = await _stored(
        managed,
        "agent:\n"
        "  name: helper\n"
        "  instructions: Help.\n"
        "  provider: claude\n"
        "  machine: laptop\n"
        "  directory: /srv/helper\n" + line,
        kind="agent",
    )

    await _as(managed["agent_id"], run_template, template_id=template_id)

    (created,) = managed["management"].created
    assert (created.auto_mode, created.auto_approve) == (expected, False)


@pytest.mark.asyncio
async def test_switch_buddy_is_created_under_its_name_and_can_manage_agents(managed):
    result = await _as(
        managed["agent_id"],
        run_template,
        template_id="official:switch-buddy",
        inputs={"agent_name": "switch-buddy-max"},
    )

    assert [a["name"] for a in result["created_agents"]] == ["switch-buddy-max"]
    async with managed["session_factory"]() as session:
        agent = (
            await session.execute(select(Agent).where(Agent.name == "switch-buddy-max"))
        ).scalar_one()
    assert agent.can_manage_agents is True
    # Shown by its own name, which carries its person's.
    assert managed["management"].created[0].display_name is None
    assert (
        managed["management"].created[0].icon_url.endswith("/assets/switch-buddy.png")
    )


def _plan(template: str, **kw: Any) -> Any:
    return plan_template(
        template,
        kw.pop("filled", {}),
        kw.pop("inputs", {}),
        builtins={},
        machines=kw.pop("machines", MACHINES),
    )


def _codes(template: str, **kw: Any) -> set[str]:
    with pytest.raises(AgentsNotCreated) as e:
        _plan(template, **kw)
    return {p.code for p in e.value.problems}


def test_an_agent_must_say_how_it_runs():
    bare = "agent:\n  name: a\n  instructions: Hi.\n"
    assert _codes(bare) == {"machine_unsaid", "provider_unsaid", "directory_unsaid"}


def test_an_icon_must_be_an_https_url():
    template = (
        "agent:\n  name: a\n  instructions: Hi.\n  provider: claude\n"
        "  machine: laptop\n  directory: /srv/a\n  icon_url: http://example.com/a.png\n"
    )
    assert _codes(template) == {"invalid_icon_url"}


def test_can_manage_agents_must_be_true_or_false():
    template = (
        "agent:\n  name: a\n  instructions: Hi.\n  provider: claude\n"
        "  machine: laptop\n  directory: /srv/a\n  can_manage_agents: maybe\n"
    )
    assert _codes(template) == {"invalid_can_manage_agents"}


def test_auto_mode_must_be_true_or_false():
    template = (
        "agent:\n  name: a\n  instructions: Hi.\n  provider: claude\n"
        "  machine: laptop\n  directory: /srv/a\n  auto_mode: maybe\n"
    )
    assert _codes(template) == {"invalid_auto_mode"}


def test_a_location_names_a_machine_only_when_it_is_one():
    def placed(location: str, provider: str = "claude") -> str:
        template = (
            f"agent:\n  name: a\n  instructions: Hi.\n  provider: {provider}\n"
            f"  location: {location}\n  directory: /x\n"
        )
        (agent,) = _plan(template).new_agents
        return agent.machine

    # A Console's "this computer" or SSH host means nothing to the server:
    # the first online machine that can run the agent stands in.
    assert placed("local") == "m-laptop"
    assert placed("dev-vm", provider="codex") == "m-server"
    assert placed("box", provider="codex") == "m-box"


def test_join_names_the_existing_rooms_to_add_the_agent_to():
    template = (
        "agent:\n  name: a\n  instructions: Hi.\n  provider: claude\n"
        "  machine: laptop\n  directory: /x\n  join: [lobby]\n"
    )
    (agent,) = _plan(template).new_agents
    assert agent.joins == ["lobby"]


@pytest.mark.asyncio
async def test_a_new_agent_joins_an_existing_room_or_the_run_is_refused(managed):
    added: list[tuple[str, list[str]]] = []

    async def add_agents_to_room(room_id: str, agent_ids: list[str]) -> None:
        added.append((room_id, agent_ids))

    managed["protocol"].room_service.add_agents_to_room = add_agents_to_room
    async with managed["session_factory"]() as session:
        lobby = Room(
            transport_room_id="!lobby:test.local",
            name="lobby",
            description="d",
            channel_type="channel_public",
            owner_id=managed["user_id"],
        )
        session.add(lobby)
        await session.commit()
        lobby_id = lobby.id
    template = """\
agent:
  name: joiner
  instructions: Join.
  provider: claude
  machine: laptop
  directory: /srv/joiner
  join: [JOIN]
"""
    unknown = await _stored(managed, template.replace("JOIN", "nowhere"), kind="agent")
    with pytest.raises(AgentsNotCreated) as e:
        await _as(managed["agent_id"], run_template, template_id=unknown)
    assert {p.code for p in e.value.problems} == {"join_unknown_room"}
    assert managed["management"].created == []

    known = await _stored(managed, template.replace("JOIN", "lobby"), kind="agent")
    result = await _as(managed["agent_id"], run_template, template_id=known)
    (created,) = result["created_agents"]
    assert added == [(lobby_id, [created["agent_id"]])]


def test_a_provider_chain_takes_the_first_ready_on_the_machine():
    template = """\
params:
  coder: { type: provider, default: [claude, codex] }
agent:
  name: a
  instructions: Hi.
  provider: "{coder}"
  machine: server
  directory: /x
"""
    (agent,) = _plan(template).new_agents
    # server's claude login has expired, so codex.
    assert agent.provider == "codex"


def test_a_repo_is_cloned_by_the_agent_and_grants_nothing():
    template = """\
agent:
  name: a
  instructions: Hi.
  provider: claude
  machine: laptop
  directory: /x
  repo: https://gitlab.com/acme/widgets.git
  connections:
    - { service: github, access: write, repos: [acme/tools] }
    - atlassian
"""
    (agent,) = _plan(template).new_agents
    github, atlassian = agent.connections
    assert (github.service, github.access, github.repositories) == (
        "github",
        "write",
        ["acme/tools"],
    )
    assert (atlassian.service, atlassian.repositories) == ("atlassian", [])
    assert "clone https://gitlab.com/acme/widgets.git" in agent.instructions


@pytest.mark.asyncio
async def test_connections_need_connections_on(managed):
    template_id = await _stored(
        managed,
        """\
agent:
  name: solo
  instructions: Work alone.
  provider: claude
  machine: laptop
  directory: /srv/solo
  connections: [github]
""",
        kind="agent",
    )

    with pytest.raises(AgentsNotCreated) as e:
        await _as(managed["agent_id"], run_template, template_id=template_id)
    assert {p.code for p in e.value.problems} == {"connections_off"}
    assert managed["management"].created == []


@pytest.mark.asyncio
async def test_an_unknown_messaging_app_is_refused_before_any_agent(managed):
    template_id = await _stored(
        managed,
        TEAM.replace(
            '  name: "{team}-room"\n', '  name: "{team}-room"\n  bridge: Nowhere\n'
        ),
    )

    with pytest.raises(ValueError, match="Unknown bridge"):
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red"},
        )
    assert managed["management"].created == []


@pytest.mark.asyncio
async def test_the_rooms_wait_until_the_new_agents_are_listening(managed):
    order: list[str] = []
    names: dict[str, str] = {}

    async def create_room(config: Any) -> Any:
        order.append(f"room {config.name}")
        return await original(config)

    original = managed["protocol"].room_service.create_room
    managed["protocol"].room_service.create_room = create_room
    lifecycle = managed["protocol"].client_lifecycle

    def get_by_agent_id(agent_id: str) -> Any:
        return ListeningActor(order, names.setdefault(agent_id, agent_id))

    lifecycle.get_by_agent_id = get_by_agent_id
    template_id = await _stored(managed, TEAM)

    result = await _as(
        managed["agent_id"],
        run_template,
        template_id=template_id,
        inputs={"team": "red"},
    )

    assert all(a["listening"] for a in result["created_agents"])
    assert order[-1] == "room red-room"
    assert len([o for o in order if o.startswith("listening")]) == 2


@pytest.mark.asyncio
async def test_an_agent_whose_client_never_starts_is_reported(managed):
    template_id = await _stored(managed, TEAM)

    result = await _as(
        managed["agent_id"],
        run_template,
        template_id=template_id,
        inputs={"team": "red"},
    )

    assert [a["listening"] for a in result["created_agents"]] == [False, False]


def test_slots_show_what_a_shared_param_says_and_each_connection():
    from switch_core.agent_templates import agent_slots

    (lead, helper) = agent_slots(
        TEAM.replace(
            "    addressing: owner-agents\n",
            "    addressing: owner-agents\n    connections:\n"
            "      - { service: github, access: write, repos: [acme/a] }\n"
            "    repo: https://github.com/acme/b\n",
        )
    )
    assert (lead.machine, helper.machine) == ("{where}", "{where}")
    assert lead.connections == [
        {"service": "github", "access": "write", "repos": ["acme/a"]}
    ]


V2_EXPERT = """\
version: 2
params:
  start_in: { type: enum, enum: [nowhere, new_room], default: new_room }
  machine: { type: machine, default: [$first] }
resources:
  expert:
    type: agent
    display_name: Switch expert
    instructions: Answer questions about Switch.
    provider: claude
    machine: "{machine}"
    directory: "{$agents_dir}/{expert.name}"
    addressing:
      - if: "{start_in} == new_room"
        value: { anyone_in: [expert_room] }
      - value: anyone
  expert_room:
    type: room
    if: "{start_in} == new_room"
    name: "Ask {expert.name}"
    description: Where you ask about Switch.
    agents: [expert]
    kickoff: "@{expert.name} hi."
"""


@pytest.mark.asyncio
async def test_a_v2_template_runs_and_opens_its_agent_to_its_room(managed):
    template_id = await _stored(managed, V2_EXPERT, kind="agent")

    result = await _as(managed["agent_id"], run_template, template_id=template_id)

    assert result["room_name"] == "Ask switch-expert"
    assert [a["name"] for a in result["created_agents"]] == ["switch-expert"]
    async with managed["session_factory"]() as session:
        agent = (
            await session.execute(select(Agent).where(Agent.name == "switch-expert"))
        ).scalar_one()
    rules = agent.addressing_policy["rules"]
    assert any(rule.get("rooms") == [result["room_id"]] for rule in rules)
    assert managed["admin"].sent[-1]["body"].startswith("@switch-expert hi.")


@pytest.mark.asyncio
async def test_a_v2_template_with_its_room_off_creates_the_agent_alone(managed):
    template_id = await _stored(managed, V2_EXPERT, kind="agent")

    result = await _as(
        managed["agent_id"],
        run_template,
        template_id=template_id,
        inputs={"start_in": "nowhere"},
    )

    assert "room_id" not in result
    async with managed["session_factory"]() as session:
        agent = (
            await session.execute(select(Agent).where(Agent.name == "switch-expert"))
        ).scalar_one()
    assert agent.addressing_policy is None
    assert await _rooms(managed) == []


async def _install_of(env: dict[str, Any], template_id: str) -> Any:
    store = TemplateInstallStore()
    async with env["session_factory"]() as session:
        installs = await store.of_template(session, template_id)
        return [(i, await store.resources(session, i.id)) for i in installs]


@pytest.mark.asyncio
async def test_switch_buddy_run_by_an_agent_is_recorded_as_its_install(managed):
    result = await _as(
        managed["agent_id"],
        run_template,
        template_id="official:switch-buddy",
        inputs={"agent_name": "switch-buddy-max"},
    )

    ((install, (resource,)),) = await _install_of(managed, "official:switch-buddy")
    assert (install.source, install.owner_id, install.revision) == (
        "official",
        managed["user_id"],
        current_revision("switch-buddy"),
    )
    assert resource.key == "buddy"
    assert resource.agent_id == result["created_agents"][0]["agent_id"]


@pytest.mark.asyncio
async def test_a_saved_template_run_by_an_agent_is_recorded_at_its_version(managed):
    template_id = await _stored(
        managed,
        "agent:\n"
        "  name: helper\n"
        "  description: Helps.\n"
        "  instructions: Help.\n"
        "  provider: claude\n"
        "  machine: laptop\n"
        "  directory: /srv/helper\n",
        kind="agent",
    )

    await _as(managed["agent_id"], run_template, template_id=template_id)

    ((install, (resource,)),) = await _install_of(managed, template_id)
    assert (install.source, install.revision) == ("saved", 1)
    assert resource.key == "helper"
    assert resource.fingerprints["instructions"] == fingerprint("Help.")
