"""What an operation's refusal is answered with over the agent HTTP front door."""

from __future__ import annotations

from switch_core.bridges.agent.api.operations import refusal_status
from switch_core.bridges.agent.protocol.agent_core import AgentClientNotRunning
from switch_core.bridges.collaboration.models import BridgeOperationError
from switch_core.delivery.send_limits import MessageTooLong, SendRateLimited
from switch_core.room_service import MembershipFixed


def test_a_fixed_conversation_is_a_conflict_as_the_room_routes_say() -> None:
    assert refusal_status(MembershipFixed("a direct conversation")) == 409


def test_other_refusals_keep_their_status() -> None:
    assert refusal_status(PermissionError("no")) == 403
    assert refusal_status(ValueError("bad")) == 400
    assert refusal_status(RuntimeError("broken")) is None


def test_an_agent_host_not_yet_running_is_503() -> None:
    """Sent again by the agent's host, as for any 503, rather than taken as refused."""
    assert refusal_status(AgentClientNotRunning("starting")) == 503


def test_a_platform_refusal_is_a_bad_gateway_with_its_reason() -> None:
    assert refusal_status(BridgeOperationError("Slack said no")) == 502


def test_a_message_too_long_is_unprocessable_and_one_too_fast_is_429() -> None:
    assert refusal_status(MessageTooLong(70_000, 65_536)) == 422
    assert (
        refusal_status(
            SendRateLimited(retry_after=1.0, burst=30, per_second=2.0, first=True)
        )
        == 429
    )
