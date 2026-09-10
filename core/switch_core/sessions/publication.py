import asyncio
import logging
import time
from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.session.contract import Command, Snapshot
from switch_core.bridges.collaboration.session.outbound import (
    SessionRequestCards,
    SessionTurnActivity,
)
from switch_core.db.models import Agent, ClientRoom, Room, SdkSession, SdkSessionCommand
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.sessions.service import SessionError

logger = logging.getLogger(__name__)


def _always_recover(_token: str) -> bool:
    return True


def _ignore_recovery(_token: str) -> None:
    return None


def _always_refresh(_token: str, _state: tuple[int, str]) -> bool:
    return True


def _ignore_refresh(_token: str, _state: tuple[int, str]) -> None:
    return None


class PublicationIncomplete(Exception):
    """A session's requests were not all published this pass, and why.

    Distinct from `SessionError`, which names a request-level failure a
    caller over HTTP acts on: this is an internal signal `publish_pending`
    reads to decide how loudly to say so. `errors` is what actually broke —
    still worth an error-level log with a traceback; `backed_off` is requests
    still waiting out a recovery search's own backoff, which is working as
    designed and must not read as a fresh failure on every retry.
    """

    def __init__(
        self, session_id: str, errors: list[BaseException], backed_off: int
    ) -> None:
        self.session_id = session_id
        self.errors = errors
        self.backed_off = backed_off
        super().__init__(
            f"Session {session_id}: {len(errors)} request(s) failed to "
            f"publish and {backed_off} are waiting out a recovery backoff."
        )


async def refresh_cards(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    session_id: str,
    cards: SessionRequestCards,
    *,
    recovery_allowed: Callable[[str], bool] = _always_recover,
    recovery_succeeded: Callable[[str], None] = _ignore_recovery,
    refresh_needed: Callable[[str, tuple[int, str]], bool] = _always_refresh,
    refreshed: Callable[[str, tuple[int, str]], None] = _ignore_refresh,
) -> None:
    """Bring a session's cards up to date with its persisted requests.

    `recovery_allowed` gates `recover` — the search for a card whose post is
    unconfirmed — per token, and `recovery_succeeded` is told when one lands.
    `refresh_needed` gates redrawing an already-confirmed card, per token and
    `(revision, state)`, and `refreshed` is told once one lands. Both parts of
    that pair matter: `request.submitting` moves a request from `open` to
    `submitting` — swapping its buttons for "Answering: …" — at the *same*
    revision the answer was accepted at, only `request.settled` bumps it, so
    revision alone cannot tell a request that just changed state from one
    that has not changed at all. `SessionPublisher` passes backoff-backed
    versions of both pairs, so a card that genuinely never lands does not
    have this re-scan a channel's growing history every cycle forever, and a
    session stuck on one broken request does not have this redraw its
    unrelated, unchanged siblings on every retry either.

    Direct callers (tests, and anything that wants every card actually
    confirmed rather than trusted from memory — including a freshly started
    process, which has no memory to trust yet) get the defaults for both,
    which always act and track nothing: every confirmed card is compared
    against what is actually recorded for it, every time.
    """
    posts = SessionRequestPostStore()
    async with session_factory() as db:
        row = await db.get(SdkSession, session_id)
        if row is None:
            raise SessionError("NOT_FOUND", "Session not found.")
        snapshot = Snapshot.model_validate(row.snapshot)
        agent = await db.get(Agent, row.agent_id)
        if agent is None:
            raise SessionError("NOT_FOUND", "Session agent not found.")
        publications = []
        for request in snapshot.requests:
            turn = next(t for t in snapshot.turns if t.turn_id == request.turn_id)
            stored = await db.get(SdkSessionCommand, (row.id, turn.command_id))
            if stored is None:
                raise SessionError("NOT_FOUND", "Request has no source command.")
            origin = Command.model_validate(stored.command).origin
            if origin.room_id is None:
                continue
            room = await db.get(Room, origin.room_id)
            if room is None or room.bridge_id != bridge_id:
                continue
            if await db.get(ClientRoom, (agent.client_id, room.id)) is None:
                logger.warning(
                    "Skipping session %s request %s: agent left room %s.",
                    row.id,
                    request.request_id,
                    room.id,
                )
                continue
            if not room.external_channel_id:
                raise SessionError("NOT_FOUND", "Request room has no platform channel.")
            post = await posts.get_by_request(db, bridge_id, row.id, request.request_id)
            publications.append(
                (request, post, room.id, room.external_channel_id, origin.thread_id)
            )
        epoch = row.epoch
        agent_name = agent.name
        db.expunge_all()
    errors: list[BaseException] = []
    backed_off = 0
    for request, post, room_id, channel_id, thread_id in publications:
        state = (request.revision, request.state)
        try:
            if post is None:
                if request.state != "open":
                    continue
                new_post = await cards.post(
                    request,
                    channel_id=channel_id,
                    thread_root_id=thread_id,
                    room_id=room_id,
                    session_id=session_id,
                    epoch=epoch,
                    agent_name=agent_name,
                )
                refreshed(new_post.token, state)
            elif post.external_post_id == post.token:
                if not recovery_allowed(post.token):
                    backed_off += 1
                    continue
                post = await cards.recover(post)
                recovery_succeeded(post.token)
                await cards.refresh(post, request)
                refreshed(post.token, state)
            elif refresh_needed(post.token, state):
                await cards.refresh(post, request)
                refreshed(post.token, state)
        except Exception as error:
            # One request's card failing must not stop its siblings from
            # being tried: a session can have several open requests, and a
            # single stuck one previously aborted this loop before it reached
            # any that came after. Each is retried on its own next cycle
            # regardless — what this function reports below is what stops
            # `publish_pending` marking the session done while any request in
            # it is still broken or waiting out a recovery backoff.
            logger.exception(
                "Could not publish request %s of session %s on bridge %s; "
                "the rest of the session's requests were tried anyway.",
                request.request_id,
                session_id,
                bridge_id,
            )
            errors.append(error)
    if len(errors) == 1 and not backed_off:
        # The one exception a single-request session (by far the common
        # case) always had, preserved as itself rather than wrapped — a
        # caller matching on `CardNotPosted` or `RichContentFailed` still
        # can.
        raise errors[0]
    if errors or backed_off:
        raise PublicationIncomplete(session_id, errors, backed_off)


async def refresh_activity(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    session_id: str,
    activity: SessionTurnActivity,
    *,
    redraw_needed: Callable[[str, str, tuple[str, tuple[int, ...]]], bool],
    redrawn: Callable[[str, str, tuple[str, tuple[int, ...]]], None],
) -> None:
    """Bring a session's turn activity up to date with its persisted state.

    Unlike a request, a turn is not addressed to anyone and nothing resolves
    against it, so a turn with no room to reach — no command behind it yet, no
    origin, no membership, no channel — is skipped rather than treated as a
    broken invariant the way a request's missing origin is.

    `SessionTurnActivity.publish` never raises: a failed post or edit is
    logged and retried on the next call, not surfaced, so there is nothing
    here to aggregate the way `refresh_cards` aggregates card failures.
    `redraw_needed` exists only to stop a running turn's channel-root message
    being rewritten every cycle when nothing about it changed — a stream
    already skips sending a chunk it has already sent.
    """
    async with session_factory() as db:
        row = await db.get(SdkSession, session_id)
        if row is None:
            raise SessionError("NOT_FOUND", "Session not found.")
        snapshot = Snapshot.model_validate(row.snapshot)
        agent = await db.get(Agent, row.agent_id)
        if agent is None:
            raise SessionError("NOT_FOUND", "Session agent not found.")
        publications = []
        for turn in snapshot.turns:
            if turn.command_id is None:
                continue
            stored = await db.get(SdkSessionCommand, (row.id, turn.command_id))
            if stored is None:
                continue
            origin = Command.model_validate(stored.command).origin
            if origin.room_id is None:
                continue
            room = await db.get(Room, origin.room_id)
            if room is None or room.bridge_id != bridge_id:
                continue
            if await db.get(ClientRoom, (agent.client_id, room.id)) is None:
                continue
            if not room.external_channel_id:
                continue
            items = [item for item in snapshot.items if item.turn_id == turn.turn_id]
            state = (turn.status, tuple(item.revision for item in items))
            if not redraw_needed(session_id, turn.turn_id, state):
                continue
            publications.append(
                (turn, items, room.external_channel_id, origin.thread_id, state)
            )
        agent_name = agent.name
        db.expunge_all()
    for turn, items, channel_id, thread_id, state in publications:
        await activity.publish(
            items,
            turn,
            session_id=session_id,
            channel_id=channel_id,
            thread_root_id=thread_id,
            agent_name=agent_name,
        )
        redrawn(session_id, turn.turn_id, state)


class _RecoveryBackoff:
    """Bounds how often `recover` re-scans a channel's history for one card.

    Unbounded retries were the problem this closes: a card whose post
    genuinely never landed had this run again every publish cycle, forever,
    against a search that gets more expensive over time as the channel
    accumulates history past the point it started from. The wait doubles per
    token on every attempt that still finds nothing, up to `_MAX`, and clears
    the moment one succeeds — so a card that does eventually turn up is not
    left waiting out a long interval it no longer needs.
    """

    _MIN = 5.0
    _MAX = 600.0  # 10 minutes

    def __init__(self) -> None:
        self._next_attempt: dict[str, float] = {}
        self._interval: dict[str, float] = {}

    def allowed(self, token: str) -> bool:
        now = time.monotonic()
        if self._next_attempt.get(token, 0.0) > now:
            return False
        interval = self._interval.get(token, self._MIN)
        self._next_attempt[token] = now + interval
        self._interval[token] = min(interval * 2, self._MAX)
        return True

    def succeeded(self, token: str) -> None:
        self._next_attempt.pop(token, None)
        self._interval.pop(token, None)


class _RedrawGuard:
    """Remembers, for one publisher's own lifetime, the `(revision, state)`
    of each confirmed card it last drew.

    Both parts of that pair are the card's identity, not revision alone:
    `request.submitting` moves a request from `open` to `submitting` — the
    card loses its buttons and gains "Answering: …" — at the *same* revision
    the answer was accepted at, and only settling it bumps the revision. A
    guard keyed on revision alone would see that transition as "unchanged"
    and skip it, leaving a card that still looks answerable, with working
    buttons, for as long as the request being decided takes — exactly the
    "still offering buttons that no longer work" state `refresh` exists to
    prevent, produced by the thing meant to avoid drawing what has not moved.

    A session retried because a *different* request in it is stuck must not
    redraw this one again on every retry — nothing about it changed since
    last time this same process drew it. A freshly started publisher
    remembers nothing, so its first pass over an existing card still confirms
    it against what is actually recorded, the way `test_host_ack_and_retry_
    survive_publication_failure` relies on: a restart cannot trust that the
    platform still shows what the last process last drew, only that the
    database says what it should show.
    """

    def __init__(self) -> None:
        self._drawn: dict[str, tuple[int, str]] = {}

    def needed(self, token: str, state: tuple[int, str]) -> bool:
        return self._drawn.get(token) != state

    def drawn(self, token: str, state: tuple[int, str]) -> None:
        self._drawn[token] = state


class _TurnRedrawGuard:
    """The `_RedrawGuard` above, for a turn rather than a card.

    A turn has no revision of its own to pair a state with — neither
    `TurnUpsert` nor `Item` carries one for the turn as a whole — so its
    identity here is its status alongside every one of its items' own
    revisions, in the order `SessionProjection.turn_activity` would return
    them. Any of those changing is something to redraw; none of them changing
    is the running turn this exists to stop from being rewritten every cycle
    for no reason.
    """

    def __init__(self) -> None:
        self._drawn: dict[tuple[str, str], tuple[str, tuple[int, ...]]] = {}

    def needed(
        self, session_id: str, turn_id: str, state: tuple[str, tuple[int, ...]]
    ) -> bool:
        return self._drawn.get((session_id, turn_id)) != state

    def drawn(
        self, session_id: str, turn_id: str, state: tuple[str, tuple[int, ...]]
    ) -> None:
        self._drawn[(session_id, turn_id)] = state


class SessionPublisher:
    """Reconcile persisted snapshots independently of host acknowledgements."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        bridge_id: str,
        cards: SessionRequestCards,
        activity: SessionTurnActivity | None = None,
    ) -> None:
        self._sessions = session_factory
        self._bridge_id = bridge_id
        self._cards = cards
        self._activity = activity
        self._published: dict[str, int] = {}
        self._recovery = _RecoveryBackoff()
        self._redraw = _RedrawGuard()
        self._turn_redraw = _TurnRedrawGuard()
        self._wake = asyncio.Event()

    def wake(self) -> None:
        self._wake.set()

    async def publish_pending(self) -> None:
        async with self._sessions() as db:
            rows = (
                await db.execute(
                    select(
                        SdkSession.id,
                        SdkSession.snapshot["throughSequence"].as_integer(),
                    )
                )
            ).all()
        for session_id, sequence in rows:
            if self._published.get(session_id) == sequence:
                continue
            ok = True
            try:
                await refresh_cards(
                    self._sessions,
                    self._bridge_id,
                    session_id,
                    self._cards,
                    recovery_allowed=self._recovery.allowed,
                    recovery_succeeded=self._recovery.succeeded,
                    refresh_needed=self._redraw.needed,
                    refreshed=self._redraw.drawn,
                )
            except PublicationIncomplete as incomplete:
                ok = False
                if incomplete.errors:
                    logger.exception(
                        "Session %s card publication failed on bridge %s "
                        "(%d failed, %d waiting on a recovery backoff); "
                        "will retry.",
                        session_id,
                        self._bridge_id,
                        len(incomplete.errors),
                        incomplete.backed_off,
                    )
                else:
                    # Every one of these is a request deliberately not
                    # searched for again yet, not a new failure — logging it
                    # as one would put a real broken-and-continuing signal in
                    # the same stream as a wait that is working as designed.
                    logger.warning(
                        "Session %s has %d request(s) waiting out a recovery "
                        "backoff on bridge %s.",
                        session_id,
                        incomplete.backed_off,
                        self._bridge_id,
                    )
            except Exception:
                ok = False
                logger.exception(
                    "Session %s card publication failed on bridge %s; will retry.",
                    session_id,
                    self._bridge_id,
                )
            if self._activity is not None:
                try:
                    await refresh_activity(
                        self._sessions,
                        self._bridge_id,
                        session_id,
                        self._activity,
                        redraw_needed=self._turn_redraw.needed,
                        redrawn=self._turn_redraw.drawn,
                    )
                except Exception:
                    ok = False
                    logger.exception(
                        "Session %s turn activity publication failed on bridge "
                        "%s; will retry.",
                        session_id,
                        self._bridge_id,
                    )
            if ok:
                self._published[session_id] = sequence

    async def run(self) -> None:
        while True:
            self._wake.clear()
            try:
                await self.publish_pending()
            except Exception:
                logger.exception(
                    "Could not read pending session publications on bridge %s; will retry.",
                    self._bridge_id,
                )
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=5)
            except TimeoutError:
                pass
