from __future__ import annotations

from types import SimpleNamespace

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.trust.client import (
    GuardrailsCheckError,
    TrustCheckResult,
    TrustFinding,
)

# Switch Trust guardrails, enforced in CollaborationCore._handle_inbound_message
# before a human-authored message becomes a room row (docs/design/switch-trust-guardrails-v1.md).

TRANSPORT_ROOM_ID = "!matrix:switch.local"


async def _noop_repair(*_args: object, **_kwargs: object) -> None:
    return None


async def _no_text_answer(_msg: object) -> None:
    return None


async def _is_registered_agent(_name: str) -> bool:
    return False


class _FakeHumanActor:
    """Already-joined human actor — these tests exercise the trust gate, not
    the join race `test_bridge_unknown_member_first_message.py` covers."""

    def __init__(self) -> None:
        self.transport_user_id = "@ext_alice:switch.local"
        self.sent: list[tuple[str, str]] = []

    async def send_message(self, room_id: str, content: str, **_kw: object) -> str:
        self.sent.append((room_id, content))
        return "$event-1"


class _FakeAdapter:
    def __init__(self) -> None:
        self.admin_messages: list[tuple[str, str, str | None, str]] = []

    def translate_inbound(self, content: str) -> str:
        return content

    async def admin_message(
        self,
        channel_id: str,
        body: str,
        root_or_ref: str | None,
        *,
        message_type: str,
    ) -> None:
        self.admin_messages.append((channel_id, body, root_or_ref, message_type))


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


def _bridge(
    human_actor: _FakeHumanActor, adapter: _FakeAdapter, trust_client: object
) -> SimpleNamespace:
    relayed: list[tuple[str, str]] = []

    async def _ensure_human_in_room(**_kw: object) -> _FakeHumanActor:
        return human_actor

    async def _record_message_map(**kwargs: str) -> None:
        relayed.append((kwargs["transport_event_id"], kwargs["external_post_id"]))

    bridge = SimpleNamespace(
        _repair_placeholder_username=_noop_repair,
        _is_registered_agent=_is_registered_agent,
        _ensure_human_in_room=_ensure_human_in_room,
        _record_message_map=_record_message_map,
        _adapter=adapter,
        _handle_text_answer=_no_text_answer,
        _channel_to_room={"chan-1": ("room-uuid", TRANSPORT_ROOM_ID)},
        _channel_locks={},
        _trust_client=trust_client,
    )
    bridge.relayed = relayed
    return bridge


def _message(content: str) -> InboundMessage:
    return InboundMessage(
        channel_id="chan-1",
        channel_type="channel_public",
        sender_id="ext-alice",
        sender_name="alice",
        content=content,
        message_ref="mm-post-1",
    )


async def test_blocked_message_never_reaches_the_room_and_sender_is_notified() -> None:
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    result = TrustCheckResult(
        outcome="blocked",
        policy_id="policy-1",
        policy_name="default",
        findings=(
            TrustFinding(category="pii/email", detector_name="email", severity="high"),
        ),
    )
    bridge = _bridge(human_actor, adapter, _FixedTrustClient(result))

    await CollaborationCore._handle_inbound_message(
        bridge, _message("my email is alice@example.com")
    )

    assert human_actor.sent == []
    assert bridge.relayed == []
    assert len(adapter.admin_messages) == 1
    channel_id, body, root_or_ref, message_type = adapter.admin_messages[0]
    assert channel_id == "chan-1"
    assert "blocked by Switch Trust" in body
    assert root_or_ref == "mm-post-1"
    assert message_type == AdminMessageType.TRUST_BLOCKED.value


async def test_redacted_message_reaches_the_room_redacted_and_sender_is_notified() -> (
    None
):
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    result = TrustCheckResult(
        outcome="redacted",
        policy_id="policy-1",
        policy_name="default",
        findings=(
            TrustFinding(category="pii/email", detector_name="email", severity="high"),
        ),
        redacted_content="my email is [redacted]",
    )
    bridge = _bridge(human_actor, adapter, _FixedTrustClient(result))

    await CollaborationCore._handle_inbound_message(
        bridge, _message("my email is alice@example.com")
    )

    assert human_actor.sent == [(TRANSPORT_ROOM_ID, "my email is [redacted]")]
    assert len(adapter.admin_messages) == 1
    channel_id, body, root_or_ref, message_type = adapter.admin_messages[0]
    assert channel_id == "chan-1"
    assert "redacted" in body
    assert "pii/email" in body
    assert root_or_ref == "mm-post-1"
    assert message_type == AdminMessageType.TRUST_REDACTED.value


async def test_allowed_message_is_relayed_unaffected() -> None:
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    result = TrustCheckResult(outcome="ok", policy_id="policy-1", policy_name="default")
    trust_client = _FixedTrustClient(result)
    bridge = _bridge(human_actor, adapter, trust_client)

    await CollaborationCore._handle_inbound_message(bridge, _message("hello there"))

    assert human_actor.sent == [(TRANSPORT_ROOM_ID, "hello there")]
    assert adapter.admin_messages == []
    # The check is scoped to the room it happened in.
    assert trust_client.room_ids == ["room-uuid"]


async def test_trust_check_failure_fails_open_and_annotates_instead_of_blocking() -> (
    None
):
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    bridge = _bridge(human_actor, adapter, _FailingTrustClient())

    await CollaborationCore._handle_inbound_message(bridge, _message("hello there"))

    assert len(human_actor.sent) == 1
    _, content = human_actor.sent[0]
    assert content.startswith("hello there")
    assert "Switch Trust could not fully check" in content
    # A degraded check is disclosed inline, not via a separate notice.
    assert adapter.admin_messages == []
