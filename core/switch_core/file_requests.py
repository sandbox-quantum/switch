"""The owner's file requests to their box, over its controller's own socket.

Your cloud files (the file explorer) lists and reads files on the owner's box.
The bytes never touch the database, the disk or any cache here: a request goes
down the controller's connection socket as a `files.request` frame, and the
controller answers on the same socket with `files.reply` frames, which are
handed straight to the waiting HTTP request.

Only the process holding the controller's socket can do that, and v1 takes it
as given that there is one replica (`hosted_cloud_files`' help text): a request
that lands on another process is answered `503 files_elsewhere` and the client
retries. A process-to-process relay is a later, separate design.

A reply is accepted only for a request that is still open and that was sent
down this same controller's socket (the binding rule). Anything else is
dropped with a log line that names ids only, never a path or any content.

It lives in Core, not in `switch_core.management`, so the gateway's files
route can use it without Core depending on agent management
(`test_import_boundary.py`): the controller socket in management hands
replies in, and the gateway hands requests out. It needs nothing from either.

Frames, as the box controller builds them:

    down  {"event": "files.request", "data": {"id", "op", "path", ...}}
          {"event": "files.more",    "data": {"id"}}     (the next zip chunk)
          {"event": "files.cancel",  "data": {"id"}}
    up    {"type": "files.reply", "id", "seq", "last", "data"?, "size"?,
           "entries"?, "cursor"?, "error"?}
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)

FILES_REQUEST = "files.request"
FILES_MORE = "files.more"
FILES_CANCEL = "files.cancel"
FILES_REPLY = "files.reply"

# One reply is one launcher chunk, 128 KiB raw, end to end.
CHUNK_BYTES = 128 * 1024
MAX_ID_LENGTH = 64
# A listing page holds at most this many entries (the launcher's page).
MAX_ENTRIES = 1000
# Files the controller works on at once; one more is answered `busy`.
MAX_IN_FLIGHT_PER_CONTROLLER = 4
# The launcher's fixed codes (`failed`: understood, but it couldn't do it),
# and the controller's own three (`bad_request`: a request it couldn't parse).
ERRORS = frozenset(
    {
        "outside_root",
        "denied",
        "not_found",
        "too_large",
        "not_regular",
        "failed",
        "bad_request",
        "busy",
        "timeout",
    }
)

Op = Literal["list", "read", "zip"]

# An agent name, as `VALID_AGENT_NAME_RE` allows it.
AGENT_NAME_PATTERN = r"^[a-z0-9][a-z0-9._-]*$"


class _Entry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=255)
    kind: Literal["file", "folder"]
    size: int = Field(ge=0)
    # Milliseconds since the epoch, as the launcher reads it from the file.
    mtime: int = Field(ge=0)
    collapsed: bool | None = None
    label: str | None = Field(default=None, max_length=255)
    # The agent whose working folder this is, by its stable name (top level only).
    # Same rule as Core's agent names (`VALID_AGENT_NAME_RE`), kept here so this
    # module needn't import the agent protocol; a test holds the two together.
    agent: str | None = Field(default=None, max_length=255, pattern=AGENT_NAME_PATTERN)


class FileReply(BaseModel):
    """One `files.reply`, checked to the agreed bounds before anything reads it."""

    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["files.reply"]
    id: str = Field(min_length=1, max_length=MAX_ID_LENGTH)
    seq: int = Field(ge=0)
    last: bool
    # Base64 of at most one chunk: 4 characters for every 3 bytes, rounded up.
    data: str | None = Field(default=None, max_length=4 * ((CHUNK_BYTES + 2) // 3))
    size: int | None = Field(default=None, ge=0)
    entries: list[_Entry] | None = Field(default=None, max_length=MAX_ENTRIES)
    cursor: str | None = Field(default=None, max_length=1024)
    error: str | None = None

    def chunk(self) -> bytes:
        """The reply's bytes, decoded; empty when it carries none."""
        if self.data is None:
            return b""
        return base64.b64decode(self.data, validate=True)


class BadReply(Exception):
    """The controller's reply broke the agreed frame rules."""


@dataclass
class FileRequest:
    """One open request: where its replies may come from, and where they go."""

    id: str
    controller_id: str
    send: Callable[[dict[str, Any]], None]
    replies: asyncio.Queue[FileReply | BadReply] = field(
        default_factory=lambda: asyncio.Queue(maxsize=2)
    )
    next_seq: int = 0
    closed: bool = False

    def more(self) -> None:
        """Ask for the next chunk, one at a time (the pull)."""
        self.send({"event": FILES_MORE, "data": {"id": self.id}})

    async def reply(self, timeout: float) -> FileReply:
        """The next reply, in order, or `TimeoutError` after `timeout`."""
        got = await asyncio.wait_for(self.replies.get(), timeout)
        if isinstance(got, BadReply):
            raise got
        return got


class FileRequests:
    """This process's controller sockets that take file requests, and the
    requests open on them."""

    def __init__(self) -> None:
        self._sockets: dict[str, tuple[object, Callable[[dict[str, Any]], None]]] = {}
        self._open: dict[str, FileRequest] = {}

    # ── Sockets, kept by the connection socket's handler ────────────────────

    def socket_opened(
        self, controller_id: str, handle: object, send: Callable[[dict[str, Any]], None]
    ) -> None:
        """This process now holds `controller_id`'s socket; `send` queues a frame
        on its priority path (`_Outbox.put_answer`)."""
        self._sockets[controller_id] = (handle, send)

    def socket_closed(self, controller_id: str, handle: object) -> None:
        """The socket `handle` went. Its open requests fail at once, rather than
        waiting out their deadline. A newer socket for the same controller is
        left as it is."""
        held = self._sockets.get(controller_id)
        if held is None or held[0] is not handle:
            return
        del self._sockets[controller_id]
        for request in [
            r for r in self._open.values() if r.controller_id == controller_id
        ]:
            self._fail(request, BadReply("socket_closed"))

    def holds(self, controller_id: str) -> bool:
        return controller_id in self._sockets

    # ── Requests, opened by the routes ──────────────────────────────────────

    def open(self, controller_id: str, op: Op, path: str, **args: Any) -> FileRequest:
        """Send a new request down `controller_id`'s socket.

        Raises `LookupError` when this process does not hold that socket, and
        `OverflowError` when the controller already has its full share open.
        """
        held = self._sockets.get(controller_id)
        if held is None:
            raise LookupError(controller_id)
        in_flight = sum(
            1 for r in self._open.values() if r.controller_id == controller_id
        )
        if in_flight >= MAX_IN_FLIGHT_PER_CONTROLLER:
            raise OverflowError(controller_id)
        request = FileRequest(
            id=f"f-{secrets.token_urlsafe(16)}",
            controller_id=controller_id,
            send=held[1],
        )
        self._open[request.id] = request
        data = {"id": request.id, "op": op, "path": path}
        data.update({k: v for k, v in args.items() if v is not None})
        request.send({"event": FILES_REQUEST, "data": data})
        return request

    def close(self, request: FileRequest, *, cancel: bool) -> None:
        """Done with `request`. `cancel` tells the controller to stop working on
        it (the client went, or a deadline passed)."""
        if request.closed:
            return
        request.closed = True
        self._open.pop(request.id, None)
        if cancel and self.holds(request.controller_id):
            request.send({"event": FILES_CANCEL, "data": {"id": request.id}})

    # ── Replies, handed over by the socket's receive loop ──────────────────

    def deliver(self, controller_id: str, message: dict[str, Any]) -> None:
        """A `files.reply` that came up `controller_id`'s socket."""
        raw_id = message.get("id")
        request = self._open.get(raw_id) if isinstance(raw_id, str) else None
        if request is None or request.controller_id != controller_id:
            # The binding rule: only a request open on this socket.
            logger.warning(
                "files_reply_unbound controller=%s id=%s",
                controller_id,
                raw_id
                if isinstance(raw_id, str) and len(raw_id) <= MAX_ID_LENGTH
                else "-",
            )
            return
        try:
            reply = FileReply.model_validate(message)
            if reply.seq != request.next_seq:
                raise BadReply("seq")
            if reply.error is not None and reply.error not in ERRORS:
                raise BadReply("error")
            # The base64 must decode to at most one chunk: its length alone lets
            # through up to two bytes more. The route decodes it again.
            if len(reply.chunk()) > CHUNK_BYTES:
                raise BadReply("size")
        except (ValidationError, BadReply, binascii.Error, ValueError):
            logger.warning(
                "files_reply_bad controller=%s id=%s", controller_id, request.id
            )
            self._fail(request, BadReply("bad_reply"))
            return
        request.next_seq += 1
        try:
            request.replies.put_nowait(reply)
        except asyncio.QueueFull:
            # More than the pull allows: one reply per ask.
            self._fail(request, BadReply("bad_reply"))

    def _fail(self, request: FileRequest, failure: BadReply) -> None:
        while not request.replies.empty():
            request.replies.get_nowait()
        request.replies.put_nowait(failure)
        self._open.pop(request.id, None)


# The one per process: a controller's socket lives in one process's memory.
file_requests = FileRequests()
