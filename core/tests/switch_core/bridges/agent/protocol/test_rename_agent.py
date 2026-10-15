"""Renaming an agent: the name people type and mention changes, everything
that points at the agent by id stays put, and every place that carries the
name follows — the client's display name (what bridges match an agent's own
messages on), the running actor, paused runs and each platform handle.

A refusal must change nothing, so the checks run before anything is written,
and a platform failing after the write is reported, not raised.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.agent_icon import generated_icon_url
from switch_core.bridges.agent.protocol.agent_core import (
    AgentExistsError,
    AgentRenameRefused,
)
from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    AgentIdentityConflict,
)
from switch_core.clients.actor import AgentActor
from switch_core.db.models import Agent, Client, Room, Template
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.tenant_context import no_tenant
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    FakeClientLifecycle,
    make_owner,
    make_service,
    register,
)


@dataclass
class _FakeActor:
    display_name: str

    async def set_display_name(self, display_name: str) -> None:
        self.display_name = display_name


class _LiveClientLifecycle(FakeClientLifecycle):
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__(session_factory)
        self.actors: dict[str, _FakeActor] = {}

    def start_client(self, client: Client) -> None:
        super().start_client(client)
        self.actors[client.id] = _FakeActor(client.display_name)

    def get(self, client_id: str) -> _FakeActor | None:
        return self.actors.get(client_id)


@dataclass
class _FakeAdapter:
    conflict: str | None = None
    rename_error: str | None = None
    renamed: list[tuple[str, str]] = field(default_factory=list)
    renamed_display_names: list[str | None] = field(default_factory=list)
    created: list[str] = field(default_factory=list)
    updated: list[str | None] = field(default_factory=list)

    async def update_agent_identity(self, agent: AgentIdentity) -> None:
        self.updated.append(agent.display_name)

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        self.created.append(agent.name)

    async def check_agent_identity_name(self, agent_id: str, new_name: str) -> None:
        if self.conflict is not None:
            raise AgentIdentityConflict(self.conflict)

    async def rename_agent_identity(self, old_name: str, agent: AgentIdentity) -> None:
        if self.rename_error is not None:
            raise RuntimeError(self.rename_error)
        self.renamed.append((old_name, agent.name))
        self.renamed_display_names.append(agent.display_name)


@dataclass
class _FakeBridge:
    adapter: _FakeAdapter
    bridge_type: str = "slack"


class _Bridges:
    def __init__(self, bridges: list[_FakeBridge]) -> None:
        self.bridges = bridges

    def bridges_for_tenant(self, tenant_id: str) -> list[_FakeBridge]:
        return self.bridges


def _service(session_factory: async_sessionmaker[AsyncSession], adapter: _FakeAdapter):
    svc = make_service(session_factory)
    svc.client_lifecycle = _LiveClientLifecycle(session_factory)  # type: ignore[assignment]
    svc.collab_lifecycle = _Bridges([_FakeBridge(adapter)])  # type: ignore[assignment]
    svc.room_store = RoomStore()
    svc.room_role_store = RoomRoleStore()
    svc.config.third_party_avatars_enabled = True  # type: ignore[attr-defined]
    return svc


async def _agent(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str
) -> Agent:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        return agent


async def _room(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    agent_ids: list[str],
    **columns: object,
) -> str:
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!{name}:test",
            name=name,
            description=name,
            **columns,
        )
        session.add(room)
        await session.flush()
        await RoomStore().add_agents(session, room.id, agent_ids)
        await session.commit()
        return room.id


class TestRename:
    async def test_the_name_and_the_message_sender_name_change_together(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        adapter = _FakeAdapter()
        svc = _service(session_factory, adapter)
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)

        result = await svc.rename_agent(
            agent_id=agent_id, new_name="flint-scout", display_name=None
        )

        assert (result.old_name, result.new_name) == ("flint-tracker", "flint-scout")
        assert result.bridge_failures == []
        agent = await _agent(session_factory, agent_id)
        assert agent.name == "flint-scout"
        async with session_factory() as session:
            client = await session.get(Client, agent.client_id)
            assert client is not None
            assert client.display_name == "flint-scout"
        actor = svc.client_lifecycle.get(agent.client_id)  # type: ignore[attr-defined]
        assert actor.display_name == "flint-scout"
        assert adapter.renamed == [("flint-tracker", "flint-scout")]

    async def test_the_running_agent_answers_to_the_new_name_at_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The running agent decides what addresses it from the row it holds.
        Holding the old row until a restart is what let the old name keep
        reaching it in the end-to-end run."""
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)
        agent = await _agent(session_factory, agent_id)

        class _Transport:
            async def set_display_name(self, display_name: str) -> None:
                return None

        actor = object.__new__(AgentActor)
        actor.transport = _Transport()  # type: ignore[assignment]
        actor.display_name = "flint-tracker"
        actor.set_agent(agent)
        svc.client_lifecycle.actors[agent.client_id] = actor  # type: ignore[attr-defined]

        await svc.rename_agent(
            agent_id=agent_id, new_name="flint-scout", display_name=None
        )

        assert actor.agent.name == "flint-scout"
        assert actor.display_name == "flint-scout"

    async def test_a_generated_avatar_is_kept(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)

        await svc.rename_agent(
            agent_id=agent_id, new_name="flint-scout", display_name=None
        )

        agent = await _agent(session_factory, agent_id)
        assert agent.icon_url == generated_icon_url("flint-tracker")

    async def test_no_avatar_is_pinned_when_third_party_avatars_are_off(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        svc.config.third_party_avatars_enabled = False  # type: ignore[attr-defined]
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)

        await svc.rename_agent(
            agent_id=agent_id, new_name="flint-scout", display_name=None
        )

        assert (await _agent(session_factory, agent_id)).icon_url is None

    async def test_a_chosen_avatar_is_left_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(
            svc, "flint-tracker", owner, icon_url="https://example.com/i.png"
        )

        await svc.rename_agent(
            agent_id=agent_id, new_name="flint-scout", display_name=None
        )

        agent = await _agent(session_factory, agent_id)
        assert agent.icon_url == "https://example.com/i.png"

    async def test_rooms_follow_the_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)
        room_id = await _room(session_factory, "ops", [agent_id])

        await svc.rename_agent(
            agent_id=agent_id, new_name="flint-scout", display_name=None
        )

        async with session_factory() as session:
            assert agent_id in await RoomStore().get_agent_ids(session, room_id)

    async def test_a_paused_run_wakes_the_agent_by_its_new_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)
        room_id = await _room(
            session_factory,
            "run-root",
            [],
            run_control={"state": "paused", "paused_agent_name": "flint-tracker"},
        )

        await svc.rename_agent(
            agent_id=agent_id, new_name="flint-scout", display_name=None
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)
            assert room is not None
            assert room.run_control == {
                "state": "paused",
                "paused_agent_name": "flint-scout",
            }

    async def test_templates_still_naming_the_old_name_are_listed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)
        async with session_factory() as session:
            for name, content in [
                ("uses-it", "agents:\n  - flint-tracker\n"),
                ("prefix-only", "agents:\n  - flint-tracker-two\n"),
            ]:
                session.add(
                    Template(
                        owner_id=owner,
                        name=name,
                        description=name,
                        kind="room",
                        content=content,
                    )
                )
            await session.commit()

        result = await svc.rename_agent(
            agent_id=agent_id, new_name="flint-scout", display_name=None
        )

        assert result.templates_mentioning_old_name == ["uses-it"]

    async def test_a_platform_failure_after_the_write_is_reported_not_raised(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter(rename_error="Slack is down"))
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)

        result = await svc.rename_agent(
            agent_id=agent_id, new_name="flint-scout", display_name=None
        )

        assert result.bridge_failures == ["slack: Slack is down"]
        assert (await _agent(session_factory, agent_id)).name == "flint-scout"

    async def test_the_same_name_is_a_no_op(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        adapter = _FakeAdapter()
        svc = _service(session_factory, adapter)
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)

        await svc.rename_agent(
            agent_id=agent_id, new_name="flint-tracker", display_name=None
        )

        assert adapter.renamed == []


class TestDisplayName:
    async def test_the_display_name_changes_with_the_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        adapter = _FakeAdapter()
        svc = _service(session_factory, adapter)
        owner = await make_owner(session_factory)
        agent_id = await register(
            svc, "notes-helper", owner, display_name="Notes Helper"
        )

        result = await svc.rename_agent(
            agent_id=agent_id, new_name="notes-writer", display_name="Notes Writer"
        )

        agent = await _agent(session_factory, agent_id)
        assert (agent.name, agent.display_name) == ("notes-writer", "Notes Writer")
        assert result.display_name == "Notes Writer"
        assert adapter.renamed == [("notes-helper", "notes-writer")]
        assert adapter.renamed_display_names == ["Notes Writer"]

    async def test_passing_the_current_display_name_keeps_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "notes-helper", owner, display_name="Scribe")

        await svc.rename_agent(
            agent_id=agent_id, new_name="notes-writer", display_name="Scribe"
        )

        assert (await _agent(session_factory, agent_id)).display_name == "Scribe"

    async def test_a_blank_display_name_clears_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(
            svc, "notes-helper", owner, display_name="Notes Helper"
        )

        await svc.rename_agent(
            agent_id=agent_id, new_name="notes-writer", display_name="  "
        )

        assert (await _agent(session_factory, agent_id)).display_name is None

    async def test_only_the_display_name_can_change(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        adapter = _FakeAdapter()
        svc = _service(session_factory, adapter)
        owner = await make_owner(session_factory)
        agent_id = await register(
            svc, "notes-helper", owner, display_name="Notes Helper"
        )

        result = await svc.rename_agent(
            agent_id=agent_id, new_name="notes-helper", display_name="Note Taker"
        )

        assert (await _agent(session_factory, agent_id)).display_name == "Note Taker"
        assert adapter.renamed == []
        assert adapter.updated == ["Note Taker"]
        assert result.bridge_failures == []

    async def test_an_unsafe_display_name_refuses_before_anything_changes(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        adapter = _FakeAdapter()
        svc = _service(session_factory, adapter)
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "notes-helper", owner)

        with pytest.raises(ValueError):
            await svc.rename_agent(
                agent_id=agent_id, new_name="notes-writer", display_name="Bad\nName"
            )

        assert (await _agent(session_factory, agent_id)).name == "notes-helper"
        assert adapter.renamed == []


class TestRefusals:
    @pytest.mark.parametrize("bad", ["Flint Tracker", "-flint", "flint@x", ""])
    async def test_a_malformed_name(
        self, session_factory: async_sessionmaker[AsyncSession], bad: str
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)

        with pytest.raises(ValueError, match="Invalid agent name"):
            await svc.rename_agent(agent_id=agent_id, new_name=bad, display_name=None)

    async def test_a_reserved_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)

        with pytest.raises(ValueError, match="reserved"):
            await svc.rename_agent(
                agent_id=agent_id, new_name="everyone", display_name=None
            )

    async def test_another_agents_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)
        await register(svc, "flint-scout", owner)

        with pytest.raises(AgentExistsError):
            await svc.rename_agent(
                agent_id=agent_id, new_name="flint-scout", display_name=None
            )

    async def test_another_agents_alias_in_a_shared_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)
        other_id = await register(svc, "helper", owner)
        room_id = await _room(session_factory, "ops", [agent_id, other_id])
        async with session_factory() as session:
            await RoomStore().set_alias(session, room_id, other_id, "scout")
            await session.commit()

        with pytest.raises(AgentRenameRefused, match="alias in room 'ops'"):
            await svc.rename_agent(
                agent_id=agent_id, new_name="scout", display_name=None
            )

    async def test_a_role_name_in_its_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)
        room_id = await _room(session_factory, "ops", [agent_id])
        async with session_factory() as session:
            await RoomRoleStore().define_role(
                session, room_id, "manager", "Lead.", exclusive=False
            )
            await session.commit()

        with pytest.raises(AgentRenameRefused, match="role in room 'ops'"):
            await svc.rename_agent(
                agent_id=agent_id, new_name="manager", display_name=None
            )

    async def test_a_platform_handle_clash_refuses_before_anything_changes(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        adapter = _FakeAdapter(conflict="The Slack handle @designers is taken")
        svc = _service(session_factory, adapter)
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)

        with pytest.raises(AgentRenameRefused, match="@designers"):
            await svc.rename_agent(
                agent_id=agent_id, new_name="designers", display_name=None
            )

        assert (await _agent(session_factory, agent_id)).name == "flint-tracker"
        assert adapter.renamed == []

    async def test_a_subagent_and_its_parent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        parent_id = await register(svc, "parent", owner)
        child_id = await register(svc, "parent.child", owner, parent_agent_id=parent_id)

        with pytest.raises(AgentRenameRefused, match="subagent"):
            await svc.rename_agent(
                agent_id=child_id, new_name="other", display_name=None
            )
        with pytest.raises(AgentRenameRefused, match="has subagents"):
            await svc.rename_agent(
                agent_id=parent_id, new_name="other", display_name=None
            )

    async def test_a_server_connector_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(
            svc, "found", owner, metadata={"server_connector_id": "c1"}
        )

        with pytest.raises(AgentRenameRefused, match="server connector"):
            await svc.rename_agent(
                agent_id=agent_id, new_name="other", display_name=None
            )

    async def test_no_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory, _FakeAdapter())
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "flint-tracker", owner)

        with no_tenant():
            with pytest.raises(RuntimeError, match="bound tenant"):
                await svc.rename_agent(
                    agent_id=agent_id, new_name="flint-scout", display_name=None
                )

        async with session_factory() as session:
            names = (await session.execute(select(Agent.name))).scalars().all()
        assert "flint-scout" not in names
