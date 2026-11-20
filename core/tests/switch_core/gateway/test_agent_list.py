"""What the Gateway's agent list says about each agent beyond its summary:
whether it is up at all, and the device it is placed on, named only to the
device's owner and to workspace admins."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.controller_presence import Binding
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.models import Agent, AgentController, AgentDefinition, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import list_agents
from switch_core.gateway.schemas import AgentDevice, GatewayAgentListEntry
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user

_SESSIONS = AgentSessionStore()


def _protocol(connections: AgentConnectionRegistry) -> SimpleNamespace:
    return SimpleNamespace(
        agent_session_store=_SESSIONS,
        room_role_store=RoomRoleStore(),
        connections=connections,
    )


async def _listed(
    session: AsyncSession,
    user: User,
    *,
    admin: bool,
    connections: AgentConnectionRegistry | None = None,
) -> dict[str, GatewayAgentListEntry]:
    entries = await list_agents(
        session,
        AgentStore(),
        UserStore(),
        _protocol(connections or AgentConnectionRegistry()),  # type: ignore[arg-type]
        user,
        admin,
    )
    return {entry.name: entry for entry in entries}


async def _with_model(session: AsyncSession, agent: Agent, model: str | None) -> None:
    agent.integration_profile = {} if model is None else {"connection_model": model}
    await session.flush()


async def _place(
    session: AsyncSession,
    agent: Agent,
    owner: User,
    *,
    name: str,
    revoked: bool = False,
) -> AgentController:
    controller = AgentController(
        owner_id=owner.id,
        name=name,
        kind="console",
        revoked_at=datetime.now(UTC) if revoked else None,
    )
    session.add(controller)
    await session.flush()
    session.add(
        AgentDefinition(
            agent_id=agent.id,
            owner_id=owner.id,
            controller_id=controller.id,
            revision=1,
            desired_state="running",
            definition={},
        )
    )
    await session.flush()
    return controller


class TestStatus:
    async def test_an_agent_that_only_polls_is_not_tracked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            passive = await add_agent(session, name="passive", owner_id=owner.id)
            unprofiled = await add_agent(session, name="unprofiled", owner_id=owner.id)
            await _with_model(session, unprofiled, None)
            # A beat says nothing about an agent Switch does not track.
            await _SESSIONS.touch_heartbeat(session, passive.id, None)

            listed = await _listed(session, owner, admin=False)

            assert listed["passive"].status == "not_tracked"
            assert listed["unprofiled"].status == "not_tracked"

    async def test_a_fresh_beat_in_any_slot_is_online(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            always = await add_agent(session, name="always", owner_id=owner.id)
            await _with_model(session, always, "always_on")
            idle = await add_agent(session, name="idle", owner_id=owner.id)
            await _with_model(session, idle, "session_addressable")
            await _SESSIONS.touch_heartbeat(session, always.id, None)

            listed = await _listed(session, owner, admin=False)

            assert listed["always"].status == "online"
            assert listed["idle"].status == "offline"

    async def test_a_live_connection_is_online(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            pushed = await add_agent(session, name="pushed", owner_id=owner.id)
            await _with_model(session, pushed, "auto_session")
            connections = AgentConnectionRegistry()
            connections.open(
                agent_id=pushed.id,
                connection_id="c-pushed",
                scope="all",
                delivery_filter="all",
                spawn_capable=True,
                position={OWN_EVENTS: 0},
                declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
                expected_generation=None,
            )

            listed = await _listed(session, owner, admin=False, connections=connections)

            assert listed["pushed"].status == "online"

    async def test_an_agent_run_by_a_device_answers_to_the_device_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A fresh beat does not make an agent online whose device is not
        connected: Switch asks the device, as it does for room presence."""
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            managed = await add_agent(session, name="managed", owner_id=owner.id)
            await _with_model(session, managed, "auto_session")
            await _SESSIONS.touch_heartbeat(session, managed.id, None)
            connections = AgentConnectionRegistry()
            connections.controllers.bind(
                Binding(
                    agent_id=managed.id,
                    controller_id="device-1",
                    tenant_id="t",
                    controller_name="Laptop",
                    running=True,
                )
            )

            listed = await _listed(session, owner, admin=False, connections=connections)

            assert listed["managed"].status == "offline"


class TestDevice:
    async def test_the_device_is_named_to_its_owner_and_to_admins_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            member = await add_user(session, name="member")
            agent = await add_agent(session, name="managed", owner_id=owner.id)
            controller = await _place(session, agent, owner, name="Laptop")
            device = AgentDevice(
                id=controller.id, name="Laptop", owner_name="owner", removed=False
            )

            assert (await _listed(session, owner, admin=False))[
                "managed"
            ].device == device
            assert (await _listed(session, member, admin=True))[
                "managed"
            ].device == device
            assert (await _listed(session, member, admin=False))[
                "managed"
            ].device is None

    async def test_an_agent_placed_nowhere_has_no_device(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            await add_agent(session, name="unplaced", owner_id=owner.id)

            listed = await _listed(session, owner, admin=True)

            assert listed["unplaced"].device is None

    async def test_a_removed_device_is_still_named_and_marked_removed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="stranded", owner_id=owner.id)
            await _place(session, agent, owner, name="Old laptop", revoked=True)

            device = (await _listed(session, owner, admin=False))["stranded"].device

            assert device is not None
            assert (device.name, device.removed) == ("Old laptop", True)

    async def test_each_device_carries_its_own_owner_not_the_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two people's devices can share a name, as every Switch Cloud device
        does; what tells them apart is whose each is, read from the device."""
        async with session_factory() as session:
            ada = await add_user(session, name="ada")
            grace = await add_user(session, name="grace")
            admin = await add_user(session, name="admin")
            first = await add_agent(session, name="first", owner_id=ada.id)
            second = await add_agent(session, name="second", owner_id=ada.id)
            await _place(session, first, ada, name="Switch Cloud")
            # Placed on Grace's device though Ada owns it.
            await _place(session, second, grace, name="Switch Cloud")

            listed = await _listed(session, admin, admin=True)

            assert listed["first"].device is not None
            assert listed["second"].device is not None
            assert listed["first"].device.owner_name == "ada"
            assert listed["second"].device.owner_name == "grace"
