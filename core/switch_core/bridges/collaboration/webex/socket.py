"""Webex's event socket: how the bridge hears Webex without a public address.

A webhook needs Webex to be able to call Switch, which means a public HTTPS
address in front of every deployment that wants a Webex connection. Webex's
own clients do not work that way. They register a *device* for the account
and open a WebSocket to Webex, and every event for that account arrives over
it. A bot can do the same thing with its own token, and that is what this
module does: register (or reuse) one device for the bot, connect, authorise,
and hand each activity on as it arrives.

The socket carries only that something happened — an activity's text is
encrypted for the device, and a bot is not given the keys. The adapter reads
what happened through the REST API, which is also what decides what a bot may
see: in a group space, only the messages that mention it.

Only the process that holds the bridge opens this. Every other one leaves it
closed and calls the REST API alone (`keeps_quiet_unless_listening`).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from switch_core.bridges.collaboration.webex.client import WebexApiError, WebexClient

logger = logging.getLogger(__name__)

# Webex's device registry. Its clients find this through a service catalog;
# this is the address that catalog has named for as long as bots have used it.
WDM_URL = "https://wdm-a.wbx2.com/wdm/api/v1"

# The device this bridge registers for its bot, found again by name so a
# restart reuses it rather than adding one more to the account's list.
DEVICE_NAME = "switch-webex-bridge"
DEVICE: dict[str, str] = {
    "deviceName": DEVICE_NAME,
    "deviceType": "DESKTOP",
    "localizedModel": "switch",
    "model": "switch",
    "name": DEVICE_NAME,
    "systemName": "switch",
    "systemVersion": "1",
}

# Reconnecting: quickly after a blip, slowly against a Webex that keeps
# refusing, and never in lockstep with every other bridge that dropped at the
# same moment.
_BACKOFF_FIRST = 1.0
_BACKOFF_CAP = 60.0

# A socket counts as having worked, and the backoff starts over, once it has
# stayed open this long. One Webex accepts and then closes
# straight away (a revoked token, a device it no longer knows) keeps backing
# off, since every reconnect lists devices and reads back missed messages.
_STABLE_AFTER = 30.0

# What the socket may carry in one frame. Activities are small; this is a
# ceiling against a misbehaving peer rather than a budget.
_MAX_FRAME = 4 * 1024 * 1024

ActivityHandler = Callable[[dict[str, Any]], Awaitable[None]]
ConnectedHandler = Callable[[datetime | None], Awaitable[None]]
Connector = Callable[..., Any]


def is_webex_socket(url: str) -> bool:
    """Whether the bot's token may be sent down a socket at `url`."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme == "wss" and (
        host.endswith(".wbx2.com") or host.endswith(".webex.com")
    )


class WebexEventStream:
    """One bot's event socket, kept open until `stop`.

    `on_activity` is given each `conversation.activity` in the order Webex
    sent them; a failure inside it is logged and the socket carries on, since
    one unreadable event is no reason to stop hearing the rest. `on_connected`
    is told each time the socket is (re)opened, with when it last went down —
    None the first time — so the adapter can read back what it missed.
    """

    def __init__(
        self,
        client: WebexClient,
        token: str,
        *,
        on_activity: ActivityHandler,
        on_connected: ConnectedHandler,
        wdm_url: str = WDM_URL,
        connector: Connector = connect,
        trusts_socket: Callable[[str], bool] = is_webex_socket,
    ) -> None:
        self._client = client
        self._token = token
        self._on_activity = on_activity
        self._on_connected = on_connected
        self._wdm_url = wdm_url
        self._connector = connector
        self._trusts_socket = trusts_socket
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()
        self._socket: ClientConnection | None = None
        self._device_url: str | None = None
        self._side_tasks: set[asyncio.Task[None]] = set()
        # When the socket last went down, for the adapter's catch-up; None
        # before it was ever up.
        self.down_since: datetime | None = None

    @property
    def connected(self) -> bool:
        return self._socket is not None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stopping.clear()
            self._task = asyncio.create_task(self._run(), name="webex-event-socket")

    async def stop(self) -> None:
        self._stopping.set()
        socket = self._socket
        if socket is not None:
            with contextlib.suppress(Exception):
                await socket.close()
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        for side in list(self._side_tasks):
            side.cancel()

    async def forget_device(self) -> None:
        """Remove this bridge's device from the bot's account, for good.

        For a connection that is being deleted: the device would otherwise
        stay registered to the bot, unused, until Webex expires it.
        """
        device_url = self._device_url
        if device_url is None:
            for device in await self._client.devices(self._wdm_url):
                if device.get("name") == DEVICE_NAME:
                    device_url = str(device.get("url") or "") or None
                    break
        if device_url:
            await self._client.delete_device(device_url)
            self._device_url = None

    async def _device(self, *, fresh: bool) -> dict[str, Any]:
        """This bridge's device, reused when the bot already has one.

        `fresh` after Webex refused the socket of the one it had: a device
        Webex has expired still lists, and connecting to it again would fail
        the same way forever.
        """
        if not fresh:
            for device in await self._client.devices(self._wdm_url):
                if device.get("name") == DEVICE_NAME and device.get("webSocketUrl"):
                    return device
        device = await self._client.register_device(self._wdm_url, DEVICE)
        if not device.get("webSocketUrl"):
            raise WebexApiError(
                "Registering the bot's device: Webex returned no socket address",
                status=0,
            )
        return device

    async def _run(self) -> None:
        backoff = _BACKOFF_FIRST
        fresh = False
        loop = asyncio.get_running_loop()
        while not self._stopping.is_set():
            opened_at: float | None = None
            try:
                device = await self._device(fresh=fresh)
                fresh = False
                self._device_url = str(device.get("url") or "") or None
                address = str(device["webSocketUrl"])
                if not self._trusts_socket(address):
                    raise WebexApiError(
                        "Webex named a socket address that is not a Webex host; "
                        "not sending the bot token there",
                        status=0,
                    )
                async with self._connector(
                    address,
                    open_timeout=20,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=_MAX_FRAME,
                ) as socket:
                    await socket.send(
                        json.dumps(
                            {
                                "id": str(uuid.uuid4()),
                                "type": "authorization",
                                "data": {"token": f"Bearer {self._token}"},
                            }
                        )
                    )
                    self._socket = socket
                    logger.info("Webex event socket is open")
                    opened_at = loop.time()
                    self._spawn(self._on_connected(self.down_since))
                    async for frame in socket:
                        await self._receive(socket, frame)
                if not self._stopping.is_set():
                    logger.warning("Webex closed the event socket; reconnecting")
            except asyncio.CancelledError:
                raise
            except InvalidStatus as exc:
                # Webex turned the socket down at the door — the device it was
                # opened for is no longer one it recognises. A new one is
                # registered on the next attempt.
                logger.warning(
                    "Webex refused the event socket (%s); re-registering", exc
                )
                fresh = True
            except ConnectionClosed as exc:
                code = exc.rcvd.code if exc.rcvd is not None else None
                logger.warning(
                    "Webex event socket dropped (code %s); reconnecting", code
                )
                if code is not None and 4000 <= code < 5000:
                    fresh = True
            except WebexApiError as exc:
                if exc.unauthorized:
                    logger.error(
                        "Webex no longer accepts the bot token, so the event socket "
                        "cannot open: %s",
                        exc,
                    )
                    backoff = _BACKOFF_CAP
                else:
                    logger.warning("Could not open the Webex event socket: %s", exc)
            except (InvalidHandshake, OSError, TimeoutError) as exc:
                logger.warning("Could not reach the Webex event socket: %s", exc)
            except Exception:
                logger.exception("Webex event socket failed")
            finally:
                if self._socket is not None:
                    self.down_since = datetime.now(UTC)
                self._socket = None
                if opened_at is not None and loop.time() - opened_at >= _STABLE_AFTER:
                    backoff = _BACKOFF_FIRST
            if self._stopping.is_set():
                break
            delay = backoff * (0.5 + random.random() / 2)  # noqa: S311 - jitter, not security
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stopping.wait(), timeout=delay)
            backoff = min(backoff * 2, _BACKOFF_CAP)

    async def _receive(self, socket: ClientConnection, frame: str | bytes) -> None:
        try:
            event = json.loads(frame)
        except ValueError:
            logger.warning("Ignoring a Webex socket frame that is not JSON")
            return
        if not isinstance(event, dict):
            return
        event_id = event.get("id")
        if isinstance(event_id, str) and event_id:
            # Acknowledged on receipt: Webex keeps a frame it was not told
            # arrived, and the handling below can take a while.
            with contextlib.suppress(ConnectionClosed):
                await socket.send(json.dumps({"type": "ack", "messageId": event_id}))
        data = event.get("data")
        if (
            not isinstance(data, dict)
            or data.get("eventType") != "conversation.activity"
        ):
            return
        activity = data.get("activity")
        if not isinstance(activity, dict):
            return
        try:
            await self._on_activity(activity)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "Failed to handle a Webex %s activity", activity.get("verb", "unknown")
            )

    def _spawn(self, work: Awaitable[None]) -> None:
        async def guarded() -> None:
            try:
                await work
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Webex reconnect handling failed")

        task = asyncio.create_task(guarded())
        self._side_tasks.add(task)
        task.add_done_callback(self._side_tasks.discard)
