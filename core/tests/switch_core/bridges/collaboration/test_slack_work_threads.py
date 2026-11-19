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
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.own_app_setup import SLACK_BOT_EVENTS
from switch_core.bridges.collaboration.session.renderers import SESSION_STOP_ACTION
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
    SlackUser,
)
from switch_core.sessions.contract import Item, TurnUpsert

from .slack_fakes import FakeResponse, FakeWebClient

CHANNEL = "C1"
ASKER = "U0ASKER"


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
    assert posted["blocks"] == [
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": "Working…"}],
        }
    ]
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


async def test_settling_edits_in_the_last_line_renames_and_ends_the_session() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    line = "Worked for 30s. 2 tool calls."
    await adapter.settle_work_message(CHANNEL, "Agent", f"{CHANNEL}:5.0", line)
    [edit] = client.updated
    assert (edit["channel"], edit["ts"]) == (CHANNEL, "5.0")
    assert edit["text"] == line
    assert edit["blocks"] == [
        {"type": "context", "elements": [{"type": "mrkdwn", "text": line}]}
    ]
    calls = [
        (method, kwargs["json"])
        for method, kwargs in client.api_calls
        if method.startswith("agents.sessions.")
    ]
    assert calls == [
        (
            "agents.sessions.rename",
            {
                "channel_id": CHANNEL,
                "thread_ts": "5.0",
                "title": "Agent · Worked for 30s. 2 tool calls.",
            },
        ),
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


async def test_how_far_a_turn_has_got_is_edited_into_its_work_message() -> None:
    """A count of steps, never the step's own title, which for a shell step is
    the command it runs."""
    client = FakeWebClient()
    adapter = _adapter(client)
    work = await adapter.open_work_message(CHANNEL, "Agent", "working", ASKER)
    ref = await adapter.post_rich(CHANNEL, "Agent", _work([_tool()]), work)
    assert _notes(client, work) == ["Working… · step 1"]
    note = [e for e in client.updated if e["text"].startswith("Working")][0]
    assert note["blocks"] == [
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": "Working… · step 1"}],
        }
    ]

    # Nothing changed in the line: no edit, whatever else is redrawn.
    await adapter.update_rich(CHANNEL, "Agent", ref, _work([_done_tool()]), work)
    assert len(_notes(client, work)) == 1

    await adapter.update_rich(
        CHANNEL, "Agent", ref, _work([_done_tool(), _done_tool("i2")]), work
    )
    assert _notes(client, work)[-1] == "Working… · step 2"


async def test_after_a_restart_the_line_is_written_again() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.post_rich(CHANNEL, "Agent", _work([_tool()]), f"{CHANNEL}:7.0")
    assert _notes(client, f"{CHANNEL}:7.0") == ["Working… · step 1"]


async def test_an_ended_turn_leaves_the_line_to_its_ending() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    work = await adapter.open_work_message(CHANNEL, "Agent", "working", ASKER)
    await adapter.post_rich(CHANNEL, "Agent", _work([_done_tool()], "completed"), work)
    assert _notes(client, work) == []


async def test_a_turn_outside_a_work_thread_gets_no_line() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=ASKER),
        f"{CHANNEL}:9.0",
    )
    assert client.updated == []


async def test_the_line_waits_out_slacks_edit_limit() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    work = await adapter.open_work_message(CHANNEL, "Agent", "working", ASKER)
    adapter._rich_update_cooldown.start(30)
    await adapter.post_rich(CHANNEL, "Agent", _work([_tool()]), work)
    assert _notes(client, work) == []


async def test_a_refused_line_edit_starts_the_cooldown_and_spares_the_turn() -> None:
    client = FakeWebClient()
    client.update_error = FakeResponse(
        {"error": "ratelimited"}, headers={"Retry-After": "5"}
    )
    adapter = _adapter(client)
    work = await adapter.open_work_message(CHANNEL, "Agent", "working", ASKER)
    await adapter.post_rich(CHANNEL, "Agent", _work([_tool()]), work)
    assert client.started, "the turn is still drawn"
    assert adapter._rich_update_cooldown.remaining() > 0


# ── The ending ───────────────────────────────────────────────────────────────


async def test_the_plan_goes_under_the_answer_rebuilt_from_its_text() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    ok = await adapter.attach_activity(
        CHANNEL,
        f"{CHANNEL}:8.0",
        "Counted to 30.\nIt's *15:59*.",
        _work([_done_tool()], "completed"),
    )
    assert ok
    [edit] = client.updated
    assert (edit["ts"], edit["text"]) == ("8.0", "Counted to 30.\nIt's *15:59*.")
    section, plan = edit["blocks"]
    assert section == {
        "type": "section",
        "text": {"type": "mrkdwn", "text": "Counted to 30.\nIt's *15:59*."},
    }
    assert plan["type"] == "plan"
    assert client.api_calls == [], "the answer is not read back from Slack"


async def test_a_long_answer_is_rebuilt_across_sections() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    text = "\n".join(["x" * 1000] * 7)
    assert await adapter.attach_activity(
        CHANNEL, f"{CHANNEL}:8.0", text, _work([_done_tool()], "completed")
    )
    blocks = client.updated[0]["blocks"]
    sections = [b["text"]["text"] for b in blocks if b["type"] == "section"]
    assert len(sections) == 4, "two 1,000-character lines and a break fit in one"
    assert all(len(section) <= 3000 for section in sections)
    assert "\n".join(sections) == text
    assert blocks[-1]["type"] == "plan"


async def test_an_attach_slack_refuses_is_reported() -> None:
    client = FakeWebClient()
    client.update_error = "cant_update_message"
    adapter = _adapter(client)
    assert not await adapter.attach_activity(
        CHANNEL, f"{CHANNEL}:8.0", "hi", _work([_done_tool()], "completed")
    )


async def test_an_attach_slack_rate_limits_is_tried_again() -> None:
    client = FakeWebClient()
    client.update_error = FakeResponse(
        {"error": "ratelimited"}, headers={"Retry-After": "5"}
    )
    adapter = _adapter(client)
    with pytest.raises(RichContentThrottled):
        await adapter.attach_activity(
            CHANNEL, f"{CHANNEL}:8.0", "hi", _work([_done_tool()], "completed")
        )


async def test_removing_a_work_thread_takes_the_replies_first() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    ok = await adapter.remove_work_thread(
        CHANNEL, f"{CHANNEL}:5.0", [f"{CHANNEL}:6.0", f"{CHANNEL}:7.0"]
    )
    assert ok
    assert [d["ts"] for d in client.deleted] == ["6.0", "7.0", "5.0"]
    [session] = _sessions(client)
    assert session == {"channel_id": CHANNEL, "thread_ts": "5.0", "status": "active"}


async def test_a_refused_delete_stops_before_the_work_message() -> None:
    client = FakeWebClient()
    refusals = iter(["message_not_found", "cant_delete_message"])

    async def chat_delete(**kwargs: Any) -> FakeResponse:
        client.deleted.append(kwargs)
        raise SlackApiError("no", FakeResponse({"error": next(refusals)}))

    client.chat_delete = chat_delete  # type: ignore[method-assign]
    adapter = _adapter(client)
    ok = await adapter.remove_work_thread(
        CHANNEL, f"{CHANNEL}:5.0", [f"{CHANNEL}:6.0", f"{CHANNEL}:7.0"]
    )
    assert not ok
    assert [d["ts"] for d in client.deleted] == ["6.0", "7.0"]


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


async def test_room_tools_are_not_counted_as_steps() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    work = await adapter.open_work_message(CHANNEL, "Agent", "working", ASKER)
    post = _tool().model_copy(
        update={"item_id": "p1", "title": "mcp__switch__post_message"}
    )
    ref = await adapter.post_rich(CHANNEL, "Agent", _work([post]), work)
    assert _notes(client, work) == [], "talking in the room is not a step"
    await adapter.update_rich(CHANNEL, "Agent", ref, _work([post, _tool()]), work)
    assert _notes(client, work) == ["Working… · step 1"]


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


async def test_closing_a_session_renames_it_and_sets_it_active() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.close_session(CHANNEL, "Agent", f"{CHANNEL}:4.0", "Turn interrupted.")
    assert [method for method, _ in client.api_calls] == [
        "agents.sessions.rename",
        "agents.sessions.setStatus",
    ]
    assert client.api_calls[0][1]["json"]["title"] == "Agent · Turn interrupted."
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
