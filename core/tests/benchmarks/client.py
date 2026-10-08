"""A minimal agent protocol client, for the harness's own checks.

This is not the workload. The workload is a real host process, spawned by the
benchmark's Node entrypoint, because the connection model is the subject of the
measurement and a Python stand-in would have a different one. What this is for
is proving the harness itself works — that the server serves, that a stream
delivers, and that the instrumentation points fire — without needing the whole
Node side up first.

It speaks only the part of the protocol those checks need: open the
connection's WebSocket, answer the server's pings, read frames.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import websockets


@dataclass(frozen=True, slots=True)
class StreamFrame:
    event: str
    sequence: int | None
    data: dict[str, Any]


class AgentConnection:
    """One agent connection over its WebSocket, answering the server's pings."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        agent_id: str,
        connection_id: str,
        scope: str,
        delivery_filter: str,
        spawn_capable: bool,
    ) -> None:
        self._base_url = base_url
        self._api_key = api_key
        self._agent_id = agent_id
        self._connection_id = connection_id
        self._scope = scope
        self._filter = delivery_filter
        self._spawn_capable = spawn_capable
        self._frames: asyncio.Queue[StreamFrame] = asyncio.Queue()
        self._cursor = 0
        self._reader: asyncio.Task[None] | None = None
        self._opened = asyncio.Event()
        self._failure: BaseException | None = None

    @property
    def cursor(self) -> int:
        return self._cursor

    async def open(self, timeout: float) -> None:
        self._reader = asyncio.create_task(self._read())
        try:
            await asyncio.wait_for(self._opened.wait(), timeout)
        except TimeoutError:
            await self.close()
            raise
        if self._failure is not None:
            raise self._failure

    async def close(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader
            except asyncio.CancelledError:
                pass

    async def next_frame(self, event: str, timeout: float) -> StreamFrame:
        """The next frame of a given type, discarding pings and others.

        Raises on timeout rather than returning None: every caller here is
        asserting that something was delivered, and a None would turn a
        delivery failure into a different assertion failure two lines later.
        """
        deadline = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise TimeoutError(
                    f"no {event!r} frame on connection {self._connection_id} "
                    f"within {timeout}s"
                )
            frame = await asyncio.wait_for(self._frames.get(), remaining)
            if frame.event == event:
                return frame

    async def _read(self) -> None:
        query = urlencode(
            {
                "connection_id": self._connection_id,
                "scope": self._scope,
                "filter": self._filter,
                "spawn_capable": str(self._spawn_capable).lower(),
            }
        )
        url = (
            self._base_url.replace("http", "ws", 1)
            + f"/agents/{self._agent_id}/connection/ws?{query}"
        )
        try:
            async with websockets.connect(
                url, additional_headers={"Authorization": f"Bearer {self._api_key}"}
            ) as socket:
                async for raw in socket:
                    message = json.loads(raw)
                    event = message.get("event")
                    if event == "refused":
                        self._failure = RuntimeError(
                            f"connection refused: {message.get('data')}"
                        )
                        self._opened.set()
                        return
                    self._opened.set()
                    if event == "ping":
                        # The heartbeat: the answer is what keeps the
                        # connection alive.
                        await socket.send(
                            json.dumps({"type": "pong", "cursor": self._cursor})
                        )
                        continue
                    frame = StreamFrame(
                        event=event,
                        sequence=message.get("id"),
                        data=message.get("data") or {},
                    )
                    if frame.sequence is not None:
                        self._cursor = frame.sequence
                    await self._frames.put(frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surfaced through open()/next_frame
            self._failure = exc
            self._opened.set()
