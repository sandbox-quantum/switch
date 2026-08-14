"""Projecting Switch operations into the AG-UI `tools[]` array.

AG-UI reserves `RunAgentInput.tools` for tools the *client* executes, which is
exactly what a Switch room operation is — so this projection is legitimate
rather than a stretch. The mechanics are trivial: `Operation` already carries a
name, a description and a transport-neutral JSON Schema, so a tool is those
three fields renamed.

What is not trivial is *which* operations to send.

**Only the room-scoped subset ships, and that is a correctness requirement.**
MCP sends its tool list once per session; AG-UI re-sends `tools[]` on every
POST, including every iteration of a tool-call loop. The full registry
serialises to roughly 13,000 tokens because `Operation.description` is the
whole docstring — so a long tool loop would spend hundreds of thousands of
tokens restating the tool list before the model reads a word of conversation.
The room-scoped subset is about 4,800.

**The list is explicit rather than inferred.** It could be derived at runtime
by asking which operations call `require_connected_room()`, and a test does
exactly that to catch drift. But the set of things a third-party agent may do
inside a room is a security boundary, and a security boundary should be a
written list somebody reviewed, not the output of a heuristic that a future
refactor could quietly widen.

Two groups are deliberately absent:

- **Connection lifecycle.** `connect_to_room` claims a room slot on the
  caller's connection and can evict a live session of the same agent
  elsewhere. Switch already knows which room the run is for, so exposing it
  offers the agent nothing and risks it disconnecting a working session.
- **Instance-wide administration.** Creating and archiving rooms, editing
  agents, managing groups and references. A different blast radius from
  "take part in this room".
"""

from __future__ import annotations

from switch_core.bridges.agent.operations import all_operations
from switch_core.bridges.agent.server_connectors.agui.request import Tool

ROOM_SCOPED_OPERATIONS: frozenset[str] = frozenset(
    {
        # Reading the room
        "read_context",
        "list_participants",
        "list_references",
        "list_linked_rooms",
        "load_internal_documents",
        # Speaking in it
        "post_message",
        "send_targeted_message",
        # The task protocol
        "delegate_task",
        "accept_task",
        "update_task",
        "finalise_task",
        "cancel_task",
        "list_tasks",
        # Room-scoped documents
        "create_room_document",
        "update_room_document",
        "delete_room_document",
        # Roles in this room
        "list_roles",
        "assume_role",
        "release_role",
        "define_role",
        "edit_role",
        "delete_role",
    }
)


class AllowlistDriftError(Exception):
    """The allowlist and the operations registry disagree."""


def room_scoped_tools() -> list[Tool]:
    """The tools an AG-UI agent is offered, in a stable order.

    Raises if the allowlist names something the registry does not define —
    a rename that silently dropped a tool would be invisible otherwise.
    """
    registry = all_operations()

    missing = sorted(ROOM_SCOPED_OPERATIONS - registry.keys())
    if missing:
        raise AllowlistDriftError(
            f"AG-UI allowlist names operations that do not exist: {missing}"
        )

    return [
        Tool(
            name=operation.name,
            description=operation.description,
            parameters=operation.input_schema,
        )
        for name, operation in sorted(registry.items())
        if name in ROOM_SCOPED_OPERATIONS
    ]


def is_exposed(operation_name: str) -> bool:
    """Whether an AG-UI agent may call this operation.

    Checked at dispatch as well as at projection: an agent can name any tool it
    likes, including one it was never offered.
    """
    return operation_name in ROOM_SCOPED_OPERATIONS
