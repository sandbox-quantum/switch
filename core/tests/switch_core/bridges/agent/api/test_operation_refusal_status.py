"""What an operation's refusal is answered with over the agent HTTP front door."""

from __future__ import annotations

from switch_core.bridges.agent.api.operations import refusal_status
from switch_core.bridges.collaboration.models import BridgeOperationError
from switch_core.room_service import MembershipFixed


def test_a_fixed_conversation_is_a_conflict_as_the_room_routes_say() -> None:
    assert refusal_status(MembershipFixed("a direct conversation")) == 409


def test_other_refusals_keep_their_status() -> None:
    assert refusal_status(PermissionError("no")) == 403
    assert refusal_status(ValueError("bad")) == 400
    assert refusal_status(RuntimeError("broken")) is None


def test_a_platform_refusal_is_a_bad_gateway_with_its_reason() -> None:
    assert refusal_status(BridgeOperationError("Slack said no")) == 502
