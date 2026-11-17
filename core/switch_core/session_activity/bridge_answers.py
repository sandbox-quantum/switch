"""Answers to request cards, given on a platform, recorded against the request.

The inbound half of `bridge_publisher`. A press carries the card's token and
the option; a typed answer names the card by its handle (`A3 yes`, `A3 q1=2
q2=use staging`), or is a bare "yes" / "no" as the first reply to an approval
card, or is one option of a single-question card, word for word or by number,
replied in that card's thread. Either resolves to one `approval_request_posts` row, and from there to
the request itself, which `AgentSessionActivityService.answer_approval` checks:
open, unexpired, fits what was asked, and from someone who may address the
agent.

`None` from either entry point means the event is not an answer to a card
of this kind, and the caller carries on with whatever else it might be.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.models import InboundInteraction, InboundMessage
from switch_core.bridges.collaboration.session.form import (
    Unanswerable,
    posted_form,
    resolve_plain_reply,
    resolve_pressed_option,
    resolve_pressed_position,
    resolve_text_answer,
    takes_a_bare_decision,
)
from switch_core.bridges.collaboration.session.refusal import InboundActor, Refused
from switch_core.bridges.collaboration.session.renderers import (
    parse_answer_action,
    parse_answer_position,
)
from switch_core.bridges.collaboration.session.text import (
    TextAnswer,
    parse_text_answer,
)
from switch_core.db.models import (
    ApprovalRequest,
    ApprovalRequestPost,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.session_activity_post_store import ApprovalRequestPostStore
from switch_core.db.stores.session_activity_store import ApprovalRequestStore
from switch_core.session_activity.cards import approval_request
from switch_core.session_activity.publisher import HANDLE_PREFIX
from switch_core.session_activity.service import (
    AgentSessionActivityService,
    PlatformPerson,
)
from switch_core.sessions.contract import RequestResult
from switch_core.sessions.errors import SessionError

logger = logging.getLogger(__name__)

_NO_IDENTITY = "Switch does not know who this account belongs to"


@dataclass(frozen=True)
class Waiting:
    """A card is waiting on an answer from the person who just spoke."""

    text: str
    card_ref: str | None


@dataclass(frozen=True)
class Answered:
    """The answer was recorded. The card redraws itself from the change."""

    handle: str


class ApprovalAnswers:
    def __init__(
        self,
        *,
        bridge_id: str,
        service: AgentSessionActivityService,
        session_factory: async_sessionmaker[AsyncSession],
        identify: Callable[[InboundActor], Awaitable[str | None]],
        is_first_reply: Callable[[str, str, str], Awaitable[bool]],
    ) -> None:
        self._bridge_id = bridge_id
        self._service = service
        self._sessions = session_factory
        self._identify = identify
        self._is_first_reply = is_first_reply
        self._posts = ApprovalRequestPostStore()
        self._approvals = ApprovalRequestStore()
        self._noticed: set[tuple[str, str, str]] = set()

    async def for_press(
        self, interaction: InboundInteraction
    ) -> Answered | Refused | None:
        pressed: str | int | None = parse_answer_action(interaction.action_id)
        if pressed is None:
            pressed = parse_answer_position(interaction.action_id)
        if pressed is None:
            return None
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            post = await self._posts.get_by_token(
                db, self._bridge_id, interaction.value
            )
            if post is None:
                return None
            row = await self._request_of(db, post)
        if (
            interaction.channel_id != post.external_channel_id
            or interaction.message_ref != post.external_post_id
        ):
            logger.warning(
                "Refusing a press for card %s on bridge %s: it came from a "
                "different message than the card.",
                post.handle,
                self._bridge_id,
            )
            return Refused(
                reason="that control does not belong to this card",
                handle=post.handle,
                card_ref=_card_thread(post),
            )
        if row is None:
            return _gone(post)
        form = posted_form(approval_request(row, None))
        answer = (
            resolve_pressed_option(form, pressed)
            if isinstance(pressed, str)
            else resolve_pressed_position(form, pressed)
        )
        return await self._answer(interaction, post, answer)

    async def for_text(self, message: InboundMessage) -> Answered | Refused | None:
        if message.sender_is_app:
            return None
        answer = parse_text_answer(message.content)
        if answer is not None and answer.handle is not None:
            return await self._named(message, answer)
        if message.root_id is None:
            return None
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            post = await self._posts.get_by_post(
                db, self._bridge_id, message.channel_id, message.root_id
            )
            direct = post is not None
            if post is None:
                post = await self._posts.latest_in_thread(
                    db, self._bridge_id, message.channel_id, message.root_id
                )
            if post is None or post.external_post_id is None:
                return None
            row = await self._request_of(db, post)
        if row is None:
            return _gone(post) if answer is not None and direct else None
        request = approval_request(row, None)
        form = posted_form(request)
        if answer is not None and takes_a_bare_decision(form):
            if not direct or not await self._is_first_reply(
                message.channel_id, message.root_id, message.message_ref
            ):
                return None
            return await self._answer(message, post, resolve_text_answer(form, answer))
        if row.state != "open":
            return None
        picked = resolve_plain_reply(request, form, message.content)
        if picked is None or isinstance(picked, Unanswerable):
            return None
        answered = await self._answer(message, post, picked)
        # A reply that read as an option but was refused (the sender may not
        # answer for this agent, or it was answered a moment ago) was chat all
        # along, and is not told off as a failed answer.
        return answered if isinstance(answered, Answered) else None

    async def waiting_notice(self, message: InboundMessage) -> Waiting | None:
        """Once per card, tell someone who could answer it that it is waiting.

        For a message that was not an answer, sent while a card in the channel
        is open: the agent is blocked on that card and reads the message only
        after it is answered, so the person is told how to answer rather than
        left wondering why nothing happened. Only someone who may answer is
        told, and only the first time, so the channel's other talk is left
        alone. Remembered per bridge process: after a restart it may be said
        once more.
        """
        if message.sender_is_app:
            return None
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            post = await self._posts.newest_open_in_channel(
                db, self._bridge_id, message.channel_id
            )
            if post is None:
                return None
            key = (post.agent_id, post.session_id, post.request_id)
            if key in self._noticed:
                return None
            row = await self._request_of(db, post)
        if row is None or row.room_id is None:
            return None
        mxid = await self._identify(message)
        if mxid is None:
            return None
        try:
            await self._service.authorize_room_control(
                post.agent_id, row.room_id, PlatformPerson(mxid), doing="answer it"
            )
        except SessionError:
            return None
        self._noticed.add(key)
        return Waiting(text=_waiting(post.handle), card_ref=_card_thread(post))

    async def _named(
        self, message: InboundMessage, answer: TextAnswer
    ) -> Answered | Refused | None:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            post = await self._post_for(db, message, answer)
            if post is None:
                return None
            row = await self._request_of(db, post)
        if post.external_post_id is None:
            logger.warning(
                "Refusing a typed answer to unconfirmed card %s on bridge %s.",
                post.handle,
                self._bridge_id,
            )
            return None
        if row is None:
            return _gone(post)
        form = posted_form(approval_request(row, None))
        return await self._answer(message, post, resolve_text_answer(form, answer))

    async def _post_for(
        self, db: AsyncSession, message: InboundMessage, answer: TextAnswer
    ) -> ApprovalRequestPost | None:
        assert answer.handle is not None
        if not answer.handle.upper().startswith(HANDLE_PREFIX):
            return None
        return await self._posts.get_by_handle(
            db, self._bridge_id, message.channel_id, answer.handle
        )

    async def _request_of(
        self, db: AsyncSession, post: ApprovalRequestPost
    ) -> ApprovalRequest | None:
        return await self._approvals.get(
            db, post.agent_id, post.session_id, post.request_id, for_update=False
        )

    async def _answer(
        self,
        actor: InboundActor,
        post: ApprovalRequestPost,
        answer: RequestResult | Unanswerable,
    ) -> Answered | Refused:
        if isinstance(answer, Unanswerable):
            return Refused(
                reason=answer.reason, handle=post.handle, card_ref=_card_thread(post)
            )
        mxid = await self._identify(actor)
        if mxid is None:
            logger.warning(
                "Ignoring an answer to card %s: no Switch identity for %s on bridge %s.",
                post.handle,
                actor.sender_id,
                self._bridge_id,
            )
            return Refused(
                reason=_NO_IDENTITY, handle=post.handle, card_ref=_card_thread(post)
            )
        try:
            await self._service.answer_approval(
                post.agent_id,
                post.session_id,
                post.request_id,
                answer=answer,
                answerer=PlatformPerson(mxid),
            )
        except SessionError as error:
            logger.warning(
                "Answer to card %s on bridge %s refused (%s): %s",
                post.handle,
                self._bridge_id,
                error.code,
                error,
            )
            return Refused(
                reason=_as_reason(str(error)),
                handle=post.handle,
                card_ref=_card_thread(post),
            )
        return Answered(handle=post.handle)


def _card_thread(post: ApprovalRequestPost) -> str | None:
    """The thread a card is in: the root it was posted under, or the card itself
    when it was posted at the top level. A platform threads a reply under a
    root, not under another reply."""
    return post.thread_ref or post.external_post_id


def _waiting(handle: str) -> str:
    return (
        f"The agent is waiting for an answer to {handle} and will read your "
        f"message once it is answered. Press a button on {handle}, reply "
        f"`{handle} 1`, or reply in its thread with one of its options."
    )


def _gone(post: ApprovalRequestPost) -> Refused:
    return Refused(
        reason="its request no longer exists",
        handle=post.handle,
        card_ref=_card_thread(post),
    )


def _as_reason(message: str) -> str:
    """A service error as the end of "…did not land, because …"."""
    text = message.strip().rstrip(".")
    return text[:1].lower() + text[1:] if text else "Switch refused it"
