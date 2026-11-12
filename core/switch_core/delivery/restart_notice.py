"""The line a room gets when a turn was cut off by its agent's host restarting.

One text and one key for whoever posts it: the agent's controller when the box
comes back (the controller route), and later Core itself for a box that never
does. Both post as the agent under the same per-agent key, so between them the
room gets it once."""

from __future__ import annotations

RESTART_NOTICE_TEXT = (
    "I was restarted while working on this and lost my reply. Please send it again."
)

# Turn ids are the controller's command ids; bounded so a key stays a key.
MAX_TURN_ID_LENGTH = 200


def restart_notice_key(turn_id: str) -> str:
    """The sender's key (`client_txn_id`) the notice for `turn_id` is posted under."""
    return f"restart:{turn_id}"
