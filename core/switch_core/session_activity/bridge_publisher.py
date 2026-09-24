"""Puts session activity and approval requests on one bridge's platform.

Pushed, not scanned: `SessionActivityListener` hands every change for the
bridge's tenant to `_on_change`, which only queues a key. A task of this
bridge's own drains the queue and does the platform work, so a slow or rate
limited platform never holds up the listener's other subscribers.

A key queued while the same key is still waiting is dropped, and each key is
handled by reading the rows as they are now. So a burst of tool calls in one
turn costs one redraw of its status message rather than one per line, and a
request answered before its card was posted is posted already answered — or,
if it is no longer open, not at all.

Per request, the card lives in `approval_request_posts`: `token` rides in the
controls and `handle` (`A<n>`) is what a person types. The reservation is
committed before the platform call, with `external_post_id` null, so a process
that dies mid-post leaves a card marked unconfirmed rather than one posted twice.

Per turn, one status message lives in `turn_status_posts`, edited as the turn
goes and left showing how it ended.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
    RichContentFailed,
    RichContentThrottled,
    ThreadUnavailable,
)
from switch_core.db.models import (
    Agent,
    ApprovalRequest,
    ApprovalRequestPost,
    BridgeMessageMap,
    Room,
    SessionActivityEvent,
    TurnStatusPost,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.session_activity_post_store import (
    ApprovalRequestPostStore,
    TurnStatusPostStore,
)
from switch_core.db.stores.session_activity_store import (
    ApprovalRequestStore,
    SessionActivityStore,
)
from switch_core.session_activity.cards import answerer_of, approval_card
from switch_core.session_activity.listener import Change, SessionActivityListener

logger = logging.getLogger(__name__)

HANDLE_PREFIX = "A"
_MINT_ATTEMPTS = 5
_HANDLE_CONSTRAINT = "uq_approval_request_posts_handle"
# An inbound message and the card answering it can race: the platform post a
# thread hangs off is mapped only once the inbound relay commits. Waited out a
# few times before the card goes to the channel root instead.
_THREAD_WAIT_SECONDS = 1.0
_THREAD_WAIT_ATTEMPTS = 5
# How far back a resync redraws settled cards. A resync means announcements may
# have been lost; one lost a while ago has had its card corrected by a later
# resync already, and redrawing every settled card on each start would spend a
# platform's rate budget on cards nobody is looking at.
_RESYNC_SETTLED_WINDOW = timedelta(minutes=15)
_STATUS_SUMMARY_CHARS = 300


@dataclass(frozen=True)
class _Target:
    channel_id: str
    thread_ref: str | None
    agent_name: str


class _ThreadNotMappedYet(Exception):
    pass


_Key = tuple[str, ...]
_RESYNC: _Key = ("resync",)


class SessionActivityBridgePublisher:
    def __init__(
        self,
        *,
        adapter: CollaborationAdapter,
        bridge_id: str,
        tenant_id: str,
        listener: SessionActivityListener,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._adapter = adapter
        self._bridge_id = bridge_id
        self._tenant_id = tenant_id
        self._listener = listener
        self._sessions = session_factory
        self._approvals = ApprovalRequestStore()
        self._rooms = RoomStore()
        self._activity = SessionActivityStore()
        self._card_posts = ApprovalRequestPostStore()
        self._turn_posts = TurnStatusPostStore()
        self._queue: asyncio.Queue[_Key] = asyncio.Queue()
        self._pending: set[_Key] = set()
        self._thread_waits: dict[_Key, int] = {}
        self._task: asyncio.Task[None] | None = None
        self._unsubscribe: Callable[[], None] | None = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._task is not None:
            raise RuntimeError("SessionActivityBridgePublisher is already started")
        self._unsubscribe = self._listener.subscribe(
            self._tenant_id, self._on_change, self._on_resync
        )
        self._task = asyncio.create_task(
            self._run(), name=f"session-activity-bridge-{self._bridge_id}"
        )
        # The listener resyncs its subscribers when it connects, which may have
        # happened before this bridge started.
        self._enqueue(_RESYNC)

    async def stop(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    # ── Listener callbacks: queue only ────────────────────────────────────────

    async def _on_change(self, change: Change) -> None:
        if change.kind.startswith("approval."):
            self._enqueue(("approval", change.agent_id, change.session_id, change.key))
        elif change.kind == "activity":
            if change.row is None:
                self._enqueue(
                    ("activity", change.agent_id, change.session_id, change.key)
                )
            elif change.row.get("turn_id") is not None:
                self._enqueue(
                    (
                        "turn",
                        change.agent_id,
                        change.session_id,
                        str(change.row["turn_id"]),
                    )
                )

    async def _on_resync(self) -> None:
        self._enqueue(_RESYNC)

    def _enqueue(self, key: _Key) -> None:
        if key in self._pending:
            return
        self._pending.add(key)
        self._queue.put_nowait(key)

    def _enqueue_later(self, key: _Key, delay: float) -> None:
        asyncio.get_running_loop().call_later(delay, self._enqueue, key)

    # ── The bridge's own task ─────────────────────────────────────────────────

    async def _run(self) -> None:
        while True:
            key = await self._queue.get()
            self._pending.discard(key)
            try:
                await self._handle(key)
            except asyncio.CancelledError:
                raise
            except RichContentThrottled as throttled:
                logger.warning(
                    "%s asked bridge %s to wait %.1fs; retrying %s then.",
                    self._adapter.platform_name,
                    self._bridge_id,
                    throttled.retry_after,
                    key,
                )
                self._enqueue_later(key, throttled.retry_after)
            except _ThreadNotMappedYet:
                self._enqueue_later(key, _THREAD_WAIT_SECONDS)
            except Exception:
                # The delivery loop: one key failing must not stop the rest.
                logger.exception(
                    "Could not publish %s on bridge %s", key, self._bridge_id
                )

    async def _handle(self, key: _Key) -> None:
        kind = key[0]
        if kind == "resync":
            await self._resync()
        elif kind == "approval":
            await self._publish_approval(key, key[1], key[2], key[3])
        elif kind == "turn":
            await self._publish_turn(key, key[1], key[2], key[3])
        elif kind == "activity":
            await self._resolve_activity(key[1], key[2], int(key[3]))
        else:
            raise ValueError(f"Unknown publication key {key!r}")

    async def _resync(self) -> None:
        since = datetime.now(UTC) - _RESYNC_SETTLED_WINDOW
        async with tenant_session(self._sessions, self._tenant_id) as db:
            posted = exists().where(
                ApprovalRequestPost.bridge_id == self._bridge_id,
                ApprovalRequestPost.agent_id == ApprovalRequest.agent_id,
                ApprovalRequestPost.session_id == ApprovalRequest.session_id,
                ApprovalRequestPost.request_id == ApprovalRequest.request_id,
            )
            requests = (
                await db.execute(
                    select(
                        ApprovalRequest.agent_id,
                        ApprovalRequest.session_id,
                        ApprovalRequest.request_id,
                    )
                    .join(Room, Room.id == ApprovalRequest.room_id)
                    .where(
                        Room.bridge_id == self._bridge_id,
                        or_(
                            ApprovalRequest.state == "open",
                            and_(ApprovalRequest.updated_at >= since, posted),
                        ),
                    )
                )
            ).all()
            turns = await self._turn_posts.unfinished(db, self._bridge_id)
        for agent_id, session_id, request_id in requests:
            self._enqueue(("approval", agent_id, session_id, request_id))
        for turn in turns:
            self._enqueue(("turn", turn.agent_id, turn.session_id, turn.turn_id))

    async def _resolve_activity(self, agent_id: str, session_id: str, seq: int) -> None:
        """An activity line announced without its row: find which turn it moved."""
        async with tenant_session(self._sessions, self._tenant_id) as db:
            event = await self._activity.get(db, agent_id, session_id, seq)
        if event is not None and event.turn_id is not None:
            self._enqueue(("turn", agent_id, session_id, event.turn_id))

    # ── Where a room's publications go ────────────────────────────────────────

    async def _target(
        self,
        db: AsyncSession,
        key: _Key,
        agent_id: str,
        room_id: str,
        thread_id: str | None,
    ) -> _Target | None:
        """The channel and thread for a room on this bridge, or None if it is not on it."""
        found = await self._rooms.get_with_membership(db, room_id, agent_id)
        if found is None or found[0].bridge_id != self._bridge_id:
            return None
        room, member = found
        if not room.external_channel_id:
            logger.warning(
                "Room %s is on bridge %s but has no channel; nothing is published there.",
                room_id,
                self._bridge_id,
            )
            return None
        agent = await db.get(Agent, agent_id)
        if agent is None:
            return None
        if not member:
            logger.warning(
                "Not publishing for agent %s in room %s: it is no longer a member.",
                agent.name,
                room_id,
            )
            return None
        return _Target(
            channel_id=room.external_channel_id,
            thread_ref=await self._thread_ref(
                db, key, room.external_channel_id, thread_id
            ),
            agent_name=agent.name,
        )

    async def _thread_ref(
        self, db: AsyncSession, key: _Key, channel_id: str, thread_id: str | None
    ) -> str | None:
        if thread_id is None:
            return None
        external_post_id = await db.scalar(
            select(BridgeMessageMap.external_post_id).where(
                BridgeMessageMap.bridge_id == self._bridge_id,
                BridgeMessageMap.external_channel_id == channel_id,
                BridgeMessageMap.transport_event_id == thread_id,
            )
        )
        if external_post_id is not None:
            self._thread_waits.pop(key, None)
            return external_post_id
        waited = self._thread_waits.get(key, 0)
        if waited < _THREAD_WAIT_ATTEMPTS:
            self._thread_waits[key] = waited + 1
            raise _ThreadNotMappedYet(thread_id)
        self._thread_waits.pop(key, None)
        logger.warning(
            "Switch message %s has no post in channel %s on bridge %s; "
            "publishing %s at the channel root instead of in its thread.",
            thread_id,
            channel_id,
            self._bridge_id,
            key,
        )
        return None

    # ── Approval cards ────────────────────────────────────────────────────────

    async def _publish_approval(
        self, key: _Key, agent_id: str, session_id: str, request_id: str
    ) -> None:
        async with tenant_session(self._sessions, self._tenant_id) as db:
            row = await self._approvals.get(
                db, agent_id, session_id, request_id, for_update=False
            )
            if row is None or row.room_id is None:
                return
            post = await self._card_posts.get(
                db, self._bridge_id, agent_id, session_id, request_id, for_update=False
            )
            if post is None and row.state != "open":
                return
            target = await self._target(db, key, agent_id, row.room_id, row.thread_id)
            if target is None:
                return
            decided_by, responder = await answerer_of(db, row, self._bridge_id)
            db.expunge_all()
        if post is None:
            await self._post_card(row, target)
            return
        if post.external_post_id is None:
            recovered = await self._recover_card(post)
            if recovered is None:
                return
            post = recovered
        assert post.external_post_id is not None
        await self._adapter.update_rich(
            post.external_channel_id,
            target.agent_name,
            post.external_post_id,
            approval_card(
                row, post, decided_by=decided_by, responder_external_id=responder
            ),
            post.thread_ref,
        )

    async def _post_card(self, row: ApprovalRequest, target: _Target) -> None:
        post = await self._reserve(row, target)
        if post is None:
            return
        card = approval_card(row, post, decided_by=None, responder_external_id=None)
        thread_ref = target.thread_ref
        try:
            try:
                ref = await self._adapter.post_rich(
                    target.channel_id, target.agent_name, card, thread_ref
                )
            except ThreadUnavailable as missing:
                logger.warning(
                    "No thread for request %s in channel %s (%s); posting its "
                    "card at the channel root.",
                    row.request_id,
                    target.channel_id,
                    missing,
                )
                thread_ref = None
                ref = await self._adapter.post_rich(
                    target.channel_id, target.agent_name, card, None
                )
        except RichContentFailed:
            await self._release(post)
            raise
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._card_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.request_id,
                for_update=True,
            )
            if stored is None:
                logger.error(
                    "Posted card %s for request %s in channel %s, but its "
                    "reservation is gone, so the card answers nothing.",
                    post.handle,
                    post.request_id,
                    target.channel_id,
                )
                return
            stored.external_post_id = ref
            stored.thread_ref = thread_ref
        logger.info(
            "Posted card %s for request %s of session %s in channel %s",
            post.handle,
            row.request_id,
            row.session_id,
            target.channel_id,
        )

    async def _reserve(
        self, row: ApprovalRequest, target: _Target
    ) -> ApprovalRequestPost | None:
        """Hold a handle nobody else in the channel has. None if another poster got there first."""
        token = secrets.token_urlsafe(16)
        async with tenant_session(self._sessions, self._tenant_id) as db:
            start = await self._card_posts.count_in_channel(
                db, self._bridge_id, target.channel_id
            )
            for attempt in range(_MINT_ATTEMPTS):
                post = ApprovalRequestPost(
                    tenant_id=self._tenant_id,
                    bridge_id=self._bridge_id,
                    agent_id=row.agent_id,
                    session_id=row.session_id,
                    request_id=row.request_id,
                    token=token,
                    handle=f"{HANDLE_PREFIX}{start + 1 + attempt}",
                    external_channel_id=target.channel_id,
                    external_post_id=None,
                    thread_ref=target.thread_ref,
                )
                try:
                    async with db.begin_nested():
                        await self._card_posts.create(db, post)
                except IntegrityError as error:
                    if _HANDLE_CONSTRAINT in str(error.orig):
                        continue
                    existing = await self._card_posts.get(
                        db,
                        self._bridge_id,
                        row.agent_id,
                        row.session_id,
                        row.request_id,
                        for_update=False,
                    )
                    if existing is None:
                        raise
                    return None
                await db.commit()
                return post
        raise RuntimeError(
            f"No free handle for request {row.request_id} in channel "
            f"{target.channel_id} after {_MINT_ATTEMPTS} tries; it has no card, "
            "because a card nobody can name cannot be answered by typing."
        )

    async def _release(self, post: ApprovalRequestPost) -> None:
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._card_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.request_id,
                for_update=True,
            )
            if stored is not None and stored.external_post_id is None:
                await db.delete(stored)

    async def _recover_card(
        self, post: ApprovalRequestPost
    ) -> ApprovalRequestPost | None:
        """Bind a card whose post was never confirmed to what is on the platform; never repost."""
        ref = await self._adapter.find_request_card(
            post.external_channel_id,
            post.thread_ref,
            post.token,
            post.created_at,
            post.handle,
        )
        if ref is None:
            logger.error(
                "Card %s for request %s in channel %s was never confirmed and "
                "cannot be found on %s. It is not posted again, to avoid asking "
                "twice; the request can still be answered in Switch Console.",
                post.handle,
                post.request_id,
                post.external_channel_id,
                self._adapter.platform_name,
            )
            return None
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._card_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.request_id,
                for_update=True,
            )
            if stored is None:
                return None
            stored.external_post_id = ref
        post.external_post_id = ref
        return post

    # ── Turn status messages ──────────────────────────────────────────────────

    async def _publish_turn(
        self, key: _Key, agent_id: str, session_id: str, turn_id: str
    ) -> None:
        async with tenant_session(self._sessions, self._tenant_id) as db:
            events = await self._activity.turn(db, agent_id, session_id, turn_id)
            placed = next((e for e in events if e.room_id is not None), None)
            if placed is None or placed.room_id is None:
                return
            target = await self._target(
                db, key, agent_id, placed.room_id, placed.thread_id
            )
            if target is None:
                return
            post = await self._turn_posts.get(
                db, self._bridge_id, agent_id, session_id, turn_id
            )
            db.expunge_all()
        tool_calls = sum(1 for e in events if e.type == "tool.called")
        finished = any(e.type == "turn.finished" for e in events)
        text = self._adapter.translate_outbound(
            turn_status_text(events, tool_calls=tool_calls, finished=finished)
        )
        if post is not None:
            await self._adapter.update_message(
                post.external_channel_id, post.external_post_id, text
            )
            async with (
                tenant_session(self._sessions, self._tenant_id) as db,
                db.begin(),
            ):
                stored = await self._turn_posts.get(
                    db, self._bridge_id, agent_id, session_id, turn_id
                )
                if stored is not None:
                    stored.tool_calls = tool_calls
                    stored.finished = finished
            return
        ref = await self._adapter.send_message(
            target.channel_id, target.agent_name, text, target.thread_ref
        )
        if ref is None:
            raise RuntimeError(
                f"{self._adapter.platform_name} did not accept the status message "
                f"for turn {turn_id} of session {session_id} in channel "
                f"{target.channel_id}."
            )
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            await self._turn_posts.create(
                db,
                TurnStatusPost(
                    tenant_id=self._tenant_id,
                    bridge_id=self._bridge_id,
                    agent_id=agent_id,
                    session_id=session_id,
                    turn_id=turn_id,
                    external_channel_id=target.channel_id,
                    external_post_id=ref,
                    thread_ref=target.thread_ref,
                    tool_calls=tool_calls,
                    finished=finished,
                ),
            )


def turn_status_text(
    events: list[SessionActivityEvent], *, tool_calls: int, finished: bool
) -> str:
    """One turn's status line, in Switch Markdown: where it is, and the latest thing it did."""
    calls = f"{tool_calls} tool call{'' if tool_calls == 1 else 's'}"
    head = f"**Finished** · {calls}" if finished else f"**Working…** · {calls}"
    latest = events[-1].summary.strip() if events else ""
    if len(latest) > _STATUS_SUMMARY_CHARS:
        latest = latest[: _STATUS_SUMMARY_CHARS - 1].rstrip() + "…"
    return f"{head}\n{latest}" if latest else head
