"""Mattermost client websocket transport with client-side TLS."""

from __future__ import annotations

import asyncio
import ssl
from collections.abc import Awaitable, Callable
from typing import final

import websockets
from mattermostdriver import Driver
from mattermostdriver.websocket import Websocket


@final
class _MattermostWebsocket(Websocket):  # type: ignore[misc]
    async def connect(self, event_handler: Callable[[str], Awaitable[None]]) -> None:
        # mattermostdriver creates a server TLS context, which cannot be used
        # to open a client socket. Keep its Mattermost wire protocol and use
        # the adapter's existing retry loop for connection failures.
        secure = self.options["scheme"] == "https"
        context = ssl.create_default_context() if secure else None
        if context is not None and not self.options["verify"]:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE

        scheme = "wss" if secure else "ws"
        host = self.options["url"]
        port = self.options["port"]
        basepath = self.options["basepath"]
        url = f"{scheme}://{host}:{port}{basepath}/websocket"
        self._alive = True
        try:
            async with websockets.connect(
                url, ssl=context, **(self.options["websocket_kw_args"] or {})
            ) as socket:
                await self._authenticate_websocket(socket, event_handler)
                try:
                    await self._start_loop(socket, event_handler)
                except websockets.ConnectionClosedOK:
                    pass
        finally:
            self._alive = False


class MattermostDriver(Driver):  # type: ignore[misc]
    def init_websocket(
        self, event_handler: Callable[[str], Awaitable[None]]
    ) -> asyncio.AbstractEventLoop:
        return super().init_websocket(  # type: ignore[no-any-return]
            event_handler, websocket_cls=_MattermostWebsocket
        )
