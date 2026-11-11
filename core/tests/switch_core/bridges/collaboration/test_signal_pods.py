"""Signal on two pods: one event stream, one copy of every message.

Against real PostgreSQL, two "processes" wired the way `main` wires one
(borrowed from `test_bridge_ownership`), both running the real
`SignalAdapter` against one fake signal-cli daemon on a real local socket.
The daemon keeps every event and replays them to whoever connects with
`Last-Event-ID: 0`, as signal-cli 0.14.9 does; it counts open event streams
and records every JSON-RPC call. So a test can say that only the lease
holder listens, that a replay to the next holder is stored once, that a
reply goes out once, and that a backlog older than the relay window is not
relayed after a hand-over.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from aiohttp import web
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.signal.adapter import (
    REPLAY_WINDOW_SECONDS,
    SignalAdapter,
    SignalConnectionConfig,
)
from switch_core.db.models import Client, CollaborationBridge, ExternalUser, Room
from switch_core.db.stores.room_store import RoomStore
from switch_core.outbound import OutboundPolicy
from tests.switch_core.bridges.collaboration.test_bridge_ownership import (
    TIMEOUT,
    _Bridge,
    _eventually,
    _holder,
    _Process,
    _process,
    _room_bodies,
    _say,
)

SIGNAL = "signal"
ACCOUNT = "+15555550100"
PHONE = "+15555550200"
PHONE_UUID = "00000000-0000-4000-8000-000000000002"
GROUP_ID = "Z3JvdXAtb25l"  # base64, as signal-cli writes group ids
CHANNEL = f"g:{GROUP_ID}"

# The daemon is a loopback socket: the bridge's start guard checks its
# `daemon_url` against the deployment's outbound policy, and only 127.0.0.1
# is reachable here, so the policy that lets it through is this one.
_LOOPBACK_POLICY = OutboundPolicy.parse("127.0.0.1")


class _Daemon:
    """One signal-cli daemon both pods reach: keeps events, replays them."""

    def __init__(self) -> None:
        self.events: list[tuple[int, dict[str, Any]]] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.open_streams = 0
        self.resumed_from: list[str] = []
        self._new = asyncio.Condition()
        self._next_id = 1
        self._runner: web.AppRunner | None = None
        self.url = ""

    async def start(self) -> None:
        app = web.Application()
        app.router.add_post("/api/v1/rpc", self._rpc)
        app.router.add_get("/api/v1/events", self._events)
        self._runner = web.AppRunner(app, handler_cancellation=True)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        self.url = f"http://127.0.0.1:{port}"

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()

    async def phone_says(self, text: str, *, sent_at_ms: int | None = None) -> str:
        """Someone writes in the group from their phone. Returns the
        `message_ref` the adapter must compute for it."""
        ts = sent_at_ms if sent_at_ms is not None else int(time.time() * 1000)
        envelope = {
            "source": PHONE,
            "sourceNumber": PHONE,
            "sourceUuid": PHONE_UUID,
            "sourceName": "Alex",
            "sourceDevice": 1,
            "timestamp": ts,
            "dataMessage": {
                "timestamp": ts,
                "message": text,
                "groupInfo": {
                    "groupId": GROUP_ID,
                    "groupName": "ops",
                    "type": "DELIVER",
                },
            },
        }
        async with self._new:
            self.events.append(
                (self._next_id, {"envelope": envelope, "account": ACCOUNT})
            )
            self._next_id += 1
            self._new.notify_all()
        return f"{PHONE_UUID}:{ts}"

    def sends(self) -> list[str]:
        return [
            str(params.get("message"))
            for method, params in self.calls
            if method == "send"
        ]

    async def _rpc(self, request: web.Request) -> web.Response:
        body = await request.json()
        method, params = body["method"], body.get("params") or {}
        self.calls.append((method, params))
        result: Any = {}
        if method == "listAccounts":
            result = [{"number": ACCOUNT}]
        elif method == "send":
            result = {
                "results": [{"type": "SUCCESS"}],
                "timestamp": int(time.time() * 1000),
            }
        return web.json_response({"jsonrpc": "2.0", "id": body["id"], "result": result})

    async def _events(self, request: web.Request) -> web.StreamResponse:
        last = request.headers.get("Last-Event-ID", "0")
        self.resumed_from.append(last)
        after = int(last.split("-")[0]) if last.split("-")[0].isdigit() else 0
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        self.open_streams += 1
        try:
            sent = after
            while True:
                pending = [(i, e) for i, e in self.events if i > sent]
                for event_id, data in pending:
                    frame = f"id:{event_id}\nevent:receive\ndata:{json.dumps(data)}\n\n"
                    await response.write(frame.encode())
                    sent = event_id
                # A comment line, so a client that went away is noticed.
                await response.write(b": ping\n\n")
                async with self._new:
                    try:
                        await asyncio.wait_for(self._new.wait(), 0.1)
                    except TimeoutError:
                        pass
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            self.open_streams -= 1
        return response


@pytest.fixture
async def daemon() -> AsyncIterator[_Daemon]:
    daemon = _Daemon()
    await daemon.start()
    try:
        yield daemon
    finally:
        await daemon.stop()


@pytest.fixture
async def bridge(
    session_factory: async_sessionmaker[AsyncSession], daemon: _Daemon
) -> _Bridge:
    """A Signal bridge carrying one room, bridged to the group, and someone
    in the room whose messages the bridge relays out."""
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        bridge_client = Client(
            transport_user_id=f"@switch-bridge-{suffix}:test",
            display_name="bridge",
            type="bridge",
        )
        speaker = Client(
            transport_user_id=f"@speaker-{suffix}:test",
            display_name="speaker",
            type="user",
        )
        session.add_all([bridge_client, speaker])
        await session.flush()
        row = CollaborationBridge(
            type=SIGNAL,
            display_name="Signal",
            connection_config={"daemon_url": daemon.url, "account": ACCOUNT},
            client_id=bridge_client.id,
            status="active",
            channel_creation_enabled=False,
            preconfigured=False,
        )
        session.add(row)
        await session.flush()
        room = Room(
            transport_room_id=f"!room-{suffix}:test",
            name="ops",
            description="",
            bridge_id=row.id,
            external_channel_id=CHANNEL,
            channel_type="group",
        )
        session.add(room)
        await session.flush()
        await RoomStore().add_client(session, bridge_client.id, room.id)
        await RoomStore().add_client(session, speaker.id, room.id)
        await session.commit()
        return _Bridge(
            bridge_id=row.id,
            client_id=bridge_client.id,
            room_id=room.id,
            transport_room_id=room.transport_room_id,
            speaker_id=speaker.id,
            speaker=speaker.transport_user_id,
        )


@pytest.fixture
async def processes() -> AsyncIterator[list[_Process]]:
    started: list[_Process] = []
    try:
        yield started
    finally:
        for process in started:
            await process.stop()


async def _boot_two(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    processes: list[_Process],
) -> tuple[_Process, _Process]:
    for _ in range(2):
        process = await _process(postgres_url, session_factory)
        # The harness's config is a MagicMock, but the bridge's start guard
        # awaits the deployment's outbound policy on the daemon URL. The
        # daemon is loopback, so allow exactly that.
        process.bridges._config.outbound_policy = _LOOPBACK_POLICY
        process.bridges.register_adapter(SIGNAL, SignalAdapter, SignalConnectionConfig)
        processes.append(process)
        await process.boot()
    for process in processes:
        await process.ownership.balance()
    for process in processes:
        await process.settled()
    return processes[0], processes[1]


async def _phone_messages(
    session_factory: async_sessionmaker[AsyncSession], bridge: _Bridge, count: int
) -> list[str | None]:
    """What the person on the phone said, as the room stored it."""

    async def person() -> str | None:
        async with session_factory() as session:
            ids = (
                await session.scalars(
                    select(ExternalUser.client_id).where(
                        ExternalUser.bridge_id == bridge.bridge_id
                    )
                )
            ).all()
            if not ids:
                return None
            assert len(ids) == 1
            client = await session.get(Client, ids[0])
            return client.transport_user_id if client else None

    async with asyncio.timeout(TIMEOUT):
        while True:
            who = await person()
            if who is not None:
                bodies = await _room_bodies(session_factory, bridge.room_id, who)
                if len(bodies) >= count:
                    break
            await asyncio.sleep(0.05)
    # Long enough for a second copy, had there been one, to have landed.
    await asyncio.sleep(0.5)
    return await _room_bodies(session_factory, bridge.room_id, who)


class TestOneStream:
    async def test_only_the_lease_holder_opens_the_event_stream(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        daemon: _Daemon,
        bridge: _Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )

        await _eventually(lambda: daemon.open_streams == 1)
        await asyncio.sleep(0.5)
        assert daemon.open_streams == 1
        held = holder.bridges.get(bridge.bridge_id)
        copy = quiet.bridges.get(bridge.bridge_id)
        assert held is not None and held.active
        assert copy is not None and not copy.active

    async def test_a_reply_is_sent_to_signal_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        daemon: _Daemon,
        bridge: _Bridge,
    ) -> None:
        await _boot_two(postgres_url, session_factory, processes)

        await _say(session_factory, bridge, "hello group")

        await _eventually(lambda: len(daemon.sends()) >= 1)
        await asyncio.sleep(0.5)
        assert len(daemon.sends()) == 1
        assert daemon.sends()[0].endswith("hello group")


class TestHandingOver:
    async def test_the_next_holder_replays_from_zero_and_stores_each_message_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        daemon: _Daemon,
        bridge: _Bridge,
    ) -> None:
        """The holder relays a message and dies. The next holder starts with
        no memory, asks the daemon for everything kept (`Last-Event-ID: 0`),
        and gets the old message again with one said while nobody listened.
        The ref is computed from the event, so the router drops the repeat."""
        holder, other = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        await _eventually(lambda: daemon.open_streams == 1)
        await daemon.phone_says("before the hand-over")
        assert await _phone_messages(session_factory, bridge, 1) == [
            "before the hand-over"
        ]

        await holder.stop()
        await _eventually(lambda: daemon.open_streams == 0)
        await daemon.phone_says("while nobody listened")
        await other.ownership.balance()
        await other.settled()

        assert await _phone_messages(session_factory, bridge, 2) == [
            "before the hand-over",
            "while nobody listened",
        ]
        assert other.bridges.holds(bridge.bridge_id)
        assert daemon.open_streams == 1
        # The new holder kept nothing from the old one: it replayed from 0.
        assert daemon.resumed_from[-1] == "0"

    async def test_a_backlog_older_than_the_relay_window_is_not_relayed(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        daemon: _Daemon,
        bridge: _Bridge,
    ) -> None:
        """The daemon still keeps a message from two days ago. A holder that
        takes over replays it with the rest; it is not worth waking an agent
        over, so only the recent one reaches the room."""
        two_days_ago = int((time.time() - 2 * REPLAY_WINDOW_SECONDS) * 1000)
        await daemon.phone_says(
            "!restart-world from two days ago", sent_at_ms=two_days_ago
        )
        await daemon.phone_says("old chatter", sent_at_ms=two_days_ago + 1)
        await daemon.phone_says("said just now")

        await _boot_two(postgres_url, session_factory, processes)

        assert await _phone_messages(session_factory, bridge, 1) == ["said just now"]
