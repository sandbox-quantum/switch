"""What the transport tells the rest of Switch about a message once it is sent.

The transport is the one place every participant's message passes through, so
it is where "a message was said in a room" can be observed without each writer
having to remember to report it. It knows nothing about who is listening: it
hands over the facts it already holds, after the commit, and carries on.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class ParticipantMessage:
    """A message a participant chose to say, as the transport saw it written.

    The same population the tenant is metered for: notices Switch posts on a
    participant's behalf are not in it. A multi-file post is reported once.
    """

    tenant_id: str
    room_id: str
    sender_client_id: str
    #: The writer's `ActorRole`: `human`, `agent`, `system` or `bridge`.
    sender_role: str
    has_attachment: bool
    in_thread: bool


class ParticipantMessageObserver(Protocol):
    """Told about every participant message after it is committed.

    Called on the sender's path, so it must return at once and never raise:
    the message is already sent, and a failure here would tell the sender
    otherwise.
    """

    def observe(self, message: ParticipantMessage) -> None: ...


class IgnoreParticipantMessages:
    """An observer that does nothing, for transports built where no one is
    listening — tooling and tests."""

    def observe(self, message: ParticipantMessage) -> None:
        return None
