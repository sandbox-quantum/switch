import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import (
    RemovalFailed,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.session.outbound import (
    CardRefused,
    SessionRequestCards,
    SessionTurnActivity,
)
from switch_core.db.models import (
    Agent,
    BridgeMessageMap,
    ClientRoom,
    Room,
    SdkSession,
    SdkSessionCommand,
    SdkSessionEvent,
    require_tenant_id,
)
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.deeplinks import deeplink_for_platform
from switch_core.sessions.contract import (
    TURN_ENDED,
    Command,
    Snapshot,
    TurnUpsert,
    decided,
)
from switch_core.sessions.presentation import (
    activity_error_summary,
    notification_recipient,
    session_console_url,
)
from switch_core.sessions.service import SessionError

logger = logging.getLogger(__name__)


def _always_recover(_token: str) -> bool:
    return True


def _never_spent(_token: str) -> bool:
    return False


def _ignore_delay(_token: str, _delay: float) -> None:
    return None


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
    deliberately not tried again yet, either a recovery search or a post to a
    destination that keeps refusing, which is working as designed and must not
    read as a fresh failure on every retry.
    """

    def __init__(
        self, session_id: str, errors: list[BaseException], backed_off: int
    ) -> None:
        self.session_id = session_id
        self.errors = errors
        self.backed_off = backed_off
        super().__init__(
            f"Session {session_id}: {len(errors)} request(s) failed to "
            f"publish and {backed_off} are waiting out a retry backoff."
        )


async def refresh_cards(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    session_id: str,
    cards: SessionRequestCards,
    *,
    gateway_public_url: str | None = None,
    recovery_allowed: Callable[[str], bool] = _always_recover,
    recovery_succeeded: Callable[[str], None] = _ignore_recovery,
    post_allowed: Callable[[str], bool] = _always_recover,
    post_succeeded: Callable[[str], None] = _ignore_recovery,
    post_spent: Callable[[str], bool] = _never_spent,
    post_delayed: Callable[[str, float], None] = _ignore_delay,
    refresh_needed: Callable[[str, tuple[int, str]], bool] = _always_refresh,
    refreshed: Callable[[str, tuple[int, str]], None] = _ignore_refresh,
    removal_allowed: Callable[[str], bool] = _always_recover,
    removal_succeeded: Callable[[str], None] = _ignore_recovery,
    removal_delayed: Callable[[str, float], None] = _ignore_delay,
) -> None:
    """Bring a session's cards up to date with its persisted requests.

    `recovery_allowed` gates `recover` — the search for a card whose post is
    unconfirmed — per token, and `recovery_succeeded` is told when one lands.

    `post_allowed` gates the *first* post of a card, keyed by session and
    request rather than by token because a refused post releases its handle
    and the next attempt mints a new one. It exists for the destination that
    is permanently unavailable — a deleted channel, a thread nobody can write
    in — where without it this reserved a handle, had the platform refuse it
    and released it again on every publish cycle, forever, logging a failure
    each time. The wait stretches instead, so a destination that comes back is
    still picked up and one that does not stops drowning the log. It does not
    decide what the channel is told: that is the platform's disclosure policy
    and is deliberately not made here.

    `post_spent` says that wait has stretched as far as it goes, and is where a
    destination stops being treated as one that might come back: the card is
    given up on, `cards.note_undeliverable` makes the single record of it, and
    the request is skipped from then on rather than counted as a failure of
    this session's publication on every later cycle. A caller that passes
    nothing keeps the old behaviour — every refusal raised, forever.

    `post_delayed` carries the platform's own Retry-After back to that wait,
    and is the reason being rate limited cannot end in `post_spent`. A throttle
    says the channel is busy, not that it is gone; if it stretched the same
    wait, a channel busy enough for long enough would be written off as
    undeliverable for the crime of being busy, and the card would never be
    posted again.

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

    `removal_allowed` / `removal_succeeded` / `removal_delayed` are the same
    three-part gate as the post's, for taking an answered card back, and they
    are kept apart from `refresh_needed` on purpose: whether a card still owes
    a deletion is a fact about the record, not about whether anything has
    changed since it was last drawn. Sharing the redraw's gate meant one
    refused deletion was never attempted again by that process, because every
    later cycle saw an unchanged card and skipped the branch. There is no
    `removal_spent`: a card that cannot be taken back is left settled and
    readable, which is a tolerable end state, but it is not one to write down
    as done — so the attempt keeps stretching rather than stopping, exactly as
    a recovery search does.

    `gateway_public_url` is here for one message: the notice sent when a card's
    delivery can never be confirmed, which is only useful if it can say where
    the request *can* be answered. It may be None, and then the notice names
    Console without linking to it.
    """
    posts = SessionRequestPostStore()
    async with session_factory() as db:
        row = await db.get(SdkSession, (require_tenant_id(), session_id))
        if row is None:
            raise SessionError("NOT_FOUND", "Session not found.")
        snapshot = Snapshot.model_validate(row.snapshot)
        now = (await db.execute(select(func.now()))).scalar_one()
        unavailable_reason = (
            "Host offline. Answers are unavailable until the session reconnects."
            if row.lease_expires_at <= now or snapshot.session.connectivity == "offline"
            else None
        )
        agent = await db.get(Agent, row.agent_id)
        if agent is None:
            raise SessionError("NOT_FOUND", "Session agent not found.")
        publications = []
        for request in snapshot.requests:
            turn = next(t for t in snapshot.turns if t.turn_id == request.turn_id)
            stored = await db.get(
                SdkSessionCommand, (require_tenant_id(), row.id, turn.command_id)
            )
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
            thread_id = (
                post.thread_id
                if post is not None
                else await _platform_message_ref(
                    db,
                    bridge_id,
                    room.external_channel_id,
                    origin.thread_id or origin.message_id,
                )
            )
            # Where the command was addressed, which is not the same question
            # as where its card goes: a thread the platform can no longer find
            # is indistinguishable from one never made, so the channel root is
            # only the audience that was asked when the asking happened there.
            asked_at_root = origin.thread_id is None
            # Only the first post of an open card asks anyone. A redraw leaves
            # the recipient unset on purpose — the mention has been made and
            # repeating it is a second notification — so "nobody to name" is
            # only meaningful here, where naming someone was the intent.
            asking = post is None and request.state == "open"
            recipient = (
                await notification_recipient(
                    db,
                    bridge_id=bridge_id,
                    room_id=room.id,
                    origin=origin,
                    agent=agent,
                    thread_id=thread_id,
                )
                if asking
                else None
            )
            publications.append(
                (
                    request,
                    post,
                    room.id,
                    room.external_channel_id,
                    thread_id,
                    asked_at_root,
                    recipient,
                    asking and recipient is None and cards.notifies_only_by_mention,
                    deeplink_for_platform(
                        session_console_url(
                            gateway_public_url, agent.id, room.id, row.id
                        ),
                        gateway_public_url,
                        cards.renders_custom_url_schemes,
                    ),
                )
            )
        epoch = row.epoch
        agent_name = agent.name
        db.expunge_all()
    errors: list[BaseException] = []
    backed_off = 0
    for (
        request,
        post,
        room_id,
        channel_id,
        thread_id,
        asked_at_root,
        recipient,
        unreachable,
        console_url,
    ) in publications:
        state = (
            request.revision,
            request.state
            + (
                ":offline"
                if unavailable_reason and request.state in {"open", "submitting"}
                else ""
            ),
        )
        # A card found again after an uncertain post is drawn whatever the
        # redraw gate says: the gate was told about the post that went missing,
        # so at this revision and state it reads as a card already drawn.
        recovered = False
        try:
            if post is None:
                if request.state != "open":
                    continue
                attempt = f"{session_id}:{request.request_id}"
                if cards.undeliverable(attempt):
                    continue
                if not post_allowed(attempt):
                    backed_off += 1
                    continue
                try:
                    new_post = await cards.post(
                        request,
                        channel_id=channel_id,
                        thread_root_id=thread_id,
                        asked_at_root=asked_at_root,
                        room_id=room_id,
                        session_id=session_id,
                        epoch=epoch,
                        agent_name=agent_name,
                        notify_external_id=recipient,
                        notify_unreachable=unreachable,
                        unavailable_reason=unavailable_reason,
                    )
                except RichContentThrottled as throttled:
                    post_delayed(attempt, throttled.retry_after)
                    backed_off += 1
                    continue
                except CardRefused as refusal:
                    if not post_spent(attempt):
                        raise
                    cards.note_undeliverable(
                        attempt,
                        request_id=request.request_id,
                        channel_id=channel_id,
                        console_url=console_url,
                        refusal=refusal,
                    )
                    continue
                post_succeeded(attempt)
                refreshed(new_post.token, state)
            elif post.removed_at is not None:
                # The card was taken back once its question was answered. The
                # row stays so a typed answer still resolves, but there is no
                # longer a message at that address: redrawing it would fail,
                # and recovering it would find whatever now sits where it was.
                continue
            elif post.external_post_id == post.token:
                if post.unconfirmed_notice_at is not None:
                    # Already disclosed as undeliverable. There is no message
                    # to edit and nothing further to try, and treating it as a
                    # failure again on every cycle would keep the session
                    # reporting an error that has already been dealt with as
                    # well as it can be.
                    continue
                if not cards.recovers_uncertain_posts:
                    if cards.discloses_unconfirmed_posts:
                        await cards.disclose_unconfirmed(post, console_url=console_url)
                    else:
                        # Nothing to search for and nothing this platform has
                        # been cleared to say, so the reservation is simply
                        # held: it is what stops a second card, and the
                        # request is still answerable in Console. Said once
                        # per process rather than on every cycle.
                        cards.note_unconfirmed(post)
                    continue
                if not recovery_allowed(post.token):
                    backed_off += 1
                    continue
                post = await cards.recover(post)
                recovery_succeeded(post.token)
                recovered = True
            if post is not None and cards.removes_answered_cards and decided(request):
                # A stage of its own, deliberately not a step of the redraw. An
                # answered card with no removal recorded is one still owed, and
                # that stays true on a cycle where nothing about the card
                # changed — which is every cycle after the one that drew it
                # settled. Hanging the removal off `refresh_needed` meant a
                # single rate limit lost the cleanup for the life of the
                # process, and left the card recovered a cycle late never
                # reached at all.
                #
                # It is asked before the card is drawn because the two
                # questions are not independent: a card that is already gone
                # cannot be edited, so drawing first turns a deletion whose
                # acknowledgement was lost into a failed edit — and the notice
                # that failure posts is a claim about a card nobody can see,
                # made on every restart, while the deletion that would settle
                # the address is never reached. Asking first settles it either
                # way, and a card the platform still holds is drawn below.
                #
                # A card already taken back never arrives here: the branch
                # above skips its row outright, which is also what stops the
                # address being deleted once a cycle forever.
                if not removal_allowed(post.token):
                    backed_off += 1
                else:
                    try:
                        await cards.remove(post)
                    except RichContentThrottled as throttled:
                        removal_delayed(post.token, throttled.retry_after)
                        backed_off += 1
                    except RemovalFailed as refusal:
                        backed_off += 1
                        logger.warning(
                            "Card %s for request %s was answered but %s would "
                            "not take it back: %s. It stays in channel %s "
                            "showing the decision until a later attempt gets "
                            "through.",
                            post.handle,
                            post.request_id,
                            cards.surface,
                            refusal,
                            post.external_channel_id,
                        )
                    else:
                        removal_succeeded(post.token)
                        continue
            if post is not None and (recovered or refresh_needed(post.token, state)):
                await cards.refresh(
                    post,
                    request,
                    agent_name=agent_name,
                    **(
                        {"unavailable_reason": unavailable_reason}
                        if unavailable_reason
                        else {}
                    ),
                )
                refreshed(post.token, state)
        except RichContentThrottled:
            backed_off += 1
        except Exception as error:
            # One request's card failing must not stop its siblings from
            # being tried: a session can have several open requests, and a
            # single stuck one previously aborted this loop before it reached
            # any that came after. Each is retried on its own next cycle
            # regardless — what this function reports below is what stops
            # `publish_pending` marking the session done while any request in
            # it is still broken or waiting out a retry backoff.
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
    db: AsyncSession, session_id: str, turn_id: str, *, running: bool = False
) -> float | None:
    """Measure a turn from host events, using the current time while running.

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

    For a completed turn, fewer than two stamps from "running" on — including a turn that never
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
                SdkSessionEvent.tenant_id == require_tenant_id(),
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
    if running:
        return max(0, (datetime.now(UTC) - _as_aware(stamps[0])).total_seconds())
    if len(stamps) < 2:
        return None
    started = _as_aware(stamps[0])
    ended = _as_aware(stamps[-1])
    elapsed = (ended - started).total_seconds()
    return elapsed if elapsed >= 0 else None


async def _platform_message_ref(
    db: AsyncSession, bridge_id: str, channel_id: str, ref: str | None
) -> str | None:
    if ref is None:
        return None
    mapping = await db.scalar(
        select(BridgeMessageMap).where(
            BridgeMessageMap.bridge_id == bridge_id,
            BridgeMessageMap.external_channel_id == channel_id,
            BridgeMessageMap.transport_event_id == ref,
        )
    )
    if mapping is not None:
        return mapping.external_post_id
    if ref.startswith("sw_"):
        # Inbound delivery can race the mapping commit. Retry publication.
        raise SessionError(
            "NOT_FOUND", "Activity message mapping is not committed yet."
        )
    return ref


async def refresh_activity(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    session_id: str,
    activity: SessionTurnActivity,
    *,
    surface: str,
    gateway_public_url: str | None = None,
    retry_allowed: Callable[[str], bool] = _always_recover,
    retry_succeeded: Callable[[str], None] = _ignore_recovery,
    retry_delayed: Callable[[str, float], None] = _ignore_delay,
    redraw_needed: Callable[[str, str, tuple[str, tuple[int, ...]]], bool],
    redrawn: Callable[[str, str, tuple[str, tuple[int, ...]]], None],
    already_held_back: Callable[[str, str], bool],
    hold_back: Callable[[str, str], None],
    first_sweep: bool,
) -> bool:
    """Publish activity and return whether running turns need clock refreshes.

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

    On the first sweep, durable publishers reconcile every recorded command
    and every live turn. Unrecorded, already-ended turns are historical and
    are held back rather than replayed during deployment. In-memory demo
    publishers retain their previous latest-turn-only behavior.
    """
    recorded = await activity.recorded_commands(session_id)
    async with session_factory() as db:
        row = await db.get(SdkSession, (require_tenant_id(), session_id))
        if row is None:
            raise SessionError("NOT_FOUND", "Session not found.")
        snapshot = Snapshot.model_validate(row.snapshot)
        now = (await db.execute(select(func.now()))).scalar_one()
        online = (
            row.lease_expires_at > now and snapshot.session.connectivity == "online"
        )
        agent = await db.get(Agent, row.agent_id)
        if agent is None:
            raise SessionError("NOT_FOUND", "Session agent not found.")
        publications = []
        turns = list(snapshot.turns)
        latest_turn_id = turns[-1].turn_id if turns else None
        known_commands = {turn.command_id for turn in turns}
        # Turns carried as errors only because the command was never
        # acknowledged, which is not the same thing as one that failed.
        unconfirmed: set[str] = set()
        # A presentation-only queued turn acknowledges input this bridge itself
        # accepted, before the SDK reports a turn. Scoped to commands that came
        # in on `surface` because that is where the acknowledgement would go: a
        # command typed in the console has no message in this channel to answer,
        # and a turn drawn for it would be this bridge announcing work nobody
        # here asked for. Never write synthetic turns into the contract.
        for pending_command in await db.scalars(
            select(SdkSessionCommand)
            .where(
                SdkSessionCommand.tenant_id == require_tenant_id(),
                SdkSessionCommand.session_id == session_id,
                SdkSessionCommand.status["status"]
                .as_string()
                .in_(["accepted", "dispatched", "unknown", "rejected"]),
            )
            .order_by(SdkSessionCommand.accepted_sequence)
        ):
            command = Command.model_validate(pending_command.command)
            if (
                command.command_id in known_commands
                or command.epoch != row.epoch
                or command.origin.surface != surface
                or command.body.type != "message.send"
            ):
                continue
            status = pending_command.status["status"]
            if status not in ("accepted", "dispatched", "unknown", "rejected"):
                continue
            turn_id = f"pending:{command.command_id}"
            if status == "unknown":
                unconfirmed.add(turn_id)
            turns.append(
                TurnUpsert(
                    type="turn.upsert",
                    turn_id=turn_id,
                    command_id=command.command_id,
                    status="queued"
                    if status in ("accepted", "dispatched")
                    else "error",
                )
            )
        for turn in turns:
            if already_held_back(session_id, turn.turn_id):
                continue
            items = [item for item in snapshot.items if item.turn_id == turn.turn_id]
            revisions = tuple(item.revision for item in items)
            if turn.status == "running" and activity.redraws_for_elapsed_time:
                revisions += (int(time.monotonic() // 5),)
            error_summary = activity_error_summary(
                turn,
                snapshot.session,
                online=online,
                unconfirmed=turn.turn_id in unconfirmed,
            )
            state = (
                turn.status + (":" + error_summary if error_summary else ""),
                revisions,
            )
            if (
                first_sweep
                and turn.command_id not in recorded
                and (
                    (activity.durable and turn.status in TURN_ENDED)
                    or (
                        not activity.durable
                        and turn.turn_id != latest_turn_id
                        and (
                            turn.status in TURN_ENDED
                            or not turn.turn_id.startswith("pending:")
                        )
                    )
                )
            ):
                if turn.status in TURN_ENDED:
                    hold_back(session_id, turn.turn_id)
                else:
                    # Still worth watching: this one draws once more the
                    # moment it actually ends, which is not yet.
                    redrawn(session_id, turn.turn_id, state)
                continue
            if turn.command_id is None:
                continue
            stored = await db.get(
                SdkSessionCommand, (require_tenant_id(), row.id, turn.command_id)
            )
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
                await _turn_elapsed_seconds(
                    db, session_id, turn.turn_id, running=turn.status == "running"
                )
                if turn.status != "queued"
                else None
            )
            # A turn is never shown at the channel root any more: one already
            # in a thread stays there, and one addressed at the root now
            # threads under that same message rather than posting beside it —
            # see SessionTurnActivity for why. A command with neither is one
            # nothing here can thread under, and posts at the root as before.
            thread_root_id = await _platform_message_ref(
                db,
                bridge_id,
                room.external_channel_id,
                origin.thread_id or origin.message_id,
            )
            # The message that actually asked, for the `:eyes:` that goes
            # with the thread — origin.message_id is the typed message or the
            # card the command came from either way, not wherever the thread
            # has since moved on to.
            asked_on = (
                await _platform_message_ref(
                    db, bridge_id, room.external_channel_id, origin.message_id
                )
                or thread_root_id
            )
            recipient = (
                await notification_recipient(
                    db,
                    bridge_id=bridge_id,
                    room_id=room.id,
                    origin=origin,
                    agent=agent,
                    thread_id=thread_root_id,
                )
                if error_summary
                else None
            )
            metadata: dict[str, Any] = {
                key: value
                for key, value in {
                    # Rewritten here rather than in the renderer: this is the
                    # only place holding both the deeplink and the gateway URL
                    # the redirect has to come from.
                    "session_url": deeplink_for_platform(
                        session_console_url(
                            gateway_public_url, agent.id, room.id, row.id
                        ),
                        gateway_public_url,
                        activity.renders_custom_url_schemes,
                    ),
                    "notify_external_id": recipient,
                    # Somebody has to act on this and there is nobody here to
                    # name. Only worth saying where a mention is the whole
                    # notification; elsewhere the platform reaches them anyway.
                    "notify_unreachable": bool(error_summary)
                    and recipient is None
                    and activity.notifies_only_by_mention,
                    "error_summary": error_summary,
                }.items()
                if value is not None
            }
            publications.append(
                (
                    turn,
                    items,
                    room.external_channel_id,
                    thread_root_id,
                    asked_on,
                    state,
                    elapsed_seconds,
                    metadata,
                )
            )
        agent_name = agent.name
        db.expunge_all()
    failed: list[str] = []
    backed_off = 0
    for (
        turn,
        items,
        channel_id,
        thread_id,
        asked_on,
        state,
        elapsed_seconds,
        metadata,
    ) in publications:
        token = f"{session_id}:{turn.turn_id}"
        if not retry_allowed(token):
            backed_off += 1
            continue
        try:
            drawn = await activity.publish(
                items,
                turn,
                session_id=session_id,
                channel_id=channel_id,
                thread_root_id=thread_id,
                asked_on=asked_on,
                agent_name=agent_name,
                elapsed_seconds=elapsed_seconds,
                **metadata,
            )
        except RichContentThrottled as error:
            retry_delayed(token, error.retry_after)
            backed_off += 1
            continue
        except Exception:
            logger.exception("Could not recover activity for turn %s", turn.turn_id)
            failed.append(turn.turn_id)
            continue
        if drawn:
            retry_succeeded(token)
            redrawn(session_id, turn.turn_id, state)
        else:
            failed.append(turn.turn_id)
    if failed or backed_off:
        raise TurnActivityIncomplete(session_id, failed, backed_off)
    return any(turn.status == "running" for turn in turns)


class _RecoveryBackoff:
    """Bounds how often one card's platform call is attempted again.

    Unbounded retries were the problem this closes. A card whose post
    genuinely never landed had `recover` re-scan the channel's history every
    publish cycle, forever, against a search that gets more expensive over
    time as the channel accumulates history past the point it started from;
    and a card whose destination no longer exists had the post itself
    reserved, refused and released on every cycle just as often. The wait
    doubles per key on every attempt that does not get there, up to `_MAX`,
    and clears the moment one succeeds — so a destination that comes back, or
    a card that does eventually turn up, is not left waiting out a long
    interval it no longer needs.
    """

    _MIN = 5.0
    _MAX = 600.0  # 10 minutes

    def __init__(self, *, max_interval: float = _MAX) -> None:
        self._max_interval = max_interval
        self._next_attempt: dict[str, float] = {}
        self._interval: dict[str, float] = {}

    def allowed(self, token: str) -> bool:
        now = time.monotonic()
        if self._next_attempt.get(token, 0.0) > now:
            return False
        interval = self._interval.get(token, self._MIN)
        self._next_attempt[token] = now + interval
        self._interval[token] = min(interval * 2, self._max_interval)
        return True

    def spent(self, token: str) -> bool:
        """Whether this key's waits have stretched as far as they go.

        True once the interval has doubled its way to `_MAX`, which takes
        several failed attempts over several minutes. A caller that has a
        terminal disposition for the thing it keeps retrying reads this to
        decide the destination is not coming back inside a wait; one that has
        none ignores it and keeps trying at the capped interval.
        """
        return self._interval.get(token, self._MIN) >= self._max_interval

    def delay(self, token: str, seconds: float) -> None:
        self._next_attempt[token] = time.monotonic() + seconds
        self._interval.pop(token, None)

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
        *,
        gateway_public_url: str | None = None,
    ) -> None:
        self._sessions = session_factory
        self._gateway_public_url = gateway_public_url
        self._bridge_id = bridge_id
        self._surface = cards.surface
        self._cards = cards
        self._activity = activity
        self._published: dict[str, tuple[int, bool]] = {}
        self._recovery = _RecoveryBackoff()
        self._card_post = _RecoveryBackoff()
        self._card_removal = _RecoveryBackoff()
        self._redraw = _RedrawGuard()
        self._turn_redraw = _TurnRedrawGuard()
        self._activity_retry = _RecoveryBackoff(max_interval=30.0)
        self._activity_seen: set[str] = set()
        self._clock_sessions: set[str] = set()
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
                        (SdkSession.lease_expires_at > func.now())
                        & (
                            SdkSession.snapshot["session"]["connectivity"].as_string()
                            == "online"
                        ),
                    ).where(SdkSession.tenant_id == require_tenant_id())
                )
            ).all()
        for session_id, sequence, online in rows:
            published_state = (sequence, online)
            unchanged = self._published.get(session_id) == published_state
            if unchanged and session_id not in self._clock_sessions:
                continue
            ok = True
            # Establish status and tool-log replies before posting request cards.
            if self._activity is not None and (
                not unchanged or session_id in self._clock_sessions
            ):
                first_sweep = session_id not in self._activity_seen
                swept = False
                try:
                    running = await refresh_activity(
                        self._sessions,
                        self._bridge_id,
                        session_id,
                        self._activity,
                        surface=self._surface,
                        **(
                            {"gateway_public_url": self._gateway_public_url}
                            if self._gateway_public_url
                            else {}
                        ),
                        retry_allowed=self._activity_retry.allowed,
                        retry_succeeded=self._activity_retry.succeeded,
                        retry_delayed=self._activity_retry.delay,
                        redraw_needed=self._turn_redraw.needed,
                        redrawn=self._turn_redraw.drawn,
                        already_held_back=self._activity_held_back.contains,
                        hold_back=self._activity_held_back.add,
                        first_sweep=first_sweep,
                    )
                    if running:
                        self._clock_sessions.add(session_id)
                    else:
                        self._clock_sessions.discard(session_id)
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
            try:
                if not unchanged:
                    # Lease expiry can change without a new snapshot event.
                    await refresh_cards(
                        self._sessions,
                        self._bridge_id,
                        session_id,
                        self._cards,
                        gateway_public_url=self._gateway_public_url,
                        recovery_allowed=self._recovery.allowed,
                        recovery_succeeded=self._recovery.succeeded,
                        post_allowed=self._card_post.allowed,
                        post_succeeded=self._card_post.succeeded,
                        post_spent=self._card_post.spent,
                        post_delayed=self._card_post.delay,
                        refresh_needed=self._redraw.needed,
                        refreshed=self._redraw.drawn,
                        removal_allowed=self._card_removal.allowed,
                        removal_succeeded=self._card_removal.succeeded,
                        removal_delayed=self._card_removal.delay,
                    )
            except PublicationIncomplete as incomplete:
                ok = False
                if incomplete.errors:
                    logger.exception(
                        "Session %s card publication failed on bridge %s "
                        "(%d failed, %d waiting on a retry backoff); "
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
                        "Session %s has %d request(s) waiting out a retry "
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
            if ok:
                self._published[session_id] = published_state

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
