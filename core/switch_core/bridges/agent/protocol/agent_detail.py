"""Shared agent-summary / agent-detail assembly and known-agent options updates.

This lives in the protocol layer so both the gateway routes (`gateway/agents.py`)
and the MCP-facing protocol methods can build the exact same `AgentSummary` /
`AgentDetail` shapes and run the same options-validation path, rather than each
re-deriving it. It imports `gateway.schemas` (pure pydantic leaf) and
`gateway.known_agents` (which only depends on `protocol.types`) — neither pulls
in `gateway.agents`, so there is no import cycle.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import AddressingPolicy
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.statuses import compute_agent_statuses
from switch_core.db.models import Agent, AgentSession
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.known_agents import KNOWN_AGENTS
from switch_core.gateway.schemas import (
    AgentDetail,
    AgentModelSummary,
    AgentRoomMembership,
    AgentSessionDetail,
    AgentSummary,
    AgentToolSummary,
)


class AgentOptionsNotEditable(Exception):
    """Raised when an agent has no known-agent type, so its options are not
    editable (the `register-other` case)."""


async def build_agent_summary(
    session: AsyncSession,
    agent_store: AgentStore,
    agent: Agent,
    owner_name: str | None,
) -> AgentSummary:
    tools = await agent_store.get_tools(session, agent.id)
    models = await agent_store.get_models(session, agent.id)
    # `metadata_` is typed as dict | None but the JSONB column can hold any
    # JSON value, and some pre-existing rows stored a list. Treat anything
    # that isn't a dict as "no known-agent metadata."
    md = agent.metadata_ if isinstance(agent.metadata_, dict) else {}
    known_agent_type = md.get("known_agent_type")
    known_agent_options = md.get("known_agent_options")
    profile = (
        agent.integration_profile if isinstance(agent.integration_profile, dict) else {}
    )
    return AgentSummary(
        id=agent.id,
        name=agent.name,
        description=agent.description,
        icon_url=agent.icon_url,
        display_name=agent.display_name,
        connector_type=agent.connector_type,
        connection_model=profile.get("connection_model"),
        tool_count=len(tools),
        model_count=len(models),
        owner_id=agent.owner_id,
        owner_name=owner_name,
        oauth_client_id=agent.oauth_client_id,
        created_at=str(agent.created_at),
        parent_agent_id=agent.parent_agent_id,
        known_agent_type=known_agent_type
        if isinstance(known_agent_type, str)
        else None,
        known_agent_options=known_agent_options
        if isinstance(known_agent_options, dict)
        else None,
        addressing_policy=(
            AddressingPolicy.model_validate(agent.addressing_policy)
            if isinstance(agent.addressing_policy, dict)
            else None
        ),
    )


async def list_agent_summaries(
    session: AsyncSession,
    agent_store: AgentStore,
    user_store: UserStore,
    *,
    name_contains: str | None = None,
    owner_name: str | None = None,
    known_agent_type: str | None = None,
) -> list[AgentSummary]:
    """Build summaries for every agent, optionally filtered.

    Filters are ANDed together; a `None` filter is ignored. `name_contains` is
    a case-insensitive substring match on the agent name; `owner_name` and
    `known_agent_type` are exact matches. Results are sorted by agent name.
    """
    agents = await agent_store.get_all(session)

    owner_ids = {a.owner_id for a in agents if a.owner_id}
    owner_names: dict[str, str] = {}
    for oid in owner_ids:
        owner = await user_store.get(session, oid)
        if owner:
            owner_names[oid] = owner.name

    needle = name_contains.lower() if name_contains else None
    summaries: list[AgentSummary] = []
    for agent in agents:
        if needle is not None and needle not in agent.name.lower():
            continue
        agent_owner_name = owner_names.get(agent.owner_id) if agent.owner_id else None
        if owner_name is not None and agent_owner_name != owner_name:
            continue
        md = agent.metadata_ if isinstance(agent.metadata_, dict) else {}
        agent_known_type = md.get("known_agent_type")
        if known_agent_type is not None and agent_known_type != known_agent_type:
            continue
        summaries.append(
            await build_agent_summary(session, agent_store, agent, agent_owner_name)
        )

    summaries.sort(key=lambda s: s.name)
    return summaries


def session_state(row: AgentSession, now: datetime) -> str:
    """Derive a session row's state, mirroring the liveness rules in
    AgentSessionStore. `explicit` rows (session_passive) are not heartbeat-driven
    so they report `open`; heartbeat rows are `live` while fresh within the
    connection model's TTL, else `stale`."""
    if row.lifecycle != "heartbeat":
        return "open"
    ttl = (
        AgentSessionStore.ALWAYS_ON_TTL
        if row.room_id is None
        else AgentSessionStore.SESSION_TTL
    )
    # `last_seen_at` is a tz-aware DateTime column; the model annotates it as str.
    return "live" if cast(datetime, row.last_seen_at) > now - ttl else "stale"


async def assemble_agent_detail(
    session: AsyncSession,
    *,
    agent: Agent,
    agent_store: AgentStore,
    room_store: RoomStore,
    user_store: UserStore,
    agent_session_store: AgentSessionStore,
    room_role_store: RoomRoleStore,
    connections: ConnectionRegistry,
) -> AgentDetail:
    # Presence is the union of the heartbeat rows and the live connections
    # (CHOO-1857 stage B); an empty set means "rows only".
    alive_agent_ids = connections.live_agent_ids()
    owner_names: dict[str, str] = {}

    async def owner_name(owner_id: str | None) -> str | None:
        if not owner_id:
            return None
        if owner_id not in owner_names:
            owner = await user_store.get(session, owner_id)
            if owner:
                owner_names[owner_id] = owner.name
        return owner_names.get(owner_id)

    summary = await build_agent_summary(
        session, agent_store, agent, await owner_name(agent.owner_id)
    )
    tools = await agent_store.get_tools(session, agent.id)
    models = await agent_store.get_models(session, agent.id)

    rooms = await room_store.get_rooms_for_agent(
        session, agent.id, include_archived=True
    )
    room_name_by_id = {room.id: room.name for room in rooms}

    memberships: list[AgentRoomMembership] = []
    for room in rooms:
        statuses = await compute_agent_statuses(
            session, [agent], room.id, agent_session_store, connections
        )
        room_role = await room_role_store.agent_room_role(
            session, room.id, agent.id, alive_agent_ids
        )
        memberships.append(
            AgentRoomMembership(
                room_id=room.id,
                room_name=room.name,
                archived=room.archived_at is not None,
                status=statuses[agent.id].value,
                room_role=room_role,
            )
        )

    now = datetime.now(UTC)
    sessions: list[AgentSessionDetail] = []
    session_rows = await agent_session_store.get_sessions_for_agent(session, agent.id)
    for row in session_rows:
        room_name: str | None = None
        if row.room_id is not None:
            room_name = room_name_by_id.get(row.room_id)
            if room_name is None:
                linked_room = await room_store.get(session, row.room_id)
                room_name = linked_room.name if linked_room else None
        sessions.append(
            AgentSessionDetail(
                room_id=row.room_id,
                room_name=room_name,
                lifecycle=row.lifecycle,
                state=session_state(row, now),
                last_seen_at=str(row.last_seen_at),
            )
        )

    # Connections are sessions too. A client on the push transport writes no
    # agent_sessions row, so listing only the rows would show a live agent with
    # no sessions at all — presence and the session list disagreeing is worse
    # than either being wrong alone. Rooms already covered by a row are skipped
    # so a client running both (a migration in progress) is not listed twice.
    listed_rooms = {row.room_id for row in session_rows}
    for conn in connections.for_agent(agent.id):
        # An `all`-scope connection claiming nothing is one room-agnostic
        # session, not none.
        conn_rooms: list[str | None] = list(sorted(conn.rooms)) or [None]
        for conn_room in conn_rooms:
            if conn_room in listed_rooms:
                continue
            listed_rooms.add(conn_room)
            room_name = None
            if conn_room is not None:
                room_name = room_name_by_id.get(conn_room)
                if room_name is None:
                    linked_room = await room_store.get(session, conn_room)
                    room_name = linked_room.name if linked_room else None
            sessions.append(
                AgentSessionDetail(
                    room_id=conn_room,
                    room_name=room_name,
                    lifecycle="connection",
                    state="live",
                    last_seen_at=str(now),
                )
            )

    child_agents = await agent_store.get_children(session, [agent.id])
    children = [
        await build_agent_summary(
            session, agent_store, child, await owner_name(child.owner_id)
        )
        for child in child_agents
    ]

    return AgentDetail(
        **summary.model_dump(),
        agent_type=agent.agent_type,
        integration_profile=agent.integration_profile
        if isinstance(agent.integration_profile, dict)
        else {},
        tools=[AgentToolSummary(name=t.name, description=t.description) for t in tools],
        models=[
            AgentModelSummary(name=m.name, description=m.description) for m in models
        ],
        rooms=memberships,
        sessions=sessions,
        children=children,
    )


async def apply_agent_options(
    session: AsyncSession,
    agent_store: AgentStore,
    agent: Agent,
    options_payload: dict[str, Any],
    *,
    merge: bool,
) -> None:
    """Validate and persist a known-agent's options.

    With `merge=False` the payload fully replaces the stored options (the
    gateway PATCH behaviour). With `merge=True` the payload is layered over the
    current options before validation, so callers can send only the fields they
    want to change. Either way the merged options are validated against the
    spec's `options_schema`, and the agent's `integration_profile` is rebuilt
    from them and persisted alongside — keeping the two in sync the same way
    registration does.

    Raises `AgentOptionsNotEditable` if the agent has no known-agent type, and
    `pydantic.ValidationError` if the resulting options fail schema validation.
    """
    md = dict(agent.metadata_) if isinstance(agent.metadata_, dict) else {}
    raw_agent_type = md.get("known_agent_type")
    agent_type = raw_agent_type if isinstance(raw_agent_type, str) else None
    spec = KNOWN_AGENTS.get(agent_type) if agent_type else None
    if spec is None:
        raise AgentOptionsNotEditable(
            "This agent has no known-agent type; options are not editable."
        )

    if merge:
        current = md.get("known_agent_options")
        merged = dict(current) if isinstance(current, dict) else {}
        merged.update(options_payload)
    else:
        merged = options_payload

    options = spec.parse_options(merged)
    integration_profile = spec.build_profile(options)
    md["known_agent_options"] = options.model_dump()

    await agent_store.update(
        session,
        agent.id,
        metadata_=md,
        integration_profile=integration_profile.model_dump(),
    )


async def reparent_agent(
    session: AsyncSession,
    agent_store: AgentStore,
    agent: Agent,
    new_parent_id: str | None,
) -> None:
    """Set (or clear, with `new_parent_id=None`) an agent's parent.

    Validates that the new parent exists and that the move does not make the
    agent its own ancestor (which would create a cycle in the subagent tree).
    Raises `ValueError` on any of those violations.
    """
    if new_parent_id is None:
        await agent_store.update(session, agent.id, parent_agent_id=None)
        return

    if new_parent_id == agent.id:
        raise ValueError("An agent cannot be its own parent")
    if await agent_store.get(session, new_parent_id) is None:
        raise ValueError(f"Parent agent not found: {new_parent_id}")

    # Walk up from the proposed parent; if we reach `agent.id`, the new parent
    # is a descendant of this agent, so the move would create a cycle.
    cursor: str | None = new_parent_id
    seen: set[str] = set()
    while cursor is not None and cursor not in seen:
        if cursor == agent.id:
            raise ValueError(
                "Cannot reparent an agent under one of its own descendants"
            )
        seen.add(cursor)
        ancestor = await agent_store.get(session, cursor)
        cursor = ancestor.parent_agent_id if ancestor else None

    await agent_store.update(session, agent.id, parent_agent_id=new_parent_id)
