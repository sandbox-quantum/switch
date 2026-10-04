"""What liveness means for anything that beats: the cadence, the TTL, and the
ways a beating thing ends.

Shared by agent connections (`agent_connections.py`) and controller connections
(`controller_presence.py`), so that "live" is one rule wherever it is asked.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# Clients tick every HEARTBEAT_INTERVAL_SECONDS; a connection is declared dead
# once nothing has arrived for HEARTBEAT_TTL_SECONDS. One mechanism replaces
# /connection/renew, /watch/heartbeat and /leases/renew.
HEARTBEAT_INTERVAL_SECONDS = 2.0
HEARTBEAT_TTL_SECONDS = 6.0

CloseCode = Literal["taken_over", "heartbeat_lapsed", "closed", "launch_superseded"]


@dataclass(frozen=True, slots=True)
class Closure:
    """Why a connection ended, in a form both sides can act on.

    The prose alone was not enough. Three producers phrased the same three
    endings six different ways, and the clients that had to tell a recoverable
    ending from a fatal one did it by comparing those strings — so one of them
    matched the short heartbeat-lapse wording, missed the long one, and killed
    a watcher that only needed to reconnect. `code` is the part that is
    promised and compared; `message` is for a human reading a log and may be
    reworded freely.

    `room_id` names the room the ending was about, and is null when it was not
    about one. A client that loses a connection over a room it declared cannot
    otherwise tell which room, and so cannot stop declaring it.
    """

    code: CloseCode
    message: str
    room_id: str | None


#: The connection's client stopped ticking. Recoverable: reopen and resume.
HEARTBEAT_LAPSED = Closure(
    code="heartbeat_lapsed",
    message="heartbeat lapsed; reopen the stream and resume from your cursor",
    room_id=None,
)

#: Another stream attached to this id. Terminal for the displaced client:
#: reopening is itself a takeover, so retrying is how two clients trade the
#: connection back and forth forever.
TAKEN_OVER = Closure(
    code="taken_over",
    message="another stream attached to this connection and took it over",
    room_id=None,
)
