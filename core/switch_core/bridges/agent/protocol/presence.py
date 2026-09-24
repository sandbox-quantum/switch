"""Which agents have something of their own in a room, from live state only.

Presence is a session that connected to the room (`ConnectionRegistry`
placement) or a room slot claimed on one of the agent's connections, which is
what a standalone or MCP client leaves behind. Coverage is not presence: an
`all`-scope watcher covering a room is the delivery rule, not something in it.

Switch keeps no record of a session's liveness, so a session that has stopped
without leaving its room still counts until another takes the room or the
agent's controller connection goes.
"""

from __future__ import annotations

from collections.abc import Iterable

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry


def agents_present_in(
    agent_ids: Iterable[str], room_id: str, connections: ConnectionRegistry
) -> set[str]:
    return {
        agent_id
        for agent_id in agent_ids
        if connections.session_in_room(agent_id, room_id) is not None
        or connections.claimant_of(agent_id, room_id) is not None
    }


def rooms_occupied(agent_id: str, connections: ConnectionRegistry) -> set[str]:
    """Every room this agent is in right now."""
    occupied = connections.placed_rooms(agent_id)
    for conn in connections.for_agent(agent_id):
        occupied |= conn.rooms
    return occupied
