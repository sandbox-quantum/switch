"""Whether a client has to write down what it sent.

Recording exists because the bus was the delivery and the table was a copy.
When the table *is* the delivery there is nothing to copy, and a client that
recorded anyway would write every message twice.

So which recorder a client gets is chosen with its transport, by the same
factory, and the pairing is the invariant: a transport that stores what it
carries takes `NoRecording`, and one that does not takes `MessageRecorder`.
Getting the pair wrong is visible immediately — duplicate rows one way, a
silent log the other — which is the argument for making it one decision in one
place rather than a flag each side reads.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from switch_core.transport import InboundMembership, SendResult


@runtime_checkable
class MessageRecording(Protocol):
    """Writes the message log, or knows that something else already did."""

    async def record(
        self,
        *,
        transport_room_id: str,
        result: SendResult,
        sender_matrix_id: str,
        sender_client_id: str,
        sender_name: str,
    ) -> None: ...

    async def record_join(
        self,
        *,
        transport_room_id: str,
        event: InboundMembership,
        client_id: str,
        member_name: str,
    ) -> None: ...


class NoRecording:
    """For a transport whose own write is the record.

    Not a disabled feature: the rows still exist, and are still exactly one per
    event. They are written by the transport, in the same transaction that
    accepted the send, which is stronger than what this replaces — the
    recorder ran after delivery and could leave a gap.
    """

    async def record(
        self,
        *,
        transport_room_id: str,
        result: SendResult,
        sender_matrix_id: str,
        sender_client_id: str,
        sender_name: str,
    ) -> None:
        return None

    async def record_join(
        self,
        *,
        transport_room_id: str,
        event: InboundMembership,
        client_id: str,
        member_name: str,
    ) -> None:
        return None
