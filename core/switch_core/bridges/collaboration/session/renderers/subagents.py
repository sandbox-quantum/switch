"""Bounded child progress shared by channel cards and text fallbacks."""

from collections.abc import Callable

from switch_core.sessions.contract import TURN_ENDED, Item, TurnUpsert

MAX_SHOWN = 5


def subagent_lines(
    items: list[Item],
    turn: TurnUpsert,
    *,
    fit: Callable[[str, int], str],
) -> list[str]:
    children = [
        item for item in items if item.kind == "tool-activity" and item.subagent
    ]
    if not children:
        return []
    children.sort(key=lambda item: item.status != "in-progress")
    lines = [f"Subagents ({len(children)}):"]
    for child in children[:MAX_SHOWN]:
        status = {
            "in-progress": "not confirmed finished"
            if turn.status in TURN_ENDED
            else "running",
            "completed": "done",
            "failed": "failed",
            "declined": "declined",
        }[child.status]
        title = " ".join(child.title.split()) or "Subagent"
        lines.append(f"• {fit(title, 160)} — {status}")
    if len(children) > MAX_SHOWN:
        lines.append(f"…{len(children) - MAX_SHOWN} more not shown.")
    return lines
