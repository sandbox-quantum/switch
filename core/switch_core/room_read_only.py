"""Which rooms take no new posts, and what still gets written to them.

A room is read-only while it is frozen (a workspace admin or the server's
operator contains it during an incident) or archived. Nothing new is said in
it: no agent post, file, card or targeted message, no person's message from
a platform or Switch Console, no command, and no scheduled or template
kickoff. Its history stays readable.

Three kinds of row are still written, because none of them is anyone saying
something to the room's agents:

- membership changes, so an account can still be taken out of a frozen room
  (and its departure recorded);
- Switch's own admin notices (`ADMIN_MARKER`, from the workspace's system
  client), which address nobody and wake no agent: how the room is told it
  was frozen, unfrozen or changed;
- run telemetry (`TELEMETRY`), the measurements an agent reports of work it
  was already doing, which are evidence an incident review wants kept.

The router refuses everything else as it writes the row
(`MessageRouter.store`), whichever path the row came by, so no caller can
skip the check. The callers that can say so sooner (an agent's post, a
platform message, a Console chat) check first and answer with the same
refusal.

The router reads the room's state before it takes the room's lock to number
the row, so a post already being written when a freeze commits can still
land just after it. Every post that starts after the commit is refused.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Literal

from switch_core.clients.admin_messages import ADMIN_MARKER
from switch_core.messages.recorded_types import MEMBERSHIP_EVENT_TYPE, TELEMETRY

if TYPE_CHECKING:
    from switch_core.db.models import Room

# The client type of a workspace's system client (`SystemActor`).
SYSTEM_CLIENT_TYPE = "admin"

ReadOnlyState = Literal["frozen", "archived"]


class RoomReadOnly(PermissionError):
    """A post to a room that is frozen or archived.

    A `PermissionError`, so the agent API answers it with 403 and the MCP
    tools with the message itself. The message tells an agent not to retry:
    the room will not take the post until a person changes it.
    """

    def __init__(self, room_name: str, state: ReadOnlyState) -> None:
        self.room_name = room_name
        self.state = state
        super().__init__(refusal_text(room_name, state))


def refusal_text(room_name: str, state: ReadOnlyState) -> str:
    if state == "frozen":
        return (
            f"Room '{room_name}' is frozen: a workspace admin has made it "
            "read-only, and nothing new can be posted in it. Do not retry. "
            "It takes posts again only once a workspace admin unfreezes it."
        )
    return (
        f"Room '{room_name}' is archived: it is read-only, and nothing new can "
        "be posted in it. Do not retry. Its owner or a workspace admin can "
        "unarchive it."
    )


def read_only_state(room: Room) -> ReadOnlyState | None:
    """Why `room` takes no new posts, or None when it does. Frozen wins: it
    is the state a person has to act on deliberately."""
    if room.frozen_at is not None:
        return "frozen"
    if room.archived_at is not None:
        return "archived"
    return None


def require_postable(room: Room) -> None:
    """Raise `RoomReadOnly` unless `room` takes new posts."""
    state = read_only_state(room)
    if state is not None:
        raise RoomReadOnly(room.name, state)


def needs_sender_check(event_type: str, content: Mapping[str, object]) -> bool:
    """Whether a row of this kind is written to a read-only room only for
    the system client: an admin notice. Membership changes and telemetry go
    in from anyone; everything else from no one."""
    return ADMIN_MARKER in content and event_type == "m.room.message"


def written_regardless(event_type: str) -> bool:
    """Whether a row of this kind is written to a read-only room whoever
    sends it."""
    return event_type == MEMBERSHIP_EVENT_TYPE or event_type in TELEMETRY
