"""A Rocket.Chat realtime server that speaks just enough DDP for the tests.

Each flag makes it misbehave in one way, so a test can see how the client copes.
Every frame the client sends is kept in `received`.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

from websockets.asyncio.server import ServerConnection


class DdpServer:
    def __init__(self) -> None:
        self.connections: list[ServerConnection] = []
        self.received: list[dict[str, Any]] = []
        self.port = 0
        self.ignore_connect = False
        self.close_on_login = False
        self.refuse_login = False
        self.ignore_login = False
        self.refuse_subscription = False

    async def __call__(self, socket: ServerConnection) -> None:
        self.connections.append(socket)
        async for raw in socket:
            frame = json.loads(raw)
            self.received.append(frame)
            await self._answer(socket, frame)

    async def _answer(self, socket: ServerConnection, frame: dict[str, Any]) -> None:
        kind = frame.get("msg")
        if kind == "connect":
            if not self.ignore_connect:
                await socket.send(json.dumps({"msg": "connected", "session": "s"}))
        elif kind == "sub":
            answer: dict[str, Any] = {"msg": "ready", "subs": [frame["id"]]}
            if self.refuse_subscription:
                answer = {
                    "msg": "nosub",
                    "id": frame["id"],
                    "error": {"reason": "nope"},
                }
            await socket.send(json.dumps(answer))
        elif kind == "method":
            await self._answer_method(socket, frame)

    async def _answer_method(
        self, socket: ServerConnection, frame: dict[str, Any]
    ) -> None:
        method = frame["method"]
        if method == "login":
            if self.close_on_login:
                await socket.close()
                return
            if self.ignore_login:
                return
            if self.refuse_login:
                await socket.send(
                    json.dumps(
                        {
                            "msg": "result",
                            "id": frame["id"],
                            "error": {"reason": "bad token"},
                        }
                    )
                )
                return
        if method == "silent":
            return
        if method == "fails":
            await socket.send(
                json.dumps(
                    {"msg": "result", "id": frame["id"], "error": {"reason": "denied"}}
                )
            )
            return
        await socket.send(
            json.dumps({"msg": "result", "id": frame["id"], "result": {"ok": True}})
        )

    async def push(self, stream: str, event: str, args: list[Any]) -> None:
        frame = {
            "msg": "changed",
            "collection": stream,
            "fields": {"eventName": event, "args": args},
        }
        await self.connections[-1].send(json.dumps(frame))


async def until(condition: Callable[[], bool]) -> None:
    async with asyncio.timeout(5):
        while not condition():
            await asyncio.sleep(0.01)
