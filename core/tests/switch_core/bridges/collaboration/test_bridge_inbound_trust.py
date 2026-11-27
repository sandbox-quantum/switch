from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.db.audit import AuditAction
from switch_core.db.models import TENANT_ZERO_ID, AuditEvent
from switch_core.delivery.send_limits import (
    MessageRefused,
    MessageTooLong,
    SendLimits,
    SendRateLimited,
)
from switch_core.trust.client import (
    TRUST_MESSAGE_TEXT_LIMIT,
    GuardrailsCheckError,
    TrustCheckResult,
    TrustFinding,
)


async def _not_handed_in(_msg: object) -> bool:
    """No post is in its room yet: these tests are not about second copies."""
    return False


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

    def __init__(self, *, fail_send: bool = False) -> None:
        self.client_id = "alice-client"
        self.transport_user_id = "@ext_alice:switch.local"
        self.sent: list[tuple[str, str]] = []
        self.authored: list[object] = []
        self.admitted: list[str | None] = []
        self._fail_send = fail_send

    def admit_message(self, authored: str | None) -> None:
        self.admitted.append(authored)

    async def send_message(
        self, room_id: str, content: str, **kw: object
    ) -> str | None:
        if self._fail_send:
            return None
        self.sent.append((room_id, content))
        self.authored.append(kw.get("authored"))
        return "$event-1"


class _FakeAdapter:
    """A platform with no private route, so every notice is posted in the
    channel, where these tests read it."""

    platform_name = "Fake"
    private_notice_delivery = "in_channel"

    def __init__(self, *, raise_on_admin_message: bool = False) -> None:
        self.admin_messages: list[tuple[str, str, str | None, str]] = []
        self._raise_on_admin_message = raise_on_admin_message

    def translate_inbound(self, content: str) -> str:
        return content

    def unlinkable_account_reason(self, _external_user_id: str) -> str | None:
        return None

    async def admin_message(
        self,
        channel_id: str,
        body: str,
        root_or_ref: str | None,
        *,
        message_type: str,
    ) -> None:
        if self._raise_on_admin_message:
            raise RuntimeError("platform unavailable")
        self.admin_messages.append((channel_id, body, root_or_ref, message_type))


class _FixedTrustClient:
    def __init__(self, result: TrustCheckResult) -> None:
        self._result = result
        self.room_ids: list[str] = []
        self.tenant_ids: list[str] = []
        self.contents: list[str] = []

    async def check(
        self, *, tenant_id: str, role: str, content: str, room_id: str
    ) -> TrustCheckResult:
        self.room_ids.append(room_id)
        self.tenant_ids.append(tenant_id)
        self.contents.append(content)
        return self._result


class _FailingTrustClient:
    """A Switch Trust outage: every check raises, never answers an outcome."""

    async def check(
        self, *, tenant_id: str, role: str, content: str, room_id: str
    ) -> TrustCheckResult:
        raise GuardrailsCheckError("boom")


def _bridge(
    session_factory: async_sessionmaker[AsyncSession],
    human_actor: _FakeHumanActor,
    adapter: _FakeAdapter,
    trust_client: object,
) -> SimpleNamespace:
    relayed: list[tuple[str, str]] = []

    async def _ensure_human_in_room(**_kw: object) -> _FakeHumanActor:
        return human_actor

    async def _record_message_map(**kwargs: str) -> None:
        relayed.append((kwargs["transport_event_id"], kwargs["external_post_id"]))

    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _repair_placeholder_username=_noop_repair,
        _is_registered_agent=_is_registered_agent,
        _already_handed_in=_not_handed_in,
        _ensure_human_in_room=_ensure_human_in_room,
        _record_message_map=_record_message_map,
        _adapter=adapter,
        _handle_text_answer=_no_text_answer,
        _channel_to_room={"chan-1": ("room-uuid", TRANSPORT_ROOM_ID)},
        _channel_locks={},
        _trust_client=trust_client,
        _session_factory=session_factory,
        _room_tenant=AsyncMock(return_value=TENANT_ZERO_ID),
    )
    # The real implementation, not a re-fake of it: exercises its try/except
    # around a failing platform notify, same as production.
    bridge._post_sender_notice = lambda msg, body, message_type: (
        CollaborationCore._post_sender_notice(bridge, msg, body, message_type)
    )
    bridge._tell_message_refused = lambda msg, refused, room: (
        CollaborationCore._tell_message_refused(bridge, msg, refused, room)
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


async def test_blocked_message_never_reaches_the_room_and_sender_is_notified(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
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
    bridge = _bridge(session_factory, human_actor, adapter, _FixedTrustClient(result))

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
    async with session_factory() as session:
        [row] = (await session.execute(select(AuditEvent))).scalars().all()
    assert row.action == AuditAction.TRUST_MESSAGE_BLOCKED
    assert row.target_id == "room-uuid"
    assert row.details is not None
    assert row.details["role"] == "user"
    assert "alice@example.com" not in str(row.details)


async def test_redacted_message_reaches_the_room_redacted_and_sender_is_notified(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
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
    bridge = _bridge(session_factory, human_actor, adapter, _FixedTrustClient(result))

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


async def test_redacted_outcome_with_nothing_to_redact_is_treated_as_blocked(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """`redacted_content` can stay `None` even on a REDACTED verdict (no
    finding carried usable detected text) — sending the original content then
    would be indistinguishable from not checking at all."""
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    result = TrustCheckResult(
        outcome="redacted",
        policy_id="policy-1",
        policy_name="default",
        findings=(
            TrustFinding(category="pii/email", detector_name="email", severity="high"),
        ),
        redacted_content=None,
    )
    bridge = _bridge(session_factory, human_actor, adapter, _FixedTrustClient(result))

    await CollaborationCore._handle_inbound_message(
        bridge, _message("my email is alice@example.com")
    )

    assert human_actor.sent == []
    assert len(adapter.admin_messages) == 1
    _, body, _, message_type = adapter.admin_messages[0]
    assert "blocked by Switch Trust" in body
    assert message_type == AdminMessageType.TRUST_BLOCKED.value


async def test_a_failed_redaction_notice_does_not_block_the_redacted_message(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter(raise_on_admin_message=True)
    result = TrustCheckResult(
        outcome="redacted",
        policy_id="policy-1",
        policy_name="default",
        findings=(
            TrustFinding(category="pii/email", detector_name="email", severity="high"),
        ),
        redacted_content="my email is [redacted]",
    )
    bridge = _bridge(session_factory, human_actor, adapter, _FixedTrustClient(result))

    await CollaborationCore._handle_inbound_message(
        bridge, _message("my email is alice@example.com")
    )

    # The notice failed, but the redacted message still reached the room.
    assert human_actor.sent == [(TRANSPORT_ROOM_ID, "my email is [redacted]")]


async def test_allowed_message_is_relayed_unaffected(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    result = TrustCheckResult(outcome="ok", policy_id="policy-1", policy_name="default")
    trust_client = _FixedTrustClient(result)
    bridge = _bridge(session_factory, human_actor, adapter, trust_client)

    await CollaborationCore._handle_inbound_message(bridge, _message("hello there"))

    assert human_actor.sent == [(TRANSPORT_ROOM_ID, "hello there")]
    assert adapter.admin_messages == []
    # The check is scoped to the room it happened in, and made against the
    # policy of the room's own workspace's organization.
    assert trust_client.room_ids == ["room-uuid"]
    assert trust_client.tenant_ids == [TENANT_ZERO_ID]
    bridge._room_tenant.assert_awaited_once_with("room-uuid")


async def test_alerted_message_reaches_the_room_and_sender_is_notified(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    result = TrustCheckResult(
        outcome="alerted",
        policy_id="policy-1",
        policy_name="default",
        findings=(
            TrustFinding(category="pii/email", detector_name="email", severity="low"),
        ),
    )
    bridge = _bridge(session_factory, human_actor, adapter, _FixedTrustClient(result))

    await CollaborationCore._handle_inbound_message(
        bridge, _message("my email is alice@example.com")
    )

    assert len(human_actor.sent) == 1
    _, content = human_actor.sent[0]
    assert content.startswith("my email is alice@example.com")
    assert "Switch Trust flagged this message" in content
    # The room content doesn't relay back to the sender's platform, so the
    # annotation needs its own notice there too.
    assert len(adapter.admin_messages) == 1
    channel_id, body, root_or_ref, message_type = adapter.admin_messages[0]
    assert channel_id == "chan-1"
    assert "Switch Trust flagged this message" in body
    assert root_or_ref == "mm-post-1"
    assert message_type == AdminMessageType.TRUST_ALERTED.value


async def test_a_failed_relay_does_not_notify_the_sender_of_an_alert_never_sent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """If the message never actually reached the room, telling the sender it
    was flagged/redacted would be misleading — the notice must wait until the
    send is confirmed."""
    human_actor = _FakeHumanActor(fail_send=True)
    adapter = _FakeAdapter()
    result = TrustCheckResult(
        outcome="alerted",
        policy_id="policy-1",
        policy_name="default",
        findings=(
            TrustFinding(category="pii/email", detector_name="email", severity="low"),
        ),
    )
    bridge = _bridge(session_factory, human_actor, adapter, _FixedTrustClient(result))

    await CollaborationCore._handle_inbound_message(
        bridge, _message("my email is alice@example.com")
    )

    assert human_actor.sent == []
    assert adapter.admin_messages == []


async def test_trust_check_failure_fails_open_and_annotates_instead_of_blocking(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    bridge = _bridge(session_factory, human_actor, adapter, _FailingTrustClient())

    await CollaborationCore._handle_inbound_message(bridge, _message("hello there"))

    assert len(human_actor.sent) == 1
    _, content = human_actor.sent[0]
    assert content.startswith("hello there")
    assert "Switch Trust could not check" in content
    # Same as an alert: the room content alone never reaches the sender's
    # platform, so the degraded-check notice needs its own call too.
    assert len(adapter.admin_messages) == 1
    _, body, _, message_type = adapter.admin_messages[0]
    assert "Switch Trust could not check" in body
    assert message_type == AdminMessageType.TRUST_ERRORED.value


_OK = TrustCheckResult(outcome="ok", policy_id=None, policy_name=None)


async def test_a_long_message_is_checked_in_part_and_room_and_sender_are_told(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Padding a message cannot make Switch Trust time out: only its start is
    sent, and the room and the sender both see that the rest went unchecked."""
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    trust = _FixedTrustClient(_OK)
    bridge = _bridge(session_factory, human_actor, adapter, trust)
    content = "a" * TRUST_MESSAGE_TEXT_LIMIT + "b" * 5_000

    await CollaborationCore._handle_inbound_message(bridge, _message(content))

    assert trust.contents == ["a" * TRUST_MESSAGE_TEXT_LIMIT]
    [(_, sent)] = human_actor.sent
    assert sent.startswith(content)
    assert "checked only the first 20,000 characters" in sent
    [(_, body, _, message_type)] = adapter.admin_messages
    assert "checked only the first 20,000 characters" in body
    assert message_type == AdminMessageType.TRUST_ERRORED.value


async def test_switch_trusts_note_does_not_count_against_a_message_within_the_limit(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A 65,496-character paste is within the 65,536 limit as the person
    sent it. Switch Trust checks only its first 20,000 characters, and the
    note saying so takes the stored message to 65,599. The limit is held to
    what the person wrote, and the row has room for the note."""
    human_actor = _FakeHumanActor()
    adapter = _FakeAdapter()
    bridge = _bridge(session_factory, human_actor, adapter, _FixedTrustClient(_OK))
    content = "x" * 65_496

    await CollaborationCore._handle_inbound_message(bridge, _message(content))

    [(_, sent)] = human_actor.sent
    assert len(sent) == 65_599
    assert sent.startswith(content + "\n\n")
    assert human_actor.authored == [content]
    limits = SendLimits(
        max_message_chars=65_536, burst=1, per_second=1.0, clock=lambda: 0.0
    )
    # What the bridge, the transport and the router hold this send to.
    assert human_actor.admitted == [content]
    limits.admit(human_actor.client_id, content, actor="human")
    limits.require_length(content, actor="human")
    limits.require_row_length(sent)
    [(_, notice, _, message_type)] = adapter.admin_messages
    assert message_type == AdminMessageType.TRUST_ERRORED.value
    assert "not delivered" not in notice


async def test_the_agent_named_for_a_channel_does_not_count_against_its_sender(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A bot tagged in a channel where it stands for an agent gets the
    agent's `@name` written in front, so the agent is addressed."""
    human_actor = _FakeHumanActor()
    bridge = _bridge(
        session_factory, human_actor, _FakeAdapter(), _FixedTrustClient(_OK)
    )
    bridge._resolve_self_mention_target = AsyncMock(return_value="helper")
    message = _message("hello").model_copy(update={"self_mention_token": "bot"})

    await CollaborationCore._handle_inbound_message(bridge, message)

    assert human_actor.sent == [(TRANSPORT_ROOM_ID, "@helper hello")]
    assert human_actor.authored == ["hello"]


class _RefusingHumanActor(_FakeHumanActor):
    """A human whose messages Switch refuses as it admits them, one refusal
    per message."""

    def __init__(self, *refusals: MessageRefused) -> None:
        super().__init__()
        self._refusals = list(refusals)

    def admit_message(self, authored: str | None) -> None:
        raise self._refusals.pop(0)


class _RowRefusingHumanActor(_FakeHumanActor):
    """A human whose message is admitted and its row then refused: longer
    than any row may be with what Switch wrote into it."""

    async def send_message(
        self, room_id: str, content: str, **_kw: object
    ) -> str | None:
        raise MessageTooLong(80_000, 73_728)


async def test_a_message_refused_as_too_long_is_told_to_its_sender(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    human_actor = _RefusingHumanActor(MessageTooLong(70_000, 65_536))
    adapter = _FakeAdapter()
    trust = _FixedTrustClient(_OK)
    bridge = _bridge(session_factory, human_actor, adapter, trust)

    assert (
        await CollaborationCore._handle_inbound_message(bridge, _message("long"))
        is None
    )

    assert bridge.relayed == []
    assert human_actor.sent == []
    # Refused before Switch Trust was asked about it.
    assert trust.contents == []
    [(channel_id, body, root_or_ref, message_type)] = adapter.admin_messages
    assert channel_id == "chan-1"
    assert "not delivered to the room" in body
    assert "70,000 characters long" in body
    assert root_or_ref == "mm-post-1"
    assert message_type == AdminMessageType.MESSAGE_REFUSED.value


async def test_a_sender_over_their_allowance_is_told_once_not_per_message(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    def limited(first: bool) -> SendRateLimited:
        return SendRateLimited(retry_after=2.0, burst=30, per_second=2.0, first=first)

    human_actor = _RefusingHumanActor(limited(True), limited(False), limited(False))
    adapter = _FakeAdapter()
    trust = _FixedTrustClient(_OK)
    bridge = _bridge(session_factory, human_actor, adapter, trust)

    for _ in range(3):
        await CollaborationCore._handle_inbound_message(bridge, _message("again"))

    [(_, body, _, message_type)] = adapter.admin_messages
    assert "faster than Switch accepts" in body
    assert "Wait 2 seconds" in body
    assert message_type == AdminMessageType.MESSAGE_REFUSED.value
    assert trust.contents == []


async def test_a_row_refused_as_it_is_written_is_told_to_its_sender(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    human_actor = _RowRefusingHumanActor()
    adapter = _FakeAdapter()
    bridge = _bridge(session_factory, human_actor, adapter, _FixedTrustClient(_OK))

    assert (
        await CollaborationCore._handle_inbound_message(bridge, _message("long"))
        is None
    )

    assert bridge.relayed == []
    [(_, body, _, message_type)] = adapter.admin_messages
    assert "80,000 characters long" in body
    assert message_type == AdminMessageType.MESSAGE_REFUSED.value
