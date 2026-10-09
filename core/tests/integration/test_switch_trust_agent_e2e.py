"""End-to-end tests for Switch Trust enforcement on agent-authored messages,
over the real transport (docs/design/switch-trust-guardrails-v1.md).

Drives the genuine path: `AgentCore.send_message` → `_enforce_trust` →
(blocked: `SystemActor.send_admin` / allowed-or-degraded: the real send) — and
reads the outcome back out of the `messages` table, so nothing is inferred
from in-process state.
"""

from __future__ import annotations

import asyncio

import pytest

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.clients.actor import SystemActor
from switch_core.clients.command_consumer import CommandConsumer
from switch_core.db.models import Message
from switch_core.room_service import RoomCreateConfig
from switch_core.trust.client import (
    GuardrailBlockedError,
    GuardrailsCheckError,
    TrustCheckResult,
    TrustFinding,
)
from tests.integration.conftest import Harness, SessionEnv

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]


class _FixedTrustClient:
    def __init__(self, result: TrustCheckResult) -> None:
        self._result = result
        self.room_ids: list[str] = []

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        self.room_ids.append(room_id)
        return self._result


class _FailingTrustClient:
    """A Switch Trust outage: every check raises, never answers an outcome."""

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        raise GuardrailsCheckError("boom")


async def _wait_joined(
    client: object, transport_room_id: str, timeout: float = 30
) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if transport_room_id in client.room_join_times:  # type: ignore[attr-defined]
            return
        await asyncio.sleep(0.25)
    raise AssertionError(f"client never joined {transport_room_id} within {timeout}s")


async def _timeline_messages(
    harness: Harness, session_env: SessionEnv, room_id: str
) -> list[Message]:
    async with harness.session_factory() as session:  # type: ignore[operator]
        rows = await session_env.message_store.list_for_room(
            session, room_id, after_seq=0, limit=100
        )
    return [row for row in rows if row.event_type == "m.room.message"]


async def _wire_admin_client(harness: Harness, session_env: SessionEnv) -> None:
    """Registers and starts Switch's own SystemActor, the way `main.py` does.

    Not part of the shared `harness` fixture: most integration tests don't
    want a running admin client, since one silently joins every room they
    create (`Harness.client_factory`'s docstring) which changes what
    room_join-watching tests see. Only the Switch Trust blocked-notice case
    here needs it, to read the `TRUST_BLOCKED` admin row back.
    """
    harness.client_factory.register(
        "admin",
        SystemActor,
        CommandConsumer,
        agent_store=session_env.agent_store,
        room_store=session_env.room_store,
        room_role_store=session_env.room_role_store,
        document_store=session_env.document_store,
        reference_store=session_env.reference_store,
        agent_session_store=session_env.agent_session_store,
        room_service=harness.room_service,
        connections=AgentConnectionRegistry(),
        frontend_base_url=session_env.config.frontend_base_url,
    )
    await harness.client_lifecycle.ensure_system_client("admin")


async def _setup_room(
    harness: Harness, session_env: SessionEnv, agent_name: str, *, with_admin: bool
) -> tuple[str, str]:
    """Registers an agent, starts it, and returns (agent_id, room_id) for a
    room it has already joined."""
    if with_admin:
        await _wire_admin_client(harness, session_env)
    agent = await harness.register_agent(agent_name)
    await harness.start_clients()
    client = harness.client_for(agent.agent_id)
    result = await harness.room_service.create_room(
        RoomCreateConfig(
            name=f"{agent_name}-room",
            description="integration switch trust test",
            agent_ids=[agent.agent_id],
        )
    )
    await _wait_joined(client, result.room.transport_room_id)
    return agent.agent_id, result.room.id


async def test_blocked_agent_message_is_not_sent_and_names_the_agent(
    harness: Harness, session_env: SessionEnv
) -> None:
    agent_id, room_id = await _setup_room(
        harness, session_env, "e2e-trust-blocked", with_admin=True
    )
    trust_client = _FixedTrustClient(
        TrustCheckResult(
            outcome="blocked",
            policy_id="policy-1",
            policy_name="default",
            findings=(
                TrustFinding(
                    category="pii/email", detector_name="email", severity="high"
                ),
            ),
        )
    )
    harness.protocol.trust_client = trust_client

    with pytest.raises(GuardrailBlockedError):
        await harness.protocol.send_message(
            agent_id, room_id, "my email is agent@example.com"
        )

    rows = await _timeline_messages(harness, session_env, room_id)
    assert not any(
        "my email is agent@example.com" in row.content.get("body", "") for row in rows
    )
    admin_rows = [row for row in rows if "com.switch.admin" in row.content]
    assert len(admin_rows) == 1
    assert admin_rows[0].content["com.switch.admin"]["type"] == "trust_blocked"
    assert "e2e-trust-blocked" in admin_rows[0].content["body"]
    assert "blocked by Switch Trust" in admin_rows[0].content["body"]
    assert trust_client.room_ids == [room_id]


async def test_allowed_agent_message_is_sent_unaffected(
    harness: Harness, session_env: SessionEnv
) -> None:
    agent_id, room_id = await _setup_room(
        harness, session_env, "e2e-trust-allowed", with_admin=False
    )
    harness.protocol.trust_client = _FixedTrustClient(
        TrustCheckResult(outcome="ok", policy_id="policy-1", policy_name="default")
    )

    await harness.protocol.send_message(agent_id, room_id, "hello there")

    rows = await _timeline_messages(harness, session_env, room_id)
    assert any(row.content.get("body") == "hello there" for row in rows)
    assert not any("com.switch.admin" in row.content for row in rows)


async def test_redacted_agent_message_is_sent_with_content_swapped(
    harness: Harness, session_env: SessionEnv
) -> None:
    agent_id, room_id = await _setup_room(
        harness, session_env, "e2e-trust-redacted", with_admin=False
    )
    harness.protocol.trust_client = _FixedTrustClient(
        TrustCheckResult(
            outcome="redacted",
            policy_id="policy-1",
            policy_name="default",
            findings=(
                TrustFinding(
                    category="pii/email", detector_name="email", severity="high"
                ),
            ),
            redacted_content="my email is [redacted]",
        )
    )

    await harness.protocol.send_message(
        agent_id, room_id, "my email is agent@example.com"
    )

    rows = await _timeline_messages(harness, session_env, room_id)
    assert any(row.content.get("body") == "my email is [redacted]" for row in rows)
    assert not any("agent@example.com" in row.content.get("body", "") for row in rows)


async def test_trust_check_failure_fails_open_and_annotates_instead_of_blocking(
    harness: Harness, session_env: SessionEnv
) -> None:
    agent_id, room_id = await _setup_room(
        harness, session_env, "e2e-trust-failopen", with_admin=False
    )
    harness.protocol.trust_client = _FailingTrustClient()

    await harness.protocol.send_message(agent_id, room_id, "hello there")

    rows = await _timeline_messages(harness, session_env, room_id)
    sent = [row for row in rows if "hello there" in row.content.get("body", "")]
    assert len(sent) == 1
    assert "Switch Trust could not fully check" in sent[0].content["body"]
    assert not any("com.switch.admin" in row.content for row in rows)
