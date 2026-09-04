"""Agent operations — what an agent can do, defined once (CHOO-1857 / CHOO-490).

These functions are the operations themselves. The MCP server registers them as
tools and the HTTP endpoint dispatches into them; neither owns them. Adding one
here makes it available through both doors at once, which is what keeps the two
from drifting apart.

Each takes its arguments and nothing else — the caller's identity, connection
and room come from `operations.context`.
"""

from __future__ import annotations

import logging
from typing import Any

from switch_core.bridges.agent.api.handlers import parse_timestamp_ms
from switch_core.bridges.agent.operations.context import (
    get_agent_id,
    get_protocol,
    require_connected_room,
    session_key,
)
from switch_core.bridges.agent.operations.registry import operation
from switch_core.bridges.agent.protocol.connections import (
    ConnectionError_,
    evicted_session_warning,
)
from switch_core.bridges.agent.protocol.instructions import build_room_instructions
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import IntegrationProfile
from switch_core.db.models import CollaborationBridge

logger = logging.getLogger(__name__)


def claim_room_on_caller_connection(
    protocol: ProtocolService, agent_id: str, connection_id: str, room_id: str
) -> str | None:
    """Bind the room to the connection that asked to connect.

    Connecting IS claiming the room slot. The caller identified itself with a
    connection, so the room is bound to it here rather than left to a follow-up
    subscribe the client has to remember — two steps that can disagree, where
    forgetting the second means silently receiving nothing.

    It also carries the fact to whoever holds that connection's stream. When a
    supervisor spawned this session and handed it the connection id, the claim
    surfaces there as ``subscription_changed``, so the supervisor learns the
    room *from Switch* rather than by reading the agent's tool result and
    hoping its shape never changes.

    **The newcomer wins, and is told what it cost.** At most one session of an
    agent may act in a room (CHOO-1419). A dead connection is not a claimant at
    all — ``claimant_of`` filters on liveness — so the only thing a claim can
    ever displace is a second session of this agent that is genuinely alive in
    the room.

    Refusing the newcomer instead would strand it: the session exists, was
    started to work here, and has nowhere to go. Letting it in resolves the
    duplicate rather than freezing it, and the loser learns it lost the room
    from ``subscription_changed`` on its own stream.

    What is not acceptable is doing it quietly. Returns the evicted connection
    id so the caller can say so — a takeover nobody reports reads exactly like
    the duplicate-session bug it is meant to resolve.

    Faults other than occupancy stay non-fatal — they cost delivery routing
    rather than the agent's place in the room, and say so in the log.
    """
    connection = protocol.connections.get(connection_id)
    if connection is None or connection.agent_id != agent_id:
        # No connection behind this caller: an MCP transport session, or a
        # runtime borrowing an id whose connection has since expired. The
        # binding row still stands and room-scoped calls resolve through it.
        return None
    try:
        evicted = protocol.connections.claim_room(connection, room_id, takeover=True)
    except ConnectionError_ as exc:
        logger.warning(
            "[CONNECT] agent=%s connection=%s could not claim room %s: %s",
            agent_id,
            connection_id,
            room_id,
            exc,
        )
        return None
    if evicted is None:
        return None
    logger.warning(
        "[CONNECT] agent=%s connection=%s took room %s from connection %s",
        agent_id,
        connection_id,
        room_id,
        evicted.id,
    )
    return evicted.id


async def bind_room_for_connectionless_caller(
    protocol: ProtocolService,
    *,
    agent_id: str,
    connection_id: str,
    room_id: str,
    connection_model: str,
) -> bool:
    """Record the room binding row, for callers that have no connection.

    The row is how an MCP transport session resolves its room, and the only
    way it can. A connection carries its own rooms, so writing the row for one
    records a binding nothing reads — and the row has no liveness check and no
    expiry, so it outlives the connection it was written for and keeps
    answering room-scoped calls afterwards. A connection that reopens without
    re-claiming its room then reads as connected on the send path while
    delivery, which consults the connection, has nothing: the agent posts into
    a room it is no longer receiving from, invisibly from either side.

    Returns whether a row was written.
    """
    if protocol.connections.get(connection_id) is not None:
        return False

    # session_passive agents have no poll loop, so the row exists only to bind
    # the MCP transport to a room — lifecycle="explicit". always_on and
    # session_addressable agents also receive heartbeat upserts; we mark the row
    # "heartbeat" so the poll path's on-conflict update doesn't need to
    # special-case it.
    lifecycle = "explicit" if connection_model == "session_passive" else "heartbeat"
    async with protocol.session_factory() as db:
        await protocol.agent_session_store.set_connected_room(
            db,
            agent_id=agent_id,
            room_id=room_id,
            transport_session_id=connection_id,
            lifecycle=lifecycle,
        )
        await db.commit()
    return True


@operation
async def list_rooms(include_archived: bool = False) -> list[dict[str, Any]]:
    """List rooms this agent is assigned to.

    Args:
        include_archived: When false (default), archived rooms are omitted so
            the active list stays uncluttered. Set true to also include
            archived rooms (each carries `archived: true`).

    Returns:
        List of {room_id, name, description, connected, archived} dicts.
        `connected` is true for the room this session is currently connected
        to (if any); `archived` is true for archived rooms.
    """
    agent_id = get_agent_id()

    protocol = get_protocol()
    connected_room_id: str | None = None
    key = session_key()
    if key:
        # Ask the live connection first and the binding row only for callers
        # that have none, matching how require_connected_room resolves it — a
        # connection carries its own rooms and no row is written for it.
        connection = protocol.connections.get(key)
        if connection is not None and len(connection.rooms) == 1:
            connected_room_id = next(iter(connection.rooms))
        elif connection is None:
            async with protocol.session_factory() as db:
                row = await protocol.agent_session_store.get_connected_room(db, key)
            if row is not None:
                _, connected_room_id = row
    rooms = await protocol.list_rooms(agent_id, include_archived=include_archived)

    return [
        {
            "room_id": r.id,
            "name": r.name,
            "description": r.description,
            "connected": r.id == connected_room_id,
            "archived": r.archived,
        }
        for r in rooms
    ]


@operation
async def connect_to_room(
    room_id: str,
    include_general_instructions: bool = True,
) -> dict[str, Any]:
    """Connect this session to a room. The agent must be assigned to the room.

    Args:
        room_id: The Switch room id (UUID string) to connect to. Get valid
            ids from list_rooms. This is the Switch room id, not the Matrix
            room id. Calling again switches the active room for this session.
        include_general_instructions: When true (default) the `instructions`
            field carries the full room-onboarding text (interaction modes,
            task protocol, agent statuses, room setup) followed by any
            room-specific instructions. Set false if your host already
            injects the general Switch usage instructions out-of-band (e.g.
            via a Claude Code skill); the general sections are then omitted
            but room-specific instructions configured at room creation are
            still returned.

    Returns:
        {agent_id, room_id, name, description, participants, instructions,
         reference_types, references, documents, packages, linked_rooms,
         roles, warning}.
        `warning` is normally null. It is set when connecting took the room off
        another live session of this same agent — only one session of an agent
        may act in a room, so that session was disconnected from it to let this
        one in. Surface it rather than ignoring it: it means work may have been
        interrupted somewhere else.
        Each reference, document, and package carries its own `instructions`
        field — agent-facing guidance for that resource — alongside a short
        `description`. `roles` lists the room's assumable roles, each
        `{name, exclusive, instructions_preview, held_by, assumable_by_me}` —
        `held_by` is the list of agent names currently holding it (live lease;
        empty if free, and a shared role may list several), so you can see
        which roles are taken and by whom before calling
        `assume_role`. `linked_rooms` lists directed pointers from this room
        to other Switch rooms: each entry has `target_room_id`,
        `target_room_name`, `target_room_description`, `label` (free-text
        relationship hint set by the operator) and `access` —
        either ``"member"`` (you can `connect_to_room(target_room_id)`) or
        ``"not_member"`` (you have NOT been assigned to that room; the
        connect call WILL fail — ask the operator to add you first).
    """
    agent_id = get_agent_id()
    protocol = get_protocol()

    try:
        room = await protocol.require_room_member(agent_id, room_id)
    except ValueError as e:
        raise ValueError(str(e)) from e
    except PermissionError as e:
        raise ValueError(str(e)) from e

    participants = await protocol.list_participants(room_id)

    async with protocol.session_factory() as session:
        agent = await protocol.agent_store.get(session, agent_id)
        room_model = await protocol.room_store.get(session, room.id)
        if agent is None or room_model is None:
            raise ValueError("Agent or room not found")
        bridge: CollaborationBridge | None = None
        if room_model.bridge_id:
            bridge = await session.get(CollaborationBridge, room_model.bridge_id)

    profile = IntegrationProfile(**agent.integration_profile)
    instructions = build_room_instructions(
        agent,
        room_model,
        profile,
        participants,
        bridge,
        include_general=include_general_instructions,
    )
    resources = await protocol.list_room_resources(room.id)
    linked_rooms = await _decorate_linked_rooms(
        protocol, agent_id, resources["linked_rooms"]
    )
    roles = await protocol.list_room_roles(agent_id, room.id)

    key = session_key()
    if not key:
        raise ValueError("MCP session has no session id; cannot connect to room")
    evicted_connection_id = claim_room_on_caller_connection(
        protocol, agent_id, key, room.id
    )

    await bind_room_for_connectionless_caller(
        protocol,
        agent_id=agent_id,
        connection_id=key,
        room_id=room.id,
        connection_model=profile.connection_model,
    )

    return {
        "agent_id": agent_id,
        "room_id": room.id,
        "name": room.name,
        "description": room.description,
        "participants": [
            {
                "id": p.id,
                "name": p.name,
                "type": p.type,
                "agent_type": p.agent_type,
                "can_delegate": p.can_delegate,
                "can_accept": p.can_accept,
                "status": p.status.value if p.status is not None else None,
                "room_role": p.room_role,
                "alias": p.alias,
            }
            for p in participants
        ],
        "instructions": instructions,
        "reference_types": resources["reference_types"],
        "references": resources["references"],
        "documents": resources["documents"],
        "packages": resources["packages"],
        "linked_rooms": linked_rooms,
        "roles": roles,
        "warning": (
            evicted_session_warning(room.id, evicted_connection_id)
            if evicted_connection_id
            else None
        ),
    }


async def _decorate_linked_rooms(
    protocol: ProtocolService,
    agent_id: str,
    linked_rooms: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Annotate each linked-room entry with an explicit ``access`` field —
    ``"member"`` if the calling agent is assigned to the target room,
    ``"not_member"`` otherwise. For ``not_member`` rows, also include a
    human-readable ``access_note`` warning that ``connect_to_room`` will
    fail until the agent is added by an operator."""
    if not linked_rooms:
        return []
    async with protocol.session_factory() as session:
        agent_rooms = await protocol.room_store.get_rooms_for_agent(session, agent_id)
    member_ids = {r.id for r in agent_rooms}
    out: list[dict[str, Any]] = []
    for entry in linked_rooms:
        is_member = entry["target_room_id"] in member_ids
        decorated = {
            **entry,
            "access": "member" if is_member else "not_member",
        }
        if not is_member:
            decorated["access_note"] = (
                "You are NOT assigned to this room. connect_to_room will fail; "
                "ask the room operator to add you before trying."
            )
        out.append(decorated)
    return out


@operation
async def list_references() -> dict[str, Any]:
    """List references, documents, and packages attached to this session's
    connected room.

    Returns:
        {reference_types, references, documents, packages} — same shape as
        the equivalent fields in `connect_to_room`. Use this to refresh
        after attachments change mid-session.

    External references carry their `value` inline (URLs / IDs); fetch the
    underlying content using your own tools as described in
    `reference_types[<type>].instructions`.

    Internal documents are advertised by id + description + instructions
    only; call `load_internal_documents` to fetch their content.

    Packages bundle other refs and documents and have their own
    `instructions`; their `references` and `documents` arrays mirror the
    same shape as the top-level fields.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()
    protocol = get_protocol()
    await protocol.require_room_member(agent_id, room_id)
    return await protocol.list_room_resources(room_id)


@operation
async def list_linked_rooms() -> list[dict[str, Any]]:
    """List the rooms linked from this session's connected room.

    Returns the directed outbound links from the current room — each link
    points at another Switch room and carries a free-text ``label`` set by
    the room's operator (e.g. "support", "parent project", "related
    workstream"). Pointers grant NO implicit access: the ``access`` field
    tells you whether you (the calling agent) can act on the target —
    ``"member"`` means ``connect_to_room(target_room_id)`` will work,
    ``"not_member"`` means you are not assigned to that room and the call
    WILL fail until an operator adds you. ``not_member`` entries also
    carry an ``access_note`` spelling that out.

    Returns:
        List of {target_room_id, target_room_name, target_room_description,
        label, access, access_note?} dicts.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()
    protocol = get_protocol()
    await protocol.require_room_member(agent_id, room_id)
    resources = await protocol.list_room_resources(room_id)
    return await _decorate_linked_rooms(protocol, agent_id, resources["linked_rooms"])


@operation
async def load_internal_documents(ids: list[str]) -> list[dict[str, Any]]:
    """Load the content of internal documents attached to the connected room.

    Args:
        ids: List of document ids to load (from `documents[*].id` in the
            connect payload or `list_references`).

    Returns:
        List of {id, description, content} entries in the same order as
        the requested ids. Raises an error if any id is not attached to the
        current room.

    The load goes through the Switch resource manager as a Matrix event
    round-trip, mirroring how tool and LLM mediation works.
    """
    import uuid

    agent_id = get_agent_id()
    room_id = await require_connected_room()
    protocol = get_protocol()
    await protocol.require_room_member(agent_id, room_id)
    request_id = str(uuid.uuid4())
    return await protocol.request_document_load(
        agent_id=agent_id,
        room_id=room_id,
        document_ids=ids,
        request_id=request_id,
        timeout=30.0,
    )


_ROOM_DOCUMENT_MAX_CONTENT_BYTES = 1_048_576


@operation
async def create_room_document(
    name: str,
    description: str,
    instructions: str,
    content: str,
) -> dict[str, str]:
    """Create a new internal document scoped to the connected room.

    The document lives only in this room, is visible to all participants,
    and never appears in the global resources library. Only you (the creating
    agent) can later update or delete it via `update_room_document` /
    `delete_room_document`. Other room members can read it via
    `load_internal_documents`, and human users can delete it from the room UI.

    Args:
        name: Short identifier for the document. Must be unique within this room.
        description: One-line summary (shown in pickers and listings).
        instructions: Agent-facing notes on when/how to use this document.
        content: Full text content (max 1 MiB).

    Returns:
        ``{"document_id": "..."}`` once the resource manager confirms creation.
    """
    import uuid

    if len(content.encode("utf-8")) > _ROOM_DOCUMENT_MAX_CONTENT_BYTES:
        raise ValueError(f"content exceeds {_ROOM_DOCUMENT_MAX_CONTENT_BYTES} bytes")
    agent_id = get_agent_id()
    room_id = await require_connected_room()
    protocol = get_protocol()
    await protocol.require_room_member(agent_id, room_id)
    request_id = str(uuid.uuid4())
    document_id = await protocol.request_room_document_create(
        agent_id=agent_id,
        room_id=room_id,
        name=name,
        description=description,
        instructions=instructions,
        content=content,
        request_id=request_id,
        timeout=30.0,
    )
    return {"document_id": document_id}


@operation
async def update_room_document(
    document_id: str,
    name: str | None = None,
    description: str | None = None,
    instructions: str | None = None,
    content: str | None = None,
) -> dict[str, str]:
    """Update a room-scoped document you created in the connected room.

    Only the agent that created the document can update it. Pass only the
    fields you want to change; omit (or set to None) the others.
    """
    import uuid

    if (
        content is not None
        and len(content.encode("utf-8")) > _ROOM_DOCUMENT_MAX_CONTENT_BYTES
    ):
        raise ValueError(f"content exceeds {_ROOM_DOCUMENT_MAX_CONTENT_BYTES} bytes")
    agent_id = get_agent_id()
    room_id = await require_connected_room()
    protocol = get_protocol()
    await protocol.require_room_member(agent_id, room_id)
    request_id = str(uuid.uuid4())
    await protocol.request_room_document_update(
        agent_id=agent_id,
        room_id=room_id,
        document_id=document_id,
        name=name,
        description=description,
        instructions=instructions,
        content=content,
        request_id=request_id,
        timeout=30.0,
    )
    return {"document_id": document_id, "status": "ok"}


@operation
async def delete_room_document(document_id: str) -> dict[str, str]:
    """Delete a room-scoped document you created in the connected room.

    Only the agent that created the document can delete it via MCP. Users
    can also delete from the room UI as an admin escape hatch.
    """
    import uuid

    agent_id = get_agent_id()
    room_id = await require_connected_room()
    protocol = get_protocol()
    await protocol.require_room_member(agent_id, room_id)
    request_id = str(uuid.uuid4())
    await protocol.request_room_document_delete(
        agent_id=agent_id,
        room_id=room_id,
        document_id=document_id,
        request_id=request_id,
        timeout=30.0,
    )
    return {"document_id": document_id, "status": "ok"}


@operation
async def read_context(
    limit: int = 50,
    since: str | None = None,
    before: str | None = None,
) -> dict[str, Any]:
    """Get the conversation timeline for the connected room, grouped into threads.

    Returns::

        {"threads": [...], "truncated": bool, "oldest_timestamp": int|None}

    `threads` is a list of thread groups ordered by latest activity (most-
    recently active LAST, so the tail is the freshest), each shaped as::

        {"root": <entry>, "replies": [<entry>, ...]}

    where <entry> is {"id", "kind", "sender", "sender_name", "body",
    "timestamp", "attachments"}. Top-level entries are roots with an empty
    `replies` list; replies are oldest-first within a thread. Use a root's (or
    any entry's) `id` as the `thread_id` argument to post_message /
    send_targeted_message to reply into that thread.

    `kind` is "message" for something a participant said, or "room_join" for
    someone arriving in the room (body reads "<name> joined the room"). Joins
    are part of the timeline so the history explains who appeared and when.

    **`truncated` matters.** It is True when older history exists that this
    call did not reach — you are looking at a partial conversation. Widen
    `limit`, or page backwards with `before`, before concluding you have the
    full picture. `oldest_timestamp` marks where to resume, but it is epoch
    milliseconds while `before` is parsed as ISO-8601: convert it rather than
    passing it straight back. `truncated` is deliberately conservative: a read
    that ends exactly on `limit` reports truncated even if nothing older
    exists.

    `attachments` is a (usually empty) list of files on the message, each
    {"filename", "mimetype", "size", "mxc", "msgtype"}. Any file type can
    appear, and a message may carry several. To actually view one, pass its
    `mxc` to the `download_attachment` tool, which fetches it to a local file
    you can read.

    Args:
        limit: Maximum number of timeline entries to return (default 50),
            grouped into threads. History is paged from the homeserver until
            this many are collected or the room's start is reached.
        since: ISO-8601 timestamp string (e.g. "2026-05-20T20:55:00Z"). Only
            entries at or after this time are returned. Use this when an event
            arrives to fetch just the recent context — pass a timestamp a few
            minutes before the event ts. None = no lower bound.
        before: ISO-8601 timestamp string. Only entries strictly before this
            time are returned; history is paged backwards to reach them, so
            this genuinely walks into older history. Combine with `since` to
            page through a window. None = no upper bound.

    The room is implicit (the session's currently connected room). Reads
    fail if you have not called connect_to_room first.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()

    protocol = get_protocol()
    since_ms = parse_timestamp_ms(since) if since else None
    before_ms = parse_timestamp_ms(before) if before else None

    return await protocol.read_context(
        agent_id, room_id, limit=limit, since_ms=since_ms, before_ms=before_ms
    )


@operation
async def list_participants() -> list[dict[str, Any]]:
    """List agents and users in the connected room.

    Args:
        (none) — operates on the session's currently connected room. Call
        connect_to_room first.

    Returns:
        List of {id, name, type, status, alias} dicts for each participant.
        `status` and `alias` are null when unset.
    """
    get_agent_id()
    room_id = await require_connected_room()

    protocol = get_protocol()
    participants = await protocol.list_participants(room_id)

    return [
        {
            "id": p.id,
            "name": p.name,
            "type": p.type,
            "status": p.status.value if p.status is not None else None,
            "alias": p.alias,
        }
        for p in participants
    ]


@operation
async def post_message(body: str, thread_id: str | None = None) -> dict[str, str]:
    """Send a message to the connected room (broadcast, no specific recipient).

    Args:
        body: The message text to send. Plain string — do not wrap in JSON or
            prefix with `@name` (use send_targeted_message for addressed
            messages). The room is implicit: messages go to the room this
            session is currently connected to via connect_to_room, so there
            is no `room_id` parameter.
        thread_id: Optional. The `id` of a message to reply into, making this a
            threaded reply. Pass any message id from the thread (a root or a
            reply) — it is normalised to the thread root. Omit for a top-level
            message. Get ids from read_context or from a notification's
            thread_id.

    Returns:
        {"event_id": "<matrix event id>"} for the posted message.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()

    protocol = get_protocol()
    event_id = await protocol.send_message(agent_id, room_id, body, thread_id=thread_id)
    return {"event_id": event_id}


@operation
async def send_targeted_message(
    body: str,
    target_names: list[str] | None = None,
    target_roles: list[str] | None = None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    """Send a message addressed to specific agents/users and/or roles.

    Prepends `@name` for each name target and `@role` for each role target so
    they receive it as an addressed event. Other participants still see the
    message as room context. Use when you need specific participants to act,
    but the work is informal (a question, nudge, or handoff that doesn't need
    task tracking).

    Args:
        body: The message text. Plain string — do not pre-add `@` prefixes;
            this tool adds them for each target.
        target_names: Agent or user names (the `name` field from
            list_participants, not ids) to address. Prepended as `@name`.
        target_roles: Role names (from list_roles) to address. Each is
            prepended as `@role` and fans out to every live holder of that
            role — the single holder for an exclusive role, all current
            holders for a shared one. Use this to reach "whoever holds the
            manager role" without naming the agent.
        thread_id: Optional. The `id` of a message to reply into, making this a
            threaded reply. Pass any message id from the thread — it is
            normalised to the thread root. Omit for a top-level message.

    At least one of target_names / target_roles is required.

    Returns:
        {"event_id": "<matrix event id>", "target_statuses": {name: status}}.
        `target_statuses` reports each addressed *agent*'s reachability at send
        time — for a role target, that is each of its live holders: `live`
        (will receive immediately), `awaiting_manual_poll` (must read context
        to see it), `no_session`/`disconnected` (not reachable; may not see the
        message until they reconnect). User targets are omitted — their
        reachability is the collaboration bridge's concern. A role with no live
        holder contributes no entries.

        `not_permitted` is the one status that is not about reachability: that
        agent's addressing policy does not admit you. The message is still
        sent, and it will answer in the room saying it cannot act on it — so
        read its reply rather than treating this as a failed send. Reaching it
        another way is a matter for whoever owns it, not for a retry.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()

    protocol = get_protocol()
    result = await protocol.send_targeted_message(
        agent_id,
        room_id,
        target_names or [],
        body,
        thread_id=thread_id,
        target_roles=target_roles or [],
    )
    return {
        "event_id": result.event_id,
        "target_statuses": {n: s.value for n, s in result.target_statuses.items()},
    }


# ── Task Protocol ───────────────────────────────────────────────────────────


@operation
async def delegate_task(
    performer_agent_id: str, summary: str, description: str
) -> dict[str, str]:
    """Delegate a task to a performer agent. Requires can_delegate capability.

    Args:
        performer_agent_id: The id of the agent to assign the task to. Must
            be a participant in the connected room. Use list_participants to
            find ids (the `id` field, not `name`).
        summary: Short one-line title for the task (shown in lists/headers).
        description: Full instructions: what to do, inputs, expected output,
            constraints. The performer reads this when accepting.

    Returns:
        {"task_id": "<id>", "status": "pending", "target_status": "<status>"}.
        `target_status` reports the performer's reachability at delegation
        time; for `no_session`/`disconnected` the performer won't see the
        task until they reconnect.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()

    protocol = get_protocol()
    result = await protocol.delegate_task(
        agent_id, room_id, performer_agent_id, summary, description
    )
    return {
        "task_id": result.task_id,
        "status": "pending",
        "target_status": result.target_status.value,
    }


@operation
async def accept_task(task_id: str) -> dict[str, Any]:
    """Accept a delegated task. Requires can_accept capability.

    Args:
        task_id: The id of the task to accept (from the task_delegate event
            or list_tasks). Caller must be the assigned performer.

    Returns:
        {"status": "ongoing", "accepted_at": "<iso timestamp>"}.
    """
    agent_id = get_agent_id()
    await require_connected_room()

    protocol = get_protocol()
    await protocol.accept_task(agent_id, task_id)
    task = await protocol.get_task(agent_id, task_id)
    accepted_at = None
    if task.accepted_at:
        accepted_at = (
            task.accepted_at.isoformat()
            if hasattr(task.accepted_at, "isoformat")
            else str(task.accepted_at)
        )
    return {
        "status": task.status,
        "accepted_at": accepted_at,
    }


@operation
async def update_task(task_id: str, update: str) -> dict[str, Any]:
    """Post a progress update on an assigned task. Requires can_accept capability.

    Args:
        task_id: The id of an ongoing task you have accepted.
        update: One-string progress note (what you've done, what's next, any
            blockers). Appended to the task's update log; does not finalise.

    Returns:
        {"status": "updated", "updates_count": <int>} with the new total.
    """
    agent_id = get_agent_id()
    await require_connected_room()

    protocol = get_protocol()
    await protocol.update_task(agent_id, task_id, update)
    task = await protocol.get_task(agent_id, task_id)
    return {"status": "updated", "updates_count": len(task.updates)}


@operation
async def finalise_task(task_id: str, outcome: str) -> dict[str, Any]:
    """Complete a task with final outcome. Requires can_accept capability.

    Args:
        task_id: The id of an ongoing task you have accepted.
        outcome: One-string final result — describe success or failure and
            any output/links the requester needs. After this call the task
            moves to `finalised` and cannot be updated further.

    Returns:
        {"status": "finalised", "finalised_at": "<iso timestamp>"}.
    """
    agent_id = get_agent_id()
    await require_connected_room()

    protocol = get_protocol()
    await protocol.finalise_task(agent_id, task_id, outcome)
    task = await protocol.get_task(agent_id, task_id)
    finalised_at = None
    if task.finalised_at:
        finalised_at = (
            task.finalised_at.isoformat()
            if hasattr(task.finalised_at, "isoformat")
            else str(task.finalised_at)
        )
    return {
        "status": task.status,
        "finalised_at": finalised_at,
    }


@operation
async def cancel_task(task_id: str, reason: str) -> dict[str, str]:
    """Abandon a task you delegated. Only the requester can cancel.

    Args:
        task_id: The id of a task this agent delegated.
        reason: Why the task is no longer needed. Recorded on the task and
            posted to the room so the performer learns it has been dropped.

    Returns:
        {"status": "cancelled", "reason": "<reason>"}.
    """
    agent_id = get_agent_id()
    await require_connected_room()

    protocol = get_protocol()
    await protocol.cancel_task(agent_id, task_id, reason)
    return {"status": "cancelled", "reason": reason}


@operation
async def list_tasks(
    role: str | None = None, status: str | None = None
) -> list[dict[str, Any]]:
    """List tasks for the connected agent in the connected room.

    Args:
        role: Perspective filter.
            - "delegated": tasks this agent created as requester
            - "assigned": tasks assigned to this agent as performer
            - None: both
        status: Lifecycle filter. One of "pending", "ongoing", "finalised",
            "cancelled", or None for all.

    Returns:
        List of task dicts {id, summary, description, status,
        requester_agent_id, performer_agent_id, updates, outcome,
        created_at, accepted_at, finalised_at}. Timestamps are ISO-8601
        strings or null.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()  # type: ignore[arg-type]

    protocol = get_protocol()
    tasks = await protocol.list_tasks(
        agent_id, room_id=room_id, role=role, status=status
    )

    result = []
    for t in tasks:
        created_at = None
        if t.created_at:
            created_at = (
                t.created_at.isoformat()
                if hasattr(t.created_at, "isoformat")
                else str(t.created_at)
            )
        accepted_at = None
        if t.accepted_at:
            accepted_at = (
                t.accepted_at.isoformat()
                if hasattr(t.accepted_at, "isoformat")
                else str(t.accepted_at)
            )
        finalised_at = None
        if t.finalised_at:
            finalised_at = (
                t.finalised_at.isoformat()
                if hasattr(t.finalised_at, "isoformat")
                else str(t.finalised_at)
            )
        result.append(
            {
                "id": t.id,
                "summary": t.summary,
                "description": t.description,
                "status": t.status,
                "requester_agent_id": t.requester_agent_id,
                "performer_agent_id": t.performer_agent_id,
                "updates": t.updates,
                "outcome": t.outcome,
                "created_at": created_at,
                "accepted_at": accepted_at,
                "finalised_at": finalised_at,
            }
        )
    return result


# ── Moderation ───────────────────────────────────────────────────────────────


@operation
async def create_room(
    name: str,
    description: str,
    agent_names: list[str],
    user_names: list[str] | None = None,
    channel_type: str | None = None,
    bridge_id: str | None = None,
    internal_only: bool = False,
    admin_mode: bool = False,
    security_config: dict[str, Any] | None = None,
    instructions: str | None = None,
    reference_ids: list[str] | None = None,
    package_ids: list[str] | None = None,
    linked_rooms: list[dict[str, str]] | None = None,
    read_visibility: str = "public",
    write_visibility: str = "public",
    group_name: str | None = None,
    roles: list[dict[str, Any]] | None = None,
    include_subagents_for: list[str] | None = None,
    join_event_listeners: list[str] | None = None,
    aliases: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Create a new Switch room.

    Rooms are bridged by default: omitting `bridge_id` uses the instance's
    default bridge (on a standalone deployment, the bundled Mattermost), so the
    room is readable by humans without the caller knowing the deployment's
    topology. Pass `bridge_id` to choose a specific bridge — call
    `list_bridges` to discover ids and present the choice to the user. Pass
    `internal_only=True` for an agent-only room with no external channel.

    If the instance has no default bridge configured and you omit `bridge_id`,
    the room is created internal-only.

    Args:
        name: Display name for the room.
        description: Free-text description shown to participants.
        agent_names: Names of agents to add to the room at creation. The
            calling agent is not added automatically — include its name here
            if it should join. Names must already exist in the registry.
        user_names: Optional list of human user names to add. Only meaningful
            for bridged rooms.
        channel_type: One of "channel_public", "channel_private", or "direct".
            Required when `bridge_id` is set; ignored for internal-only rooms.
            Use "direct" to open a 1:1 DM room — exactly one entry in
            `agent_names` and one in `user_names`. On Slack this is provisioned
            as a private channel with that user invited; the user must already
            be known to Switch on the bridge (creation fails otherwise).
        bridge_id: Optional id of the collaboration bridge backing this room.
            Omit to use the instance's default bridge.
        internal_only: Create a room with no external channel, opting out of
            the default bridge. Ignored when `bridge_id` is set.
        admin_mode: When true, the room is created in administrative mode.
        security_config: Optional dict overriding default protection checks.
        instructions: Room-specific system prompt / guidance shown to agents
            when they connect.
        reference_ids: References to attach at creation. Authorization is
            checked against the calling agent's owner; you can only attach
            references your owning user has access to.
        package_ids: Packages to attach at creation. Same authorization as
            references.
        linked_rooms: Directed links from this room to existing rooms. Each
            entry is `{"target_room_id": "...", "label": "..."}`.
        read_visibility: "public" (anyone may read) or "private" (owner/admin
            only). Defaults to "public".
        write_visibility: "public" (anyone may modify — invite, attach, edit)
            or "private" (owner/admin only). Defaults to "public". Must not be
            "public" while read_visibility is "private".
        group_name: Optional name of an existing room group to file this room
            under (a navigation/visualization layer surfaced in the room list
            and graph). Must match an existing group exactly; errors if unknown
            or ambiguous. Omit to leave the room standalone.
        roles: Optional room-roles to define at creation. Each entry is
            `{"name": "...", "instructions": "...", "exclusive": bool}`.
            Roles are assumable instruction bundles agents pick up with
            `assume_role`; exclusive roles allow at most one live holder.
        include_subagents_for: Per-agent opt-in. A subset of `agent_names`
            whose subagents (child agents — e.g. a Claude Code agent's
            registered `.claude/agents` subagents) should also be added to the
            room. Only the named parents are expanded, not every agent.
        join_event_listeners: Per-agent opt-in. A subset of `agent_names` that
            should receive `room_join` events in this room (fired when someone
            joins). Agents not listed do not receive them. Use for a welcome /
            onboarding agent that should greet new arrivals.
        aliases: Optional per-room agent aliases, keyed by agent name → alias.
            `@<alias>` then addresses that agent in the room exactly like its
            real name. Each agent must be in `agent_names`; an alias may
            contain only letters, digits, '.', '-', '_' and must not clash
            with an agent's real name, a room role, or another alias.

    Returns:
        `{"id", "name", "matrix_room_id", "failed_attachments": [...]}`.
        `failed_attachments` is empty on full success; otherwise it lists
        `{kind, id, error}` for each attachment that could not be applied
        after the room was created (race-time failures only; predictable
        errors like missing ids abort creation upfront).
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    result = await protocol.create_moderation_room(
        agent_id=agent_id,
        name=name,
        description=description,
        agent_names=agent_names,
        include_subagents_for=include_subagents_for,
        join_event_listeners=join_event_listeners,
        user_names=user_names,
        channel_type=channel_type,
        bridge_id=bridge_id,
        internal_only=internal_only,
        admin_mode=admin_mode,
        security_config=security_config,
        instructions=instructions,
        reference_ids=reference_ids,
        package_ids=package_ids,
        linked_rooms=linked_rooms,
        read_visibility=read_visibility,
        write_visibility=write_visibility,
        group_name=group_name,
        roles=roles,
        aliases=aliases,
    )
    return {
        "id": result.room.id,
        "name": result.room.name,
        "matrix_room_id": result.room.matrix_room_id,
        "failed_attachments": result.failed_attachments,
    }


@operation
async def list_roles() -> list[dict[str, Any]]:
    """List the roles defined in the connected room.

    Roles are room-scoped, assumable instruction bundles. Each entry carries
    `name`,
    `exclusive`, an `instructions_preview`, `assumable_by_me` (whether you could
    `assume_role` it right now), and `held_by` — the live holders (empty if
    free, possibly several for a shared role). Each holder is an object
    `{"name", "present_here", "session_room"}`: `present_here` is True when that
    holder's assuming session is connected to THIS room right now; otherwise
    `session_room` names the room its session is currently attending (a lease
    survives room hops, so a holder can be live but looking elsewhere), or is
    null if no bound session can be located.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()
    return await get_protocol().list_room_roles(agent_id, room_id)


@operation
async def get_role_detail(room_id: str, role_name: str) -> dict[str, Any]:
    """Get one room role's FULL untruncated instructions.

    `list_roles` and `get_room_detail` only expose a 200-char
    `instructions_preview`; use this when you need a role's complete
    instructions — e.g. before assuming it. You must be a member of the room
    (it does not have to be the room your session is currently connected to).

    Args:
        room_id: The Switch room id (UUID string).
        role_name: The exact role name (as shown by `list_roles`).

    Returns:
        {name, exclusive, instructions (the FULL untruncated bundle),
        held_by (live holder objects {name, present_here, session_room}), and
        assumable_by_me}. The `held_by` and `assumable_by_me` fields carry the
        same semantics as `list_roles`. Raises if no such role exists in the
        room, or if you are not a member.
    """
    agent_id = get_agent_id()
    return await get_protocol().get_room_role(agent_id, room_id, role_name)


@operation
async def define_role(
    name: str, instructions: str, exclusive: bool = False
) -> dict[str, Any]:
    """Define a new role in the connected room. Requires write access to the room.

    Args:
        name: Role name, unique within the room (e.g. "manager", "worker").
        instructions: The instruction bundle delivered when an agent assumes
            this role.
        exclusive: When true, at most one live agent may hold the role at a
            time (a lease with auto-release). When false, unrestricted.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()
    await get_protocol().define_room_role(
        agent_id, room_id, name, instructions, exclusive
    )
    return {"status": "defined", "name": name}


@operation
async def edit_role(
    name: str,
    instructions: str | None = None,
    exclusive: bool | None = None,
) -> dict[str, Any]:
    """Edit a role's instructions and/or exclusivity. Requires write access.

    Edits take effect on the next `assume_role`; any current holder keeps the
    instructions it already received.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()
    await get_protocol().edit_room_role(
        agent_id, room_id, name, instructions, exclusive
    )
    return {"status": "edited", "name": name}


@operation
async def delete_role(name: str) -> dict[str, Any]:
    """Delete a role from the connected room (and any lease on it).

    Requires write access to the room.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()
    await get_protocol().delete_room_role(agent_id, room_id, name)
    return {"status": "deleted", "name": name}


@operation
async def assume_role(role: str) -> dict[str, Any]:
    """Assume a role in the connected room and receive its instructions.

    Returns `{"role", "instructions"}` — the role's instruction delta to layer
    on top of the room context you already have. Any room member may assume a
    role. Fails if you already hold a role (release it first), or if the role
    is exclusive and currently held by another live agent.

    For exclusive roles, this acquires a lease with a fast heartbeat: while
    your session stays alive the seat is yours, and it auto-releases shortly
    after you disconnect so another agent can take over.
    """
    agent_id = get_agent_id()
    room_id = await require_connected_room()
    return await get_protocol().assume_room_role(agent_id, room_id, role, session_key())


@operation
async def release_role() -> dict[str, Any]:
    """Release the role you currently hold, freeing it for others. Idempotent."""
    agent_id = get_agent_id()
    await require_connected_room()
    await get_protocol().release_room_role(agent_id)
    return {"status": "released"}


@operation
async def list_reference_types() -> list[dict[str, Any]]:
    """List the Reference sub-types this Switch instance supports.

    Call this before `create_reference` to discover which `type` values
    are valid and what shape the `value` payload must have.

    Returns:
        List of `{type, display_name, instructions, value_schema}`.
        `value_schema` is the JSON Schema for the per-type value
        payload — use it to build the `value` dict for `create_reference`.
    """
    protocol = get_protocol()
    return protocol.list_reference_types()


@operation
async def create_reference(
    type: str,
    name: str,
    description: str,
    instructions: str,
    value: dict[str, Any],
    read_visibility: str = "private",
    write_visibility: str = "private",
) -> dict[str, Any]:
    """Create a new Reference owned by your user.

    A Reference is a pointer to external content (e.g. Google Drive
    documents, Confluence pages, GitHub repositories, Jira issues) that can
    be attached to rooms so other agents and humans in the room can discover
    and access it.

    Args:
        type: Reference type. Supported values: "google_drive",
            "confluence", "github", "jira". Each type expects a specific
            `value` shape. Call `list_reference_types` for the authoritative
            list and each type's `value_schema`.
        name: Short display name.
        description: One-or-two sentence summary of what this reference
            points at, shown in listings.
        instructions: Free-text guidance for agents on how to USE this
            reference — what's in it, when to consult it, any caveats.
            This is the field agents read when the reference shows up in
            their room context.
        value: Type-specific payload. For every built-in type today the
            shape is `{"urls": ["https://...", ...]}` — `min_length=1`. For
            "jira" the URLs point at projects, issues, or boards (e.g.
            `https://your-org.atlassian.net/browse/PROJ-123`).
        read_visibility: "private" (default — only you can read/attach it) or
            "public" (anyone can read/attach).
        write_visibility: "private" (default — only you can edit it) or
            "public" (anyone can edit). Must not be "public" while
            read_visibility is "private".

    Returns:
        `{"id", "type", "name", "read_visibility", "write_visibility"}` of the
        created reference.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    ref = await protocol.create_reference(
        agent_id=agent_id,
        type=type,
        name=name,
        description=description,
        instructions=instructions,
        value=value,
        read_visibility=read_visibility,
        write_visibility=write_visibility,
    )
    return {
        "id": ref.id,
        "type": ref.type,
        "name": ref.name,
        "read_visibility": ref.read_visibility,
        "write_visibility": ref.write_visibility,
    }


@operation
async def attach_reference_to_room(room_id: str, reference_id: str) -> dict[str, bool]:
    """Attach an existing Reference to an existing room.

    Authorization: your agent's owner must be able to access the
    reference (public, owned by them, or they are an admin). Use
    `create_reference` first if you need to create one.

    Args:
        room_id: Switch room id to attach to.
        reference_id: Id of the reference to attach.

    Returns:
        `{"ok": true}` on success.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    await protocol.attach_reference_to_room_as_agent(agent_id, room_id, reference_id)
    return {"ok": True}


@operation
async def link_rooms(
    source_room_id: str, target_room_id: str, label: str
) -> dict[str, Any]:
    """Create a directed link from one room to another.

    Links are advertised to agents connected to `source_room_id` via
    the `linked_rooms` array, with the `label` you supply as the
    relationship hint (e.g. "support", "parent project", "depends on").
    Links are one-way; create the reverse link separately if you want
    both directions.

    Args:
        source_room_id: The room the link is attached to (where the
            pointer will appear).
        target_room_id: The room the link points at.
        label: Free-text relationship hint, shown to agents and humans.
            Must not be empty.

    Returns:
        `{"target_room_id", "target_room_name", "target_room_description",
        "label"}` for the freshly-created link.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    return await protocol.link_rooms(agent_id, source_room_id, target_room_id, label)


@operation
async def unlink_rooms(source_room_id: str, target_room_id: str) -> dict[str, bool]:
    """Remove a directed link from one room to another.

    The inverse of `link_rooms`: detaches the existing pointer from
    `source_room_id` to `target_room_id` so it no longer appears in the
    source room's `linked_rooms` array. Links are one-way, so this only
    removes the `source_room_id → target_room_id` direction; remove the
    reverse link separately if one exists.

    Args:
        source_room_id: The room the link is attached to (where the
            pointer currently appears).
        target_room_id: The room the link points at.

    Returns:
        `{"ok": true}` on success. Raises an error if no such link
        exists.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    await protocol.unlink_rooms(agent_id, source_room_id, target_room_id)
    return {"ok": True}


@operation
async def list_bridges() -> list[dict[str, Any]]:
    """List collaboration bridges available on this Switch instance.

    Use this when creating a room and you need to pick a bridge — present
    the list to the user and let them choose, rather than guessing.

    Returns:
        List of `{id, type, display_name, status, is_default,
        can_create_channels}` dicts. Only `status` == "active" bridges are
        usable for new rooms; others are shown for context. `is_default`
        marks the bridge that `create_room` uses when no `bridge_id` is given
        (at most one).

        `can_create_channels` is false when Switch cannot make a channel on
        that bridge — either the platform has no such call (Telegram) or an
        operator has withheld it. Creating a room on one of those fails, so
        offer an existing channel instead: the chat is made on the platform,
        the Switch app is added to it, and the room is adopted from that.
    """
    protocol = get_protocol()
    return await protocol.list_bridges()


@operation
async def invite_agent_to_room(
    room_id: str, agent_name: str, include_subagents: bool = False
) -> dict[str, bool]:
    """Invite an agent into an existing room by name.

    Args:
        room_id: The Switch room id (UUID string).
        agent_name: Registry name of the agent to add.
        include_subagents: When true, also add the invited agent's subagents
            (child agents — e.g. a Claude Code agent's registered
            `.claude/agents` subagents).

    Returns:
        {"ok": true} on success.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    await protocol.invite_agent_to_room(
        agent_id, room_id, agent_name, include_subagents=include_subagents
    )
    return {"ok": True}


@operation
async def add_users_to_room(room_id: str, user_names: list[str]) -> dict[str, Any]:
    """Add one or more human users to an existing bridged room by name.

    Unlike `invite_agent_to_room` (which adds agents), this adds humans. The
    room must already be bridged: each user is added to the room's external
    channel (Slack/Mattermost) and joined to the Switch room. Each name must
    be a user already known to that bridge — e.g. someone who has signed into
    the workspace — otherwise the bridge cannot resolve them. Use this after a
    bridge change to re-invite the humans who were dropped, since their
    identities are bridge-specific and are not carried across.

    Args:
        room_id: The Switch room id (UUID string).
        user_names: Registry names of the users to add.

    Returns:
        `{"ok": bool, "added": [...], "unresolved": [...]}`. `unresolved`
        lists names the bridge had no external user for — they were skipped,
        not added (likely they have not signed into the workspace yet). `ok`
        is true only when every requested name was added.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    unresolved = await protocol.add_users_to_room(agent_id, room_id, user_names)
    added = [name for name in user_names if name not in unresolved]
    return {"ok": not unresolved, "added": added, "unresolved": unresolved}


@operation
async def list_all_rooms(include_archived: bool = False) -> list[dict[str, Any]]:
    """List every room on this Switch instance (not just rooms this agent
    is a member of). Use `list_rooms` instead to see only the rooms this
    agent is assigned to.

    Args:
        include_archived: When false (default), archived rooms are omitted.
            Set true to also include archived rooms (each carries
            `archived: true`).

    Returns:
        List of {room_id, name, description, archived} dicts.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    rooms = await protocol.list_all_rooms(agent_id, include_archived=include_archived)
    return [
        {
            "room_id": r.id,
            "name": r.name,
            "description": r.description,
            "archived": r.archived_at is not None,
        }
        for r in rooms
    ]


@operation
async def list_room_groups() -> list[dict[str, Any]]:
    """List the room groups on this Switch instance.

    Room groups are a navigation/organization layer: a room can belong to a
    group (or be standalone), and groups can nest under a parent group. Use
    this to discover the group names you can pass as `group_name` to
    `create_room`, or to understand how rooms are organized.

    Returns:
        List of {id, name, description, parent_group_id, room_count, path}
        dicts, where `path` is the group's root-first ancestry (e.g.
        "Parent / Child") and `room_count` is the number of rooms directly in
        the group. Sorted by path.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    return await protocol.list_room_groups(agent_id)


@operation
async def create_room_group(
    name: str,
    description: str | None = None,
    color: str | None = None,
    parent_group_name: str | None = None,
) -> dict[str, Any]:
    """Create a new room group (a navigation/organization layer for rooms).

    A room group is a named bucket that rooms can be filed under (via
    `create_room`'s `group_name`), and groups can nest under a parent group to
    form a tree. Creating a group does not move any rooms into it.

    Args:
        name: The group's display name.
        description: Optional free-text description.
        color: Optional UI colour hint (e.g. a hex string).
        parent_group_name: Optional name of an existing group to nest this one
            under. Must match an existing group exactly; errors if unknown or
            ambiguous. Omit to create a top-level group.

    Returns:
        {id, name, description, color, parent_group_id, room_count, path,
        member_rooms, child_groups} for the new group (room_count 0, empty
        member_rooms/child_groups). `path` is the root-first ancestry.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    return await protocol.create_room_group(
        agent_id, name, description, color, parent_group_name
    )


@operation
async def get_room_group_detail(group_id: str) -> dict[str, Any]:
    """Get full detail for a room group, including its members and children.

    Args:
        group_id: The room group's id (from `list_room_groups`).

    Returns:
        {id, name, description, color, parent_group_id, room_count, path,
        member_rooms, child_groups}, where `path` is the group's root-first
        ancestry (e.g. "Parent / Child"), `member_rooms` is the rooms directly
        in this group as {id, name}, and `child_groups` is the immediate
        subgroups as {id, name}.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    return await protocol.get_room_group_detail(agent_id, group_id)


@operation
async def list_agents(
    name_contains: str | None = None,
    owner_name: str | None = None,
    known_agent_type: str | None = None,
) -> list[dict[str, Any]]:
    """List the agents registered on this Switch instance.

    Unlike `list_participants` (which is scoped to the connected room), this
    lists every agent on the instance. Use the optional filters to narrow the
    result; they are ANDed together, and omitting one ignores it.

    Args:
        name_contains: Case-insensitive substring to match against agent names.
        owner_name: Return only agents owned by the user with this exact name.
        known_agent_type: Return only agents of this known-agent type (e.g.
            "claude-code").

    Returns:
        A list of agent summaries (sorted by name), each
        {id, name, description, icon_url, display_name, connector_type,
        connection_model, tool_count, model_count, owner_id, owner_name,
        oauth_client_id, created_at, parent_agent_id, known_agent_type,
        known_agent_options}.
        `icon_url` is null when the agent has no icon set. `display_name` is
        null when the agent has no display name set; fall back to `name`.
        Use `get_agent_detail` for the full detail of one agent.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    return await protocol.list_agents(
        agent_id, name_contains, owner_name, known_agent_type
    )


@operation
async def get_agent_detail(agent_id: str) -> dict[str, Any]:
    """Get full detail for an agent on this Switch instance.

    Readable for any agent (not just your own). Use it to inspect another
    agent's configuration, capabilities, room memberships, and live sessions.

    Args:
        agent_id: The target agent's id (from `list_participants` or
            `list_all_rooms`/`get_room_detail`).

    Returns:
        {id, name, description, icon_url, display_name, connector_type,
        connection_model, tool_count, model_count, owner_id, owner_name,
        oauth_client_id, created_at, parent_agent_id, known_agent_type,
        known_agent_options, agent_type, integration_profile, tools, models,
        rooms, sessions, children}.
        `icon_url` is null when the agent has no icon set. `display_name` is
        null when the agent has no display name set; fall back to `name`.
    """
    caller_id = get_agent_id()
    protocol = get_protocol()
    detail = await protocol.get_agent_detail(caller_id, agent_id)
    return detail.model_dump()


@operation
async def update_agent_detail(
    agent_id: str,
    options: dict[str, Any] | None = None,
    parent_agent_id: str | None = None,
    clear_parent: bool = False,
) -> dict[str, Any]:
    """Update an agent's editable settings and return its fresh detail.

    Owner-only: you may only update an agent whose owner is the same as your
    own owner (the call fails with a permission error otherwise). Only agents
    registered with a known-agent type (e.g. "claude-code") have editable
    options.

    Editable fields:
        - `options`: a PARTIAL map of the agent's known-agent options to
          change — only the keys you pass are updated; the rest are left as-is.
          For a claude-code agent the options are `repo_dir` (the working
          directory), `channels_enabled`, and `subagent_name`.
          The merged options are validated against the agent type's schema and
          its integration profile is rebuilt to match.
        - `parent_agent_id`: set the agent's parent (e.g. to make it a subagent
          of another agent). Validated against self-parenting and cycles.
        - `clear_parent`: pass True to detach the agent from its parent (make it
          top-level). Mutually exclusive with `parent_agent_id`.

    Omit a field to leave it unchanged. Returns the same shape as
    `get_agent_detail`.
    """
    caller_id = get_agent_id()
    protocol = get_protocol()
    detail = await protocol.update_agent_detail(
        caller_id, agent_id, options, parent_agent_id, clear_parent
    )
    return detail.model_dump()


@operation
async def get_room_detail(room_id: str) -> dict[str, Any]:
    """Get full detail for a room you are a member of.

    You must be a member of the room (assigned to it); this does not have to
    be the room your session is currently connected to. Fails with a
    permission error if you are not a member.

    Args:
        room_id: The Switch room id (UUID string).

    Returns:
        {id, name, description, channel_type, admin_mode, instructions,
        matrix_room_id, created_at, bridge_id, bridge_display_name,
        external_channel_id, group_id, group_name, group_path (the group's
        root-first ancestry, e.g. "Parent / Child"; null when standalone),
        agent_names, agent_statuses (keyed by agent name), connected_user_names,
        aliases (per-room agent aliases, keyed by agent name → alias),
        roles (the room's assumable roles, mirroring list_roles: each entry has
        name, exclusive, instructions_preview, held_by (holder objects with
        presence), and assumable_by_me)}.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    detail = await protocol.get_room_detail(agent_id, room_id)
    return detail.model_dump()


@operation
async def update_room(
    room_id: str,
    name: str | None = None,
    description: str | None = None,
    instructions: str | None = None,
    admin_mode: bool | None = None,
    join_event_listeners: dict[str, bool] | None = None,
    bridge_id: str | None = None,
    channel_type: str | None = None,
    external_channel_id: str | None = None,
    aliases: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Update attributes of a room you are a member of.

    You must be a member of the room (assigned to it); fails with a
    permission error otherwise. Only the fields you pass are changed —
    omit (leave as None) any attribute you want to keep unchanged.

    Args:
        room_id: The Switch room id (UUID string).
        name: New room name, or None to leave unchanged.
        description: New room description, or None to leave unchanged.
        instructions: New room-specific instructions, or None to leave
            unchanged.
        admin_mode: New admin-mode flag, or None to leave unchanged.
        join_event_listeners: Partial map of agent name → whether that agent
            should receive `room_join` events in this room. Only the named
            agents change; omit to leave all memberships unchanged. Each named
            agent must already be a member of the room.
        bridge_id: Move the room onto this collaboration bridge. A fresh
            external channel is provisioned on the target bridge and the
            room's current agents are re-added, then the old bridge is detached
            (the old external channel is left in place on its platform but is
            no longer synced). Human users are NOT carried over — their
            identities are bridge-specific — so re-invite them to the new
            channel manually. Call `list_bridges` for valid ids. Omit to leave
            the room's bridge unchanged. This sets or moves a bridge only — it
            cannot remove one.
        channel_type: Visibility for the newly provisioned channel when
            `bridge_id` is set — "channel_public" or "channel_private". Omit
            to keep the room's current privacy. Ignored unless `bridge_id` is
            given.
        external_channel_id: Bind to this EXISTING channel on the target
            bridge instead of provisioning a new one — e.g. to move a room
            back onto a channel it previously used (channels are left in place
            on a bridge change, so the old one still exists). The id must be a
            real channel on the target bridge whose bridge bot is a member.
            Ignored unless `bridge_id` is given.
        aliases: Per-room agent aliases to set, keyed by agent name → alias.
            `@<alias>` then addresses that agent in the room like its real
            name. Pass an empty string ("") as the value to clear an agent's
            alias. Only the agents you name are touched; others keep their
            current alias. An alias may contain only letters, digits, '.',
            '-', '_' and must not clash with an agent's real name, a room
            role, or another alias. Omit to leave aliases unchanged.

    Returns:
        The full, updated room detail (same shape as get_room_detail),
        including the room's current `aliases` map.
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    detail = await protocol.update_room(
        agent_id,
        room_id,
        name=name,
        description=description,
        instructions=instructions,
        admin_mode=admin_mode,
        join_event_listeners=join_event_listeners,
        bridge_id=bridge_id,
        channel_type=channel_type,
        external_channel_id=external_channel_id,
        aliases=aliases,
    )
    return detail.model_dump()


@operation
async def archive_room(room_id: str) -> dict[str, Any]:
    """Archive a room you are a member of, hiding it from the default active
    room lists once its work is complete.

    Archiving is metadata-only and fully reversible: the Matrix room, its
    members, and any bridge channel are left intact, and the room can still
    be connected to and read. It simply stops appearing in `list_rooms` /
    `list_all_rooms` (and the management UI) unless archived rooms are
    explicitly requested. Use this for ephemeral rooms (e.g. a finished
    feature-implementation or bug-fix room) to keep the active list tidy.
    Reverse it with `unarchive_room`.

    You must be a member of the room and have write access to it; fails with
    a permission error otherwise.

    Args:
        room_id: The Switch room id (UUID string).

    Returns:
        The full, updated room detail (same shape as get_room_detail).
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    detail = await protocol.set_room_archived(agent_id, room_id, True)
    return detail.model_dump()


@operation
async def unarchive_room(room_id: str) -> dict[str, Any]:
    """Unarchive a room you are a member of, restoring it to the default
    active room lists.

    The inverse of `archive_room`. You must be a member of the room and have
    write access to it; fails with a permission error otherwise.

    Args:
        room_id: The Switch room id (UUID string).

    Returns:
        The full, updated room detail (same shape as get_room_detail).
    """
    agent_id = get_agent_id()
    protocol = get_protocol()
    detail = await protocol.set_room_archived(agent_id, room_id, False)
    return detail.model_dump()
