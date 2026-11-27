"""Whether an agent's owner gave it more power themselves, as the security
monitor reads it from `escalation_details`."""

from __future__ import annotations

from switch_core.db.audit import escalation_details


def test_the_owner_acting_themselves_is_by_the_owner() -> None:
    assert escalation_details(
        owner_id="ada", actor_user_id="ada", acting_agent_id=None
    ) == {"acting_agent_id": None, "by_owner": True}


def test_an_agent_acting_for_its_owner_is_not_by_the_owner() -> None:
    assert escalation_details(
        owner_id="ada", actor_user_id="ada", acting_agent_id="helper"
    ) == {"acting_agent_id": "helper", "by_owner": False}


def test_someone_else_is_not_the_owner() -> None:
    details = escalation_details(
        owner_id="ada", actor_user_id="grace", acting_agent_id=None
    )
    assert details["by_owner"] is False


def test_no_request_behind_the_change_is_not_by_the_owner() -> None:
    details = escalation_details(
        owner_id="ada", actor_user_id=None, acting_agent_id=None
    )
    assert details["by_owner"] is False
