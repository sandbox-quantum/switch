from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_agent_store,
    get_bridge_store,
    get_session,
)
from switch_core.gateway.schemas import (
    EcosystemEdge,
    EcosystemGraphResponse,
    EcosystemNode,
)

router = APIRouter()

SWITCH_NODE_ID = "switch"


@router.get("/graph")
async def get_ecosystem_graph(
    session: Annotated[AsyncSession, Depends(get_session)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> EcosystemGraphResponse:
    """Switch-centric ecosystem graph: the Switch at the centre, with agent
    types branching out (and individual agents under each type) and one branch
    per connected collaboration app.

    The payload is a generic node/edge graph so it can be extended with more
    entity kinds later without changing its shape."""
    nodes: list[EcosystemNode] = [
        EcosystemNode(id=SWITCH_NODE_ID, kind="switch", label="Switch")
    ]
    edges: list[EcosystemEdge] = []

    # Agents grouped by connector_type -> one agent-type node per type, with
    # each agent hanging off its type.
    agents = await agent_store.get_all(session)

    by_type: dict[str, list] = {}
    for agent in agents:
        by_type.setdefault(agent.connector_type, []).append(agent)

    for connector_type, type_agents in by_type.items():
        type_node_id = f"type:{connector_type}"
        count = len(type_agents)
        nodes.append(
            EcosystemNode(
                id=type_node_id,
                kind="agent_type",
                label=connector_type,
                sublabel=f"{count} agent{'' if count == 1 else 's'}",
            )
        )
        edges.append(EcosystemEdge(source=SWITCH_NODE_ID, target=type_node_id))

        for agent in type_agents:
            agent_node_id = f"agent:{agent.id}"
            nodes.append(
                EcosystemNode(
                    id=agent_node_id,
                    kind="agent",
                    label=agent.name,
                    sublabel=agent.description or "",
                )
            )
            edges.append(EcosystemEdge(source=type_node_id, target=agent_node_id))

    # One branch per connected collaboration app.
    bridges = await bridge_store.get_all(session)
    for bridge in bridges:
        bridge_node_id = f"bridge:{bridge.id}"
        nodes.append(
            EcosystemNode(
                id=bridge_node_id,
                kind="bridge",
                label=bridge.display_name,
                sublabel=f"{bridge.type} · {bridge.status}",
            )
        )
        edges.append(EcosystemEdge(source=SWITCH_NODE_ID, target=bridge_node_id))

    return EcosystemGraphResponse(nodes=nodes, edges=edges)
