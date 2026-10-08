from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.presence import agents_present_in
from switch_core.bridges.agent.protocol.types import AgentStatus
from switch_core.db.models import Agent
from switch_core.db.stores.agent_session_store import AgentSessionStore


async def compute_agent_statuses(
    session: AsyncSession,
    agents: list[Agent],
    room_id: str,
    agent_session_store: AgentSessionStore,
    connections: AgentConnectionRegistry,
) -> dict[str, AgentStatus]:
    """Derive each agent's presence status in a room, keyed by agent id.

    Presence is the **union of three sources** during the transport migration
    (CHOO-1857):

    - the ``agent_sessions`` rows, maintained by clients still polling and
      still sending ``/connection/renew`` and ``/watch/heartbeat``;
    - the live connection registry, which is all a client on the push
      transport maintains — it sends one heartbeat and no renews;
    - the sessions Switch holds a record of, whose binding and host lease say
      where they are working. Their connection cannot: it is shared with their
      siblings, so its rooms are the union of theirs and it stays up while any
      one of them does.

    No one of them alone is correct while all three kinds of client exist:
    without the connection arm a migrated client reads DISCONNECTED while
    demonstrably alive on its stream, and without the DB arm an un-migrated one
    does. When the old clients are gone both of those go with them, and what
    remains is the session arm.

    ``connections`` is required rather than defaulted: a call site that forgot
    it would report a migrated agent as offline, and that failure is invisible
    at the call site. Pass an empty registry to mean "DB arm only".

    The status then follows the agent's ``connection_model``:

    - ``always_on``: LIVE if reachable at all, else DISCONNECTED.
    - ``session_addressable``: LIVE if reachable in this room, else NO_SESSION.
    - ``auto_session``: LIVE if reachable in this room; else DORMANT if a
      connector is watching and will spawn on demand; else NO_SESSION if the
      agent is connected but nothing will start one; else DISCONNECTED.
    - ``session_passive``: always AWAITING_MANUAL_POLL (no heartbeat).

    Shared by AgentCore (room detail / participants) and the in-room
    ``!status`` command so both report presence identically.

    A controller-backed agent is answered from its controller alone
    (`controller_statuses`), and none of the three sources above is asked
    about it.
    """
    return (
        await agent_statuses_by_room(
            session, agents, [room_id], agent_session_store, connections
        )
    )[room_id]


async def agent_statuses_by_room(
    session: AsyncSession,
    agents: list[Agent],
    room_ids: list[str],
    agent_session_store: AgentSessionStore,
    connections: AgentConnectionRegistry,
) -> dict[str, dict[str, AgentStatus]]:
    """`compute_agent_statuses` for each of `room_ids`, keyed by room id.

    The heartbeat rows are read once for all the rooms: one query for the
    room-agnostic rows and one for the room-scoped ones, however many rooms
    and agents there are. Everything else `compute_agent_statuses` describes
    is in memory and asked room by room, so each room's answer is exactly the
    one `compute_agent_statuses` gives for it alone.
    """
    controllers = connections.controllers
    backed = [agent for agent in agents if controllers.is_bound(agent.id)]
    backed_statuses = controller_statuses(backed, connections)
    agents = [agent for agent in agents if not controllers.is_bound(agent.id)]

    always_on_ids: list[str] = []
    addressable_ids: list[str] = []
    auto_session_ids: list[str] = []
    model_by_id: dict[str, str] = {}
    for agent in agents:
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )
        model_by_id[agent.id] = connection_model
        if connection_model == "always_on":
            always_on_ids.append(agent.id)
        elif connection_model == "session_addressable":
            addressable_ids.append(agent.id)
        elif connection_model == "auto_session":
            auto_session_ids.append(agent.id)

    # Each agent has one connection model, so one read per kind of row covers
    # every model: room-agnostic rows say always_on is up and auto_session is
    # watching; room-scoped rows say auto_session and session_addressable are
    # in that room.
    room_agnostic = await agent_session_store.get_live_agent_ids(
        session, always_on_ids + auto_session_ids, None
    )
    in_room = await agent_session_store.live_agent_ids_by_room(
        session, auto_session_ids + addressable_ids, room_ids
    )

    by_room: dict[str, dict[str, AgentStatus]] = {}
    for room_id in room_ids:
        statuses = dict(backed_statuses)
        live_here = in_room.get(room_id, set())
        live_always_on = room_agnostic & set(always_on_ids)
        # auto_session agents are LIVE when something covers this room, and
        # DORMANT when only the room-agnostic "watching" signal is present.
        live_auto_room = live_here & set(auto_session_ids)
        watching_auto = room_agnostic & set(auto_session_ids)
        live_addressable = live_here & set(addressable_ids)
        # always_on has no separate notion of a session: any live connection is the
        # agent being up, and its scope is room-agnostic.
        live_always_on |= connections.live_agents(always_on_ids)
        # For the session-shaped models, LIVE means a session is *present* in the
        # room, which is two different facts about two kinds of client. A session
        # Switch holds a record of says so by the room it is bound to and the lease
        # its host is still renewing; a client Switch has no record of leaves only
        # the room slot its connection claimed.
        #
        # Neither is coverage. An `all`-scope watcher covers rooms it has not
        # yielded, which is the delivery rule, not presence: treating it as LIVE
        # would report an agent as present in a room where nothing but a watcher is
        # listening, suppressing both the "no session" reply and the auto_session
        # promise to start one.
        live_auto_room |= agents_present_in(auto_session_ids, room_id, connections)
        live_addressable |= agents_present_in(addressable_ids, room_id, connections)
        # …whereas DORMANT is a promise that a session is coming, so what it asks
        # of a connection is willingness, not mere connectivity. The client says so
        # when it opens the stream, and one connection of an agent says nothing
        # about another: a session worker is connected and will never spawn, and a
        # controller with auto-start off is connected and has declined to. Reading
        # either as watching promises "Starting a session…" over a room nothing
        # will ever join. The heartbeat rows keep their own arm: a client still on
        # /watch/heartbeat declares nothing, and that loop meant willingness.
        watching_auto |= connections.agents_that_can_spawn_for(
            auto_session_ids, room_id
        )
        # An agent whose client is connected but will start nothing is not
        # disconnected. It is reachable and has no session here, which is what
        # NO_SESSION says and what the room needs to hear: DISCONNECTED over a live
        # controller with automatic starts off tells a user the agent is away, and
        # the reply they get if they address it anyway contradicts that.
        connected_auto = connections.live_agents(auto_session_ids)
        # A spawn-capable connection covering the room will start a session on
        # demand, whatever the agent was configured as. DORMANT rather than
        # NO_SESSION is the honest report: nothing is attending yet, but something
        # is watching and will be.
        spawn_ready = {
            aid
            for aid in addressable_ids
            if aid not in live_addressable and connections.can_spawn_for(aid, room_id)
        }

        for agent in agents:
            model = model_by_id[agent.id]
            if model == "always_on":
                statuses[agent.id] = (
                    AgentStatus.LIVE
                    if agent.id in live_always_on
                    else AgentStatus.DISCONNECTED
                )
            elif model == "session_addressable":
                if agent.id in live_addressable:
                    statuses[agent.id] = AgentStatus.LIVE
                elif agent.id in spawn_ready:
                    statuses[agent.id] = AgentStatus.DORMANT
                else:
                    statuses[agent.id] = AgentStatus.NO_SESSION
            elif model == "auto_session":
                if agent.id in live_auto_room:
                    statuses[agent.id] = AgentStatus.LIVE
                elif agent.id in watching_auto:
                    statuses[agent.id] = AgentStatus.DORMANT
                elif agent.id in connected_auto:
                    statuses[agent.id] = AgentStatus.NO_SESSION
                else:
                    statuses[agent.id] = AgentStatus.DISCONNECTED
            else:
                statuses[agent.id] = AgentStatus.AWAITING_MANUAL_POLL
        by_room[room_id] = statuses
    return by_room


def controller_statuses(
    agents: list[Agent], connections: AgentConnectionRegistry
) -> dict[str, AgentStatus]:
    """Presence for agents run by an agents controller.

    Switch knows only whether such an agent is connected, not where its
    sessions are: whatever its `connection_model`, it is LIVE while its
    controller is live, it is set to running and the controller is not
    revoked, and DISCONNECTED otherwise. A `session_passive` agent is
    AWAITING_MANUAL_POLL, as any other.
    """
    controllers = connections.controllers
    statuses: dict[str, AgentStatus] = {}
    for agent in agents:
        model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )
        if model == "session_passive":
            statuses[agent.id] = AgentStatus.AWAITING_MANUAL_POLL
        elif controllers.is_live(agent.id):
            statuses[agent.id] = AgentStatus.LIVE
        else:
            statuses[agent.id] = AgentStatus.DISCONNECTED
    return statuses
