"""Per-platform renderings of a projected session.

A renderer reads contract types and produces one platform's artefact. It makes
no access decisions and no routing ones: by the time something reaches a
renderer, whether a room sees it and which room that is have both been settled.
"""

from __future__ import annotations

from dataclasses import dataclass

# Every platform that puts controls on a message gives each one an id it hands
# straight back when it is operated. The prefix marks the ones this layer wrote,
# so a control belonging to something else in the same channel is left alone.
ANSWER_ACTION = "switch:request-answer"


def parse_answer_action(action_id: str) -> str | None:
    """The option a control stands for, or None if it is not one of ours.

    An option id is all the id carries. Which request, and against which
    revision, comes from the record the token resolves to — not from here, and
    not from anything else the platform sent back.
    """
    prefix = f"{ANSWER_ACTION}:"
    if not action_id.startswith(prefix):
        return None
    option_id = action_id[len(prefix) :]
    return option_id or None


@dataclass(frozen=True)
class RequestReference:
    """How a platform refers back to a request, without carrying the session.

    `token` goes in a button's callback payload and `handle` is the short thing
    a person types when they answer in words. Both are opaque and resolved
    against a record the server keeps: a payload that leaks names nothing, and
    it is never an agent credential. Callers mint them — this layer only
    renders and reads them back.
    """

    token: str
    handle: str
