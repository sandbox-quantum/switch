"""A minimal agent protocol client, for the harness's own checks.

This is not the workload. The workload is a real host process, spawned by the
benchmark's Node entrypoint, because the connection model is the subject of the
measurement and a Python stand-in would have a different one. What this is for
is proving the harness itself works — that the server serves, that a stream
delivers, and that the instrumentation points fire — without needing the whole
Node side up first.

It speaks only the part of the protocol those checks need: open the stream,
heartbeat, read frames.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

import httpx

from switch_core.bridges.agent.protocol.connections import HEARTBEAT_INTERVAL_SECONDS


@dataclass(frozen=True, slots=True)
class StreamFrame:
    event: str
    sequence: int | None
    data: dict[str, Any]


class AgentConnection:
    """One SSE connection, with the heartbeat the server requires to keep it."""

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
        self._client: httpx.AsyncClient | None = None
        self._reader: asyncio.Task[None] | None = None
        self._beater: asyncio.Task[None] | None = None
        self._opened = asyncio.Event()
        self._failure: BaseException | None = None

    @property
    def cursor(self) -> int:
        return self._cursor

    async def open(self, timeout: float) -> None:
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={"Authorization": f"Bearer {self._api_key}"},
            timeout=httpx.Timeout(None),
        )
        self._reader = asyncio.create_task(self._read())
        try:
            await asyncio.wait_for(self._opened.wait(), timeout)
        except TimeoutError:
            await self.close()
            raise
        if self._failure is not None:
            raise self._failure
        self._beater = asyncio.create_task(self._beat())

    async def close(self) -> None:
        for task in (self._beater, self._reader):
            if task is not None:
                task.cancel()
        for task in (self._beater, self._reader):
            if task is not None:
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        if self._client is not None:
            await self._client.aclose()

    async def next_frame(self, event: str, timeout: float) -> StreamFrame:
        """The next frame of a given type, discarding keepalives and others.

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
        assert self._client is not None
        params = {
            "connection_id": self._connection_id,
            "scope": self._scope,
            "filter": self._filter,
            "spawn_capable": str(self._spawn_capable).lower(),
        }
        try:
            async with self._client.stream(
                "GET",
                f"/agents/{self._agent_id}/events",
                params=params,
                headers={"Accept": "text/event-stream"},
            ) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    self._failure = RuntimeError(
                        f"event stream refused with {response.status_code}: "
                        f"{body.decode(errors='replace')}"
                    )
                    self._opened.set()
                    return
                self._opened.set()
                block: list[str] = []
                async for line in response.aiter_lines():
                    if line:
                        block.append(line)
                        continue
                    frame = _parse(block)
                    block = []
                    if frame is None:
                        continue
                    if frame.sequence is not None:
                        self._cursor = frame.sequence
                    await self._frames.put(frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surfaced through open()/next_frame
            self._failure = exc
            self._opened.set()

    async def _beat(self) -> None:
        assert self._client is not None
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
            response = await self._client.post(
                f"/agents/{self._agent_id}/connection/beat",
                json={"connection_id": self._connection_id, "cursor": self._cursor},
            )
            if response.status_code != 200:
                raise RuntimeError(
                    f"heartbeat for {self._connection_id} rejected with "
                    f"{response.status_code}: {response.text}"
                )


def _parse(block: list[str]) -> StreamFrame | None:
    event = None
    data = None
    sequence = None
    for line in block:
        if line.startswith(":"):
            continue
        if line.startswith("id: "):
            sequence = int(line[4:])
        elif line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            data = json.loads(line[6:])
    if event is None or not isinstance(data, dict):
        return None
    return StreamFrame(event=event, sequence=sequence, data=data)
