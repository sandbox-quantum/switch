"""What the transport tells the rest of Switch about a message once it is sent.

Nearly every participant's message passes through the transport, so it is
where "a message was said in a room" can be observed without each writer
having to remember to report it. The exception is a Switch Console chat
message, which `ChatService.send` writes through the router and reports itself.

The transport knows nothing about who is listening: it hands over the facts it
already holds, after the commit, and carries on.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

from switch_core.observability.catalogue import OBSERVER_FAILURES
from switch_core.observability.metrics import metrics
from switch_core.observability.throttle import WarningThrottle

logger = logging.getLogger(__name__)

# One for the process rather than one per writer: every client has a
# transport, and an observer that breaks breaks for all of them.
_observer_failures = WarningThrottle(60.0)


@dataclass(frozen=True)
class ParticipantMessage:
    """A message a participant chose to say, as the transport saw it written.

    The same population the tenant is metered for: notices Switch posts on a
    participant's behalf are not in it. A multi-file post is reported once.
    """

    tenant_id: str
    room_id: str
    sender_client_id: str
    #: The writer's `ActorRole`: `human`, `agent`, `system` or `bridge`; or
    #: `member`, a person posting from Switch Console, which the chat service
    #: reports rather than a transport.
    sender_role: str
    #: The bridge marked the post as an integration's, not a person's
    #: (`SENDER_IS_APP_MARKER`). Only ever true for a `human` writer.
    sender_is_app: bool
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


def observe_safely(
    observer: ParticipantMessageObserver, message: ParticipantMessage
) -> None:
    """Tell `observer` about `message`, which is already committed.

    Guarded because the row is already committed: an exception leaving the
    send now would tell the sender that a message in the room was not sent,
    and its retry would post it twice. Counted, because a guard that only logs
    leaves nothing to alert on.
    """
    try:
        observer.observe(message)
    except Exception:
        metrics().increment(OBSERVER_FAILURES, {"actor": message.sender_role})
        if (failures := _observer_failures.note()) is not None:
            logger.error(
                "Message observer failed; the message itself was sent. %d "
                "failure(s) since the last error.",
                failures,
                exc_info=True,
            )
