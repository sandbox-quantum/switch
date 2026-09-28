import json

import pytest

from switch_core.bridges.collaboration.adapter import RequestCard, TurnActivity
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.renderers.slack import (
    with_session_context,
)

from .session_fixtures import _items, _turn, open_request
from .test_session_slack_requests import _adapter

URL = (
    "switchdash://session?server=https%3A%2F%2Fswitch.example&agent=a&room=r&session=s"
)


def test_waiting_link_is_visible_in_the_compact_status_without_expanding():
    """A row under the state, not a plan to open and not a plan's first card.

    This post draws no plan — there is nothing done to put in one — so the link
    has nowhere to hide and nothing to expand: it is read where it is written.
    """
    adapter, _ = _adapter()
    message = adapter._render_rich(
        TurnActivity([], _turn("queued"), status_only=True, session_url=URL)
    )
    assert [block["type"] for block in message.blocks] == ["task_card", "context"]
    note = message.blocks[1]
    assert f"<{URL}|Open in Console app>" in note["elements"][0]["text"]
    assert "details" not in note


async def test_plan_keeps_tool_details_but_fallback_is_compact():
    adapter, _ = _adapter()
    message = adapter._render_rich(
        TurnActivity(await _items(), _turn("running"), session_url=URL)
    )
    assert message.blocks[0]["type"] == "plan"
    assert len(message.blocks[0]["tasks"]) > 1
    assert URL in json.dumps(message.blocks[0]["tasks"][0])
    assert URL not in message.text
    assert len(message.text.splitlines()) == 1


async def test_a_finished_plan_keeps_its_tools_and_stays_off_the_fallback():
    adapter, _ = _adapter()
    message = adapter._render_rich(
        TurnActivity(await _items(), _turn("completed"), session_url=URL)
    )
    assert message.blocks[0]["type"] == "plan"
    assert len(message.blocks[0]["tasks"]) > 1
    assert URL in json.dumps(message.blocks[0]["tasks"][0])
    assert URL not in message.text
    assert "Worked for" not in message.text


def test_request_keeps_answer_buttons_and_recovery_marker_without_console_link():
    adapter, _ = _adapter()
    request = open_request()
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


def test_untrusted_url_scheme_is_not_rendered():
    adapter, _ = _adapter()
    message = adapter._render_rich(TurnActivity([], _turn("running"), status_only=True))
    result = with_session_context(message, session_url="javascript:alert(1)")
    assert "javascript" not in json.dumps(result.blocks)
