"""Agents a turn started, as every platform draws them.

A call that started another agent is a tool call that names the agent. What
these pin is that a reader can tell one from the other calls, can see which
are still at work and which have finished, and is never told a background
agent was left unfinished when it is still going after its turn.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.session.renderers import (
    MARKDOWN,
    turn_state,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    activity_log,
    turn_status,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity_plan,
)
from switch_core.sessions.contract import Item

from .session_fixtures import _item, _turn


def _identity(text: str) -> str:
    return text


def _call(status: str = "completed", title: str = "Ran `pytest`") -> Item:
    return _item(itemId=f"call-{title}", status=status, title=title)


def _agent(name: str, task: str, status: str = "in-progress") -> Item:
    return _item(itemId=f"agent-{task}", status=status, title=task, subagent=name)


def _cards(items: list[Item], status: str) -> list[dict[str, Any]]:
    tasks = render_activity_plan(items, _turn(status)).blocks[0]["tasks"]
    assert tasks[0]["task_id"] == "switch-session"
    return tasks[1:]


def _status(items: list[Item], status: str, *, tool_detail: bool = True) -> list[str]:
    return turn_status(
        items,
        _turn(status),
        escape=_identity,
        limit=10_000,
        markup=MARKDOWN,
        tool_detail=tool_detail,
    ).splitlines()


# ── Where the turn got to ────────────────────────────────────────────────────


def test_a_running_turn_says_how_many_agents_are_at_work() -> None:
    items = [_agent("Explore", "Find the retry setting"), _agent("Plan", "Draft it")]

    early = turn_state(items, _turn(), tool_detail=True, elapsed_seconds=40)
    later = turn_state(items, _turn(), tool_detail=True, elapsed_seconds=150)

    assert early == "Working… · 2 subagents running"
    assert later == "Working… 2m · 2 subagents running"


def test_an_ended_turn_counts_its_agents_apart_from_its_calls() -> None:
    items = [_call(), _call(title="ls"), _agent("Explore", "Find it", "completed")]

    state = turn_state(items, _turn("completed"), tool_detail=True, elapsed_seconds=60)

    assert state == "Worked for 1m 0s. 2 tool calls and 1 subagent."


def test_an_agent_still_at_work_after_its_turn_is_running_not_unfinished() -> None:
    """A call the host never closed was left unfinished. An agent in the
    background has not been left at all: its host closes it when it ends."""
    items = [_call("in-progress"), _agent("Explore", "Find it")]

    state = turn_state(items, _turn("completed"), tool_detail=True)

    assert state == "Turn complete. 1 step left unfinished. 1 subagent still running."


# ── Slack: a card in the plan ────────────────────────────────────────────────


def test_an_agent_is_a_card_with_its_own_glyph_and_its_name_first() -> None:
    [call, agent] = _cards(
        [_call(title="Ran the tests"), _agent("Explore", "Find the retry setting")],
        "running",
    )

    assert (call["title"], call["icon"]["name"]) == ("Ran the tests", "code")
    assert agent["title"] == "Explore: Find the retry setting"
    assert (agent["icon"]["name"], agent["status"]) == ("bot", "in_progress")


def test_an_agent_titled_with_its_own_name_is_named_once() -> None:
    """Codex titles a call that starts an agent with the tool's name, the same
    string it names the agent by: said twice, it reads as a stutter."""
    [agent] = _cards([_agent("spawn_agent", "spawn_agent")], "running")

    assert agent["title"] == "spawn_agent"


def test_an_agent_still_at_work_keeps_spinning_after_its_turn_ends() -> None:
    [call, agent] = _cards(
        [_call("in-progress"), _agent("Explore", "Find it")], "completed"
    )

    assert call["title"].startswith("Unfinished: ")
    assert agent["title"] == "Explore: Find it"
    assert agent["status"] == "in_progress"


def test_a_finished_agent_settles_as_any_call_does() -> None:
    """Over, with how it went in the title: one stopped agent does not make the
    whole plan a failed plan."""
    [done, stopped] = _cards(
        [
            _agent("Explore", "Find it", "completed"),
            _agent("Plan", "Draft it", "declined"),
        ],
        "completed",
    )

    assert (done["title"], done["status"]) == ("Explore: Find it", "complete")
    assert (stopped["title"], stopped["status"]) == ("⊘ Plan: Draft it", "complete")


# ── Text platforms: the status, and the log ──────────────────────────────────


def test_the_status_lists_each_agent_and_how_it_is_going() -> None:
    items = [
        _call(),
        _agent("Explore", "Find the retry setting"),
        _agent("Plan", "Draft the change", "completed"),
    ]

    lines = _status(items, "running")

    assert lines[0] == "**Working… · 1 subagent running**"
    assert lines[-2:] == [
        "⎇ ▸ Explore: Find the retry setting",
        "⎇ ✓ Plan: Draft the change",
    ]
    assert "Now: Ran `pytest`" not in lines[1:], "a finished call is not the live one"


def test_where_tool_activity_is_not_reported_only_running_agents_are() -> None:
    items = [_agent("Explore", "Find it"), _agent("Plan", "Draft it", "completed")]

    lines = _status(items, "running", tool_detail=False)

    assert lines[1:] == ["⎇ ▸ Explore: Find it"]


def test_the_list_goes_once_the_turn_and_its_agents_are_done() -> None:
    items = [_agent("Explore", "Find it", "completed")]

    assert _status(items, "completed") == ["**Turn complete.**"]


def test_an_agent_still_at_work_after_its_turn_stays_listed() -> None:
    items = [_agent("Explore", "Find it"), _agent("Plan", "Draft it", "completed")]

    lines = _status(items, "completed")

    assert lines == [
        "**Turn complete. 1 subagent still running.**",
        "⎇ ▸ Explore: Find it",
        "⎇ ✓ Plan: Draft it",
    ]


def test_a_long_list_keeps_the_running_agents_and_counts_the_rest() -> None:
    items = [_agent("Explore", "early, still going")] + [
        _agent("Plan", f"step {n}", "completed") for n in range(10)
    ]

    lines = _status(items, "running")

    listed = [line for line in lines if line.startswith("⎇")]
    assert len(listed) == 8
    assert listed[0] == "⎇ ▸ Explore: early, still going"
    assert listed[-1] == "⎇ ✓ Plan: step 9"
    assert lines[-1] == "…3 more subagents not shown."


def test_the_log_marks_an_agent_apart_from_a_call() -> None:
    log = activity_log(
        [_call(), _agent("Explore", "Find it", "completed")],
        _turn("completed"),
        escape=_identity,
        limit=10_000,
        markup=MARKDOWN,
        elapsed_seconds=None,
        heading=False,
    )

    assert log.splitlines() == ["⌗ ✓ Ran `pytest`", "⎇ ✓ Explore: Find it"]
