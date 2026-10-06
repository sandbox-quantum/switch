from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    ModelSpec,
    ToolSpec,
)

# ── Registration ──────────────────────────────────────────────────────────────


class RegisterAgentRequest(BaseModel):
    name: str
    description: str
    icon_url: str | None = None
    display_name: str | None = None
    connector_type: str
    integration_profile: IntegrationProfile
    tools: list[ToolSpec] = []
    models: list[ModelSpec] = []
    metadata: dict[str, Any] = {}
    overwrite: bool = False


class RegisterAgentResponse(BaseModel):
    id: str
    api_key: str


class RegisterKnownAgentRequest(BaseModel):
    agent_type: str
    name: str
    description: str
    icon_url: str | None = None
    display_name: str | None = None
    options: dict[str, Any] = {}
    # When set, register this agent as a child of `parent_agent_id` (e.g. a
    # Claude Code subagent under the user's main agent). None = top-level.
    parent_agent_id: str | None = None
    overwrite: bool = False


class BulkSubagentSpec(BaseModel):
    """One Claude Code subagent to register under a parent agent.

    `subagent_name` is the bare Claude Code subagent identifier (the `name`
    frontmatter field, used for the `--agent <name>` launch flag); the Switch
    agent name is derived server-side as `<parent-name>.<subagent_name>`.
    """

    subagent_name: str
    description: str


class RegisterKnownAgentBulkRequest(BaseModel):
    """Register many subagents under one parent agent in a single call.

    `options` is the shared base (e.g. `channels_enabled`, `repo_dir`) applied
    to every subagent; the per-subagent `subagent_name`
    is merged in on top. Used by the configure skill to bring a user's
    existing `.claude/agents/*.md` subagents into Switch in one step.
    """

    agent_type: str
    parent_agent_id: str
    options: dict[str, Any] = {}
    subagents: list[BulkSubagentSpec]
    overwrite: bool = False


class BulkRegisterResult(BaseModel):
    subagent_name: str
    name: str
    id: str
    api_key: str


class RegisterKnownAgentBulkResponse(BaseModel):
    results: list[BulkRegisterResult]


# ── Messages ──────────────────────────────────────────────────────────────────


class SendMessageRequest(BaseModel):
    room_id: str
    content: str
    metadata: dict[str, Any] = {}


class TypingRequest(BaseModel):
    room_id: str
    is_typing: bool


class ConnectionRenewRequest(BaseModel):
    room_id: str


class ConnectionSubscribeRequest(BaseModel):
    """Claim (or release) a room on an open connection (CHOO-1857)."""

    connection_id: str
    room_id: str
    # Evict whichever connection currently holds the room. Off by default: the
    # usual cause of a collision is a stale process, and rejecting surfaces it.
    takeover: bool = False
    # The incarnation the caller believes it holds. A connection id alone says
    # nothing about *which* client is on it, so without this a client that has
    # already been displaced can still rewrite the winner's rooms. Optional
    # because a client built before the fence sends none, which keeps the
    # unchecked behaviour it has always had.
    generation: int | None = None


class ConnectionPlacementsRequest(BaseModel):
    """Every session placement on an open connection, replacing what it had."""

    connection_id: str
    #: Session id to the Switch room id it is working in. Rooms are distinct;
    #: a session the connection placed before and omits here is unplaced.
    placements: dict[str, str]
    #: The incarnation the caller believes it holds, fenced as on subscribe.
    generation: int | None = None


class ConnectionBeatRequest(BaseModel):
    """The single client tick that keeps a connection alive (CHOO-1857).

    Replaces /connection/renew, /watch/heartbeat and /leases/renew: it proves
    the client is alive *and* consuming, and reports how far it has read so the
    event buffer knows what has been seen.
    """

    connection_id: str
    cursor: int = 0
    #: The incarnation of the connection this client is attached to, as the
    #: server told it on `connection_state`. Fences the tick: a client that has
    #: been displaced still holds the id and the token, and is otherwise
    #: indistinguishable from the one that replaced it. Null is accepted only
    #: while the connection's holder is a client built before the fence existed
    #: — unknown, not current; from a holder that declares the revision which
    #: carries it, a tick without one is refused.
    generation: int | None = None


# ── Resources ─────────────────────────────────────────────────────────────────
