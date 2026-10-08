"""The per-message events: what is said in rooms, and to and by agents.

Everything else in the catalogue fires a handful of times a day. These fire
once per message, so they are the only events where reporting could slow the
thing being reported on. Three rules keep it off that path:

- **The sender never waits.** The transport and the agent consumer hand over a
  small record and return. One worker task looks up what the event needs — the
  room's platform, type and membership, who the sender is — and emits.
- **Lookups are cached.** A busy room says a lot and changes membership
  rarely, so a room is read at most once per `_CACHE_TTL_SECONDS` rather than
  once per message. The member counts can therefore be that far behind.
- **A failing database is left alone.** After a lookup fails, lookups stop for
  `_LOOKUP_BACKOFF_SECONDS` and events report what they could not look up as
  `unknown`, and the failure is logged at most once a minute — rather than
  the worker retrying a struggling database, and logging a traceback, once per
  message.

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

from switch_core.db.models import Agent, Client, ClientRoom, CollaborationBridge, Room
from switch_core.db.session_scope import tenant_session
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.snapshot import (
    AGENT_CLIENT_TYPE,
    HUMAN_CLIENT_TYPE,
    normalise_channel_type,
    normalise_known_agent_type,
    normalise_platform,
)
from switch_core.telemetry.throttle import WarningThrottle
from switch_core.transport.observer import ParticipantMessage

logger = logging.getLogger(__name__)

_QUEUE_SIZE = 10_000
_CACHE_TTL_SECONDS = 300.0
_CACHE_MAX_ENTRIES = 10_000
_WARNING_INTERVAL_SECONDS = 60.0
_LOOKUP_BACKOFF_SECONDS = 5.0
# Inside `main._MESSAGE_TELEMETRY_DRAIN_SECONDS`, leaving the rest of it for
# cancelling the worker.
_DRAIN_SECONDS = 0.3

# The transport's `ActorRole` as the catalogue's `sender_kind`. A system or
# bridge writer is Switch itself.
_ROLE_KIND = {
    "human": "user",
    "agent": "agent",
    "system": "platform",
    "bridge": "platform",
}

# `clients.type` as `sender_kind`. `admin` is Switch's own client.
_CLIENT_TYPE_KIND = {
    HUMAN_CLIENT_TYPE: "user",
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
    user_count: int
    agent_count: int


# A room whose lookup failed. Reported rather than dropped, so a lookup
# problem shows as `unknown` in the charts instead of as fewer messages; -1
# rather than 0 so it cannot be read as an empty room. The catalogue has no
# empty value, so an average of the counts has to filter on
# `bridge_platform != unknown` — the docs say so.
_UNKNOWN_ROOM = _RoomFacts(
    bridge_platform="unknown", channel_type="unknown", user_count=-1, agent_count=-1
)


@dataclass(frozen=True)
class _AgentAddressed:
    tenant_id: str
    room_id: str
    sender_transport_user_id: str
    from_platform: bool
    agent_metadata: dict | None
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
    """Reports `room_message_sent`, `agent_message_sent` and
    `agent_message_received`.

    The transport's `ParticipantMessageObserver`, and what the agent consumer
    tells when a message is addressed to its agent. Does nothing at all — no
    queue, no lookups — while telemetry is off.
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
            _CACHE_TTL_SECONDS, _CACHE_MAX_ENTRIES
        )
        self._sender_kinds: _TtlCache[tuple[str, str], str] = _TtlCache(
            _CACHE_TTL_SECONDS, _CACHE_MAX_ENTRIES
        )
        self._agent_runtimes: _TtlCache[tuple[str, str], str] = _TtlCache(
            _CACHE_TTL_SECONDS, _CACHE_MAX_ENTRIES
        )
        self._drops = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._late = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._report_failures = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._lookup_failures = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._lookup_misses = WarningThrottle(_WARNING_INTERVAL_SECONDS)
        self._lookups_resume_at: float | None = None

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
        agent_metadata: dict | None,
        agent_live: bool,
        has_attachment: bool,
    ) -> None:
        """A message was addressed to an agent and let through its addressing
        policy and budget. `agent_live` is whether the agent had a live session
        for the room when it arrived."""
        self._enqueue(
            _AgentAddressed(
                tenant_id=tenant_id,
                room_id=room_id,
                sender_transport_user_id=sender_transport_user_id,
                from_platform=from_platform,
                agent_metadata=agent_metadata,
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

    async def _report(self, item: ParticipantMessage | _AgentAddressed) -> None:
        if isinstance(item, _AgentAddressed):
            await self._report_addressed(item)
        else:
            await self._report_message(item)

    async def _report_message(self, message: ParticipantMessage) -> None:
        room = await self._room_facts(message.tenant_id, message.room_id)
        self._telemetry.emit(
            "room_message_sent",
            sender_kind=_ROLE_KIND.get(message.sender_role, "unknown"),
            bridge_platform=room.bridge_platform,
            channel_type=room.channel_type,
            room_user_count=room.user_count,
            room_agent_count=room.agent_count,
            has_attachment=message.has_attachment,
            in_thread=message.in_thread,
        )
        if message.sender_role != "agent":
            return
        self._telemetry.emit(
            "agent_message_sent",
            known_agent_type=await self._agent_runtime(
                message.tenant_id, message.sender_client_id
            ),
            bridge_platform=room.bridge_platform,
            channel_type=room.channel_type,
            room_user_count=room.user_count,
            has_attachment=message.has_attachment,
            in_thread=message.in_thread,
        )

    async def _report_addressed(self, item: _AgentAddressed) -> None:
        room = await self._room_facts(item.tenant_id, item.room_id)
        sender_kind = (
            "platform"
            if item.from_platform
            else await self._sender_kind(item.tenant_id, item.sender_transport_user_id)
        )
        self._telemetry.emit(
            "agent_message_received",
            sender_kind=sender_kind,
            known_agent_type=normalise_known_agent_type(item.agent_metadata),
            bridge_platform=room.bridge_platform,
            channel_type=room.channel_type,
            has_attachment=item.has_attachment,
            agent_live=item.agent_live,
        )

    async def aclose(self) -> None:
        """Report what is already queued, briefly, then stop."""
        self._closed = True
        if self._worker is not None:
            try:
                async with asyncio.timeout(_DRAIN_SECONDS):
                    await self._queue.join()
            except TimeoutError:
                logger.warning(
                    "%d message event(s) still queued at shutdown were dropped.",
                    self._queue.qsize(),
                )
            finally:
                self._worker.cancel()
            # `wait` rather than awaiting the task: it does not raise the
            # worker's own cancellation, so nothing here has to suppress one,
            # and a cancellation aimed at this caller — the shutdown timeout —
            # still reaches it. Outside the `finally`, so a cancellation that
            # lands during the drain is not followed by an unbounded wait.
            await asyncio.wait({self._worker})
        if dropped := self._drops.take_pending():
            self._warn_dropped(dropped)
        if failures := self._report_failures.take_pending():
            logger.error(
                "%d more message event(s) could not be reported since the last "
                "error and were dropped.",
                failures,
            )

    # ── Lookups ──────────────────────────────────────────────────────────────

    def _lookups_suspended(self) -> bool:
        return (
            self._lookups_resume_at is not None
            and time.monotonic() < self._lookups_resume_at
        )

    def _lookup_failed(self, what: str) -> None:
        """Back off after a failed lookup, and say so at most once a minute.

        Called from inside the `except` block, so the warning carries the
        traceback of the failure that triggered it.
        """
        self._lookups_resume_at = time.monotonic() + _LOOKUP_BACKOFF_SECONDS
        if (failures := self._lookup_failures.note()) is not None:
            logger.warning(
                "Message telemetry could not look up %s, so events report it as "
                "unknown and lookups pause for %.0fs; %d lookup(s) failed since "
                "the last warning.",
                what,
                _LOOKUP_BACKOFF_SECONDS,
                failures,
                exc_info=True,
            )

    def _lookup_missed(self, what: str) -> None:
        if (misses := self._lookup_misses.note()) is not None:
            logger.warning(
                "Message telemetry found no %s, so events report it as unknown; "
                "%d lookup(s) found nothing since the last warning.",
                what,
                misses,
            )

    async def _room_facts(self, tenant_id: str, room_id: str) -> _RoomFacts:
        key = (tenant_id, room_id)
        cached = self._rooms.get(key)
        if cached is not None:
            return cached
        if self._lookups_suspended():
            return _UNKNOWN_ROOM
        try:
            facts = await self._load_room_facts(tenant_id, room_id)
        except Exception:
            self._lookup_failed(f"room {room_id}")
            return _UNKNOWN_ROOM
        if facts is None:
            self._lookup_missed(f"room {room_id}")
            return _UNKNOWN_ROOM
        self._rooms.put(key, facts)
        return facts

    async def _load_room_facts(self, tenant_id: str, room_id: str) -> _RoomFacts | None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            row = (
                await session.execute(
                    select(Room.channel_type, CollaborationBridge.type)
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
        channel_type, platform = row
        return _RoomFacts(
            bridge_platform=normalise_platform(platform),
            channel_type=normalise_channel_type(channel_type),
            user_count=by_type.get(HUMAN_CLIENT_TYPE, 0),
            agent_count=by_type.get(AGENT_CLIENT_TYPE, 0),
        )

    async def _sender_kind(self, tenant_id: str, transport_user_id: str) -> str:
        key = (tenant_id, transport_user_id)
        cached = self._sender_kinds.get(key)
        if cached is not None:
            return cached
        if self._lookups_suspended():
            return "unknown"
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
            self._lookup_failed("a message sender")
            return "unknown"
        if client_type is None:
            self._lookup_missed("client for a message sender")
            return "unknown"
        kind = _CLIENT_TYPE_KIND.get(client_type, "unknown")
        self._sender_kinds.put(key, kind)
        return kind

    async def _agent_runtime(self, tenant_id: str, client_id: str) -> str:
        key = (tenant_id, client_id)
        cached = self._agent_runtimes.get(key)
        if cached is not None:
            return cached
        if self._lookups_suspended():
            return _UNKNOWN_RUNTIME
        try:
            async with tenant_session(self._session_factory, tenant_id) as session:
                result = await session.execute(
                    select(Agent.metadata_).where(
                        Agent.tenant_id == tenant_id, Agent.client_id == client_id
                    )
                )
                row = result.one_or_none()
        except Exception:
            self._lookup_failed("an agent's runtime")
            return _UNKNOWN_RUNTIME
        if row is None:
            self._lookup_missed(f"agent for client {client_id}")
            return _UNKNOWN_RUNTIME
        runtime = normalise_known_agent_type(row[0])
        self._agent_runtimes.put(key, runtime)
        return runtime
