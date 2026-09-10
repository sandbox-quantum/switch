import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.session.contract import (
    TURN_ENDED,
    Command,
    Snapshot,
)
from switch_core.bridges.collaboration.session.outbound import (
    SessionRequestCards,
    SessionTurnActivity,
)
from switch_core.db.models import (
    Agent,
    ClientRoom,
    Room,
    SdkSession,
    SdkSessionCommand,
    SdkSessionEvent,
)
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


class TurnActivityIncomplete(Exception):
    """Some of a session's turns did not fully draw this pass.

    `SessionTurnActivity.publish` already logs why a given turn did not land;
    this exists only so `SessionPublisher` knows not to mark the session's
    sequence done — a turn whose draw was refused must be tried again next
    cycle rather than treated, by the guard or by the sequence dedupe, as
    already showing what was asked. `backed_off` is kept separate from
    `turn_ids` for the same reason `PublicationIncomplete` keeps it separate
    for cards: a turn waiting out its own retry backoff is not a fresh
    failure, and logging it as one every cycle would bury the ones that are.
    """

    def __init__(self, session_id: str, turn_ids: list[str], backed_off: int) -> None:
        self.session_id = session_id
        self.turn_ids = turn_ids
        self.backed_off = backed_off
        super().__init__(
            f"Session {session_id}: {len(turn_ids)} turn(s) did not fully publish "
            f"and {backed_off} are waiting out a retry backoff."
        )


def _as_aware(value: str) -> datetime:
    """A timestamp's own moment, never naive.

    `_iso_datetime` (contract.py) accepts what `datetime.fromisoformat` does,
    which is looser than the `z.iso.datetime()` the TypeScript side actually
    enforces: a non-conforming host can post an offset-less string and it
    still validates. Comparing that against an aware one raises, so a bare
    string is read as UTC — the same assumption `_append` already makes for
    a timestamp it stamps itself — rather than let one non-conforming host
    event stop this turn's session from publishing any activity at all.
    """
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


async def _turn_elapsed_seconds(
    db: AsyncSession, session_id: str, turn_id: str
) -> float | None:
    """How long a turn actually ran, read back from the session's own event log.

    Neither a turn nor an item carries a timestamp, so there is nothing to
    read this off in the snapshot itself — it comes from the host-reported
    `turn.upsert` events for this turn: the first one whose status is
    "running", and the last one of any status, which is the one that set the
    status a caller is only calling this for the turn having already
    reached.

    Host-reported, not merely last: recovery ends every queued or running
    turn itself, stamped with the moment it noticed rather than anything the
    host ever said (`SessionAuthority`'s recovery path, `_append` with no
    `host`) — outage time, not work. `SdkSessionEvent.host_sequence` is null
    on exactly those synthetic rows — a genuine `HostEvent` always carries
    one — so the query only reads a duration off real reports of the turn.

    Running, not merely first: a real host publishes "queued" the moment a
    command arrives and turns run one at a time, so a turn can sit queued
    behind another for as long as that one takes. Anchoring at "queued"
    would count that wait as work. A turn recovered before it ever reported
    running has nothing to anchor a start on at all, which is deliberate:
    a few hundred milliseconds of queued-to-running is real but unmeasured
    work, and reporting `None` for it is more honest than reporting zero.

    Fewer than two stamps from "running" on — including a turn that never
    reported running before something ended it — means there is no earlier
    point to measure from. `None` rather than a duration of zero, which
    would claim a measurement that was never taken; likewise a delta that
    comes out negative — a clock stepped or a host's wall clock ran backward
    across the two events — reports as unmeasured rather than as a lie in
    the other direction.
    """
    rows = (
        await db.execute(
            select(
                SdkSessionEvent.event["occurredAt"].as_string(),
                SdkSessionEvent.event["body"]["status"].as_string(),
            )
            .where(
                SdkSessionEvent.session_id == session_id,
                SdkSessionEvent.event["body"]["type"].as_string() == "turn.upsert",
                SdkSessionEvent.event["body"]["turnId"].as_string() == turn_id,
                SdkSessionEvent.host_sequence.isnot(None),
            )
            .order_by(SdkSessionEvent.sequence)
        )
    ).all()
    running_index = next(
        (index for index, (_, status) in enumerate(rows) if status == "running"), None
    )
    if running_index is None:
        return None
    stamps = [at for at, _ in rows[running_index:]]
    if len(stamps) < 2:
        return None
    started = _as_aware(stamps[0])
    ended = _as_aware(stamps[-1])
    elapsed = (ended - started).total_seconds()
    return elapsed if elapsed >= 0 else None


async def refresh_activity(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    session_id: str,
    activity: SessionTurnActivity,
    *,
    retry_allowed: Callable[[str], bool] = _always_recover,
    retry_succeeded: Callable[[str], None] = _ignore_recovery,
    redraw_needed: Callable[[str, str, tuple[str, tuple[int, ...]]], bool],
    redrawn: Callable[[str, str, tuple[str, tuple[int, ...]]], None],
    already_held_back: Callable[[str, str], bool],
    hold_back: Callable[[str, str], None],
    first_sweep: bool,
) -> None:
    """Bring a session's turn activity up to date with its persisted state.

    Unlike a request, a turn is not addressed to anyone and nothing resolves
    against it, so a turn with no room to reach — no command behind it yet, no
    origin, no membership, no channel — is skipped rather than treated as a
    broken invariant the way a request's missing origin is.

    `redraw_needed` exists only to stop a running turn's channel-root message
    being rewritten every cycle when nothing about it changed — a stream
    already skips sending a chunk it has already sent. `redrawn` is told only
    when `publish` reports it actually landed: a turn it refused is left out
    of the guard so the next cycle tries it again instead of reading "already
    drawn" for a state that was never shown.

    `retry_allowed` bounds how often a turn whose last draw failed is tried
    again, the same way `recovery_allowed` bounds card recovery: without it,
    a channel that keeps refusing one turn — Slack rate-limited, a permission
    revoked, the channel gone — gets tried again every cycle forever, and on
    a turn whose stream already closed that means a brand new message every
    cycle rather than one bounded duplicate, since a fresh attempt has no
    anchor left to edit and opens fresh.

    `first_sweep` scopes this call, on a session this publisher has not
    handled activity for before, to the session's single latest turn.
    `snapshot.turns` keeps every turn a session has ever had, in the order
    each first appeared, and a freshly started publisher's redraw guard
    remembers nothing, so without this every turn from earlier in the
    session's life looks undrawn on the first sweep and each gets posted
    again as a new message — the whole session's history replayed into the
    channel.

    Position in the list cannot tell "not drawn yet" from "drawn by a
    previous process and since forgotten" — that needs a durable anchor
    turn activity does not have — so this narrows only the one sweep where
    every turn looks equally undrawn and the ambiguity is total. A turn this
    skips has to be remembered, not merely passed over, or it is new again
    on the very next sweep — every sweep after the first is unrestricted, so
    a skip that left no trace would replay the same history this parameter
    exists to hold back, just one sweep later rather than never.

    An already-ended turn is remembered through `already_held_back` /
    `hold_back` rather than `redraw_needed` / `redrawn`: its state can never
    change again, so unlike a turn still running behind the latest — which
    does still need `redraw_needed` watching it, since it draws once more
    the moment it actually ends — it needs nothing watched, only never
    revisited. That distinction is what the eviction bound underneath
    `redraw_needed` requires: every sweep after the first re-examines a
    session's *entire* turn history, not just what changed, so a hold-back
    record has to outlive whatever else is going on for as long as the
    session does, rather than compete with unrelated sessions for space in
    a fixed-size cache sized for turns actually being watched.
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
        latest_turn_id = snapshot.turns[-1].turn_id if snapshot.turns else None
        for turn in snapshot.turns:
            if already_held_back(session_id, turn.turn_id):
                continue
            items = [item for item in snapshot.items if item.turn_id == turn.turn_id]
            state = (turn.status, tuple(item.revision for item in items))
            if first_sweep and turn.turn_id != latest_turn_id:
                if turn.status in TURN_ENDED:
                    hold_back(session_id, turn.turn_id)
                else:
                    # Still worth watching: this one draws once more the
                    # moment it actually ends, which is not yet.
                    redrawn(session_id, turn.turn_id, state)
                continue
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
            if not redraw_needed(session_id, turn.turn_id, state):
                continue
            elapsed_seconds = (
                await _turn_elapsed_seconds(db, session_id, turn.turn_id)
                if turn.status in TURN_ENDED
                else None
            )
            publications.append(
                (
                    turn,
                    items,
                    room.external_channel_id,
                    origin.thread_id,
                    state,
                    elapsed_seconds,
                )
            )
        agent_name = agent.name
        db.expunge_all()
    failed: list[str] = []
    backed_off = 0
    for turn, items, channel_id, thread_id, state, elapsed_seconds in publications:
        token = f"{session_id}:{turn.turn_id}"
        if not retry_allowed(token):
            backed_off += 1
            continue
        drawn = await activity.publish(
            items,
            turn,
            session_id=session_id,
            channel_id=channel_id,
            thread_root_id=thread_id,
            agent_name=agent_name,
            elapsed_seconds=elapsed_seconds,
        )
        if drawn:
            retry_succeeded(token)
            redrawn(session_id, turn.turn_id, state)
        else:
            failed.append(turn.turn_id)
    if failed or backed_off:
        raise TurnActivityIncomplete(session_id, failed, backed_off)


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


# How many turns' redraw state one publisher keeps. Turns far outnumber the
# request cards _RedrawGuard tracks — every command opens one — so unlike
# that guard this one bounds itself the same way SessionTurnActivity bounds
# its own anchors: dropping the least recently drawn costs one needless
# redraw if that turn ever changes again, not a leak for the life of the
# process.
_MAX_TRACKED_TURNS = 4096


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
        self._drawn: OrderedDict[tuple[str, str], tuple[str, tuple[int, ...]]] = (
            OrderedDict()
        )

    def needed(
        self, session_id: str, turn_id: str, state: tuple[str, tuple[int, ...]]
    ) -> bool:
        return self._drawn.get((session_id, turn_id)) != state

    def drawn(
        self, session_id: str, turn_id: str, state: tuple[str, tuple[int, ...]]
    ) -> None:
        self._drawn[(session_id, turn_id)] = state
        self._drawn.move_to_end((session_id, turn_id))
        while len(self._drawn) > _MAX_TRACKED_TURNS:
            self._drawn.popitem(last=False)


class _PermanentlyHeldBack:
    """Ended turns a first sweep decided never to draw, kept per session.

    Not `_TurnRedrawGuard`: that one is bounded and shared across every
    session on the bridge, evicting whichever entry was least recently
    drawn, which is the right trade for turns actually being watched — an
    eviction there costs one needless redraw if the turn ever changes again.
    An already-ended turn recorded here never changes again, so an eviction
    would not cost a redraw, it would cost a fresh, wrong repost of history:
    every sweep after the first re-examines a session's entire turn list,
    not just what changed, so a record has to survive for as long as the
    session does, regardless of how much unrelated activity other sessions
    produce in the meantime. Scoped to one session's own turns rather than
    shared, so a deployment with a long history in one session cannot evict
    another session's hold-back — only that session's own turn count grows
    this, and closing over it there is deliberately not a `_MAX_*` bound to
    trade away.
    """

    def __init__(self) -> None:
        self._turns: dict[str, set[str]] = {}

    def contains(self, session_id: str, turn_id: str) -> bool:
        return turn_id in self._turns.get(session_id, ())

    def add(self, session_id: str, turn_id: str) -> None:
        self._turns.setdefault(session_id, set()).add(turn_id)


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
        self._activity_retry = _RecoveryBackoff()
        self._activity_seen: set[str] = set()
        self._activity_held_back = _PermanentlyHeldBack()
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
                first_sweep = session_id not in self._activity_seen
                swept = False
                try:
                    await refresh_activity(
                        self._sessions,
                        self._bridge_id,
                        session_id,
                        self._activity,
                        retry_allowed=self._activity_retry.allowed,
                        retry_succeeded=self._activity_retry.succeeded,
                        redraw_needed=self._turn_redraw.needed,
                        redrawn=self._turn_redraw.drawn,
                        already_held_back=self._activity_held_back.contains,
                        hold_back=self._activity_held_back.add,
                        first_sweep=first_sweep,
                    )
                    swept = True
                except TurnActivityIncomplete as incomplete:
                    ok = False
                    swept = True
                    if incomplete.turn_ids:
                        logger.exception(
                            "Session %s turn activity publication failed on "
                            "bridge %s (%d failed, %d waiting on a retry "
                            "backoff); will retry.",
                            session_id,
                            self._bridge_id,
                            len(incomplete.turn_ids),
                            incomplete.backed_off,
                        )
                    else:
                        # Every one of these is a turn deliberately not
                        # retried yet, not a new failure — logging it as one
                        # would put a real broken-and-continuing signal in
                        # the same stream as a wait that is working as
                        # designed.
                        logger.warning(
                            "Session %s has %d turn(s) waiting out a retry "
                            "backoff on bridge %s.",
                            session_id,
                            incomplete.backed_off,
                            self._bridge_id,
                        )
                except Exception:
                    # Unlike TurnActivityIncomplete, this means the sweep
                    # itself did not run to completion — the query that
                    # decides what "latest" even is may never have finished
                    # — so `first_sweep` is not consumed: the next cycle
                    # retries the same restricted view rather than risking
                    # the flood this parameter exists to stop.
                    ok = False
                    logger.exception(
                        "Session %s turn activity publication failed on bridge "
                        "%s; will retry.",
                        session_id,
                        self._bridge_id,
                    )
                if swept:
                    self._activity_seen.add(session_id)
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
