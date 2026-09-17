import json

import pytest

from switch_core.bridges.collaboration.adapter import RequestCard, TurnActivity
from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.renderers.slack import (
    with_session_context,
)

from .test_session_activity import _items, _turn
from .test_session_slack_requests import _adapter, _projection

URL = (
    "switchdash://session?server=https%3A%2F%2Fswitch.example&agent=a&room=r&session=s"
)


def test_waiting_link_is_visible_in_the_compact_status_without_expanding():
    adapter, _ = _adapter()
    message = adapter._render_rich(
        TurnActivity([], _turn("queued"), status_only=True, session_url=URL)
    )
    assert len(message.blocks) == 1
    block = message.blocks[0]
    assert block["type"] == "context"
    assert f"<{URL}|Console app>" in block["elements"][0]["text"]
    assert "details" not in block


async def test_plan_keeps_tool_details_but_fallback_is_compact():
    adapter, _ = _adapter()
    message = adapter._render_rich(
        TurnActivity(await _items(), _turn("running"), session_url=URL)
    )
    assert message.blocks[0]["type"] == "plan"
    assert len(message.blocks[0]["tasks"]) > 1
    assert URL not in json.dumps(message.blocks[0])
    assert len(message.text.splitlines()) == 1


async def test_a_finished_plan_keeps_its_tools_and_stays_off_the_fallback():
    adapter, _ = _adapter()
    message = adapter._render_rich(
        TurnActivity(await _items(), _turn("completed"), session_url=URL)
    )
    assert message.blocks[0]["type"] == "plan"
    assert len(message.blocks[0]["tasks"]) > 1
    assert URL not in json.dumps(message.blocks[0])
    assert "Worked for" not in message.text


async def test_the_clock_and_the_tool_log_move_the_one_message_link_and_all():
    """No thread requester here, so this is the unstreamed fallback path.

    Both things that used to have a message each — the clock and the tool log
    — now move the same one, and the Console link stays on it throughout.
    """
    adapter, client = _adapter()
    activity = SessionTurnActivity(adapter)
    items = await _items()
    kwargs = dict(
        session_id="session",
        channel_id="C1",
        thread_root_id="C1:root",
        asked_on=None,
        agent_name="Agent",
        session_url=URL,
    )
    await activity.publish(items, _turn("running"), elapsed_seconds=1, **kwargs)
    assert len(client.posted) == 1
    await activity.publish(items, _turn("running"), elapsed_seconds=30, **kwargs)
    assert len(client.updated) == 1
    assert client.updated[0]["ts"] == "1.0"
    assert "30s" in client.updated[0]["text"]
    assert URL in json.dumps(client.updated[0]["blocks"])

    # A tool moving without the clock moving is still a change to this message.
    tool_index = next(i for i, item in enumerate(items) if item.kind == "tool-activity")
    items[tool_index] = items[tool_index].model_copy(
        update={"revision": items[tool_index].revision + 1}
    )
    await activity.publish(items, _turn("running"), elapsed_seconds=30, **kwargs)
    assert len(client.updated) == 2
    assert client.updated[1]["ts"] == "1.0"
    assert URL in json.dumps(client.updated[1]["blocks"])


def test_request_keeps_answer_buttons_and_recovery_marker_without_console_link():
    adapter, _ = _adapter()
    request = _projection().open_requests()[0]
    message = adapter._render_rich(
        RequestCard(request, RequestReference("token", "R42"))
    )
    assert message.blocks[0]["block_id"] == "switch-request:token"
    assert any(block["type"] == "actions" for block in message.blocks)
    assert URL not in json.dumps(message.blocks)
    assert URL not in message.text
    assert "R42" in message.text


@pytest.mark.parametrize("recipient", [None, "<!channel>", "U1> <@U2"])
def test_only_valid_explicit_recipients_create_mentions(recipient):
    adapter, _ = _adapter()
    message = adapter._render_rich(
        TurnActivity(
            [],
            _turn("error"),
            error_summary="The request failed.",
            notify_external_id=recipient,
        )
    )
    assert "<@" not in message.text
    assert "<!channel>" not in json.dumps(message.blocks)


async def test_attention_post_mentions_once_and_edit_removes_mention():
    adapter, client = _adapter()
    content = TurnActivity(
        [],
        _turn("error"),
        error_summary="The request failed.",
        notify_external_id="UOWNER",
        session_url=URL,
    )
    ref = await adapter.post_rich("C1", "Agent", content, "C1:root")
    assert client.posted[0]["text"].startswith("<@UOWNER>")
    assert client.posted[0]["thread_ts"] == "root"
    assert not client.posted[0].get("reply_broadcast")
    await adapter.update_rich("C1", "Agent", ref, content, None)
    assert "<@UOWNER>" not in client.updated[0]["text"]


async def test_attention_retries_do_not_create_extra_posts_and_recovery_clears_warning():
    adapter, client = _adapter()
    activity = SessionTurnActivity(adapter)
    kwargs = dict(
        session_id="session",
        channel_id="C1",
        thread_root_id="C1:root",
        asked_on=None,
        agent_name="Agent",
        elapsed_seconds=1,
        session_url=URL,
    )
    for _ in range(3):
        await activity.publish(
            [], _turn("running"), error_summary="The host is offline.", **kwargs
        )
    assert len(client.posted) == 2  # The turn, and one attention reply.
    alert_ref = "2.0"
    await activity.publish([], _turn("running"), **kwargs)
    assert len(client.posted) == 2
    edits = [edit for edit in client.updated if edit["ts"] == alert_ref]
    assert edits[-1]["blocks"][0]["type"] == "task_card"
    assert "Working" in edits[-1]["text"]
    assert "offline" not in edits[-1]["text"]


def test_untrusted_url_scheme_is_not_rendered():
    adapter, _ = _adapter()
    message = adapter._render_rich(TurnActivity([], _turn("running"), status_only=True))
    result = with_session_context(message, session_url="javascript:alert(1)")
    assert "javascript" not in json.dumps(result.blocks)


async def test_a_turn_running_to_completion_posts_once_and_deletes_nothing():
    adapter, client = _adapter()
    activity = SessionTurnActivity(adapter)
    kwargs = dict(
        session_id="session",
        channel_id="C1",
        thread_root_id="C1:root",
        asked_on=None,
        agent_name="Agent",
        session_url=URL,
    )
    await activity.publish([], _turn("running"), elapsed_seconds=1, **kwargs)
    assert len(client.posted) == 1
    assert "Working" in client.posted[0]["text"]
    items = await _items()
    await activity.publish(items, _turn("running"), elapsed_seconds=30, **kwargs)
    await activity.publish(items, _turn("completed"), elapsed_seconds=100, **kwargs)
    assert len(client.posted) == 1
    assert "Worked for 1m 40s" in client.updated[-1]["text"]
    assert not client.deleted
    settled = [edit for edit in client.updated if edit["ts"] == "1.0"][-1]
    assert settled["blocks"][0]["type"] == "plan"
    assert "Worked for 1m 40s" in settled["blocks"][0]["title"]
    assert json.dumps(settled["blocks"]).count(URL) == 1
