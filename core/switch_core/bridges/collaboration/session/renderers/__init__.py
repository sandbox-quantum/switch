"""Per-platform renderings of a projected session.

A renderer reads contract types and produces one platform's artefact. It makes
no access decisions: by the time something reaches a renderer the audience gate
has already said the room may see it.
"""

from __future__ import annotations

from dataclasses import dataclass


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
