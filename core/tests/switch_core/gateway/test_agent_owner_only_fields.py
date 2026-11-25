"""How an agent is set up on its owner's machine is its owner's and admins'.

A member was handed every agent in the workspace with its options, which hold
the directory its sessions run in, and its OAuth client, through the agent
list, an agent's detail and the agent tools; and every agent in the
ecosystem graph, which the dashboard narrowed only in the browser.

Every agent is still listed to everyone, since people pick others' agents to
bring into rooms. But to whoever neither owns nor administers it, an agent
comes without its options, its OAuth client and the device a session runs
on, and without sessions in rooms they may not read. The ecosystem graph
shows a member only their own agents.
"""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import Principal
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.agent_detail import shown_to
from switch_core.db.models import Agent, Room, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import get_agent_detail, list_agents
from switch_core.gateway.ecosystem import get_ecosystem_graph
from switch_core.gateway.schemas import AgentDetail, AgentSessionDetail
from tests.switch_core.gateway.agent_route_harness import (
    SERVICES_ON,
    add_agent,
    add_user,
)

REPO_DIR = "/home/owner/code/secret-project"
OAUTH_CLIENT = "oauth-client"


def _protocol() -> SimpleNamespace:
    return SimpleNamespace(
        agent_session_store=AgentSessionStore(),
        room_role_store=RoomRoleStore(),
        connections=AgentConnectionRegistry(),
    )


async def _set_up(session: AsyncSession, agent: Agent) -> None:
    agent.metadata_ = {
        "known_agent_type": "claude-code",
        "known_agent_options": {"repo_dir": REPO_DIR},
    }
    agent.oauth_client_id = f"{OAUTH_CLIENT}-{agent.name}"
    await session.flush()


async def _world(session: AsyncSession) -> tuple[User, User, Agent, Agent]:
    owner = await add_user(session, name="owner")
    member = await add_user(session, name="member")
    theirs = await add_agent(session, name="theirs", owner_id=owner.id)
    mine = await add_agent(session, name="mine", owner_id=member.id)
    await _set_up(session, theirs)
    await _set_up(session, mine)
    await session.commit()
    return owner, member, theirs, mine


async def _listed(
    session: AsyncSession, user: User, admin: bool
) -> dict[str, tuple[object, object]]:
    entries = await list_agents(
        session,
        AgentStore(),
        UserStore(),
        _protocol(),  # type: ignore[arg-type]
        user,
        admin,
    )
    return {e.name: (e.known_agent_options, e.oauth_client_id) for e in entries}


async def _detail(
    session: AsyncSession, agent: Agent, user: User, admin: bool
) -> AgentDetail:
    return await get_agent_detail(
        agent.id,
        session,
        AgentStore(),
        RoomStore(),
        UserStore(),
        _protocol(),  # type: ignore[arg-type]
        user,
        admin,
        SERVICES_ON,  # type: ignore[arg-type]
    )


async def test_the_list_shows_everyone_every_agent_but_its_setup_only_to_its_owner_and_admins(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _theirs, _mine = await _world(session)
        mine = ({"repo_dir": REPO_DIR}, f"{OAUTH_CLIENT}-mine")
        theirs = ({"repo_dir": REPO_DIR}, f"{OAUTH_CLIENT}-theirs")

        assert await _listed(session, member, False) == {
            "mine": mine,
            "theirs": (None, None),
        }
        assert await _listed(session, owner, False) == {
            "mine": (None, None),
            "theirs": theirs,
        }
        admin = await add_user(session, name="admin")
        assert await _listed(session, admin, True) == {"mine": mine, "theirs": theirs}


async def test_an_agents_detail_shows_its_setup_only_to_its_owner_and_admins(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, theirs, _mine = await _world(session)

        seen = await _detail(session, theirs, member, False)
        assert (seen.name, seen.known_agent_type) == ("theirs", "claude-code")
        assert (seen.known_agent_options, seen.oauth_client_id) == (None, None)
        assert REPO_DIR not in seen.model_dump_json()

        for viewer, admin in ((owner, False), (member, True)):
            seen = await _detail(session, theirs, viewer, admin)
            assert seen.known_agent_options == {"repo_dir": REPO_DIR}


async def test_a_session_names_its_room_and_its_device_only_to_who_may_see_them(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, theirs, _mine = await _world(session)
        hidden = Room(
            transport_room_id="!hidden:test",
            name="hidden",
            description="",
            owner_id=owner.id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add(hidden)
        await session.flush()
        await AgentSessionStore().touch_heartbeat(session, theirs.id, hidden.id)
        await session.commit()

        assert (await _detail(session, theirs, member, False)).sessions == []
        owners_view = await _detail(session, theirs, owner, False)
        assert [s.room_id for s in owners_view.sessions] == [hidden.id]

    on_device = owners_view.model_copy(
        update={
            "sessions": [
                AgentSessionDetail(
                    room_id=None,
                    room_name=None,
                    lifecycle="controller",
                    state="live",
                    created_at=None,
                    last_seen_at="now",
                    controller_id="owners-laptop",
                )
            ]
        }
    )
    for viewer, device in ((member, None), (owner, "owners-laptop")):
        shown = shown_to(Principal(viewer.id, False), on_device)
        assert [s.controller_id for s in shown.sessions] == [device]


async def test_an_agent_reading_the_list_or_a_detail_gets_the_same_rule_by_its_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        _owner, _member, theirs, mine = await _world(session)
    core = object.__new__(AgentCore)
    core.connections = AgentConnectionRegistry()
    core.session_factory = session_factory  # type: ignore[attr-defined]
    core.agent_store = AgentStore()  # type: ignore[attr-defined]
    core.room_store = RoomStore()  # type: ignore[attr-defined]
    core.user_store = UserStore()  # type: ignore[attr-defined]
    core.agent_session_store = AgentSessionStore()  # type: ignore[attr-defined]
    core.room_role_store = RoomRoleStore()  # type: ignore[attr-defined]

    listed = await core.list_agents(mine.id, None, None, None)
    assert {a["name"]: a["known_agent_options"] for a in listed} == {
        "mine": {"repo_dir": REPO_DIR},
        "theirs": None,
    }
    detail = await core.get_agent_detail(mine.id, theirs.id)
    assert (detail.known_agent_options, detail.oauth_client_id) == (None, None)


async def test_the_ecosystem_shows_a_member_only_their_own_agents(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _theirs, mine = await _world(session)
        config = SimpleNamespace(feature_flags={"ecosystem.show_owners": False})

        async def agents_in_graph(user: User, admin: bool) -> dict[str, str]:
            graph = await get_ecosystem_graph(
                session,
                AgentStore(),
                CollaborationBridgeStore(),
                UserStore(),
                user,
                admin,
                config,  # type: ignore[arg-type]
            )
            return {
                node.label: node.sublabel
                for node in graph.nodes
                if node.kind in ("agent", "agent_type")
            }

        assert await agents_in_graph(member, False) == {
            "external": "1 agent",
            "mine": "mine desc",
        }
        assert await agents_in_graph(owner, True) == {
            "external": "2 agents",
            "mine": "mine desc",
            "theirs": "theirs desc",
        }
        assert mine.connector_type == "external"
