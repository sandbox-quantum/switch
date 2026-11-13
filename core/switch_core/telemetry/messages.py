"""The per-message events: what is said in rooms, and to and by agents.

Everything else in the catalogue fires a handful of times a day. These fire
once per message, so they are the only events where reporting could slow the
thing being reported on. Three rules keep it off that path:

- **The sender never waits.** The transport and the router hand over a small
  record and return. One worker task looks up what the event needs (the
  room's platform, type and membership, who the sender is) and emits.
- **Lookups are cached.** A busy room says a lot and changes membership
  rarely, so a room is read at most once per `_ROOM_TTL_SECONDS` rather than
  once per message. The member counts can therefore be that far behind. Who
  a sender is and an agent's runtime do not change, and are kept for
  `_IDENTITY_TTL_SECONDS`. A lookup that finds nothing is cached too, as
  `unknown`: a room deleted while its last messages were queued must not cost
  a query per message.
- **A failing lookup is left alone.** A room, sender or agent whose lookup
  failed is not looked up again for `_LOOKUP_BACKOFF_SECONDS`, and events
  report it as `unknown` meanwhile. Only that key: one tenant or room that
  keeps failing must not blank every other. When lookups fail
  `_FAILURES_TO_PAUSE_ALL` times in a row, with none succeeding between, the
  database itself is in trouble and every lookup pauses for that long. Either
  way the failure is logged at most once a minute, rather than the worker
  retrying a struggling database, and logging a traceback, once per message.

The queue is bounded: a worker that falls behind drops events with a warning
rather than growing a backlog inside the process it is measuring.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import CHAT_OPERATION_ID_KEY, MEMBER_CLIENT_TYPE
from switch_core.db.models import Agent, Client, ClientRoom, CollaborationBridge, Room
from switch_core.db.session_scope import tenant_session
from switch_core.observability.throttle import WarningThrottle
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.snapshot import (
    AGENT_CLIENT_TYPE,
    HUMAN_CLIENT_TYPE,
    normalise_channel_type,
    normalise_known_agent_type,
    normalise_platform,
)
from switch_core.transport.observer import ParticipantMessage

logger = logging.getLogger(__name__)

_QUEUE_SIZE = 10_000
# A room's facts are re-read this often, so its member counts are at most
# this far behind. Most rooms are quiet: kept for minutes rather than an hour,
# a room's lookup is a query for most of its messages.
_ROOM_TTL_SECONDS = 900.0
# Who a sender is, and an agent's runtime: neither changes.
_IDENTITY_TTL_SECONDS = 3600.0
# Above the agents and rooms of a large deployment, so a cache at its limit
# does not evict what it is about to be asked again.
_CACHE_MAX_ENTRIES = 50_000
_WARNING_INTERVAL_SECONDS = 60.0
_LOOKUP_BACKOFF_SECONDS = 5.0
# Failures in a row, from any keys, that read as the database failing rather
# than one bad row or tenant. A success between them resets the count.
_FAILURES_TO_PAUSE_ALL = 3
# Inside `main._MESSAGE_TELEMETRY_DRAIN_SECONDS`, leaving the rest of it for
# cancelling the worker.
_DRAIN_SECONDS = 0.3

# The transport's `ActorRole` as the catalogue's `sender_kind`. A system or
# bridge writer is Switch itself; `member` is a person in Switch Console, which
# the chat service reports rather than a transport.
_ROLE_KIND = {
    "human": "user",
    "agent": "agent",
    "system": "platform",
    "bridge": "platform",
    MEMBER_CLIENT_TYPE: "member",
}

# `clients.type` as `sender_kind`. `admin` is Switch's own client.
_CLIENT_TYPE_KIND = {
    HUMAN_CLIENT_TYPE: "user",
    MEMBER_CLIENT_TYPE: "member",
    AGENT_CLIENT_TYPE: "agent",
    "admin": "platform",
    "bridge": "platform",
}

# An agent whose runtime could not be looked up. Not `none`, which is a real
# answer: an agent that declares no runtime.
_UNKNOWN_RUNTIME = "unknown"


@dataclass(frozen=True)
class _RoomFacts:
    bridge_platform: str
    channel_type: str
    user_count: int | None
    agent_count: int | None
    # `true` / `false` / `unknown`: whether Switch Console made the room as a
    # chat, as a tri-state because a room whose lookup failed cannot say.
    console_chat: str


# A room whose lookup failed. Reported rather than dropped, so a lookup
# problem shows as `unknown` in the charts instead of as fewer messages. Its
# sizes are left off the event rather than reported as 0, which would read as
# an empty room, so an average of them skips it.
_UNKNOWN_ROOM = _RoomFacts(
    bridge_platform="unknown",
    channel_type="unknown",
    user_count=None,
    agent_count=None,
    console_chat="unknown",
)


def _people(members_by_type: dict[str, int]) -> int:
    """A room's people: those on a messaging platform and those in Switch
    Console. Someone who is both counts twice, as someone on two platforms
    does."""
    return members_by_type.get(HUMAN_CLIENT_TYPE, 0) + members_by_type.get(
        MEMBER_CLIENT_TYPE, 0
    )


@dataclass(frozen=True)
class _AgentAddressed:
    tenant_id: str
    room_id: str
    sender_transport_user_id: str
    from_platform: bool
    from_app: bool
    known_agent_type: str
    agent_live: bool
    has_attachment: bool


class _TtlCache[K, V]:
    """Least-recently-used, with entries expiring after a fixed age."""

    def __init__(self, ttl_seconds: float, max_entries: int) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._entries: OrderedDict[K, tuple[float, V]] = OrderedDict()

    def get(self, key: K) -> V | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if expires_at < time.monotonic():
            del self._entries[key]
            return None
        self._entries.move_to_end(key)
        return value

    def put(self, key: K, value: V) -> None:
        self._entries[key] = (time.monotonic() + self._ttl, value)
        self._entries.move_to_end(key)
        while len(self._entries) > self._max:
            self._entries.popitem(last=False)


class MessageTelemetry:
    """Reports `message_sent` and `agent_message_received`.

    The transport's `ParticipantMessageObserver`, and what the router tells
    once a message addressed to an agent has committed. Does nothing at all
    (no queue, no lookups) while telemetry is off.
    """

    def __init__(
        self,
        *,
        telemetry: TelemetryService,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._telemetry = telemetry
        self._session_factory = session_factory
        self._queue: asyncio.Queue[ParticipantMessage | _AgentAddressed] = (
            asyncio.Queue(maxsize=_QUEUE_SIZE)
        )
        self._worker: asyncio.Task[None] | None = None
        self._closed = False
        self._rooms: _TtlCache[tuple[str, str], _RoomFacts] = _TtlCache(
            _ROOM_TTL_SECONDS, _CACHE_MAX_ENTRIES
        )
        self._sender_kinds: _TtlCache[tuple[str, str], str] = _TtlCache(
            _IDENTITY_TTL_SECONDS, _CACHE_MAX_ENTRIES
        )
        self._agent_runtimes: _TtlCache[tuple[str, str], str] = _TtlCache(
            _IDENTITY_TTL_SECONDS, _CACHE_MAX_ENTRIES
        )
        # Keys whose lookup failed, as `(lookup, tenant_id, id)`, until they
        # may be tried again.
        self._failed_lookups: _TtlCache[tuple[str, str, str], bool] = _TtlCache(
            _LOOKUP_BACKOFF_SECONDS, _CACHE_MAX_ENTRIES
        )
        self._failures_in_a_row = 0
        self._all_lookups_resume_at: float | None = None
        # When each tenant may next be read whole (`_read_tenant`), on the
        # monotonic clock.
        self._tenants_read: dict[str, float] = {}
        # Taken off the queue and not yet reported. Not `qsize`, which leaves
        # out the one the worker is cancelled in the middle of.
        self._in_hand = 0
        self._drops = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._late = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._report_failures = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._lookup_failures = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._lookup_pauses = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._lookup_misses = WarningThrottle(_WARNING_INTERVAL_SECONDS)

    @property
    def enabled(self) -> bool:
        """Whether anything handed over is reported. A caller with work to do
        only for telemetry can skip it while this is false."""
        return self._telemetry.enabled

    # ── Called on the sender's path ──────────────────────────────────────────

    def observe(self, message: ParticipantMessage) -> None:
        """A participant said something in a room."""
        self._enqueue(message)

    def agent_addressed(
        self,
        *,
        tenant_id: str,
        room_id: str,
        sender_transport_user_id: str,
        from_platform: bool,
        from_app: bool,
        agent_metadata: dict | None,
        agent_live: bool,
        has_attachment: bool,
    ) -> None:
        """A message was addressed to an agent and let through its addressing
        policy and budget. `agent_live` is whether the agent had a live session
        for the room when it arrived.

        The runtime is read from `agent_metadata` here rather than by the
        worker, so the queue holds a value and not the agent's own dict.
        """
        self._enqueue(
            _AgentAddressed(
                tenant_id=tenant_id,
                room_id=room_id,
                sender_transport_user_id=sender_transport_user_id,
                from_platform=from_platform,
                from_app=from_app,
                known_agent_type=normalise_known_agent_type(agent_metadata),
                agent_live=agent_live,
                has_attachment=has_attachment,
            )
        )

    def _enqueue(self, item: ParticipantMessage | _AgentAddressed) -> None:
        if not self._telemetry.enabled:
            return
        if self._closed:
            # Senders still run while shutdown drains, and what they say then
            # is lost; counted, so a low figure for the last minute has a cause.
            if (late := self._late.note()) is not None:
                logger.warning(
                    "%d message event(s) arrived after message telemetry shut "
                    "down and were dropped.",
                    late,
                )
            return
        if self._worker is None or self._worker.done():
            # Before the put, so a worker that ended with the queue full is
            # replaced rather than leaving every later event to be dropped.
            # A fresh context: started from whichever sender enqueued first, it
            # would otherwise carry that sender's tenant and log fields for its
            # whole life.
            self._worker = asyncio.get_running_loop().create_task(
                self._run(), context=contextvars.Context()
            )
        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            if (dropped := self._drops.note()) is not None:
                self._warn_dropped(dropped)

    @staticmethod
    def _warn_dropped(dropped: int) -> None:
        logger.warning(
            "Message telemetry is behind: %d event(s) dropped because %d were "
            "already queued. Message counts in analytics will read low.",
            dropped,
            _QUEUE_SIZE,
        )

    # ── The worker ───────────────────────────────────────────────────────────

    async def _run(self) -> None:
        while True:
            item = await self._queue.get()
            self._in_hand += 1
            try:
                await self._report(item)
            except Exception:
                # One bad event must not stop the rest being reported, and a
                # bug that breaks every event must not log once per message.
                if (failures := self._report_failures.note()) is not None:
                    logger.error(
                        "Could not report a message event; %d event(s) dropped "
                        "this way since the last error.",
                        failures,
                        exc_info=True,
                    )
            finally:
                self._queue.task_done()
            # Not in the `finally`: an event the shutdown cancels mid-report
            # was never reported, and leaving it counted is what says so.
            self._in_hand -= 1

    async def _report(self, item: ParticipantMessage | _AgentAddressed) -> None:
        if isinstance(item, _AgentAddressed):
            await self._report_addressed(item)
        else:
            await self._report_message(item)

    async def _report_message(self, message: ParticipantMessage) -> None:
        room = await self._room_facts(message.tenant_id, message.room_id)
        self._telemetry.emit(
            "message_sent",
            sender_kind=(
                "bot"
                if message.sender_is_app
                else _ROLE_KIND.get(message.sender_role, "unknown")
            ),
            known_agent_type=(
                await self._agent_runtime(message.tenant_id, message.sender_client_id)
                if message.sender_role == "agent"
                else None
            ),
            bridge_platform=room.bridge_platform,
            channel_type=room.channel_type,
            console_chat=room.console_chat,
            room_user_count=room.user_count,
            room_agent_count=room.agent_count,
            has_attachment=message.has_attachment,
            in_thread=message.in_thread,
        )

    async def _report_addressed(self, item: _AgentAddressed) -> None:
        room = await self._room_facts(item.tenant_id, item.room_id)
        if item.from_platform:
            sender_kind = "platform"
        elif item.from_app:
            sender_kind = "bot"
        else:
            sender_kind = await self._sender_kind(
                item.tenant_id, item.sender_transport_user_id
            )
        self._telemetry.emit(
            "agent_message_received",
            sender_kind=sender_kind,
            known_agent_type=item.known_agent_type,
            bridge_platform=room.bridge_platform,
            channel_type=room.channel_type,
            console_chat=room.console_chat,
            has_attachment=item.has_attachment,
            agent_live=item.agent_live,
        )

    async def aclose(self) -> None:
        """Report what is already queued, briefly, then stop."""
        self._closed = True
        try:
            if self._worker is not None:
                try:
                    async with asyncio.timeout(_DRAIN_SECONDS):
                        await self._queue.join()
                except TimeoutError:
                    pass
                finally:
                    self._worker.cancel()
                # `wait` rather than awaiting the task: it does not raise the
                # worker's own cancellation, so nothing here has to suppress
                # one, and a cancellation aimed at this caller — the shutdown
                # timeout — still reaches it. Outside the `finally`, so a
                # cancellation that lands during the drain is not followed by
                # an unbounded wait.
                await asyncio.wait({self._worker})
        finally:
            self._report_unsent()

    def _report_unsent(self) -> None:
        """Say what shutdown could not report. Run from a `finally`, so the
        caller's timeout cutting `aclose` off still leaves the count."""
        if unreported := self._queue.qsize() + self._in_hand:
            logger.warning(
                "%d message event(s) still queued at shutdown were dropped.",
                unreported,
            )
        if dropped := self._drops.take_pending():
            self._warn_dropped(dropped)
        if late := self._late.take_pending():
            logger.warning(
                "%d more message event(s) arrived after message telemetry shut "
                "down and were dropped.",
                late,
            )
        if failures := self._report_failures.take_pending():
            logger.error(
                "%d more message event(s) could not be reported since the last "
                "error and were dropped.",
                failures,
            )

    # ── Lookups ──────────────────────────────────────────────────────────────

    def _may_look_up(self, key: tuple[str, str, str]) -> bool:
        """Whether `key` may be looked up now: neither it nor the database as a
        whole failed within the last `_LOOKUP_BACKOFF_SECONDS`."""
        if (
            self._all_lookups_resume_at is not None
            and time.monotonic() < self._all_lookups_resume_at
        ):
            return False
        return self._failed_lookups.get(key) is None

    def _lookup_answered(self) -> None:
        """The database answered, whether or not it found anything."""
        self._failures_in_a_row = 0

    def _lookup_failed(self, key: tuple[str, str, str], what: str) -> None:
        """Back off after a failed lookup, and say so at most once a minute.

        Called from inside the `except` block, so the warning carries the
        traceback of the failure that triggered it.
        """
        self._failed_lookups.put(key, True)
        self._failures_in_a_row += 1
        if (failures := self._lookup_failures.note()) is not None:
            logger.warning(
                "Message telemetry could not look up %s, so events report it as "
                "unknown and it is not looked up again for %.0fs; %d lookup(s) "
                "failed since the last warning.",
                what,
                _LOOKUP_BACKOFF_SECONDS,
                failures,
                exc_info=True,
            )
        # Not reset when it trips: while the database stays down, the first
        # lookup after each pause fails and starts the next one at once.
        if self._failures_in_a_row >= _FAILURES_TO_PAUSE_ALL:
            self._all_lookups_resume_at = time.monotonic() + _LOOKUP_BACKOFF_SECONDS
            if (pauses := self._lookup_pauses.note()) is not None:
                logger.warning(
                    "Message telemetry lookups failed %d times in a row, so every "
                    "lookup pauses for %.0fs and events report the rooms and "
                    "senders they need as unknown; %d pause(s) since the last "
                    "warning.",
                    self._failures_in_a_row,
                    _LOOKUP_BACKOFF_SECONDS,
                    pauses,
                )

    def _lookup_missed(self, what: str) -> None:
        if (misses := self._lookup_misses.note()) is not None:
            logger.warning(
                "Message telemetry found no %s, so events report it as unknown; "
                "%d lookup(s) found nothing since the last warning.",
                what,
                misses,
            )

    async def _read_tenant(self, tenant_id: str) -> None:
        """Read the facts of every open room, the kind of every client and the
        runtime of every agent of the tenant at once, the first time a lookup
        of it misses, and again once `_ROOM_TTL_SECONDS` have passed.

        In a workspace of thousands of agents and rooms, a process reports a
        message about most of them before it reports a second one, so with one
        lookup each a cache that kept every answer still missed for most
        messages. A read that fails raises, and the lookup that asked counts
        it as its own failure; it is tried again once a failed lookup would be.
        """
        next_read = self._tenants_read.get(tenant_id)
        if next_read is not None and time.monotonic() < next_read:
            return
        # Not again for as long as a failed lookup waits; a read that succeeds
        # puts it off for as long as a room is kept, below.
        self._tenants_read[tenant_id] = time.monotonic() + _LOOKUP_BACKOFF_SECONDS
        async with tenant_session(self._session_factory, tenant_id) as session:
            open_room = and_(Room.tenant_id == tenant_id, Room.archived_at.is_(None))
            rooms = (
                await session.execute(
                    select(
                        Room.id,
                        Room.channel_type,
                        CollaborationBridge.type,
                        Room.metadata_.has_key(CHAT_OPERATION_ID_KEY),
                    )
                    .select_from(Room)
                    .outerjoin(
                        CollaborationBridge,
                        and_(
                            CollaborationBridge.id == Room.bridge_id,
                            CollaborationBridge.tenant_id == tenant_id,
                        ),
                    )
                    .where(open_room)
                )
            ).all()
            members = (
                await session.execute(
                    select(ClientRoom.room_id, Client.type, func.count())
                    .select_from(ClientRoom)
                    .join(Client, Client.id == ClientRoom.client_id)
                    .join(Room, Room.id == ClientRoom.room_id)
                    .where(
                        ClientRoom.tenant_id == tenant_id,
                        Client.tenant_id == tenant_id,
                        open_room,
                    )
                    .group_by(ClientRoom.room_id, Client.type)
                )
            ).all()
            clients = (
                await session.execute(
                    select(Client.transport_user_id, Client.type).where(
                        Client.tenant_id == tenant_id
                    )
                )
            ).all()
            agents = (
                await session.execute(
                    select(
                        Agent.client_id,
                        Agent.metadata_["known_agent_type"].astext,
                    ).where(Agent.tenant_id == tenant_id)
                )
            ).all()
        self._tenants_read[tenant_id] = time.monotonic() + _ROOM_TTL_SECONDS
        by_room: dict[str, dict[str, int]] = {}
        for room_id, client_type, count in members:
            by_room.setdefault(room_id, {})[client_type] = int(count)
        for room_id, channel_type, platform, console_chat in rooms:
            by_type = by_room.get(room_id, {})
            self._rooms.put(
                (tenant_id, room_id),
                _RoomFacts(
                    bridge_platform=normalise_platform(platform),
                    channel_type=normalise_channel_type(channel_type),
                    user_count=_people(by_type),
                    agent_count=by_type.get(AGENT_CLIENT_TYPE, 0),
                    console_chat="true" if console_chat else "false",
                ),
            )
        for transport_user_id, client_type in clients:
            self._sender_kinds.put(
                (tenant_id, transport_user_id),
                _CLIENT_TYPE_KIND.get(client_type, "unknown"),
            )
        for client_id, known_agent_type in agents:
            self._agent_runtimes.put(
                (tenant_id, client_id),
                normalise_known_agent_type(
                    None
                    if known_agent_type is None
                    else {"known_agent_type": known_agent_type}
                ),
            )

    async def _room_facts(self, tenant_id: str, room_id: str) -> _RoomFacts:
        key = (tenant_id, room_id)
        cached = self._rooms.get(key)
        if cached is not None:
            return cached
        failure_key = ("room", tenant_id, room_id)
        if not self._may_look_up(failure_key):
            return _UNKNOWN_ROOM
        try:
            await self._read_tenant(tenant_id)
        except Exception:
            self._lookup_failed(failure_key, f"room {room_id}")
            return _UNKNOWN_ROOM
        cached = self._rooms.get(key)
        if cached is not None:
            return cached
        try:
            facts = await self._load_room_facts(tenant_id, room_id)
        except Exception:
            self._lookup_failed(failure_key, f"room {room_id}")
            return _UNKNOWN_ROOM
        self._lookup_answered()
        if facts is None:
            self._lookup_missed(f"room {room_id}")
            self._rooms.put(key, _UNKNOWN_ROOM)
            return _UNKNOWN_ROOM
        self._rooms.put(key, facts)
        return facts

    async def _load_room_facts(self, tenant_id: str, room_id: str) -> _RoomFacts | None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            row = (
                await session.execute(
                    select(
                        Room.channel_type,
                        CollaborationBridge.type,
                        Room.metadata_.has_key(CHAT_OPERATION_ID_KEY),
                    )
                    .select_from(Room)
                    .outerjoin(
                        CollaborationBridge,
                        and_(
                            CollaborationBridge.id == Room.bridge_id,
                            CollaborationBridge.tenant_id == tenant_id,
                        ),
                    )
                    .where(Room.tenant_id == tenant_id, Room.id == room_id)
                )
            ).one_or_none()
            if row is None:
                return None
            members = await session.execute(
                select(Client.type, func.count())
                .select_from(ClientRoom)
                .join(Client, Client.id == ClientRoom.client_id)
                .where(
                    ClientRoom.tenant_id == tenant_id,
                    ClientRoom.room_id == room_id,
                    Client.tenant_id == tenant_id,
                )
                .group_by(Client.type)
            )
            by_type = {client_type: int(count) for client_type, count in members.all()}
        channel_type, platform, console_chat = row
        return _RoomFacts(
            bridge_platform=normalise_platform(platform),
            channel_type=normalise_channel_type(channel_type),
            user_count=_people(by_type),
            agent_count=by_type.get(AGENT_CLIENT_TYPE, 0),
            console_chat="true" if console_chat else "false",
        )

    async def _sender_kind(self, tenant_id: str, transport_user_id: str) -> str:
        key = (tenant_id, transport_user_id)
        cached = self._sender_kinds.get(key)
        if cached is not None:
            return cached
        failure_key = ("sender", tenant_id, transport_user_id)
        if not self._may_look_up(failure_key):
            return "unknown"
        try:
            await self._read_tenant(tenant_id)
        except Exception:
            self._lookup_failed(failure_key, "a message sender")
            return "unknown"
        cached = self._sender_kinds.get(key)
        if cached is not None:
            return cached
        try:
            async with tenant_session(self._session_factory, tenant_id) as session:
                client_type = (
                    await session.execute(
                        select(Client.type).where(
                            Client.tenant_id == tenant_id,
                            Client.transport_user_id == transport_user_id,
                        )
                    )
                ).scalar_one_or_none()
        except Exception:
            self._lookup_failed(failure_key, "a message sender")
            return "unknown"
        self._lookup_answered()
        if client_type is None:
            self._lookup_missed("client for a message sender")
            self._sender_kinds.put(key, "unknown")
            return "unknown"
        kind = _CLIENT_TYPE_KIND.get(client_type, "unknown")
        self._sender_kinds.put(key, kind)
        return kind

    async def _agent_runtime(self, tenant_id: str, client_id: str) -> str:
        key = (tenant_id, client_id)
        cached = self._agent_runtimes.get(key)
        if cached is not None:
            return cached
        failure_key = ("agent", tenant_id, client_id)
        if not self._may_look_up(failure_key):
            return _UNKNOWN_RUNTIME
        try:
            await self._read_tenant(tenant_id)
        except Exception:
            self._lookup_failed(failure_key, "an agent's runtime")
            return _UNKNOWN_RUNTIME
        cached = self._agent_runtimes.get(key)
        if cached is not None:
            return cached
        try:
            async with tenant_session(self._session_factory, tenant_id) as session:
                result = await session.execute(
                    select(Agent.metadata_).where(
                        Agent.tenant_id == tenant_id, Agent.client_id == client_id
                    )
                )
                row = result.one_or_none()
        except Exception:
            self._lookup_failed(failure_key, "an agent's runtime")
            return _UNKNOWN_RUNTIME
        self._lookup_answered()
        if row is None:
            self._lookup_missed(f"agent for client {client_id}")
            self._agent_runtimes.put(key, _UNKNOWN_RUNTIME)
            return _UNKNOWN_RUNTIME
        runtime = normalise_known_agent_type(row[0])
        self._agent_runtimes.put(key, runtime)
        return runtime
