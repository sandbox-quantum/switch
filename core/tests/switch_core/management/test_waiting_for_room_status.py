"""A box reports a conversation waiting for room as a separate optional field
on the agent's status entry (`waiting_for_room`), not a new `session` value
(a fixed list an older Core would refuse). Core must keep it when it stores the
report and hand it back in the agent's status, or Console's amber "Waiting for
room" card never shows."""

from __future__ import annotations

from types import SimpleNamespace

from switch_core.management.schemas import StatusReport, agent_status_from

from .harness import fixture


def test_waiting_for_room_is_accepted_stored_and_returned_in_the_agent_status() -> None:
    report = fixture("status_request.json")
    agent_id = report["agents"][0]["agent_id"]
    waiting = {"count": 2, "oldest_since": "2026-10-27T11:20:00Z"}
    report["agents"][0]["waiting_for_room"] = waiting

    # Accepted as-is (the status body allows extra fields), and kept by the
    # same dump the service stores the report with.
    stored = StatusReport.model_validate(report).model_dump(
        mode="json", exclude_unset=True
    )

    status = agent_status_from(SimpleNamespace(status=stored), agent_id)
    assert status is not None
    assert status["waiting_for_room"] == waiting
    # An agent that reports nothing waiting carries no such field.
    other = agent_status_from(
        SimpleNamespace(status=stored), report["agents"][1]["agent_id"]
    )
    assert other is not None and "waiting_for_room" not in other
