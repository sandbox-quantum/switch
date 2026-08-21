from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.clients.agent_client import AUTO_REPLY_FLAG, AgentClient


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
    """A minimal AgentClient stand-in: addressed, offline, non-moderator."""

    async def _resolve_room_meta(_matrix_room_id: str) -> SimpleNamespace:
        return _meta()

    async def _compute_addressed(_event: object, _meta: object) -> bool:
        return True  # addressed → the offline auto-reply path runs

    async def _gate_addressed(
        _room: object,
        _event: object,
        _meta: object,
        _reply_thread_root: str,
        is_addressed: bool,
    ) -> bool:
        # No addressing policy in these tests — pass the addressed flag through.
        return is_addressed

    async def _is_available(_room_id: str) -> bool:
        return False  # no live session → triggers the auto-reply

    async def _reply_when_unavailable_here(_meta: object) -> str:
        return unavailable_reply

    ns = SimpleNamespace(
        agent=SimpleNamespace(id="agent-1", name="cc-bug-fixing"),
        _resolve_room_meta=_resolve_room_meta,
        _compute_addressed=_compute_addressed,
        _gate_addressed=_gate_addressed,
        _is_available=_is_available,
        _reply_when_unavailable_here=_reply_when_unavailable_here,
        send_message=send_message,
        _event_buffer=SimpleNamespace(enqueue=lambda *a, **k: None),
    )
    # Exercise the real sender-tagging helper.
    ns._sender_handle = AgentClient._sender_handle.__get__(ns)
    return ns


def _event(thread_id: str | None, *, is_auto_reply: bool = False) -> SimpleNamespace:
    content: dict[str, object] = {"sender_name": "adalovelace"}
    if thread_id is not None:
        content["m.relates_to"] = {"rel_type": "m.thread", "event_id": thread_id}
    if is_auto_reply:
        content[AUTO_REPLY_FLAG] = True
    return SimpleNamespace(
        body="@cc-bug-fixing can you help",
        sender="@switch-mattermost-adalovelace:switch.local",
        event_id="$trigger",
        server_timestamp=0,
        source={"content": content},
    )


@pytest.mark.asyncio
async def test_no_session_reply_threads_under_triggering_mention() -> None:
    send_message = _Recorder()
    room = SimpleNamespace(room_id="!matrix:server")
    await AgentClient.on_message(
        _fake_self(send_message), room, _event(thread_id="$thread-root")
    )

    assert len(send_message.calls) == 1
    assert send_message.calls[0]["thread_root_id"] == "$thread-root"
    # The reply tags the sender so they get notified.
    assert send_message.calls[0]["body"].startswith("@adalovelace ")
    assert send_message.calls[0]["mentions"] == [
        "@switch-mattermost-adalovelace:switch.local"
    ]
    # The reply is stamped as an auto-reply so it can't re-trigger another one.
    assert send_message.calls[0]["extra_content"] == {AUTO_REPLY_FLAG: True}


@pytest.mark.asyncio
async def test_no_session_reply_not_triggered_by_another_auto_reply() -> None:
    # CHOO-548: two session-less agents addressed via each other's auto-replies
    # must not ping-pong. A message already flagged as an auto-reply gets no
    # reply, so the loop can never form.
    send_message = _Recorder()
    room = SimpleNamespace(room_id="!matrix:server")
    await AgentClient.on_message(
        _fake_self(send_message),
        room,
        _event(thread_id="$thread-root", is_auto_reply=True),
    )

    assert send_message.calls == []


@pytest.mark.asyncio
async def test_no_session_reply_does_not_double_tag_the_asker() -> None:
    # The known-agent reply may already lead with its own @mention (pinging the
    # configured operator). When that's the same person as the asker, we must
    # tag them once, not "@adalovelace @adalovelace".
    send_message = _Recorder()
    room = SimpleNamespace(room_id="!matrix:server")
    await AgentClient.on_message(
        _fake_self(
            send_message, unavailable_reply="@adalovelace\n\nmy operator should run …"
        ),
        room,
        _event(thread_id=None),
    )

    assert len(send_message.calls) == 1
    body = send_message.calls[0]["body"]
    assert body.count("@adalovelace") == 1
    assert body.startswith("@adalovelace")


@pytest.mark.asyncio
async def test_no_session_reply_tags_distinct_asker_and_operator() -> None:
    # When the reply's embedded mention is a DIFFERENT person (the operator),
    # both the asker and that operator are tagged.
    send_message = _Recorder()
    room = SimpleNamespace(room_id="!matrix:server")
    await AgentClient.on_message(
        _fake_self(
            send_message, unavailable_reply="@operator\n\nmy operator should run …"
        ),
        room,
        _event(thread_id=None),
    )

    assert len(send_message.calls) == 1
    body = send_message.calls[0]["body"]
    assert body.startswith("@adalovelace ")
    assert "@operator" in body


class TestUnavailableReplyGoesWhereItWasAsked:
    """Where "Starting a session to handle this" lands (CHOO-2173).

    It used to reply onto the triggering message, which for a message at the
    conversation root means opening a thread off it. So asking at the root got
    a one-line notice tucked into a new thread, away from where the asker was
    looking and away from the answer that follows.

    This reverses CHOO-586, which made the root case start a thread on purpose.
    The reply is now placed the same way the typing indicator already is: in the
    thread when asked in a thread, at the root when asked at the root.
    """

    @pytest.mark.asyncio
    async def test_asked_at_the_root_it_answers_at_the_root(self) -> None:
        send_message = _Recorder()
        room = SimpleNamespace(room_id="!matrix:server")

        await AgentClient.on_message(
            _fake_self(send_message), room, _event(thread_id=None)
        )

        assert len(send_message.calls) == 1
        # Not "$trigger": that would open a thread on the asker's message.
        assert send_message.calls[0]["thread_root_id"] is None

    @pytest.mark.asyncio
    async def test_asked_in_a_thread_it_stays_in_that_thread(self) -> None:
        # The other half of the rule — replying at the root here would strand
        # the notice away from the conversation it belongs to.
        send_message = _Recorder()
        room = SimpleNamespace(room_id="!matrix:server")

        await AgentClient.on_message(
            _fake_self(send_message), room, _event(thread_id="$thread-root")
        )

        assert send_message.calls[0]["thread_root_id"] == "$thread-root"
