"""Which sent events belong in the message log.

The log and the bus are two different things. The bus carries everything a
running system says to itself — a typing indicator, an RPC request, a task
transition. The log is the conversation: what a person reading the room later
would expect to find there. Only the second belongs in `messages`.

This is a denylist rather than an allowlist on purpose. A type nobody
classified is recorded, which costs a row; an allowlist would drop it, and a
missing message the read path never knows to look for is the worse failure by
far. `test_recorded_types.py` walks the dispatch table and fails on anything
unclassified, so the denylist stays honest without the log going quiet.
"""

from __future__ import annotations

# An arrival. Not a send, so it never reaches `should_record` — the recorder
# has its own entry point for it — but the read path needs the name to tell an
# arrival from something someone said.
MEMBERSHIP_EVENT_TYPE = "m.room.member"

# Ephemeral: presence-like state, superseded by the next one, null body.
EPHEMERAL = frozenset({"com.switch.agent.runtime_state"})

# Request/response pairs that use the bus as an RPC channel. They are addressed
# to one recipient and meaningless once answered.
RPC = frozenset(
    {
        "com.switch.mediation.tool_request",
        "com.switch.mediation.llm_request",
        "com.switch.mediation.tool_result",
        "com.switch.mediation.llm_response",
        "com.switch.resource.load_request",
        "com.switch.resource.load_response",
        "com.switch.resource.room_document_create_request",
        "com.switch.resource.room_document_create_response",
        "com.switch.resource.room_document_update_request",
        "com.switch.resource.room_document_update_response",
        "com.switch.resource.room_document_delete_request",
        "com.switch.resource.room_document_delete_response",
    }
)

# Already durable in the `tasks` table, which is the record readers query.
PERSISTED_ELSEWHERE = frozenset(
    {
        "com.switch.task.delegate",
        "com.switch.task.accept",
        "com.switch.task.update",
        "com.switch.task.finalise",
        "com.switch.task.cancel",
    }
)

# Measurements of a run, not utterances in a room. If these are worth keeping
# they want a table shaped for querying them, not the conversation log.
TELEMETRY = frozenset({"com.switch.report.tool_call", "com.switch.report.llm_call"})

# Declared and dispatched, but nothing in switch_core sends them.
NOT_SENT = frozenset(
    {"com.switch.permission.request", "com.switch.permission.response"}
)

NOT_RECORDED = EPHEMERAL | RPC | PERSISTED_ELSEWHERE | TELEMETRY | NOT_SENT

# The observe prefix is reserved and unimplemented; no type under it exists to
# name individually yet.
NOT_RECORDED_PREFIXES = ("com.switch.observe.",)


def should_record(event_type: str) -> bool:
    """Whether an event of this type belongs in the message log."""
    if event_type in NOT_RECORDED:
        return False
    return not event_type.startswith(NOT_RECORDED_PREFIXES)
