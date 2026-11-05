from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import random
import ssl
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import cast
from uuid import uuid4

from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)

from .config import IrcConnectionConfig
from .protocol import CaseMapping, Line, build, fold, is_channel, parse

logger = logging.getLogger(__name__)
_CAPS = frozenset(
    {
        "sasl",
        "account-tag",
        "account-notify",
        "server-time",
        "message-tags",
        "batch",
        "draft/chathistory",
        "draft/read-marker",
        "echo-message",
        "labeled-response",
    }
)
_HISTORY_CAPS = frozenset(
    {"server-time", "message-tags", "batch", "draft/chathistory", "draft/read-marker"}
)


@dataclass(frozen=True)
class ChannelTypeChanged:
    channel: str
    private: bool


@dataclass(frozen=True)
class HistoryComplete:
    channel: str


Event = Line | ChannelTypeChanged | HistoryComplete


@dataclass
class HistoryPage:
    channel: str
    count: int = 0
    cursor: str | None = None


def _observe_failure[T](future: asyncio.Future[T]) -> None:
    if not future.cancelled():
        future.exception()


class IrcClient:
    def __init__(
        self,
        config: IrcConnectionConfig,
        resolve: Callable[[str, int], Awaitable[list[str]]],
        on_event: Callable[[Event], Awaitable[None]],
    ) -> None:
        self.config = config
        self.resolve = resolve
        self.on_event = on_event
        self.source_prefix: str | None = None
        self.nick = config.nick
        self.case_mapping: CaseMapping = config.network_case_mapping or "rfc1459"
        self.caps: set[str] = set()
        self.modes: dict[str, set[str]] = {}
        self.desired_channels: set[str] = set(config.channels.split(",")) - {""}
        self.account_nicks: dict[str, set[str]] = {}
        self.bot_account: str | None = None
        self.joined: set[str] = set()
        self.created_channels: set[str] = set()
        self._names: dict[str, list[str]] = {}
        self._writer: asyncio.StreamWriter | None = None
        self._runner: asyncio.Task[None] | None = None
        self._dispatcher: asyncio.Task[None] | None = None
        self._ready: asyncio.Future[None] | None = None
        self._events: asyncio.Queue[Event] = asyncio.Queue(maxsize=10000)
        self._outbox: asyncio.PriorityQueue[
            tuple[int, int, bytes, asyncio.Future[None]]
        ] = asyncio.PriorityQueue(maxsize=10000)
        self._sequence = 0
        self._join_waiters: dict[str, asyncio.Future[None]] = {}
        self._joining: dict[str, Line] = {}
        self._parts: dict[str, asyncio.Future[None]] = {}
        self._whois: dict[str, asyncio.Future[str | None]] = {}
        self._whois_accounts: dict[str, str] = {}
        self._expired_whois: set[str] = set()
        self._acks: dict[str, asyncio.Future[str]] = {}
        self._invites: dict[tuple[str, str], asyncio.Future[None]] = {}
        self._histories: dict[str, HistoryPage] = {}
        self._replaying: set[str] = set()
        self._failed_history: set[str] = set()
        self._last_seen: dict[str, str] = {}
        self._history_limit = 100
        self._stopping = False

    def canonical(self, name: str) -> str:
        return fold(name, self.case_mapping)

    @property
    def connected(self) -> bool:
        """Whether the client currently has a writer for the IRC server."""
        return self._writer is not None

    def force_reconnect(self) -> None:
        """Close a live socket so the connection loop can establish a fresh one."""
        if self._writer is not None:
            self._writer.close()

    async def start(self) -> None:
        self._ready = asyncio.get_running_loop().create_future()
        self._ready.add_done_callback(_observe_failure)
        self._dispatcher = asyncio.create_task(self._dispatch(), name="irc-events")
        self._runner = asyncio.create_task(self._run(), name="irc-connection")
        try:
            async with asyncio.timeout(35):
                await asyncio.shield(self._ready)
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        self._stopping = True
        tasks = [task for task in (self._runner, self._dispatcher) if task]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._fail_waiters()

    async def _open(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        context = ssl.create_default_context() if self.config.tls else None
        addresses = await self.resolve(self.config.server, self.config.port)
        last_error: OSError | None = None
        for address in addresses:
            try:
                async with asyncio.timeout(10):
                    return await asyncio.open_connection(
                        address,
                        self.config.port,
                        ssl=context,
                        server_hostname=self.config.server if context else None,
                        limit=16384,
                    )
            except OSError as error:
                last_error = error
        if last_error:
            raise last_error
        raise ConnectionError("IRC server resolved to no usable address")

    async def _write(self, command: str, *params: str) -> None:
        if self._writer is None:
            raise ConnectionError("IRC is disconnected")
        self._writer.write(build(command, *params))
        await self._writer.drain()

    async def _next(self, reader: asyncio.StreamReader) -> Line:
        while True:
            async with asyncio.timeout(120):
                raw = await reader.readline()
            if not raw:
                raise ConnectionError("IRC server closed the connection")
            line = parse(raw.decode("utf-8", errors="replace"))
            if line.command == "PING":
                await self._write("PONG", *line.params[-1:])
            else:
                return line

    def _isupport(self, params: tuple[str, ...]) -> None:
        for token in params[1:-1]:
            key, _, value = token.partition("=")
            if key == "CASEMAPPING":
                if value not in ("ascii", "rfc1459", "strict-rfc1459"):
                    raise BridgeOperationError(
                        "This IRC server advertises an unsupported case mapping"
                    )
                if (
                    self.config.network_case_mapping
                    and value != self.config.network_case_mapping
                ):
                    raise BridgeOperationError(
                        "The IRC server changed its case mapping. Reconnect the messaging app to verify its configuration."
                    )
                self.case_mapping = cast(CaseMapping, value)
            elif key == "CHATHISTORY" and value.isdigit():
                self._history_limit = max(1, min(100, int(value)))

    async def _register(self, reader: asyncio.StreamReader) -> None:
        self.caps.clear()
        self.nick = self.config.nick
        self.bot_account = None
        if self.config.server_password:
            await self._write("PASS", self.config.server_password)
        await self._write("CAP", "LS", "302")
        await self._write("NICK", self.nick)
        await self._write("USER", "switch", "0", "*", "Switch IRC bridge")
        offered: dict[str, str] = {}
        fallbacks = 0
        async with asyncio.timeout(30):
            while True:
                line = await self._next(reader)
                command, params = line.command, line.params
                if command == "CAP" and len(params) >= 3:
                    verb = params[1]
                    if verb == "LS":
                        for cap in params[-1].split():
                            name, _, value = cap.partition("=")
                            offered[name] = value
                        if params[2] == "*":
                            continue
                        if self.config.account_password and (
                            "sasl" not in offered
                            or offered["sasl"]
                            and "PLAIN" not in offered["sasl"].split(",")
                        ):
                            raise BridgeCredentialError(
                                "The IRC network does not offer SASL PLAIN. Password login requires SASL over TLS."
                            )
                        wanted = sorted(
                            _CAPS
                            & offered.keys()
                            - ({"sasl"} if not self.config.account_password else set())
                        )
                        if wanted:
                            await self._write("CAP", "REQ", " ".join(wanted))
                        else:
                            await self._write("CAP", "END")
                    elif verb == "ACK":
                        self.caps.update(params[-1].split())
                        if self.config.account_password:
                            await self._write("AUTHENTICATE", "PLAIN")
                        else:
                            await self._write("CAP", "END")
                    elif verb == "NAK":
                        raise BridgeOperationError(
                            "IRC server refused the requested capabilities"
                        )
                elif command == "AUTHENTICATE" and params == ("+",):
                    account = self.config.account or self.config.nick
                    encoded = base64.b64encode(
                        f"\0{account}\0{self.config.account_password}".encode()
                    ).decode()
                    for offset in range(0, len(encoded), 400):
                        await self._write(
                            "AUTHENTICATE", encoded[offset : offset + 400]
                        )
                    if len(encoded) % 400 == 0:
                        await self._write("AUTHENTICATE", "+")
                elif command in ("903", "907"):
                    await self._write("CAP", "END")
                elif command == "900" and len(params) >= 3:
                    self.bot_account = params[2].lower()
                    self.source_prefix = params[1]
                elif command == "433" and fallbacks < 3:
                    fallbacks += 1
                    self.nick = self.config.nick[: 30 - fallbacks] + "_" * fallbacks
                    await self._write("NICK", self.nick)
                elif command in (
                    "432",
                    "433",
                    "464",
                    "465",
                    "902",
                    "904",
                    "905",
                    "906",
                ):
                    raise BridgeCredentialError(
                        f"IRC registration was refused ({command}). Check the bot nickname and credentials."
                    )
                elif command == "001":
                    self.nick = params[0]
                elif command == "005":
                    self._isupport(params)
                elif command in ("376", "422"):
                    return
                elif command == "ERROR":
                    raise ConnectionError(
                        "IRC server closed the connection during registration"
                    )

    async def _run(self) -> None:
        delay = 1.0
        assert self._ready is not None
        while not self._stopping:
            try:
                reader, self._writer = await self._open()
                await self._register(reader)
                self.joined.clear()
                self.created_channels.clear()
                self._names.clear()
                self._joining.clear()
                self.modes.clear()
                self.account_nicks.clear()
                self._expired_whois.clear()
                self._failed_history.clear()
                self._replaying.clear()
                self._histories.clear()
                if not {"echo-message", "labeled-response"} <= self.caps:
                    logger.warning(
                        "IRC network lacks labeled echo acknowledgements. Outgoing delivery is best-effort and server refusals may be unavailable."
                    )
                if not _HISTORY_CAPS <= self.caps:
                    logger.warning(
                        "IRC network lacks history/read-marker capabilities. Messages sent while disconnected cannot be recovered."
                    )
                writer_task = asyncio.create_task(
                    self._send_queued(), name="irc-writer"
                )
                self.desired_channels = {
                    self.canonical(channel) for channel in self.desired_channels
                }
                for channel in self.desired_channels:
                    key = self.canonical(channel)
                    future = asyncio.get_running_loop().create_future()
                    future.add_done_callback(_observe_failure)
                    self._join_waiters[key] = future
                    self._enqueue("JOIN", channel)
                if not self._ready.done():
                    self._ready.set_result(None)
                delay = 1.0
                reader_task = asyncio.create_task(
                    self._read_messages(reader), name="irc-reader"
                )
                tasks = {writer_task, reader_task}
                try:
                    done, _ = await asyncio.wait(
                        tasks, return_when=asyncio.FIRST_COMPLETED
                    )
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if not self._ready.done():
                    self._ready.set_exception(error)
                    return
                # Never include server text here: it can echo an authentication secret.
                logger.warning(
                    "IRC connection interrupted (%s). Reconnecting.",
                    type(error).__name__,
                )
            finally:
                if self._writer:
                    self._writer.close()
                    try:
                        with contextlib.suppress(OSError):
                            closing = asyncio.create_task(self._writer.wait_closed())
                            closing.add_done_callback(_observe_failure)
                            await asyncio.shield(closing)
                    finally:
                        self._writer = None
                self._fail_waiters()
            await asyncio.sleep(delay * random.uniform(0.8, 1.2))
            delay = min(60.0, delay * 2)

    async def _read_messages(self, reader: asyncio.StreamReader) -> None:
        while True:
            await self._handle(await self._next(reader))

    def _enqueue(
        self, command: str, *params: str, label: str | None = None
    ) -> asyncio.Future[None]:
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        # Some control sends have no waiter. Consume their failure after it is logged.
        future.add_done_callback(_observe_failure)
        self._sequence += 1
        self._outbox.put_nowait(
            (
                1 if command == "PRIVMSG" else 0,
                self._sequence,
                build(command, *params, label=label),
                future,
            )
        )
        return future

    async def _send_queued(self) -> None:
        allowance = 4.0
        previous = asyncio.get_running_loop().time()
        while True:
            _, _, data, future = await self._outbox.get()
            try:
                now = asyncio.get_running_loop().time()
                allowance = min(4.0, allowance + now - previous)
                if allowance < 1:
                    await asyncio.sleep(1 - allowance)
                    now = asyncio.get_running_loop().time()
                    allowance = 1.0
                previous = now
                allowance -= 1
                if future.cancelled():
                    continue
                if self._writer is None:
                    raise ConnectionError("IRC disconnected before sending")
                self._writer.write(data)
                await self._writer.drain()
                if not future.done():
                    future.set_result(None)
            except BaseException:
                if not future.done():
                    future.set_exception(
                        BridgeOperationError(
                            "IRC disconnected during the send. Delivery is uncertain."
                        )
                    )
                raise
            finally:
                self._outbox.task_done()

    def _fail_waiters(self) -> None:
        self._whois_accounts.clear()
        for pending in (
            self._join_waiters,
            self._parts,
            self._whois,
            self._acks,
            self._invites,
        ):
            for future in pending.values():
                if not future.done():
                    future.set_exception(
                        BridgeOperationError(
                            "IRC connection ended before the operation was confirmed"
                        )
                    )
            pending.clear()
        while not self._outbox.empty():
            _, _, _, future = self._outbox.get_nowait()
            if not future.done():
                future.set_exception(
                    BridgeOperationError("IRC disconnected before sending")
                )
            self._outbox.task_done()

    def private(self, channel: str) -> bool:
        modes = self.modes.get(self.canonical(channel))
        return modes is None or bool(modes & {"s", "p", "i", "k"})

    async def join(self, channel: str) -> None:
        key = self.canonical(channel)
        self.desired_channels.add(key)
        if key in self.joined and key in self.modes:
            return
        future = self._join_waiters.get(key)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            future.add_done_callback(_observe_failure)
            self._join_waiters[key] = future
            self._enqueue("JOIN", channel)
        async with asyncio.timeout(15):
            await asyncio.shield(future)

    async def part(self, channel: str) -> None:
        key = self.canonical(channel)
        if key in self.joined:
            future = self._parts.get(key)
            if future is None:
                future = asyncio.get_running_loop().create_future()
                future.add_done_callback(_observe_failure)
                self._parts[key] = future
                self._enqueue("PART", channel)
            try:
                async with asyncio.timeout(15):
                    await asyncio.shield(future)
            finally:
                if future.done():
                    self._parts.pop(key, None)
        self.desired_channels = {
            desired
            for desired in self.desired_channels
            if self.canonical(desired) != key
        }

    def message_budget(self, target: str, *, labeled: bool = False) -> int:
        prefix = self.source_prefix or f"{self.nick}!{'u' * 10}@{'h' * 253}"
        tag_bytes = len(("@label=" + ("0" * 32) + " ").encode()) if labeled else 0
        return 510 - tag_bytes - len(f":{prefix} PRIVMSG {target} :".encode())

    async def send(self, target: str, text: str) -> str:
        if is_channel(target):
            await self.join(target)
        label = uuid4().hex
        acknowledged = {"echo-message", "labeled-response"} <= self.caps
        future: asyncio.Future[str] | None = None
        if acknowledged:
            future = asyncio.get_running_loop().create_future()
            self._acks[label] = future
        try:
            async with asyncio.timeout(15):
                await self._enqueue(
                    "PRIVMSG", target, text, label=label if acknowledged else None
                )
                return await future if future is not None else label
        except TimeoutError as error:
            raise BridgeOperationError(
                "IRC did not confirm the message before the timeout. Delivery is uncertain."
            ) from error
        finally:
            self._acks.pop(label, None)

    async def query_modes(self, channel: str) -> None:
        key = self.canonical(channel)
        future = self._join_waiters.get(key)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            future.add_done_callback(_observe_failure)
            self._join_waiters[key] = future
            self._enqueue("MODE", channel)
        async with asyncio.timeout(15):
            await asyncio.shield(future)

    async def command(self, command: str, *params: str) -> None:
        async with asyncio.timeout(15):
            await self._enqueue(command, *params)

    async def whois_account(self, nick: str) -> str | None:
        key = self.canonical(nick)
        if key in self._expired_whois:
            raise BridgeOperationError(
                "IRC account lookup timed out. Wait for the connection to recover before retrying."
            )
        future = self._whois.get(key)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            future.add_done_callback(_observe_failure)
            self._whois_accounts.pop(key, None)
            self._whois[key] = future
            self._enqueue("WHOIS", nick)
        try:
            async with asyncio.timeout(10):
                return await asyncio.shield(future)
        except (TimeoutError, asyncio.CancelledError):
            self._expired_whois.add(key)
            if self._writer:
                self._writer.close()
            raise
        finally:
            self._whois.pop(key, None)
            self._whois_accounts.pop(key, None)

    async def invite(self, nick: str, channel: str) -> None:
        key = (self.canonical(nick), self.canonical(channel))
        future = self._invites.get(key)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            self._invites[key] = future
            self._enqueue("INVITE", nick, channel)
        try:
            async with asyncio.timeout(10):
                await asyncio.shield(future)
        finally:
            self._invites.pop(key, None)

    async def _handle(self, line: Line) -> None:
        command, params = line.command, line.params
        if line.nick and self.canonical(line.nick) == self.canonical(self.nick):
            self.source_prefix = line.source
        if command == "341" and len(params) >= 3:
            invitation = self._invites.get(
                (self.canonical(params[1]), self.canonical(params[2]))
            )
            if invitation is not None and not invitation.done():
                invitation.set_result(None)
        elif command.isdigit() and int(command) >= 400:
            if len(params) >= 2:
                for pending in (self._join_waiters, self._parts):
                    failed = pending.pop(self.canonical(params[1]), None)
                    if failed is not None and not failed.done():
                        failed.set_exception(
                            BridgeOperationError(
                                f"IRC refused the channel operation ({command})"
                            )
                        )
            for (nick, channel), invitation in list(self._invites.items()):
                if (
                    any(
                        self.canonical(param) in (nick, channel)
                        for param in params[1:3]
                    )
                    and not invitation.done()
                ):
                    invitation.set_exception(
                        BridgeOperationError(f"IRC refused the invitation ({command})")
                    )
        label = line.tags.get("label")
        if label in self._acks:
            ack_future = self._acks[label]
            if command.isdigit() and int(command) >= 400 and not ack_future.done():
                ack_future.set_exception(
                    BridgeOperationError(f"IRC refused the message ({command})")
                )
            elif command in ("PRIVMSG", "ACK") and not ack_future.done():
                ack_future.set_result(line.tags.get("msgid", label))
        if command == "005":
            self._isupport(params)
        if command == "330" and len(params) >= 3:
            key = self.canonical(params[1])
            if key in self._whois:
                self._whois_accounts[key] = params[2].lower()
        elif command == "318" and len(params) >= 2:
            key = self.canonical(params[1])
            whois_future = self._whois.get(key)
            if whois_future is not None and not whois_future.done():
                whois_future.set_result(self._whois_accounts.get(key))
        elif command == "NICK" and line.nick and params:
            for nicks in self.account_nicks.values():
                if line.nick in nicks:
                    nicks.discard(line.nick)
                    nicks.add(params[0])
            if self.canonical(line.nick) == self.canonical(self.nick):
                self.nick = params[0]
        elif command in ("QUIT", "ACCOUNT") and line.nick:
            for nicks in self.account_nicks.values():
                nicks.discard(line.nick)
            if command == "ACCOUNT" and params and params[0] != "*":
                self.account_nicks.setdefault(params[0].lower(), set()).add(line.nick)
        if line.nick and line.tags.get("account") not in (None, "*"):
            self.account_nicks.setdefault(line.tags["account"].lower(), set()).add(
                line.nick
            )
        if (
            command in ("PART", "KICK")
            and params
            and (
                command == "PART"
                and line.nick
                and self.canonical(line.nick) == self.canonical(self.nick)
                or command == "KICK"
                and len(params) >= 2
                and self.canonical(params[1]) == self.canonical(self.nick)
            )
        ):
            channel = self.canonical(params[0])
            self.joined.discard(channel)
            self.modes.pop(channel, None)
            self.created_channels.discard(channel)
            self._joining.pop(channel, None)
            part_future = self._parts.get(channel)
            if command == "PART" and part_future is not None and not part_future.done():
                part_future.set_result(None)
            if command == "KICK":
                logger.warning(
                    "IRC bot was kicked from %s. Channel delivery requires rejoining.",
                    channel,
                )
        if command == "353" and len(params) >= 4:
            channel = self.canonical(params[2])
            self._names.setdefault(channel, []).extend(params[3].split())
        elif command == "366" and len(params) >= 2:
            channel = self.canonical(params[1])
            names = self._names.pop(channel, [])
            if (
                len(names) == 1
                and names[0].startswith(("@", "~", "&"))
                and self.canonical(names[0].lstrip("~&@%+"))
                == self.canonical(self.nick)
            ):
                self.created_channels.add(channel)
        if (
            command == "INVITE"
            and len(params) == 2
            and self.canonical(params[0]) == self.canonical(self.nick)
            and is_channel(params[1])
        ):
            channel = self.canonical(params[1])
            self.desired_channels.add(channel)
            if channel not in self.joined and channel not in self._join_waiters:
                future = asyncio.get_running_loop().create_future()
                future.add_done_callback(_observe_failure)
                self._join_waiters[channel] = future
                self._enqueue("JOIN", channel)
        if (
            command == "JOIN"
            and line.nick
            and params
            and self.canonical(line.nick) == self.canonical(self.nick)
        ):
            channel = self.canonical(params[0])
            self.joined.add(channel)
            self._joining[channel] = line
            self._enqueue("MODE", channel)
            if _HISTORY_CAPS <= self.caps:
                self._replaying.add(channel)
                self._enqueue("MARKREAD", channel)
        elif command in ("MODE", "324"):
            offset = 1 if command == "324" else 0
            if len(params) > offset + 1 and is_channel(params[offset]):
                channel = self.canonical(params[offset])
                modes = set() if command == "324" else self.modes.get(channel, set())
                adding = True
                for mode in params[offset + 1]:
                    if mode in "+-":
                        adding = mode == "+"
                    elif adding:
                        modes.add(mode)
                    else:
                        modes.discard(mode)
                self.modes[channel] = modes
                await self._events.put(
                    ChannelTypeChanged(channel, self.private(channel))
                )
                if channel in self._joining:
                    await self._events.put(self._joining.pop(channel))
                join_future = self._join_waiters.pop(channel, None)
                if join_future and not join_future.done():
                    join_future.set_result(None)
        elif command == "MARKREAD" and len(params) >= 2:
            channel = self.canonical(params[0])
            if channel in self._replaying and params[1].startswith("timestamp="):
                self._enqueue(
                    "CHATHISTORY", "AFTER", channel, params[1], str(self._history_limit)
                )
            elif channel in self._replaying:
                await self._events.put(HistoryComplete(channel))
        elif command == "BATCH" and params:
            if (
                params[0].startswith("+")
                and len(params) >= 3
                and params[1] == "chathistory"
            ):
                self._histories[params[0][1:]] = HistoryPage(self.canonical(params[2]))
            elif params[0].startswith("-"):
                page = self._histories.pop(params[0][1:], None)
                if page:
                    if page.count >= self._history_limit and page.cursor:
                        self._enqueue(
                            "CHATHISTORY",
                            "AFTER",
                            page.channel,
                            page.cursor,
                            str(self._history_limit),
                        )
                    else:
                        await self._events.put(HistoryComplete(page.channel))
        else:
            page = self._histories.get(line.tags.get("batch", ""))
            if page:
                page.count += 1
                if line.tags.get("msgid"):
                    page.cursor = "msgid=" + line.tags["msgid"]
                elif line.tags.get("time"):
                    page.cursor = "timestamp=" + line.tags["time"]
            if command in ("PRIVMSG", "JOIN"):
                await self._events.put(line)

    async def _dispatch(self) -> None:
        while True:
            event = await self._events.get()
            channel = None
            if isinstance(event, Line) and event.command == "PRIVMSG" and event.params:
                channel = self.canonical(event.params[0])
            try:
                if isinstance(event, HistoryComplete):
                    self._replaying.discard(event.channel)
                    await self._checkpoint(event.channel)
                else:
                    await self.on_event(event)
                    if (
                        channel
                        and is_channel(channel)
                        and isinstance(event, Line)
                        and event.tags.get("time")
                    ):
                        stamp = event.tags["time"]
                        old = self._last_seen.get(channel)
                        if old is None or datetime.fromisoformat(
                            stamp
                        ) > datetime.fromisoformat(old):
                            self._last_seen[channel] = stamp
                        await self._checkpoint(channel)
            except Exception:
                if channel:
                    self._failed_history.add(channel)
                logger.exception("IRC event could not be relayed to Switch")
            finally:
                self._events.task_done()

    async def _checkpoint(self, channel: str) -> None:
        if channel in self._failed_history or channel in self._replaying:
            return
        stamp = self._last_seen.get(channel)
        if stamp and _HISTORY_CAPS <= self.caps:
            self._enqueue("MARKREAD", channel, "timestamp=" + stamp)
