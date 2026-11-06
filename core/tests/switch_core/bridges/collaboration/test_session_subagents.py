from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from switch_core.bridges.collaboration.session.renderers import MARKDOWN
from switch_core.bridges.collaboration.session.renderers.neutral import (
    activity_log,
    turn_status,
    turn_summary,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity,
    render_activity_plan,
    render_activity_stream,
)
from switch_core.db.models import AgentSessionActivityItem
from switch_core.session_activity.bridge_turns import status_state, turn_view

from .session_fixtures import _item, _turn


def _child(index: int = 0, status: str = "in-progress", title: str = "Review changes"):
    return _item(
        itemId=f"child-{index}",
        kind="tool-activity",
        subagent=True,
        status=status,
        title=title,
    )


def _text(items, state="running", limit=4000):
    return turn_status(
        items,
        _turn(state),
        escape=lambda text: text,
        limit=limit,
        markup=MARKDOWN,
        tool_detail=True,
    )


@pytest.mark.parametrize(
    "render", [render_activity, render_activity_plan, render_activity_stream]
)
def test_slack_lists_children_with_independent_outcomes_and_stable_block(render):
    items = [_child(0), _child(1, "completed"), _child(2, "failed")]
    result = render(items, _turn("running"))
    blocks = [
        block for block in result.blocks if block.get("block_id") == "switch-subagents"
    ]
    assert len(blocks) == 1
    body = blocks[0]["text"]["text"]
    assert "Subagents (3):" in body
    assert "Review changes — running" in body
    assert "Review changes — done" in body
    assert "Review changes — failed" in body
    finished = render(
        [child.model_copy(update={"status": "completed"}) for child in items],
        _turn("completed"),
    )
    section = next(
        block
        for block in finished.blocks
        if block.get("block_id") == "switch-subagents"
    )
    assert "running" not in section["text"]["text"]
    assert section["text"]["text"].count("— done") == 3


def test_slack_keeps_running_children_visible_after_the_tool_log_rolls_over():
    items = [
        _child(title="Still reviewing"),
        *[_item(itemId=f"tool-{i}", title="Read file") for i in range(160)],
    ]
    drawn = render_activity_stream(items, _turn("running"))
    section = next(
        block for block in drawn.blocks if block.get("block_id") == "switch-subagents"
    )
    assert "Still reviewing — running" in section["text"]["text"]


def test_both_renderers_bound_the_list_and_prioritize_running_children():
    items = [_child(i, "completed", f"Finished {i}") for i in range(20)]
    items.append(_child(20, title="Still working"))
    neutral = _text(items)
    slack = render_activity_stream(items, _turn("running"))
    section = next(
        block for block in slack.blocks if block.get("block_id") == "switch-subagents"
    )
    for text in [neutral, section["text"]["text"]]:
        assert "Subagents (21):" in text
        assert "Still working — running" in text
        assert text.count("• ") == 5
        assert "16 more not shown" in text


def test_ended_parent_does_not_claim_an_unfinished_child_succeeded_or_is_running():
    for state in ["completed", "interrupted", "error"]:
        assert "not confirmed finished" in _text([_child()], state)
        assert "— running" not in _text([_child()], state)
        assert "1 step left unfinished" in _text([_child()], state)


def test_slack_escapes_mentions_and_bounds_long_descriptions():
    result = render_activity_plan(
        [_child(title="<!channel> & " + "x" * 10_000)], _turn("running")
    )
    block = next(
        block for block in result.blocks if block.get("block_id") == "switch-subagents"
    )
    assert "<!channel>" not in json.dumps(block)
    assert len(block["text"]["text"]) < 1000


def test_text_fallback_and_activity_log_identify_subagents():
    assert "Subagents (1)" in turn_summary(
        [_child()], _turn("running"), escape=lambda text: text, limit=4000
    )
    assert "Subagent" in activity_log(
        [_child()],
        _turn("running"),
        escape=lambda text: text,
        limit=4000,
        markup=MARKDOWN,
        elapsed_seconds=None,
        heading=True,
    )
    assert len(_text([_child(title="x" * 1000)], limit=100)) <= 100


def test_persisted_child_revision_changes_the_platform_redraw_key():
    now = datetime(2026, 10, 1, tzinfo=UTC)
    base = dict(
        agent_id="agent",
        session_id="session",
        turn_id="turn",
        revision=1,
        title="Review changes",
        text="",
        command_id=None,
        room_id=None,
        thread_id=None,
        message_id=None,
        occurred_at=now,
        created_at=now,
        updated_at=now,
    )
    turn = AgentSessionActivityItem(
        **base, item_id="turn", kind="turn", status="running"
    )
    child = AgentSessionActivityItem(
        **base,
        item_id="child",
        kind="tool-activity",
        subagent=True,
        status="in-progress",
    )
    view = turn_view([turn, child])
    assert view is not None
    assert view.items[0].kind == "tool-activity"
    assert view.items[0].subagent is True
    before = status_state(
        view,
        elapsed_seconds=None,
        interrupt_turn_id=None,
        clock_redraws=False,
        closed_by_platform=False,
    )
    child.revision = 2
    child.status = "completed"
    after = turn_view([turn, child])
    assert after is not None
    assert (
        status_state(
            after,
            elapsed_seconds=None,
            interrupt_turn_id=None,
            clock_redraws=False,
            closed_by_platform=False,
        )
        != before
    )
    assert "— done" in _text(after.items)
