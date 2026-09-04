"""Message transport for Switch.

`MessageTransport` (in `port`) is the contract; implementations live beside it.
Only modules inside this package may import a transport library — everything
else talks to the port and the neutral types in `types`.
"""

from switch_core.transport.port import (
    Handler,
    MessageTransport,
    TransportHandlers,
)
from switch_core.transport.types import (
    DownloadResult,
    HistoryPage,
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
    MessageFormat,
    NotConnectedError,
    RoomRef,
    SeekDirection,
    SendResult,
    TransportError,
    UploadResult,
)

__all__ = [
    "DownloadResult",
    "Handler",
    "HistoryPage",
    "InboundCustomEvent",
    "InboundEvent",
    "InboundMedia",
    "InboundMembership",
    "InboundMessage",
    "MessageFormat",
    "MessageTransport",
    "NotConnectedError",
    "RoomRef",
    "SeekDirection",
    "SendResult",
    "TransportError",
    "TransportHandlers",
    "UploadResult",
]
