"""The signed-in user's change notices, pushed over one WebSocket.

Console keeps this open per server it is signed in to, and reads a list again
when a notice names its kind, instead of reading it on a timer. The frames are
JSON `{"event", "data"}`, as on the agent and controller sockets:

- `hello` once, on opening: `protocol`, the `kinds` this server sends notices
  for, and `ping_interval_s`. A client stops polling only for those kinds.
- `changed`: `changes`, a list of `{"kind", "id"}`; `id` null means any of
  that kind (`switch_core.user_changes`).
- `ping` every `ping_interval_s`; the client answers `{"type": "pong"}`. A
  client that sends nothing for `_SILENT_PINGS` intervals is gone, and its
  socket is closed. A client that hears no ping for as long should assume the
  same of the server and reconnect.

Authenticated once, when the socket opens, by the same session cookie and
tenant resolution as every gateway route (`authenticate_socket`); a refusal is
a `refused` frame with the status and detail, then close code 4000 plus the
status, like the agent socket. The socket holds no database connection while
it is open. It is closed with 4401 when the cookie it was opened with
expires, so a client reconnects with the cookie it has renewed since.

A client reads everything again each time the socket opens, so a notice lost
while it was closed costs nothing more than that read.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import authenticate_socket
from switch_core.gateway.dependencies import (
    get_config,
    get_session_factory,
    get_user_changes,
    get_user_store,
)
from switch_core.user_changes import KINDS, LocalUserChanges, UserChangeSubscription

logger = logging.getLogger(__name__)

router = APIRouter()

PROTOCOL = 1
PING_INTERVAL_SECONDS = 25.0
# Intervals without a word from the client before its socket is closed.
_SILENT_PINGS = 3
# The close code for a session cookie that has expired: 4000 plus 401.
_EXPIRED = 4401


@router.websocket("/changes/ws")
async def changes_socket(
    websocket: WebSocket,
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    changes: Annotated[LocalUserChanges, Depends(get_user_changes)],
) -> None:
    await websocket.accept()
    try:
        caller = await authenticate_socket(
            websocket, session_factory, user_store, config
        )
    except HTTPException as exc:
        await websocket.send_json(
            {
                "event": "refused",
                "data": {"status": exc.status_code, "detail": exc.detail},
            }
        )
        await websocket.close(code=4000 + exc.status_code)
        return

    subscription = changes.subscribe(caller.tenant_id, caller.user_id)
    heard = asyncio.Event()
    listener = asyncio.create_task(_listen(websocket, heard))
    try:
        await websocket.send_json(
            {
                "event": "hello",
                "data": {
                    "protocol": PROTOCOL,
                    "kinds": list(KINDS),
                    "ping_interval_s": PING_INTERVAL_SECONDS,
                },
            }
        )
        code = await _serve(websocket, subscription, heard, listener, caller.expires_at)
    except (WebSocketDisconnect, RuntimeError):
        # Gone, or closed under us by the server shutting down: nothing to send.
        return
    finally:
        subscription.close()
        listener.cancel()
    try:
        await websocket.close(code=code)
    except RuntimeError:
        pass  # the client closed it first


async def _serve(
    websocket: WebSocket,
    subscription: UserChangeSubscription,
    heard: asyncio.Event,
    listener: asyncio.Task[None],
    expires_at: float,
) -> int:
    """Send notices as they come and a ping every interval, until the client
    goes quiet, goes away or its cookie expires. Returns the close code.

    One writer: a WebSocket must not be sent to from two tasks at once, so
    notices and pings both go out from this loop."""
    loop = asyncio.get_running_loop()
    next_ping = loop.time() + PING_INTERVAL_SECONDS
    silent = 0
    while not listener.done():
        if time.time() >= expires_at:
            return _EXPIRED
        timeout = min(next_ping - loop.time(), expires_at - time.time())
        woken = asyncio.ensure_future(subscription.wake.wait())
        await asyncio.wait(
            {woken, listener},
            timeout=max(0.0, timeout),
            return_when=asyncio.FIRST_COMPLETED,
        )
        woken.cancel()
        if listener.done():
            break
        drained = subscription.drain()
        if drained:
            await websocket.send_json(
                {
                    "event": "changed",
                    "data": {
                        "changes": [{"kind": c.kind, "id": c.id} for c in drained]
                    },
                }
            )
        if loop.time() >= next_ping:
            silent = 0 if heard.is_set() else silent + 1
            heard.clear()
            if silent >= _SILENT_PINGS:
                return 1001
            await websocket.send_json({"event": "ping", "data": {}})
            next_ping = loop.time() + PING_INTERVAL_SECONDS
    return 1000


async def _listen(websocket: WebSocket, heard: asyncio.Event) -> None:
    """Note each message the client sends, until it goes. Its content is not
    read: a pong and anything else both say the client is there."""
    while True:
        try:
            await websocket.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            return
        heard.set()
