"""Integration profiles stored before the task protocol was removed still load."""

from __future__ import annotations

from switch_core.bridges.agent.protocol.types import IntegrationProfile


def test_a_stored_profile_with_task_protocol_still_loads() -> None:
    stored = {
        "connection_model": "session_addressable",
        "message_exchange": True,
        "pre_invocation_mediation": [],
        "post_invocation_mediation": [],
        "event_reporting": [],
        "task_protocol": {"can_delegate": True, "can_accept": True},
    }

    profile = IntegrationProfile(**stored)

    assert profile.connection_model == "session_addressable"
    assert "task_protocol" not in profile.model_dump()
