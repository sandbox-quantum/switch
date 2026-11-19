"""The subagents a turn started, as every renderer words them.

A subagent arrives as a tool call the host marked (`Item.subagent`), so it has
a call's statuses. It is listed once, in a group of its own, and kept out of
the turn's tool counts: a reader counting calls and agents together would read
three researchers as three tool calls.

A subagent can outlive its turn — one started in the background keeps working
after the agent has replied — so its status follows the subagent, not the
turn: still in progress is "running" whatever the turn says. Only Switch
settling it after its session went away (`ORPHANED_SUBAGENT_TEXT`) reads as not
confirmed finished, because nothing said how it ended.
"""

from collections.abc import Callable

from switch_core.sessions.contract import ORPHANED_SUBAGENT_TEXT, Item

MAX_SHOWN = 5


def is_subagent(item: Item) -> bool:
    return item.kind == "tool-activity" and item.subagent


def is_tool_call(item: Item) -> bool:
    return item.kind == "tool-activity" and not item.subagent


def subagent_state(item: Item) -> str:
    """How a subagent stands, in the words the card shows.

    A stopped or killed subagent ended on purpose, so it reads "stopped"
    rather than as a failure (`declined` is the status the host gives it)."""
    if item.status == "in-progress":
        return "running"
    if item.status == "completed":
        return "done"
    if item.status == "declined":
        return "stopped"
    if item.text == ORPHANED_SUBAGENT_TEXT:
        return "not confirmed finished"
    return "failed"


def subagent_lines(items: list[Item], *, fit: Callable[[str, int], str]) -> list[str]:
    """The group: a heading and up to `MAX_SHOWN` subagents, running first,
    and a count of the rest."""
    children = [item for item in items if is_subagent(item)]
    if not children:
        return []
    children.sort(key=lambda item: item.status != "in-progress")
    lines = [f"Subagents ({len(children)}):"]
    for child in children[:MAX_SHOWN]:
        title = " ".join(child.title.split()) or "Subagent"
        lines.append(f"• {fit(title, 160)} — {subagent_state(child)}")
    if len(children) > MAX_SHOWN:
        lines.append(f"…{len(children) - MAX_SHOWN} more not shown.")
    return lines
