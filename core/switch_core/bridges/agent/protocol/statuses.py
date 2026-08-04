from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.types import AgentStatus
from switch_core.db.models import Agent
from switch_core.db.stores.agent_session_store import AgentSessionStore


async def compute_agent_statuses(
    session: AsyncSession,
    agents: list[Agent],
    room_id: str,
    agent_session_store: AgentSessionStore,
    connections: ConnectionRegistry,
) -> dict[str, AgentStatus]:
    """Derive each agent's presence status in a room, keyed by agent id.

    Presence is the **union of two sources** during the transport migration
    (CHOO-1857):

    - the ``agent_sessions`` rows, maintained by clients still polling and
      still sending ``/connection/renew`` and ``/watch/heartbeat``;
    - the live connection registry, which is all a client on the push
      transport maintains — it sends one heartbeat and no renews.

    Neither alone is correct while both kinds of client exist: without the
    connection arm a migrated client reads DISCONNECTED while demonstrably
    alive on its stream, and without the DB arm an un-migrated one does. When
    the old clients are gone the DB arm goes with them, and what remains is the
    connection arm — this is the shape the code keeps, minus one branch.

    ``connections`` is required rather than defaulted: a call site that forgot
    it would report a migrated agent as offline, and that failure is invisible
    at the call site. Pass an empty registry to mean "DB arm only".

    The status then follows the agent's ``connection_model``:

    - ``always_on``: LIVE if reachable at all, else DISCONNECTED.
    - ``session_addressable``: LIVE if reachable in this room, else NO_SESSION.
    - ``auto_session``: LIVE if reachable in this room; else DORMANT if a
      connector is watching and will spawn on demand; else DISCONNECTED.
    - ``session_passive``: always AWAITING_MANUAL_POLL (no heartbeat).

    Shared by ProtocolService (room detail / participants) and the in-room
    ``!status`` command so both report presence identically.
    """
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

    live_always_on = await agent_session_store.get_live_agent_ids(
        session, always_on_ids, None
    )
    # auto_session agents are LIVE when something covers this room, and DORMANT
    # when only the room-agnostic "watching" signal is present.
    live_auto_room = await agent_session_store.get_live_agent_ids(
        session, auto_session_ids, room_id
    )
    watching_auto = await agent_session_store.get_live_agent_ids(
        session, auto_session_ids, None
    )
    live_addressable = await agent_session_store.get_live_agent_ids(
        session, addressable_ids, room_id
    )

    # always_on has no separate notion of a session: any live connection is the
    # agent being up, and its scope is room-agnostic.
    live_always_on |= connections.live_agents(always_on_ids)
    # For the session-shaped models, LIVE means a session is *attending* the
    # room — a claimed room slot. An `all`-scope watcher covers rooms it has
    # not yielded, which is the delivery rule, not presence: treating it as
    # LIVE would report an agent as present in a room where nothing but a
    # watcher is listening, suppressing both the "no session" reply and the
    # auto_session promise to start one.
    live_auto_room |= connections.agents_with_session_in(auto_session_ids, room_id)
    live_addressable |= connections.agents_with_session_in(addressable_ids, room_id)
    # …whereas watching is exactly "has any live connection": that is what the
    # /watch/heartbeat loop used to assert, and what DORMANT means.
    watching_auto |= connections.live_agents(auto_session_ids)
    # A spawn-capable connection covering the room will start a session on
    # demand, whatever the agent was configured as. DORMANT rather than
    # NO_SESSION is the honest report: nothing is attending yet, but something
    # is watching and will be.
    spawn_ready = {
        aid
        for aid in addressable_ids
        if aid not in live_addressable and connections.can_spawn_for(aid, room_id)
    }

    statuses: dict[str, AgentStatus] = {}
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
            else:
                statuses[agent.id] = AgentStatus.DISCONNECTED
        else:
            statuses[agent.id] = AgentStatus.AWAITING_MANUAL_POLL
    return statuses
