"""Which sent events belong in the message log.

The log and the bus are two different things. The bus carries everything a
running system says to itself — a typing indicator, an RPC request, a run
report. The log is the conversation: what a person reading the room later
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

# Ephemeral: presence-like state, superseded by the next one, null body. The
# transport delivers these live instead of storing them (`transport/
# ephemeral.py`). None is today; typing would be one if it returned.
EPHEMERAL: frozenset[str] = frozenset()

# Measurements of a run, not utterances in a room. If these are worth keeping
# they want a table shaped for querying them, not the conversation log. None
# is sent today.
TELEMETRY: frozenset[str] = frozenset()

# Types no code sends any more. The bus keeps its history forever, so events of
# a retired type stay readable long after the last line that could produce one
# was deleted — and anything walking that history has to be able to say what
# they were. Without this, deleting a type turns every historical event of it
# into an unclassified event that should have been recorded, which reconcile
# reports as a missing row for good.
#
# APPEND ONLY. A name leaves this set only if the type is revived, in which
# case it belongs in one of the categories above instead.
RETIRED = frozenset(
    {
        # Deleted with the RPC round trips, which were switch-core talking to
        # itself over the bus.
        "com.switch.mediation.tool_request",
        "com.switch.mediation.tool_result",
        "com.switch.mediation.llm_request",
        "com.switch.mediation.llm_response",
        "com.switch.resource.load_request",
        "com.switch.resource.load_response",
        "com.switch.resource.room_document_create_request",
        "com.switch.resource.room_document_create_response",
        "com.switch.resource.room_document_update_request",
        "com.switch.resource.room_document_update_response",
        "com.switch.resource.room_document_delete_request",
        "com.switch.resource.room_document_delete_response",
        # Deleted as dead since the initial import.
        "com.switch.permission.request",
        "com.switch.permission.response",
        # Deleted with the task protocol, which was never put to use.
        "com.switch.task.delegate",
        "com.switch.task.accept",
        "com.switch.task.update",
        "com.switch.task.finalise",
        "com.switch.task.cancel",
        # Deleted with the runtime-state report, which nothing sent any more.
        "com.switch.agent.runtime_state",
        # Deleted with the tool and LLM call reports, which nothing consumed.
        "com.switch.report.tool_call",
        "com.switch.report.llm_call",
    }
)

NOT_RECORDED = EPHEMERAL | TELEMETRY | RETIRED


def should_record(event_type: str) -> bool:
    """Whether an event of this type belongs in the message log."""
    return event_type not in NOT_RECORDED
