"""Teams has two channel layouts, and they want opposite things.

A **posts** channel is a list of conversations: a message at the root opens a
new one, so an agent's answer has to be steered under the question or it reads
as a non-sequitur. A **chat** channel is a stream like every other platform
Switch bridges, and steering there is exactly wrong — it buries the agent's
first message, the room-linked notice and the runtime status inside whatever
thread the channel last used.

Graph is the only thing that knows which is which.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

_CHANNEL = "19:abc@thread.tacv2"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _Connector:
    def __init__(self) -> None:
        self.new_posts: list[str] = []
        self.replies: list[str] = []

    async def create_channel_thread(
        self, *, service_url: str, channel_id: str, activity: dict[str, Any]
    ) -> tuple[str, str]:
        self.new_posts.append(channel_id)
        return f"{channel_id};messageid=new", "msg-new"

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        self.replies.append(conversation_id)
        return "msg-reply"


class _Graph:
    """Graph, answering only what the adapter reads off a channel."""

    def __init__(self, layout: str | None) -> None:
        self._layout = layout
        self.reads = 0

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        self.reads += 1
        channel: dict[str, Any] = {"id": channel_id, "displayName": "general"}
        if self._layout is not None:
            channel["layoutType"] = self._layout
        return channel


class _RefusingGraph:
    def __init__(self) -> None:
        self.reads = 0

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        self.reads += 1
        raise RuntimeError("Authorization_RequestDenied")


def _adapter(graph: Any) -> tuple[TeamsAdapter, _Connector]:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-9",
            team_id="team-7",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    connector = _Connector()
    adapter._connector = connector  # type: ignore[assignment]
    adapter._graph = graph
    adapter._default_service_url = "https://smba.example"
    adapter._channel_type[_CHANNEL] = "channel_public"
    return adapter, connector


async def _seen(adapter: TeamsAdapter, *, root_id: str | None, ref: str) -> None:
    adapter._on_message = None  # type: ignore[assignment]
    adapter._on_command = None  # type: ignore[assignment]
    await adapter._deliver(
        channel_id=_CHANNEL,
        channel_type="channel_public",
        sender_id="aad-1",
        sender_name="alice",
        text="a question",
        message_ref=ref,
        root_id=root_id,
        channel_name="general",
    )


# ── Chat layout: the ordinary policy, same as every other bridge ──────────────


def test_a_chat_channel_answers_at_the_root_when_no_thread_was_named() -> None:
    adapter, connector = _adapter(_Graph("chat"))
    _run(_seen(adapter, root_id=None, ref="msg-1"))

    _run(adapter.send_message(_CHANNEL, "james", "an answer"))

    # A new root message in the stream, not a reply buried under msg-1.
    assert connector.new_posts == [_CHANNEL]
    assert connector.replies == []


def test_a_chat_channel_still_honours_a_thread_the_agent_chose() -> None:
    # The agent decides: a Matrix-threaded reply is threaded in Teams too.
    adapter, connector = _adapter(_Graph("chat"))
    _run(_seen(adapter, root_id=None, ref="msg-1"))

    _run(adapter.send_message(_CHANNEL, "james", "an answer", "msg-1"))

    assert connector.replies == [f"{_CHANNEL};messageid=msg-1"]


def test_a_chat_channel_puts_the_room_linked_notice_at_the_root() -> None:
    # The notice answers nothing, and lands after the message that triggered
    # the room's creation — so it is the case most likely to be swallowed.
    adapter, connector = _adapter(_Graph("chat"))
    _run(_seen(adapter, root_id=None, ref="msg-1"))

    _run(adapter.admin_message(_CHANNEL, "I've linked this channel to a room."))

    assert connector.new_posts == [_CHANNEL]
    assert connector.replies == []


def test_a_chat_channel_keeps_the_runtime_status_where_the_message_was() -> None:
    adapter, connector = _adapter(_Graph("chat"))

    # Triggered by a message at the root → the status belongs at the root.
    _run(
        adapter.apply_runtime_state(
            _CHANNEL, "james", "working", mention_handle=None, thread_root_id=None
        )
    )
    assert connector.new_posts == [_CHANNEL]
    assert connector.replies == []

    # Triggered from inside a thread → the status belongs in that thread.
    _run(
        adapter.apply_runtime_state(
            _CHANNEL, "rita", "working", mention_handle=None, thread_root_id="msg-4"
        )
    )
    assert connector.replies == [f"{_CHANNEL};messageid=msg-4"]


def test_a_chat_channel_does_not_glue_an_agents_messages_together() -> None:
    # The bug Louis saw: everything an agent said after its first message was
    # rewritten into the thread that first message opened.
    adapter, connector = _adapter(_Graph("chat"))

    _run(adapter.send_message(_CHANNEL, "james", "Hi! I'm here and connected."))
    _run(adapter.send_message(_CHANNEL, "james", "What can I help with?"))

    assert connector.new_posts == [_CHANNEL, _CHANNEL]
    assert connector.replies == []


# ── Posts layout: unchanged, an answer goes under the question ────────────────


def test_a_posts_channel_still_answers_under_the_question() -> None:
    adapter, connector = _adapter(_Graph("post"))
    _run(_seen(adapter, root_id=None, ref="post-1"))

    _run(adapter.send_message(_CHANNEL, "james", "an answer"))

    assert connector.new_posts == []
    assert connector.replies == [f"{_CHANNEL};messageid=post-1"]


def test_an_agents_own_post_never_displaces_a_real_message() -> None:
    # An agent deliberately replying into an older thread must not drag every
    # later answer back into it.
    adapter, connector = _adapter(_Graph("post"))
    _run(_seen(adapter, root_id=None, ref="post-2"))

    _run(adapter.send_message(_CHANNEL, "james", "a note on the old one", "post-1"))
    _run(adapter.send_message(_CHANNEL, "james", "answering you"))

    assert connector.replies == [
        f"{_CHANNEL};messageid=post-1",
        f"{_CHANNEL};messageid=post-2",
    ]


# ── When Graph cannot say ─────────────────────────────────────────────────────


def test_an_unreadable_layout_is_treated_as_posts() -> None:
    # Graph's own default, and what every Teams channel was before the chat
    # layout existed — so it is the answer least likely to surprise.
    adapter, connector = _adapter(_RefusingGraph())
    _run(_seen(adapter, root_id=None, ref="post-1"))

    _run(adapter.send_message(_CHANNEL, "james", "an answer"))

    assert connector.replies == [f"{_CHANNEL};messageid=post-1"]


def test_a_layout_graph_omits_is_treated_as_posts() -> None:
    adapter, connector = _adapter(_Graph(None))
    _run(_seen(adapter, root_id=None, ref="post-1"))

    _run(adapter.send_message(_CHANNEL, "james", "an answer"))

    assert connector.replies == [f"{_CHANNEL};messageid=post-1"]


def test_the_layout_is_read_once_per_channel() -> None:
    graph = _Graph("chat")
    adapter, _ = _adapter(graph)

    _run(_seen(adapter, root_id=None, ref="msg-1"))
    _run(adapter.send_message(_CHANNEL, "james", "one"))
    _run(adapter.send_message(_CHANNEL, "james", "two"))
    _run(_seen(adapter, root_id=None, ref="msg-2"))

    assert graph.reads == 1


def test_a_refusal_is_not_retried_on_every_message() -> None:
    graph = _RefusingGraph()
    adapter, _ = _adapter(graph)

    _run(_seen(adapter, root_id=None, ref="post-1"))
    _run(adapter.send_message(_CHANNEL, "james", "one"))
    _run(adapter.send_message(_CHANNEL, "james", "two"))

    assert graph.reads == 1


# ── A failed read must not be permanent ───────────────────────────────────────


class _FlakyGraph:
    """Refuses the first read, answers the second."""

    def __init__(self, layout: str) -> None:
        self._layout = layout
        self.reads = 0

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        self.reads += 1
        if self.reads == 1:
            raise RuntimeError("ServiceUnavailable")
        return {"id": channel_id, "displayName": "general", "layoutType": self._layout}


def test_a_failed_read_is_retried_once_its_backoff_has_passed() -> None:
    # A blip, or a permission granted a minute after the bridge started, must
    # not pin a channel to "nameless, posts layout" for the life of the
    # process — that is the shape of the bug that killed capture at a restart.
    import switch_core.bridges.collaboration.teams.adapter as adapter_module

    graph = _FlakyGraph("chat")
    adapter, connector = _adapter(graph)

    _run(adapter._channel_layout(_CHANNEL))
    assert graph.reads == 1
    # Still inside the backoff: no second call, and no layout yet.
    _run(adapter._channel_layout(_CHANNEL))
    assert graph.reads == 1

    adapter._channel_read_failed_at[_CHANNEL] -= (
        adapter_module._CHANNEL_READ_RETRY_AFTER + 1
    )

    assert _run(adapter._channel_layout(_CHANNEL)) == "chat"
    assert graph.reads == 2
    # And once it has answered, it is not asked again.
    _run(adapter._channel_layout(_CHANNEL))
    assert graph.reads == 2


def test_learning_a_new_team_reopens_a_read_made_against_the_old_one() -> None:
    """The gap this closes: a channel in another team fails its read, then the
    team is learned and the subscription heals — but the name and layout would
    stay stuck at whatever the failed read left behind, because the wrong team
    is exactly what Graph refuses."""
    graph = _Graph("chat")
    adapter, _ = _adapter(graph)
    # A read made while the team was wrong, cached as "could not say".
    adapter._channel_layouts[_CHANNEL] = ""
    adapter._channel_names[_CHANNEL] = ""
    adapter._channel_read_failed_at[_CHANNEL] = 0.0

    _run(adapter._learn_channel_team(_CHANNEL, "team-elsewhere"))

    assert _CHANNEL not in adapter._channel_layouts
    assert _CHANNEL not in adapter._channel_read_failed_at
    assert _run(adapter._channel_layout(_CHANNEL)) == "chat"


def test_relearning_the_same_team_does_not_discard_a_good_read() -> None:
    graph = _Graph("chat")
    adapter, _ = _adapter(graph)
    _run(adapter._learn_channel_team(_CHANNEL, "team-7"))
    _run(adapter._channel_layout(_CHANNEL))
    assert graph.reads == 1

    _run(adapter._learn_channel_team(_CHANNEL, "team-7"))

    assert _run(adapter._channel_layout(_CHANNEL)) == "chat"
    assert graph.reads == 1
