"""The classification has to keep up with the dispatch table.

A custom event type added to `ClientBase._EVENT_DISPATCH` without a decision
here is recorded by default, which is the safe direction but not a decision.
These tests make the omission visible instead of letting it ride.
"""

from switch_core.clients.client_base import ClientBase
from switch_core.messages.recorded_types import (
    EPHEMERAL,
    NOT_RECORDED,
    NOT_SENT,
    PERSISTED_ELSEWHERE,
    RPC,
    TELEMETRY,
    should_record,
)

# The one custom type that is part of the conversation: a person typing
# `!invite-agent` into a room.
RECORDED_CUSTOM_TYPES = frozenset({"com.switch.command"})


def test_every_dispatched_type_is_classified():
    dispatched = set(ClientBase._EVENT_DISPATCH)
    unclassified = dispatched - NOT_RECORDED - RECORDED_CUSTOM_TYPES
    assert not unclassified, (
        "These custom event types are neither recorded nor denied. Decide "
        "which they are in switch_core/messages/recorded_types.py: "
        f"{sorted(unclassified)}"
    )


def test_classification_names_no_type_that_is_never_dispatched():
    dispatched = set(ClientBase._EVENT_DISPATCH)
    stale = (NOT_RECORDED | RECORDED_CUSTOM_TYPES) - dispatched
    assert not stale, f"Classified but no longer dispatched: {sorted(stale)}"


def test_the_buckets_do_not_overlap():
    buckets = [EPHEMERAL, RPC, PERSISTED_ELSEWHERE, TELEMETRY, NOT_SENT]
    total = sum(len(bucket) for bucket in buckets)
    assert total == len(NOT_RECORDED)


def test_conversation_is_recorded():
    assert should_record("m.room.message")
    assert should_record("com.switch.command")


def test_bus_traffic_is_not_recorded():
    assert not should_record("com.switch.agent.runtime_state")
    assert not should_record("com.switch.mediation.tool_request")
    assert not should_record("com.switch.task.delegate")
    assert not should_record("com.switch.report.llm_call")


def test_the_unimplemented_observe_prefix_is_not_recorded():
    assert not should_record("com.switch.observe.anything")


def test_an_unknown_type_is_recorded_rather_than_dropped():
    """The denylist fails towards keeping too much, never towards silence."""
    assert should_record("com.switch.something.nobody.has.written.yet")
