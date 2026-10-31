from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from switch_core.clients.admin_messages import PLATFORM_MARKER
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.delivery.recipient import (
    _STARTING_SESSION_MESSAGE,
    AUTO_REPLY_FLAG,
    AgentRecipient,
    _GateOutcome,
)
from switch_core.transport import InboundMessage, RoomRef


@asynccontextmanager
async def _session_factory():  # type: ignore[no-untyped-def]
    yield object()


class _Recorder:
    """Captures the send_message call so we can assert on thread_root_id."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def __call__(self, room_id: str, body: str, **kwargs: object) -> str:
        self.calls.append({"room_id": room_id, "body": body, **kwargs})
        return "$sent"


def _meta() -> SimpleNamespace:
    return SimpleNamespace(
        room_id="room-uuid",
        name="Some Room",
        bridge_id="bridge-1",
        channel_type="channel_private",
    )


def _fake_self(
    send_message: _Recorder,
    unavailable_reply: str = "I don't have a session connected to this room.",
) -> SimpleNamespace:
    """A minimal AgentRecipient stand-in: addressed, offline, non-moderator."""

    def _addressed_without_lookup(_event: object, _meta: object) -> bool:
        return True

    async def _compute_addressed(
        _session: object, _event: object, _meta: object
    ) -> bool:
        return True  # addressed → the offline auto-reply path runs

    async def _fresh_agent(_session: object) -> object:
        return ns.agent

    async def _gate_addressed(
        _session: object, _agent: object, _event: object, _meta: object
    ) -> _GateOutcome:
        # No addressing policy in these tests — the message stays addressed.
        return _GateOutcome(addressed=True, refusal=None)

    async def _is_available(_session: object, _agent: object, _room_id: str) -> bool:
        return False  # no live session → triggers the auto-reply

    async def _reply_when_unavailable_here(
        _session: object, _agent: object, _meta: object, _asker_handle: str
    ) -> str:
        return unavailable_reply

    async def _sender_role(
        _session: object, _sender: str, _content: object
    ) -> str | None:
        return None

    async def _no_notice(_session: object) -> None:
        return None

    ns = SimpleNamespace(
        agent=SimpleNamespace(id="agent-1", name="cc-bug-fixing"),
        tenant_id=TENANT_ZERO_ID,
        session_factory=_session_factory,
        _meta=_meta(),
        _room=RoomRef(room_id="!matrix:server"),
        _addressed_without_lookup=_addressed_without_lookup,
        _compute_addressed=_compute_addressed,
        _fresh_agent=_fresh_agent,
        _gate_addressed=_gate_addressed,
        _sender_role=_sender_role,
        _switch_notice=_no_notice,
        _is_available=_is_available,
        _reply_when_unavailable_here=_reply_when_unavailable_here,
        _triggered_by_auto_reply=AgentRecipient._triggered_by_auto_reply,
        actor=SimpleNamespace(send_message=send_message),
        _report_addressed=lambda *a, **k: None,
    )
    # Exercise the real sender-tagging and auto-reply helpers.
    ns._sender_handle = AgentRecipient._sender_handle.__get__(ns)
    ns._post_auto_reply = AgentRecipient._post_auto_reply.__get__(ns)
    ns._after_message = AgentRecipient._after_message.__get__(ns)
    return ns


async def _deliver(fake: SimpleNamespace, event: InboundMessage) -> None:
    """Decide the message for the agent as the router does, then do what it
    leaves to do once it has committed. What the agent is sent is not under
    test here, only where the reply goes."""
    delivery = await AgentRecipient.decide_message(fake, None, event)  # type: ignore[arg-type]
    if delivery.after is not None:
        await delivery.after(event)


def _event(thread_id: str | None, *, is_auto_reply: bool = False) -> InboundMessage:
    content: dict[str, object] = {"sender_name": "louisa"}
    if is_auto_reply:
        content[AUTO_REPLY_FLAG] = True
    return InboundMessage(
        room_id="!matrix:server",
        event_id="$trigger",
        sender="@switch-slack-louisa:switch.local",
        timestamp=0,
        content=content,
        body="@cc-bug-fixing can you help",
        sender_name="louisa",
        thread_root_id=thread_id,
    )


@pytest.mark.asyncio
async def test_no_session_reply_threads_under_triggering_mention() -> None:
    send_message = _Recorder()
    await _deliver(_fake_self(send_message), _event(thread_id="$thread-root"))

    assert len(send_message.calls) == 1
    assert send_message.calls[0]["thread_root_id"] == "$thread-root"
    # The reply tags the sender so they get notified.
    assert send_message.calls[0]["body"].startswith("@louisa ")
    assert send_message.calls[0]["mentions"] == ["@switch-slack-louisa:switch.local"]
    # The reply is stamped as an auto-reply so it can't re-trigger another one.
    assert send_message.calls[0]["extra_content"] == {AUTO_REPLY_FLAG: True}
    # Switch said it, not the agent, so the tenant is not charged for it.
    assert send_message.calls[0]["metered"] is False


@pytest.mark.asyncio
async def test_a_command_reply_is_not_metered() -> None:
    send_message = _Recorder()
    await AgentRecipient.reply_command(
        SimpleNamespace(actor=SimpleNamespace(send_message=send_message)),  # type: ignore[arg-type]
        "!matrix:server",
        "the result",
    )

    assert send_message.calls[0]["metered"] is False


@pytest.mark.asyncio
async def test_no_session_reply_not_triggered_by_another_auto_reply() -> None:
    # CHOO-548: two session-less agents addressed via each other's auto-replies
    # must not ping-pong. A message already flagged as an auto-reply gets no
    # reply, so the loop can never form.
    send_message = _Recorder()
    await _deliver(
        _fake_self(send_message), _event(thread_id="$thread-root", is_auto_reply=True)
    )

    assert send_message.calls == []


@pytest.mark.asyncio
async def test_no_session_reply_does_not_double_tag_the_asker() -> None:
    # The known-agent reply may already lead with its own @mention (pinging the
    # configured operator). When that's the same person as the asker, we must
    # tag them once, not "@louisa @louisa".
    send_message = _Recorder()
    await _deliver(
        _fake_self(
            send_message,
            unavailable_reply="@louisa — I'm not online in this room. Open Switch Console …",
        ),
        _event(thread_id=None),
    )

    assert len(send_message.calls) == 1
    body = send_message.calls[0]["body"]
    assert body.count("@louisa") == 1
    assert body.startswith("@louisa")


@pytest.mark.asyncio
async def test_no_session_reply_tags_distinct_asker_and_operator() -> None:
    # When the reply's embedded mention is a DIFFERENT person (the operator),
    # both the asker and that operator are tagged.
    send_message = _Recorder()
    await _deliver(
        _fake_self(
            send_message,
            unavailable_reply="@operator — I'm not online in this room. Open Switch Console …",
        ),
        _event(thread_id=None),
    )

    assert len(send_message.calls) == 1
    body = send_message.calls[0]["body"]
    assert body.startswith("@louisa ")
    assert "@operator" in body


class TestStartingSessionNoticeGoesWhereItWasAsked:
    """Where "Starting a session to handle this" lands (CHOO-2173).

    It is a preamble, not an answer: the real reply follows it in the same
    place. It used to reply onto the triggering message, which for a message at
    the conversation root means opening a thread off it — so asking at the root
    got a one-line notice tucked into a new thread, away from where the asker
    was looking and away from the answer that follows.

    This reverses CHOO-586, which made the root case start a thread on purpose.
    The notice is now placed the same way the typing indicator already is: in
    the thread when asked in a thread, at the root when asked at the root.
    """

    @pytest.mark.asyncio
    async def test_asked_at_the_root_it_answers_at_the_root(self) -> None:
        send_message = _Recorder()
        await _deliver(
            _fake_self(send_message, unavailable_reply=_STARTING_SESSION_MESSAGE),
            _event(thread_id=None),
        )

        assert len(send_message.calls) == 1
        # Not "$trigger": that would open a thread on the asker's message.
        assert send_message.calls[0]["thread_root_id"] is None

    @pytest.mark.asyncio
    async def test_asked_in_a_thread_it_stays_in_that_thread(self) -> None:
        # The other half of the rule — replying at the root here would strand
        # the notice away from the conversation it belongs to.
        send_message = _Recorder()
        await _deliver(
            _fake_self(send_message, unavailable_reply=_STARTING_SESSION_MESSAGE),
            _event(thread_id="$thread-root"),
        )

        assert send_message.calls[0]["thread_root_id"] == "$thread-root"


class TestTerminalReplyThreadsOffTheTrigger:
    """Where an "I can't help right now" reply lands (CHOO-2344).

    Unlike the starting-session notice, nothing follows it — it IS the answer.
    And it is addressed to one person: an owner mention and an instruction
    only they can act on. At the conversation root that is noise dropped into
    the channel for everyone else, so it threads off the message that
    triggered it instead.
    """

    @pytest.mark.asyncio
    async def test_asked_at_the_root_it_opens_a_thread_on_the_trigger(self) -> None:
        send_message = _Recorder()
        await _deliver(_fake_self(send_message), _event(thread_id=None))

        assert len(send_message.calls) == 1
        assert send_message.calls[0]["thread_root_id"] == "$trigger"

    @pytest.mark.asyncio
    async def test_asked_in_a_thread_it_stays_in_that_thread(self) -> None:
        # Already in a thread: the trigger's thread root IS that thread, so it
        # lands there rather than starting a nested one.
        send_message = _Recorder()
        await _deliver(_fake_self(send_message), _event(thread_id="$thread-root"))

        assert send_message.calls[0]["thread_root_id"] == "$thread-root"


@pytest.mark.asyncio
async def test_a_kickoff_that_wants_the_channel_gets_its_reply_at_top_level() -> None:
    # The template kickoff sits in a thread to keep the channel to one line,
    # but flags that the work belongs in the channel: the agent's reply goes
    # to the top level, not under the kickoff.
    send_message = _Recorder()
    event = _event(thread_id="$kickoff-headline")
    event.content[PLATFORM_MARKER] = {
        "on_behalf_of": {"user_id": "u9", "name": "dantas.abel"},
        "reply_in_channel": True,
    }
    await _deliver(_fake_self(send_message), event)

    assert len(send_message.calls) == 1
    assert send_message.calls[0]["thread_root_id"] is None
    assert send_message.calls[0]["body"].startswith("@dantas.abel ")
