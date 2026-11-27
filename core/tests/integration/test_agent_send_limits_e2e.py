"""An agent is held to the same limits as a person, over the real transport:
a message too long or sent too fast is refused with a reason before it is
written, and a long one within the limit reaches Switch Trust only in part,
with a notice in the room saying so."""

from __future__ import annotations

import pytest

from switch_core.bridges.agent.api.operations import refusal_status
from switch_core.delivery.send_limits import MessageTooLong, SendLimits, SendRateLimited
from switch_core.trust.client import TRUST_MESSAGE_TEXT_LIMIT, TrustCheckResult
from tests.integration.conftest import Harness, SessionEnv
from tests.integration.test_switch_trust_agent_e2e import (
    _setup_room,
    _timeline_messages,
)

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]


class _RecordingTrustClient:
    def __init__(self) -> None:
        self.contents: list[str] = []

    async def check(
        self, *, tenant_id: str, role: str, content: str, room_id: str
    ) -> TrustCheckResult:
        self.contents.append(content)
        return TrustCheckResult(outcome="ok", policy_id=None, policy_name=None)


def _limit(
    harness: Harness, agent_id: str, *, max_message_chars: int, burst: int
) -> None:
    transport = harness.client_for(agent_id).transport
    transport._router.send_limits = SendLimits(  # type: ignore[attr-defined]
        max_message_chars=max_message_chars,
        burst=burst,
        per_second=0.001,
        clock=lambda: 0.0,
    )


async def test_an_agent_message_over_the_limit_is_refused_and_not_written(
    harness: Harness, session_env: SessionEnv
) -> None:
    agent_id, room_id = await _setup_room(
        harness, session_env, "e2e-limit-long", with_admin=False
    )
    _limit(harness, agent_id, max_message_chars=100, burst=100)

    with pytest.raises(MessageTooLong) as refused:
        await harness.protocol.send_message(agent_id, room_id, "x" * 101)

    assert refusal_status(refused.value) == 422
    assert "at most 100" in str(refused.value)
    rows = await _timeline_messages(harness, session_env, room_id)
    assert not any(row.body == "x" * 101 for row in rows)


async def test_an_agent_sending_too_fast_is_refused_after_its_burst(
    harness: Harness, session_env: SessionEnv
) -> None:
    agent_id, room_id = await _setup_room(
        harness, session_env, "e2e-limit-fast", with_admin=False
    )
    _limit(harness, agent_id, max_message_chars=1000, burst=2)

    await harness.protocol.send_message(agent_id, room_id, "one")
    await harness.protocol.send_message(agent_id, room_id, "two")
    with pytest.raises(SendRateLimited) as refused:
        await harness.protocol.send_message(agent_id, room_id, "three")

    assert refusal_status(refused.value) == 429
    bodies = [
        row.body for row in await _timeline_messages(harness, session_env, room_id)
    ]
    assert "three" not in bodies
    assert {"one", "two"} <= set(bodies)


async def test_a_long_agent_message_is_checked_in_part_and_the_room_is_told(
    harness: Harness, session_env: SessionEnv
) -> None:
    agent_id, room_id = await _setup_room(
        harness, session_env, "e2e-limit-partial", with_admin=True
    )
    trust = _RecordingTrustClient()
    harness.protocol.trust_client = trust
    content = "a" * TRUST_MESSAGE_TEXT_LIMIT + "b" * 1_000

    sent = await harness.protocol.send_message(agent_id, room_id, content)

    assert trust.contents == ["a" * TRUST_MESSAGE_TEXT_LIMIT]
    assert sent.trust is not None
    assert sent.trust.outcome == "errored"
    rows = await _timeline_messages(harness, session_env, room_id)
    assert any(row.body == content for row in rows)
    [notice] = [row for row in rows if "com.switch.admin" in row.content]
    assert notice.content["com.switch.admin"]["type"] == "trust_errored"
    assert "checked only the first 20,000 characters" in notice.content["body"]
