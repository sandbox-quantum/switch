"""Slack's side of `!work-threads`, and the asker a stream is addressed to.

A turn asked at the top of a channel can do its work in a thread under a
message of the agent's own: a divider at the channel root, an agent session on
its thread for the asker, and the turn's stream in that thread. Nobody follows
that thread, so the stream stopping marks nobody's Threads view unread.
"""

from __future__ import annotations

from typing import Any

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.adapter import (
    AskedQuestion,
    RichContentFailed,
    TurnActivity,
    WorkEnding,
)
from switch_core.bridges.collaboration.own_app_setup import SLACK_BOT_EVENTS
from switch_core.bridges.collaboration.session.renderers import (
    SESSION_STOP_ACTION,
    turn_state,
    work_ending,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
    SlackUser,
)
from switch_core.sessions.contract import Item, TurnUpsert

from .slack_fakes import FakeResponse, FakeWebClient

CHANNEL = "C1"
ASKER = "U0ASKER"


def _state(
    title: str, *, status: str = "in_progress", link: tuple[str, str] | None = None
) -> dict[str, Any]:
    """A work message: one line, a plan of one card for Slack's own icon, and
    the link to the question, (url, label), in the card where there is one."""
    task: dict[str, Any] = {
        "task_id": "switch-work-thread",
        "title": "Jump to the question" if link else "The steps are in the thread",
        "status": status,
    }
    if link is not None:
        task["details"] = {
            "type": "rich_text",
            "elements": [
                {
                    "type": "rich_text_section",
                    "elements": [{"type": "link", "url": link[0], "text": link[1]}],
                }
            ],
        }
    return {"type": "plan", "title": title, "tasks": [task]}


def _adapter(client: FakeWebClient) -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )
    adapter._web_client = client  # type: ignore[assignment]
    adapter._team_id = "T123"
    return adapter


async def _named(user_id: str) -> SlackUser:
    return SlackUser(name="person", display_name="Person")


def _sessions(client: FakeWebClient) -> list[dict[str, Any]]:
    return [
        kwargs["json"]
        for method, kwargs in client.api_calls
        if method == "agents.sessions.setStatus"
    ]


def _turn(status: str = "running") -> TurnUpsert:
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": "t1", "status": status, "commandId": None}
    )


def _tool() -> Item:
    return Item.model_validate(
        {
            "itemId": "i1",
            "turnId": "t1",
            "revision": 1,
            "kind": "tool-activity",
            "status": "in-progress",
            "title": "Ran pytest",
            "text": "",
            "attachments": [],
            "origin": None,
        }
    )


@pytest.mark.parametrize(
    ("kind", "hosts"),
    [("channel", True), ("group", True), ("im", False), ("mpim", False)],
)
async def test_work_threads_are_everywhere_but_a_dm(kind: str, hosts: bool) -> None:
    adapter = _adapter(FakeWebClient())
    adapter._channel_type_cache[CHANNEL] = kind
    assert await adapter.hosts_work_threads(CHANNEL) is hosts


async def test_a_channel_never_seen_is_looked_up_once() -> None:
    client = FakeWebClient()
    looked_up: list[dict[str, Any]] = []

    async def conversations_info(**kwargs: Any) -> FakeResponse:
        looked_up.append(kwargs)
        return FakeResponse({"channel": {"is_im": True}})

    client.conversations_info = conversations_info  # type: ignore[method-assign]
    adapter = _adapter(client)
    assert await adapter.hosts_work_threads(CHANNEL) is False
    assert await adapter.hosts_work_threads(CHANNEL) is False
    assert len(looked_up) == 1


async def test_a_channel_that_cannot_be_looked_up_keeps_the_askers_thread() -> None:
    client = FakeWebClient()

    async def conversations_info(**kwargs: Any) -> FakeResponse:
        raise SlackApiError("no", FakeResponse({"error": "channel_not_found"}))

    client.conversations_info = conversations_info  # type: ignore[method-assign]
    assert await _adapter(client).hosts_work_threads(CHANNEL) is False


async def test_a_work_message_is_a_line_with_a_session_for_the_asker() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    ref = await adapter.open_work_message(
        CHANNEL, "Agent", "Agent is working on this", ASKER
    )
    [posted] = client.posted
    assert ref == f"{CHANNEL}:{client._ts}.0"
    assert posted["channel"] == CHANNEL
    assert "thread_ts" not in posted, "the work message is at the channel root"
    assert posted["blocks"] == [_state("Working…")]
    assert posted["text"] == "Agent is working on this"
    [session] = _sessions(client)
    assert session["channel_id"] == CHANNEL
    assert session["thread_ts"] == ref.split(":", 1)[1]
    assert session["status"] == "processing"
    assert session["initiator_user_id"] == ASKER


async def test_a_session_slack_refuses_does_not_stop_the_work_message() -> None:
    client = FakeWebClient()

    async def api_call(method: str, **kwargs: Any) -> FakeResponse:
        raise SlackApiError("no", FakeResponse({"error": "feature_disabled"}))

    client.api_call = api_call  # type: ignore[method-assign]
    ref = await _adapter(client).open_work_message(CHANNEL, "Agent", "working", ASKER)
    assert ref.startswith(f"{CHANNEL}:")
    assert len(client.posted) == 1


async def test_a_work_message_slack_refuses_is_reported() -> None:
    client = FakeWebClient()

    async def chat_postMessage(**kwargs: Any) -> FakeResponse:
        raise SlackApiError("no", FakeResponse({"error": "not_in_channel"}))

    client.chat_postMessage = chat_postMessage  # type: ignore[method-assign]
    with pytest.raises(RichContentFailed):
        await _adapter(client).open_work_message(CHANNEL, "Agent", "working", ASKER)
    assert _sessions(client) == []


async def test_settling_edits_in_the_last_line_and_ends_the_session() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    line = "Worked for 30s. 2 tool calls."
    await adapter.settle_work_message(
        CHANNEL,
        "Agent",
        f"{CHANNEL}:5.0",
        line,
        ending=WorkEnding("Worked on", "30s · 2 steps", failed=False),
    )
    [edit] = client.updated
    assert (edit["channel"], edit["ts"]) == (CHANNEL, "5.0")
    assert edit["text"] == line, "notifications and screen readers get the sentence"
    assert edit["blocks"] == [_state("Worked · 30s · 2 steps", status="complete")]
    calls = [
        (method, kwargs["json"])
        for method, kwargs in client.api_calls
        if method.startswith("agents.sessions.")
    ]
    assert calls == [
        (
            "agents.sessions.setStatus",
            {"channel_id": CHANNEL, "thread_ts": "5.0", "status": "active"},
        ),
    ]


async def test_a_stream_in_a_thread_nobody_spoke_in_goes_to_whoever_the_turn_answers() -> (
    None
):
    """A work thread, or any thread after a restart emptied the memory of who
    spoke there: still a stream, which is silent, not an ordinary post."""
    client = FakeWebClient()
    adapter = _adapter(client)
    adapter._channel_type_cache[CHANNEL] = "channel"
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=ASKER),
        f"{CHANNEL}:9.0",
    )
    [started] = client.started
    assert started["recipient_user_id"] == ASKER
    assert started["thread_ts"] == "9.0"
    assert client.posted == []


async def test_the_person_seen_in_the_thread_wins_over_the_turns_asker() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    adapter._thread_requester[(CHANNEL, "9.0")] = "U0SEEN"
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=ASKER),
        f"{CHANNEL}:9.0",
    )
    assert client.started[0]["recipient_user_id"] == "U0SEEN"


async def test_a_turn_with_nobody_to_address_is_still_an_ordinary_post() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([_tool()], _turn()), f"{CHANNEL}:9.0"
    )
    assert client.started == []
    assert len(client.posted) == 1


def _notes(client: FakeWebClient, work_ref: str) -> list[str]:
    ts = work_ref.split(":", 1)[1]
    return [edit["text"] for edit in client.updated if edit["ts"] == ts]


def _done_tool(item_id: str = "i1") -> Item:
    return _tool().model_copy(update={"status": "completed", "item_id": item_id})


def _work(items: list[Item], status: str = "running") -> TurnActivity:
    return TurnActivity(
        items, _turn(status), recipient_external_id=ASKER, work_thread=True
    )


# ── The ending ───────────────────────────────────────────────────────────────


async def test_a_refused_delete_keeps_the_status_message() -> None:
    client = FakeWebClient()

    async def chat_delete(**kwargs: Any) -> FakeResponse:
        raise SlackApiError("no", FakeResponse({"error": "cant_delete_message"}))

    client.chat_delete = chat_delete  # type: ignore[method-assign]
    assert not await _adapter(client).remove_status_message(CHANNEL, f"{CHANNEL}:5.0")


async def test_a_status_message_already_gone_counts_as_deleted() -> None:
    client = FakeWebClient()

    async def chat_delete(**kwargs: Any) -> FakeResponse:
        raise SlackApiError("no", FakeResponse({"error": "message_not_found"}))

    client.chat_delete = chat_delete  # type: ignore[method-assign]
    assert await _adapter(client).remove_status_message(CHANNEL, f"{CHANNEL}:5.0")


async def test_a_closed_stream_in_a_work_thread_carries_on_in_a_new_one() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    work = await adapter.open_work_message(CHANNEL, "Agent", "working", ASKER)
    first = await adapter.post_rich(CHANNEL, "Agent", _work([_tool()]), work)
    client.append_error = "message_not_in_streaming_state"
    moved = await adapter.update_rich(
        CHANNEL, "Agent", first, _work([_done_tool(), _tool()]), work
    )
    client.append_error = None
    assert moved is not None and moved != first
    assert len(client.started) == 2
    assert client.started[1]["thread_ts"] == work.split(":", 1)[1]


async def test_a_closed_stream_in_the_askers_thread_is_edited_as_before() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    turn = TurnActivity([_tool()], _turn(), recipient_external_id=ASKER)
    first = await adapter.post_rich(CHANNEL, "Agent", turn, f"{CHANNEL}:9.0")
    client.append_error = "message_not_in_streaming_state"
    moved = await adapter.update_rich(
        CHANNEL,
        "Agent",
        first,
        TurnActivity([_done_tool(), _tool()], _turn()),
        f"{CHANNEL}:9.0",
    )
    assert moved is None
    assert len(client.started) == 1


# ── Inline ───────────────────────────────────────────────────────────────────


async def test_a_session_opens_on_a_status_message_for_the_asker() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.open_session(
        CHANNEL, "Agent", f"{CHANNEL}:4.0", ASKER, "Agent is working on this"
    )
    [session] = _sessions(client)
    assert session["thread_ts"] == "4.0"
    assert session["status"] == "processing"
    assert session["initiator_user_id"] == ASKER
    assert session["title"] == "Agent is working on this"
    assert client.posted == [] and client.updated == []


async def test_closing_a_session_sets_it_active_and_keeps_its_title() -> None:
    """Never renamed to how the turn ended: Slack's spinner said it was
    working, and the message says how it went."""
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.close_session(CHANNEL, "Agent", f"{CHANNEL}:4.0", "Turn interrupted.")
    assert [method for method, _ in client.api_calls] == [
        "agents.sessions.setStatus",
    ]
    assert client.updated == [], "the message itself is left as last drawn"


async def test_a_status_message_at_the_root_is_an_ordinary_post() -> None:
    """Slack refuses a stream at the top of an ordinary channel."""
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=ASKER),
        None,
    )
    assert client.started == []
    [posted] = client.posted
    assert "thread_ts" not in posted or posted["thread_ts"] is None
    assert any(block["type"] == "plan" for block in posted["blocks"])


# ── Slack's own Stop ─────────────────────────────────────────────────────────


async def test_slacks_own_stop_is_a_stop_press_on_the_sessions_message() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    pressed: list[Any] = []

    async def on_interaction(interaction: Any) -> None:
        pressed.append(interaction)

    adapter._on_interaction = on_interaction
    adapter._resolve_user_name = _named  # type: ignore[method-assign]
    await adapter.dispatch_event(
        envelope_type="events_api",
        payload={
            "event": {
                "type": "agent_session_stopped",
                "channel": CHANNEL,
                "thread_ts": "4.0",
                "user": ASKER,
                "streaming_message_ts": ["5.0"],
            }
        },
    )
    [press] = pressed
    assert press.action_id == SESSION_STOP_ACTION
    assert press.message_ref == f"{CHANNEL}:4.0"
    assert press.sender_id == ASKER


async def test_a_stream_someone_stopped_is_not_carried_on() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    work = await adapter.open_work_message(CHANNEL, "Agent", "working", ASKER)
    first = await adapter.post_rich(CHANNEL, "Agent", _work([_tool()]), work)
    client.append_error = "stopped_by_user"
    moved = await adapter.update_rich(
        CHANNEL, "Agent", first, _work([_done_tool(), _tool()]), work
    )
    assert moved is None
    assert len(client.started) == 1


async def test_after_slacks_stop_the_turn_does_not_open_another_stream() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    work = await adapter.open_work_message(CHANNEL, "Agent", "working", ASKER)
    first = await adapter.post_rich(CHANNEL, "Agent", _work([_tool()]), work)
    adapter._sessions_stopped[work] = None
    client.append_error = "message_not_in_streaming_state"
    moved = await adapter.update_rich(
        CHANNEL, "Agent", first, _work([_done_tool(), _tool()]), work
    )
    assert moved is None
    assert len(client.started) == 1


def test_the_app_subscribes_to_slacks_stop() -> None:
    assert "agent_session_stopped" in SLACK_BOT_EVENTS


# ── Which Stop to show ───────────────────────────────────────────────────────


def _answering(client: FakeWebClient, answer: FakeResponse) -> None:
    async def api_call(method: str, **kwargs: Any) -> FakeResponse:
        client.api_calls.append((method, kwargs))
        return answer

    client.api_call = api_call  # type: ignore[method-assign]


def _has_own_stop(blocks: list[dict[str, Any]]) -> bool:
    return any(block.get("type") == "actions" for block in blocks)


async def _inline_post(adapter: SlackAdapter, client: FakeWebClient) -> list[Any]:
    await adapter.open_session(CHANNEL, "Agent", f"{CHANNEL}:4.0", ASKER, "t")
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), interrupt_turn_id="t1", has_session=True),
        None,
    )
    return client.posted[-1]["blocks"]


async def test_an_app_subscribed_to_slacks_stop_leaves_its_own_out() -> None:
    client = FakeWebClient()
    _answering(client, FakeResponse({"ok": True, "status": "processing"}))
    adapter = _adapter(client)
    blocks = await _inline_post(adapter, client)
    assert adapter.native_stop_available() is True
    assert not _has_own_stop(blocks), "Slack draws the Stop on the session"


async def test_an_app_not_subscribed_keeps_switchs_own_stop() -> None:
    client = FakeWebClient()
    _answering(
        client,
        FakeResponse(
            {
                "ok": True,
                "warning": "missing_agent_session_stopped_event_subscription",
                "response_metadata": {
                    "warnings": ["missing_agent_session_stopped_event_subscription"]
                },
            }
        ),
    )
    adapter = _adapter(client)
    blocks = await _inline_post(adapter, client)
    assert adapter.native_stop_available() is False
    assert _has_own_stop(blocks)


async def test_a_workspace_without_sessions_keeps_switchs_own_stop() -> None:
    client = FakeWebClient()

    async def api_call(method: str, **kwargs: Any) -> FakeResponse:
        raise SlackApiError("no", FakeResponse({"error": "feature_disabled"}))

    client.api_call = api_call  # type: ignore[method-assign]
    adapter = _adapter(client)
    blocks = await _inline_post(adapter, client)
    assert adapter.native_stop_available() is False
    assert _has_own_stop(blocks)


async def test_a_turn_without_a_session_always_keeps_switchs_own_stop() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    adapter._native_stop = True
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), interrupt_turn_id="t1"),
        None,
    )
    assert _has_own_stop(client.posted[-1]["blocks"])


# ── Who stopped it ───────────────────────────────────────────────────────────


def test_an_interrupted_turn_names_who_stopped_it() -> None:
    line = turn_state(
        [],
        _turn("interrupted"),
        tool_detail=True,
        elapsed_seconds=7,
        stopped_by="Simon",
    )
    assert line == "Stopped by Simon. Worked for 7s."


def test_an_interruption_nobody_pressed_keeps_its_own_words() -> None:
    line = turn_state([], _turn("interrupted"), tool_detail=True, elapsed_seconds=7)
    assert line.startswith("Turn interrupted.")


def test_a_name_never_changes_how_a_finished_turn_reads() -> None:
    line = turn_state(
        [], _turn("completed"), tool_detail=True, elapsed_seconds=7, stopped_by="Simon"
    )
    assert line == "Worked for 7s."


async def test_the_plan_header_says_who_stopped_the_turn() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity(
            [_done_tool()],
            _turn("interrupted"),
            elapsed_seconds=7,
            stopped_by="Simon",
        ),
        None,
    )
    [plan] = [b for b in client.posted[-1]["blocks"] if b["type"] == "plan"]
    assert plan["title"].startswith("Stopped by Simon. Worked for 7s.")


# ── Pointing back at the question ────────────────────────────────────────────

TEAM_URL = "https://acme.slack.com/"
ASKED = AskedQuestion(message_ref=f"{CHANNEL}:1700000000.123456", text="how many PRs?")
LINK = "https://acme.slack.com/archives/C1/p1700000000123456"


def _pointing(client: FakeWebClient) -> SlackAdapter:
    adapter = _adapter(client)
    adapter._team_url = TEAM_URL
    return adapter


def _pointer(text: str) -> dict[str, Any]:
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": text}]}


async def test_a_work_message_is_one_line_naming_its_question() -> None:
    """The question leads the line, with Slack's spinner beside it. A plan's
    title is plain text, so its link is in the card: a link, not a mention,
    so nobody is notified."""
    client = FakeWebClient()
    await _pointing(client).open_work_message(
        CHANNEL, "Agent", "working", ASKER, asked=ASKED
    )
    [posted] = client.posted
    assert posted["blocks"] == [
        _state("Working on “how many PRs?”", link=(LINK, "“how many PRs?”"))
    ]
    assert "<@" not in str(posted["blocks"])
    [session] = _sessions(client)
    assert session["title"] == "how many PRs?"


async def test_the_line_is_edited_once_when_the_turn_ends() -> None:
    """Nothing of the turn's progress is edited in while it runs: the steps
    are in the thread. Its ending is one edit, a tick for a turn that
    completed and an error mark for one stopped or failed."""
    client = FakeWebClient()
    adapter = _pointing(client)
    work = await adapter.open_work_message(
        CHANNEL, "Agent", "working", ASKER, asked=ASKED
    )
    content = TurnActivity(
        [_tool()], _turn(), recipient_external_id=ASKER, work_thread=True, asked=ASKED
    )
    await adapter.post_rich(CHANNEL, "Agent", content, work)
    assert client.updated == [], "no edit of the line while the turn runs"

    await adapter.settle_work_message(
        CHANNEL,
        "Agent",
        work,
        "Stopped by Person.",
        asked=ASKED,
        ending=WorkEnding("Stopped:", "by Person · 40s", failed=True),
    )
    [settled] = client.updated
    assert settled["blocks"] == [
        _state(
            "Stopped: “how many PRs?” · by Person · 40s",
            status="error",
            link=(LINK, "“how many PRs?”"),
        )
    ]


async def test_an_inline_status_message_leads_with_the_link_back() -> None:
    client = FakeWebClient()
    await _pointing(client).post_rich(
        CHANNEL,
        "Agent",
        TurnActivity(
            [_tool()],
            _turn(),
            recipient_external_id=ASKER,
            has_session=True,
            asked=ASKED,
        ),
        None,
    )
    [posted] = client.posted
    assert posted["blocks"][0] == _pointer(f"↩ <{LINK}|“how many PRs?”>")
    assert any(block["type"] == "plan" for block in posted["blocks"])


async def test_a_turn_without_a_session_does_not_point_back() -> None:
    """Off: the turn is drawn in the asker's own thread, which is the link."""
    client = FakeWebClient()
    await _pointing(client).post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=ASKER, asked=ASKED),
        None,
    )
    [posted] = client.posted
    assert all("↩" not in str(block) for block in posted["blocks"])


async def test_a_question_cannot_forge_markup_in_the_link_back() -> None:
    """Where the link back is text Slack parses (an inline status message),
    the question is escaped so it can neither forge a mention nor end the
    link early."""
    client = FakeWebClient()
    sly = AskedQuestion(ASKED.message_ref, "ping <!channel> & <@U1|x> or a|b")
    await _pointing(client).post_rich(
        CHANNEL,
        "Agent",
        TurnActivity(
            [_tool()], _turn(), recipient_external_id=ASKER, has_session=True, asked=sly
        ),
        None,
    )
    text = client.posted[0]["blocks"][0]["elements"][0]["text"]
    assert text == (f"↩ <{LINK}|“ping &lt;!channel&gt; &amp; &lt;@U1¦x&gt; or a¦b”>")


async def test_without_the_workspace_address_the_question_is_named_unlinked() -> None:
    client = FakeWebClient()
    await _adapter(client).open_work_message(
        CHANNEL, "Agent", "working", ASKER, asked=ASKED
    )
    assert client.posted[0]["blocks"] == [_state("Working on “how many PRs?”")]


async def test_a_question_that_was_only_a_mention_is_still_linked() -> None:
    client = FakeWebClient()
    adapter = _pointing(client)
    await adapter.open_work_message(
        CHANNEL, "Agent", "working", ASKER, asked=AskedQuestion(ASKED.message_ref, "")
    )
    assert client.posted[0]["blocks"] == [
        _state("Working…", link=(LINK, "The message this answers"))
    ]
    [session] = _sessions(client)
    assert session["title"] == "Agent", "no question: the agent's name"


# ── Inline in a thread ───────────────────────────────────────────────────────


async def test_an_inline_turn_in_a_thread_is_an_ordinary_reply_not_a_stream() -> None:
    """A stream would bring a session of Slack's own, and its Stop, beside
    the one the turn opened for its asker."""
    client = FakeWebClient()
    await _adapter(client).post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=ASKER, has_session=True),
        f"{CHANNEL}:3.0",
    )
    assert client.started == []
    [posted] = client.posted
    assert posted["thread_ts"] == "3.0"
    assert any(block["type"] == "plan" for block in posted["blocks"])


@pytest.mark.parametrize(
    ("working", "status"), [(True, "processing"), (False, "active")]
)
async def test_a_stop_not_acted_on_takes_the_session_off_stopping(
    working: bool, status: str
) -> None:
    client = FakeWebClient()
    await _adapter(client).restore_session(CHANNEL, f"{CHANNEL}:3.0", working=working)
    assert _sessions(client) == [
        {"channel_id": CHANNEL, "thread_ts": "3.0", "status": status}
    ]


async def test_removing_an_inline_reply_ends_the_session_on_its_thread() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    assert await adapter.remove_status_message(
        CHANNEL, f"{CHANNEL}:4.0", session_ref=f"{CHANNEL}:3.0"
    )
    [session] = _sessions(client)
    assert session["thread_ts"] == "3.0"
    assert [d["ts"] for d in client.deleted] == ["4.0"]


async def test_a_question_asked_in_a_thread_is_linked_with_its_thread() -> None:
    client = FakeWebClient()
    adapter = _pointing(client)
    asked = AskedQuestion(
        message_ref=f"{CHANNEL}:1700000000.200000",
        text="how many PRs?",
        thread_ref=f"{CHANNEL}:1700000000.100000",
    )
    await adapter.open_work_message(CHANNEL, "Agent", "working", ASKER, asked=asked)
    link = (
        "https://acme.slack.com/archives/C1/p1700000000200000"
        "?thread_ts=1700000000.100000&cid=C1"
    )
    [plan] = client.posted[0]["blocks"]
    assert plan["tasks"][0]["details"]["elements"][0]["elements"][0]["url"] == link


async def test_removing_while_another_turn_has_the_session_leaves_it_working() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    assert await adapter.remove_status_message(
        CHANNEL, f"{CHANNEL}:5.0", session_ref=f"{CHANNEL}:1.0", end_session=False
    )
    assert _sessions(client) == []
    assert [d["ts"] for d in client.deleted] == ["5.0"]


async def test_an_inline_status_message_counts_steps_instead_of_naming_them() -> None:
    """A shell step's title is its whole command, which wraps a status
    message's header across lines; the step is inside the plan."""
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=ASKER, has_session=True),
        None,
    )
    [plan] = [b for b in client.posted[0]["blocks"] if b["type"] == "plan"]
    assert plan["title"].endswith(" · step 1")
    assert "Ran pytest" not in plan["title"]


async def test_a_turn_in_the_askers_thread_keeps_naming_its_step() -> None:
    client = FakeWebClient()
    await _adapter(client).post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=None),
        None,
    )
    [plan] = [b for b in client.posted[0]["blocks"] if b["type"] == "plan"]
    assert plan["title"].endswith("Running: Ran pytest")


@pytest.mark.parametrize(
    ("status", "stopped_by", "items", "expected"),
    [
        ("completed", None, "two", ("Worked on", "1m 12s · 2 steps")),
        ("completed", None, "one", ("Worked on", "1m 12s · 1 step")),
        ("completed", None, "none", ("Worked on", "1m 12s")),
        ("interrupted", "Simon", "one", ("Stopped:", "by Simon · 1m 12s")),
        ("interrupted", None, "one", ("Stopped:", "1m 12s")),
        ("error", None, "one", ("Failed:", "1m 12s")),
    ],
)
def test_a_work_message_names_its_turns_end_in_a_few_words(
    status: str, stopped_by: str | None, items: str, expected: tuple[str, str]
) -> None:
    tools = {
        "none": [],
        "one": [_done_tool()],
        "two": [_done_tool(), _done_tool("i2")],
    }[items]
    assert (
        work_ending(tools, _turn(status), elapsed_seconds=72, stopped_by=stopped_by)
        == expected
    )
