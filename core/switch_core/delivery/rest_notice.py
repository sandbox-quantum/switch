"""The line a room gets when an agent's background processes were stopped as
it went to rest.

An agent whose sessions have all been parked for a while has its host stopped
until its next message, and anything it left running (a preview server, say)
is stopped with it. The agent's controller has Switch tell the room once, at
the start of the agent's next reply, so the person knows to start it again.
The text is Switch's, with a count only: never a process name or command."""

from __future__ import annotations

# The most processes a notice names; a count past it is refused, not trusted.
MAX_STOPPED = 1000

# Keys are the controller's own ids for the wake; bounded so a key stays a key.
MAX_REST_KEY_LENGTH = 200


def rest_notice_text(stopped: int) -> str:
    """The agreed wording, for one or several."""
    if stopped == 1:
        return (
            "When I went to rest, I stopped 1 background process I'd left running. "
            "Start it again if you still need it."
        )
    return (
        f"When I went to rest, I stopped {stopped} background processes I'd left "
        "running. Start them again if you still need them."
    )


def rest_notice_key(key: str) -> str:
    """The sender's key (`client_txn_id`) the notice for wake `key` is posted under."""
    return f"rest:{key}"
