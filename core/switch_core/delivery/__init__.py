"""Working out who a message is for, independently of how it arrived.

Everything here takes a message as data — a sender, a body, a content dict —
rather than a transport event, so the same rules apply whether the message came
off the bus or was read back out of the message log.
"""

from switch_core.delivery.addressing import (
    AddressingDecision,
    AddressingResolver,
    IncomingMessage,
)

__all__ = ["AddressingDecision", "AddressingResolver", "IncomingMessage"]
