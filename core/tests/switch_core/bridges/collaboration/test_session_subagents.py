from __future__ import annotations

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
from switch_core.sessions.contract import ORPHANED_SUBAGENT_TEXT

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


def _tasks(message):
    """Every step's task card in a Slack render, in order, without the
    session's own card."""
    found = []
    for block in message.blocks:
        if block.get("type") == "plan":
            found.extend(block.get("tasks", []))
        elif block.get("type") == "task_card":
            found.append(block)
    return [task for task in found if task.get("task_id") != "switch-session"]


@pytest.mark.parametrize(
    "render", [render_activity, render_activity_plan, render_activity_stream]
)
def test_slack_draws_each_child_once_as_a_bot_card_with_its_outcome(render):
    items = [
        _child(0),
        _child(1, "completed"),
        _child(2, "failed"),
        _child(3, "declined"),
        _item(itemId="tool-1", title="Read file", status="completed"),
    ]
    result = render(items, _turn("running"))
    assert all(
        block.get("type") in ("plan", "task_card", "context", "section", "actions")
        for block in result.blocks
    )
    assert not any(
        block.get("block_id") == "switch-subagents" for block in result.blocks
    )
    tasks = _tasks(result)
    children = [
        task for task in tasks if task["title"].startswith("Subagent: Review changes")
    ]
    assert len(children) == 4
    assert {task["icon"]["name"] for task in children} == {"bot"}
    tools = [task for task in tasks if "Read file" in task["title"]]
    assert [task["icon"]["name"] for task in tools] == ["code"]
    titles = [task["title"] for task in children]
    assert "Subagent: Review changes — running" in titles
    assert "Subagent: Review changes — done" in titles
    assert "Subagent: Review changes — failed" in titles
    assert "Subagent: Review changes — stopped" in titles


def test_slack_keeps_a_child_running_after_its_turn_ends():
    result = render_activity_plan([_child()], _turn("completed"))
    [task] = _tasks(result)
    assert task["status"] == "in_progress"
    assert "Unfinished" not in task["title"]
    assert task["title"] == "Subagent: Review changes — running"


def test_slack_text_fallback_lists_children_once_apart_from_calls():
    result = render_activity(
        [_child(0), _item(itemId="tool-1", title="Read file", status="completed")],
        _turn("running"),
    )
    assert result.text.count("Review changes") == 1
    assert "Subagents (1):" in result.text
    assert "Review changes — running" in result.text


def test_neutral_lists_children_once_and_counts_only_calls():
    text = _text(
        [
            _child(0),
            _child(1),
            _item(itemId="tool-1", title="Read file", status="failed"),
        ]
    )
    assert "Subagents (2):" in text
    assert text.count("Review changes") == 2
    assert "1 failed" in text
    ended = _text(
        [_child(0, "completed"), _item(itemId="tool-1", title="Read file")],
        "completed",
    )
    assert "Subagents (1):" in ended


def test_the_list_is_bounded_and_running_children_come_first():
    items = [_child(i, "completed", f"Finished {i}") for i in range(20)]
    items.append(_child(20, title="Still working"))
    text = _text(items)
    assert "Subagents (21):" in text
    assert "Still working — running" in text
    assert text.count("• ") == 5
    assert "16 more not shown" in text


@pytest.mark.parametrize("state", ["completed", "interrupted", "error"])
def test_a_child_outliving_its_turn_is_running_and_not_left_unfinished(state):
    text = _text([_child()], state)
    assert "Review changes — running" in text
    assert "not confirmed finished" not in text
    assert "left unfinished" not in text


def test_a_child_switch_settled_after_its_session_went_away_is_not_confirmed():
    orphan = _child(status="failed").model_copy(update={"text": ORPHANED_SUBAGENT_TEXT})
    assert "Review changes — not confirmed finished" in _text([orphan], "completed")
    [task] = _tasks(render_activity_plan([orphan], _turn("completed")))
    assert task["title"] == "Subagent: Review changes — not confirmed finished"


def test_a_stopped_child_reads_stopped_not_failed():
    text = _text([_child(status="declined"), _child(1, status="failed")])
    assert "Review changes — stopped" in text
    assert "Review changes — failed" in text


def test_slack_bounds_long_descriptions():
    """A task card's title is plain text, so a mention in it pings nobody;
    what matters is that it stays inside Slack's limit."""
    result = render_activity_plan(
        [_child(title="<!channel> & " + "x" * 10_000)], _turn("running")
    )
    [task] = _tasks(result)
    assert len(task["title"]) <= 200


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
        detail=False,
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
    view = turn_view([turn, child], show_tool_detail=False)
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
    after = turn_view([turn, child], show_tool_detail=False)
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
