"""Synthetic subagent events through real activity renderers and platform adapters."""

from __future__ import annotations

import html
import json
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.session.renderers import MARKDOWN
from switch_core.bridges.collaboration.session.renderers.neutral import (
    turn_status,
    turn_summary,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity_plan,
    render_activity_stream,
    render_activity_text,
)
from switch_core.sessions.contract import Item, Subagent

from .session_fixtures import _item, _turn
from .test_mattermost_sdk_only import _adapter, _posts

_CHILD_OUTPUT = "PRIVATE CHILD TRANSCRIPT"
_PARENT_OUTPUT = "PRIVATE PARENT TRANSCRIPT"


def _child(
    status: str = "in-progress", title: str = "Inspect tests", index: int = 0
) -> Item:
    return _item(
        itemId=f"child-{index}",
        kind="tool-activity",
        status=status,
        title=title,
        text=_CHILD_OUTPUT,
    ).model_copy(update={"subagent": Subagent(child_id=f"native-{index}")})


def _tasks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        task
        for block in blocks
        if block["type"] == "plan"
        for task in block["tasks"][1:]
    ]


@pytest.mark.parametrize("renderer", [render_activity_plan, render_activity_stream])
@pytest.mark.parametrize(
    ("status", "label", "card_status"),
    [
        ("in-progress", "running", "in_progress"),
        ("completed", "completed", "complete"),
        ("failed", "failed", "error"),
        ("declined", "declined", "error"),
    ],
)
def test_slack_child_lifecycle_survives_parent_completion_without_child_transcript(
    renderer: Any, status: str, label: str, card_status: str
) -> None:
    rendered = renderer([_child(status)], _turn("completed"))
    task = _tasks(rendered.blocks)[0]
    assert f"Subagent {label}: Inspect tests" in task["title"]
    assert task["status"] == card_status
    assert "Unfinished" not in task["title"]
    assert "details" not in task
    assert _CHILD_OUTPUT not in json.dumps(rendered.blocks)
    if status == "in-progress":
        assert "1 subagent still running" in json.dumps(rendered.blocks)
        assert "left unfinished" not in json.dumps(rendered.blocks)


@pytest.mark.parametrize("renderer", [render_activity_plan, render_activity_stream])
def test_slack_keeps_an_old_live_child_visible_after_160_ordinary_calls(
    renderer: Any,
) -> None:
    items = [_child()] + [
        _item(
            itemId=f"tool-{i}",
            kind="tool-activity",
            status="completed",
            title=f"Tool {i}",
        )
        for i in range(160)
    ]
    rendered = renderer(items, _turn("completed"))
    task = _tasks(rendered.blocks)[-1]
    assert task["title"] == "Subagent running: Inspect tests"
    assert task["status"] == "in_progress"
    assert (
        "no longer shown" if renderer is render_activity_stream else "not shown"
    ) in json.dumps(rendered.blocks)


def test_neutral_status_prioritizes_four_children_and_counts_omissions_without_tool_detail() -> (
    None
):
    items = [_child("completed", f"done {i}", i) for i in range(5)]
    items.append(_child("in-progress", "live & <child>", 5))
    items.append(_item(kind="assistant-message", text=_PARENT_OUTPUT))
    text = turn_status(
        items,
        _turn("completed"),
        escape=html.escape,
        limit=2000,
        markup=MARKDOWN,
        tool_detail=False,
    )
    lines = text.splitlines()
    assert lines[1] == "Subagent running: live &amp; &lt;child&gt;"
    assert sum(line.startswith("Subagent ") for line in lines) == 4
    assert lines[-1] == "…2 more subagents not shown."
    assert _PARENT_OUTPUT not in text
    assert _CHILD_OUTPUT not in text
    assert "<child>" not in text


def test_slack_plain_text_fallback_never_repeats_child_output() -> None:
    text = render_activity_text([_child()], _turn("completed"))
    assert "Subagent running: Inspect tests" in text
    assert _CHILD_OUTPUT not in text
    assert "unfinished" not in text


@pytest.mark.parametrize("limit", [40, 400, 2000])
def test_neutral_text_fallback_preserves_parent_answer_but_excludes_child_output(
    limit: int,
) -> None:
    items = [
        _child(title="&<" * 1000),
        _item(kind="assistant-message", text=_PARENT_OUTPUT),
    ]
    text = turn_summary(items, _turn("completed"), escape=html.escape, limit=limit)
    assert len(text) <= limit
    assert not text.startswith("**")
    assert _CHILD_OUTPUT not in text
    assert "&<" not in text
    assert all(len(line) <= 200 for line in text.splitlines()[1:])
    if limit >= 400:
        assert text.startswith(f"{_PARENT_OUTPUT}\n")
        assert "Subagent running:" in text


def test_neutral_fallback_keeps_only_the_latest_parent_answer_with_child_status() -> (
    None
):
    items = [
        _item(itemId="earlier", kind="assistant-message", text="Earlier answer"),
        _child("completed"),
        _item(
            itemId="answer",
            kind="assistant-message",
            text="Run the verification command.",
        ),
        _item(
            itemId="human",
            kind="user-message",
            text="Do not attribute this to the agent",
        ),
    ]
    text = turn_summary(
        items, _turn("completed"), escape=lambda value: value, limit=2000
    )
    assert text.splitlines() == [
        "Run the verification command.",
        "Turn complete.",
        "Subagent completed: Inspect tests",
    ]
    assert _CHILD_OUTPUT not in text


@pytest.mark.parametrize("limit", [0, 1, 14, 40, 80, 400, 2000])
def test_neutral_fallback_bounds_escaped_parent_and_many_children(limit: int) -> None:
    items = [
        _child(title=f"Child {index} <&> " * 100, index=index) for index in range(6)
    ]
    items.append(_item(kind="assistant-message", text="Parent answer <&> " * 500))
    text = turn_summary(items, _turn("completed"), escape=html.escape, limit=limit)
    assert len(text) <= limit
    assert _CHILD_OUTPUT not in text
    assert "<&>" not in text
    assert "**" not in text
    if limit >= 400:
        assert text.startswith("Parent answer &lt;&amp;&gt;")
        assert "6 subagents still running." in text
        assert "Subagent running:" in text
    # Cuts must not leave fragments of escaped entities on either kind of line.
    unescaped = text.replace("&lt;", "").replace("&amp;", "").replace("&gt;", "")
    assert "&" not in unescaped


async def test_mattermost_updates_the_original_post_when_a_background_child_completes() -> (
    None
):
    adapter = _adapter("worker")
    child = _child()
    ref = await adapter.post_rich(
        "chan-1", "worker", TurnActivity([child], _turn("completed")), "root-1"
    )
    posts = _posts(adapter)
    assert "Subagent running: Inspect tests" in posts.created[0]["message"]
    assert _CHILD_OUTPUT not in posts.created[0]["message"]
    completed = child.model_copy(update={"status": "completed", "revision": 2})
    await adapter.update_rich(
        "chan-1", "worker", ref, TurnActivity([completed], _turn("completed")), "root-1"
    )
    assert len(posts.created) == 1
    assert len(posts.patched) == 1
    post_id, body = posts.patched[0]
    assert post_id == "post-1"
    assert "Subagent completed: Inspect tests" in body["message"]
    assert "still running" not in body["message"]
    assert _CHILD_OUTPUT not in body["message"]
    assert posts.stored[post_id]["message"] == body["message"]
