"""Record what a session's host reports, and check answers to its requests.

The host owns the session. This service keeps only what messaging platforms
draw and what must be checked when a person answers: each turn's steps and the
requests a session waits on. Each call is one short transaction over small
rows.

An answer is accepted from anyone who may address the agent — the agent's
addressing policy, judged in the request's room — and only while the request
is open, unexpired, and the answer fits what was asked.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import allows_on_behalf_of, parse_policy
from switch_core.db.models import (
    APPROVAL_REQUEST_KINDS,
    SESSION_ACTIVITY_KINDS,
    Agent,
    ApprovalRequest,
    SessionActivityItem,
    UsageMetric,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.session_activity_store import (
    TURN_ITEM_ID,
    ApprovalRequestStore,
    SessionActivityStore,
)
from switch_core.db.stores.usage_store import UsageStore
from switch_core.delivery.addressing import AddressingResolver
from switch_core.sessions.contract import (
    TURN_ENDED,
    ApprovalResult,
    QuestionsResult,
    RequestResult,
)
from switch_core.sessions.errors import SessionError

MAX_TITLE_CHARS = 500
MAX_TEXT_CHARS = 8000
MAX_DETAIL_CHARS = 4000
MAX_OPTIONS = 10
MAX_QUESTIONS = 50
MAX_QUESTION_OPTIONS = 50
MAX_CUSTOM_ANSWER_CHARS = 4000
MAX_MODEL_CHARS = 200
MAX_MODELS_PER_TURN = 50
# A host counts in JavaScript numbers, exact only up to 2**53 - 1.
MAX_TOKENS = 2**53 - 1
# What the host sends inside a question is not truncated by the host, so it is
# cut here to what any platform can show rather than refused.
_QUESTION_TITLE_CHARS = 500
_QUESTION_PROMPT_CHARS = 4000
_OPTION_LABEL_CHARS = 500
_OPTION_DESCRIPTION_CHARS = 1000
# A request nobody answers must not hold a session forever, and one that
# outlives a working day is no longer the question anyone is looking at.
MAX_APPROVAL_LIFETIME = timedelta(hours=24)
NOTICE_PREFIX = "notice:"

ITEM_STATUSES: dict[str, frozenset[str]] = {
    "turn": frozenset({"queued", "running", "completed", "interrupted", "error"}),
    "user-message": frozenset({"in-progress", "completed", "failed", "declined"}),
    "assistant-message": frozenset({"in-progress", "completed", "failed", "declined"}),
    "tool-activity": frozenset({"in-progress", "completed", "failed", "declined"}),
    "notice": frozenset({"info", "warning", "error"}),
}

Decision = Literal["accept", "acceptForSession", "decline", "cancel"]
DECISIONS: tuple[Decision, ...] = ("accept", "acceptForSession", "decline", "cancel")
RequestKind = Literal["approval", "questions"]


@dataclass(frozen=True)
class TokenSpend:
    """Tokens one model spent in a turn. `model` is empty when the provider
    ran its default without naming it."""

    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int


@dataclass(frozen=True)
class ApprovalOption:
    id: str
    label: str
    # What choosing it means. Platforms style the control by it (a decline is
    # drawn as the dangerous one) and a typed "yes" or "no" resolves by it.
    decision: Decision


@dataclass(frozen=True)
class QuestionOption:
    id: str
    label: str
    description: str | None


@dataclass(frozen=True)
class Question:
    id: str
    title: str
    prompt: str
    options: list[QuestionOption]
    multi_select: bool
    allow_custom_answer: bool


@dataclass(frozen=True)
class PlatformPerson:
    """Someone answering from a messaging platform, by their room identity (mxid)."""

    mxid: str

    @property
    def recorded_as(self) -> str:
        return self.mxid


@dataclass(frozen=True)
class SwitchUser:
    """A signed-in Switch user answering from Switch Console or the web."""

    user_id: str

    @property
    def recorded_as(self) -> str:
        return f"user:{self.user_id}"


Answerer = PlatformPerson | SwitchUser


class SessionActivityService:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory
        self._approvals = ApprovalRequestStore()
        self._activity = SessionActivityStore()
        self._usage = UsageStore()
        self._rooms = RoomStore()
        self._external_users = ExternalUserStore()
        self._addressing = AddressingResolver(
            room_store=self._rooms,
            room_role_store=RoomRoleStore(),
            client_store=ClientStore(),
            agent_store=AgentStore(),
            external_user_store=self._external_users,
            # Only role mentions consult liveness; a permission check never does.
            live_connection_ids=set,
        )

    # ── Turn steps ────────────────────────────────────────────────────────────

    async def report_item(
        self,
        agent_id: str,
        session_id: str,
        *,
        turn_id: str,
        item_id: str,
        kind: str,
        revision: int,
        status: str,
        title: str,
        text: str,
        command_id: str | None,
        room_id: str | None,
        thread_id: str | None,
        message_id: str | None,
        occurred_at: datetime,
        usage: list[TokenSpend],
    ) -> bool:
        """Record one step of a turn. False when a revision at least as new is stored.

        `usage` is what the turn spent, and only a turn's own row, reported as
        ended, carries it.
        """
        if kind not in SESSION_ACTIVITY_KINDS:
            raise SessionError("INVALID_EVENT", f"Unknown activity kind: {kind}")
        if status not in ITEM_STATUSES[kind]:
            raise SessionError(
                "INVALID_EVENT", f"{status!r} is not a status of a {kind} row."
            )
        if (item_id == TURN_ITEM_ID) != (kind == "turn"):
            raise SessionError(
                "INVALID_EVENT",
                f"Only the turn's own row has item id {TURN_ITEM_ID!r}.",
            )
        if kind == "notice" and not item_id.startswith(NOTICE_PREFIX):
            raise SessionError(
                "INVALID_EVENT", f"A notice's item id starts with {NOTICE_PREFIX!r}."
            )
        if command_id is not None and kind != "turn":
            raise SessionError(
                "INVALID_EVENT", "Only the turn's own row carries a command id."
            )
        if revision < 0:
            raise SessionError("INVALID_EVENT", "A revision is never negative.")
        if usage and not (kind == "turn" and status in TURN_ENDED):
            raise SessionError(
                "INVALID_EVENT", "Only an ended turn's own row carries its usage."
            )
        if len(title) > MAX_TITLE_CHARS or len(text) > MAX_TEXT_CHARS:
            raise SessionError(
                "INVALID_EVENT",
                f"A step's title is at most {MAX_TITLE_CHARS} characters and its "
                f"text at most {MAX_TEXT_CHARS}.",
            )
        tenant_id = require_tenant_id()
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            if room_id is not None:
                await self._require_member(db, agent_id, room_id)
            prior_status = (
                await self._activity.status_for_update(
                    db, agent_id, session_id, turn_id, item_id
                )
                if kind == "turn"
                else None
            )
            moved = await self._activity.upsert(
                db,
                SessionActivityItem(
                    tenant_id=tenant_id,
                    agent_id=agent_id,
                    session_id=session_id,
                    turn_id=turn_id,
                    item_id=item_id,
                    kind=kind,
                    revision=revision,
                    status=status,
                    title=title,
                    text=text,
                    command_id=command_id,
                    room_id=room_id,
                    thread_id=thread_id,
                    message_id=message_id,
                    occurred_at=occurred_at,
                ),
            )
            if moved and kind == "turn":
                if prior_status is None:
                    await self._meter_turn(db, tenant_id, agent_id)
                if status in TURN_ENDED and prior_status not in TURN_ENDED:
                    await self._meter_tokens(db, tenant_id, agent_id, usage)
            return moved

    async def _meter_turn(
        self, db: AsyncSession, tenant_id: str, agent_id: str
    ) -> None:
        """Count a turn the first time its host reports it, whatever its status.

        A turn has been paid for once it exists: one that errors or is
        interrupted still spent the model's time, so counting only the ones
        that complete would under-report exactly the runaway loops a budget is
        for.
        """
        await self._usage.record(
            db,
            tenant_id=tenant_id,
            metric=UsageMetric.TURNS,
            client_id=await self._agent_client_id(db, tenant_id, agent_id),
            model="",
            amount=1,
        )

    async def _meter_tokens(
        self,
        db: AsyncSession,
        tenant_id: str,
        agent_id: str,
        usage: list[TokenSpend],
    ) -> None:
        """Count what a turn spent, once: when its row first reports it ended.

        The counts are what the host says: a customer's own agent reports on
        itself, which is enough for a budget the customer sets for itself.
        """
        if not usage:
            return
        client_id = await self._agent_client_id(db, tenant_id, agent_id)
        # One agent's turns can end concurrently; upserting the counters in the
        # same order in each keeps two of them from deadlocking.
        for spend in sorted(usage, key=lambda s: s.model):
            for metric, amount in (
                (UsageMetric.INPUT_TOKENS, spend.input_tokens),
                (UsageMetric.OUTPUT_TOKENS, spend.output_tokens),
                (UsageMetric.CACHE_READ_TOKENS, spend.cache_read_tokens),
                (UsageMetric.CACHE_WRITE_TOKENS, spend.cache_write_tokens),
            ):
                if amount > 0:
                    await self._usage.record(
                        db,
                        tenant_id=tenant_id,
                        metric=metric,
                        client_id=client_id,
                        model=spend.model,
                        amount=amount,
                    )

    @staticmethod
    async def _agent_client_id(db: AsyncSession, tenant_id: str, agent_id: str) -> str:
        """The client an agent's usage is charged to, the identity every other
        metric is counted against."""
        client_id = await db.scalar(
            select(Agent.client_id).where(
                Agent.tenant_id == tenant_id, Agent.id == agent_id
            )
        )
        if client_id is None:
            raise SessionError("NOT_FOUND", f"Agent {agent_id} does not exist.")
        return client_id

    async def turn_items(
        self, agent_id: str, session_id: str, turn_id: str
    ) -> list[SessionActivityItem]:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            return await self._activity.turn(db, agent_id, session_id, turn_id)

    async def prune_activity(self, older_than: timedelta) -> int:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            return await self._activity.prune_before(db, datetime.now(UTC) - older_than)

    # ── Approval requests ─────────────────────────────────────────────────────

    async def open_approval(
        self,
        agent_id: str,
        session_id: str,
        *,
        request_id: str,
        turn_id: str,
        kind: str,
        title: str,
        detail: str | None,
        options: list[ApprovalOption],
        questions: list[Question],
        room_id: str | None,
        thread_id: str | None,
        expires_at: datetime | None,
    ) -> ApprovalRequest:
        """Open a request, or return it unchanged when the host retries the same open."""
        if kind not in APPROVAL_REQUEST_KINDS:
            raise SessionError("INVALID_EVENT", f"Unknown request kind: {kind}")
        if not title.strip():
            raise SessionError("INVALID_EVENT", "A request needs a title.")
        if len(title) > MAX_TITLE_CHARS:
            raise SessionError(
                "INVALID_EVENT",
                f"A request's title is at most {MAX_TITLE_CHARS} characters.",
            )
        if detail is not None and len(detail) > MAX_DETAIL_CHARS:
            raise SessionError(
                "INVALID_EVENT",
                f"A request's detail is at most {MAX_DETAIL_CHARS} characters.",
            )
        if kind == "approval":
            _check_approval_options(options, questions)
        else:
            _check_questions(options, questions)
        now = datetime.now(UTC)
        if expires_at is not None:
            if expires_at <= now:
                raise SessionError("INVALID_EVENT", "The request has already expired.")
            if expires_at - now > MAX_APPROVAL_LIFETIME:
                raise SessionError(
                    "INVALID_EVENT",
                    "A request may stay open for at most 24 hours.",
                )
        offered = [
            {
                "id": option.id,
                "label": _clip(option.label, _OPTION_LABEL_CHARS),
                "decision": option.decision,
            }
            for option in options
        ]
        asked = [_stored_question(question) for question in questions]
        tenant_id = require_tenant_id()
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            if room_id is not None:
                await self._require_member(db, agent_id, room_id)
            created = await self._approvals.insert_if_absent(
                db,
                ApprovalRequest(
                    agent_id=agent_id,
                    session_id=session_id,
                    request_id=request_id,
                    turn_id=turn_id,
                    kind=kind,
                    room_id=room_id,
                    thread_id=thread_id,
                    title=title,
                    detail=detail,
                    options=offered,
                    questions=asked,
                    state="open",
                    expires_at=expires_at,
                ),
            )
            row = await self._approvals.get(
                db, agent_id, session_id, request_id, for_update=False
            )
            assert row is not None
            if not created and (
                row.kind,
                row.turn_id,
                row.title,
                row.detail,
                row.options,
                row.questions,
                row.room_id,
                row.thread_id,
                row.expires_at,
            ) != (
                kind,
                turn_id,
                title,
                detail,
                offered,
                asked,
                room_id,
                thread_id,
                expires_at,
            ):
                raise SessionError(
                    "REQUEST_CONFLICT",
                    f"Request {request_id} of session {session_id} was already "
                    "opened with different content.",
                )
            return row

    async def answer_approval(
        self,
        agent_id: str,
        session_id: str,
        request_id: str,
        *,
        answer: RequestResult,
        answerer: Answerer,
    ) -> ApprovalRequest:
        """Record a person's answer. A repeat of the same answer by the same person is a no-op.

        The answerer must be someone who may address the agent: answering is
        talking to the agent, so it takes the same permission.
        """
        answered_by = answerer.recorded_as
        tenant_id = require_tenant_id()
        closed_as: str | None = None
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            row = await self._require_request(db, agent_id, session_id, request_id)
            unfit: SessionError | None = None
            try:
                chosen, given = _answer_fields(row, answer)
            except SessionError as error:
                unfit = error
            if (
                unfit is None
                and row.state == "answered"
                and (row.answer, row.answers, row.answered_by)
                == (chosen, given, answered_by)
            ):
                return row
            await self._require_may_address(
                db, row.agent_id, row.room_id, answerer, doing="answer it"
            )
            if row.state == "open" and _past(row.expires_at):
                # Kept even though the answer is refused: the agent is owed the expiry.
                row.state = "expired"
            if row.state != "open":
                closed_as = row.state
            elif unfit is not None:
                raise unfit
            else:
                row.state = "answered"
                row.answer = chosen
                row.answers = given
                row.answered_by = answered_by
                row.answered_at = datetime.now(UTC)
        if closed_as is not None:
            raise SessionError(
                "REQUEST_CLOSED", f"Request {request_id} is {closed_as}."
            )
        return row

    async def authorize_room_control(
        self, agent_id: str, room_id: str, person: PlatformPerson, *, doing: str
    ) -> None:
        """Refuse a person who may not address the agent in the room.

        A control drives the agent as surely as a message does, so it takes
        the same permission the room's own `!interrupt` is gated by.
        """
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            await self._require_may_address(db, agent_id, room_id, person, doing=doing)

    async def close_approval(
        self, agent_id: str, session_id: str, request_id: str
    ) -> ApprovalRequest:
        """The host no longer needs an answer. Closing a settled request changes nothing."""
        tenant_id = require_tenant_id()
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            row = await self._require_request(db, agent_id, session_id, request_id)
            if row.state == "open":
                row.state = "closed"
            return row

    async def open_for_owner(self, owner_id: str) -> list[ApprovalRequest]:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            return await self._approvals.open_for_owner(db, owner_id)

    async def undelivered_outcomes(self, agent_id: str) -> list[ApprovalRequest]:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            return await self._approvals.undelivered(db, agent_id)

    async def mark_delivered(
        self, agent_id: str, session_id: str, request_id: str
    ) -> ApprovalRequest:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._require_request(db, agent_id, session_id, request_id)
            if row.state not in ("answered", "expired"):
                raise SessionError(
                    "REQUEST_OPEN",
                    f"Request {request_id} is {row.state}; there is no outcome to deliver.",
                )
            if row.delivered_at is None:
                row.delivered_at = datetime.now(UTC)
            return row

    async def expire_due(self) -> list[ApprovalRequest]:
        """Expire the bound tenant's overdue requests. Run on a timer."""
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            return await self._approvals.expire_due(db, datetime.now(UTC))

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def _require_member(
        self, db: AsyncSession, agent_id: str, room_id: str
    ) -> None:
        found = await self._rooms.get_with_membership(db, room_id, agent_id)
        if found is None:
            raise SessionError("NOT_FOUND", f"Room not found: {room_id}")
        if not found[1]:
            raise SessionError("NOT_AUTHORIZED", "Agent is not a member of this room.")

    async def _require_may_address(
        self,
        db: AsyncSession,
        agent_id: str,
        room_id: str | None,
        answerer: Answerer,
        *,
        doing: str,
    ) -> None:
        agent = await db.get(Agent, agent_id)
        if agent is None:
            raise SessionError("NOT_FOUND", f"Agent not found: {agent_id}")
        if isinstance(answerer, SwitchUser):
            allowed = await self._switch_user_may_address(db, agent, room_id, answerer)
        elif room_id is not None:
            decision = await self._addressing.permitted(
                db, agent=agent, room_id=room_id, sender=answerer.mxid
            )
            allowed = decision.allowed
        else:
            # Asked outside any room, so no room's policy applies: only the
            # agent's owner may answer.
            principal = await self._addressing.resolve_sender(db, answerer.mxid)
            allowed = (
                principal is not None
                and agent.owner_id is not None
                and agent.owner_id in principal.user_ids
            )
        if not allowed:
            raise SessionError(
                "NOT_AUTHORIZED",
                f"You may not address this agent, so you may not {doing}.",
            )

    async def _switch_user_may_address(
        self, db: AsyncSession, agent: Agent, room_id: str | None, user: SwitchUser
    ) -> bool:
        """The rule the platform follows when it speaks on a person's behalf."""
        if room_id is None:
            return agent.owner_id is not None and agent.owner_id == user.user_id
        room = await self._rooms.get(db, room_id)
        claimed = await self._external_users.get_by_user(db, user.user_id)
        return allows_on_behalf_of(
            parse_policy(agent.addressing_policy),
            room_id=room_id,
            group_id=room.group_id if room is not None else None,
            user_id=user.user_id,
            external_user_ids=[account.id for account in claimed],
            owner_user_id=agent.owner_id,
        )

    async def _require_request(
        self, db: AsyncSession, agent_id: str, session_id: str, request_id: str
    ) -> ApprovalRequest:
        row = await self._approvals.get(
            db, agent_id, session_id, request_id, for_update=True
        )
        if row is None:
            raise SessionError("NOT_FOUND", f"Request not found: {request_id}")
        return row


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _check_approval_options(
    options: list[ApprovalOption], questions: list[Question]
) -> None:
    if questions:
        raise SessionError("INVALID_EVENT", "An approval asks no questions.")
    ids = [option.id for option in options]
    if not options or len(options) > MAX_OPTIONS:
        raise SessionError(
            "INVALID_EVENT",
            f"An approval needs between 1 and {MAX_OPTIONS} options.",
        )
    if len(set(ids)) != len(ids) or not all(
        option.id and option.label and option.decision in DECISIONS
        for option in options
    ):
        raise SessionError(
            "INVALID_EVENT",
            "Options need distinct ids, non-empty labels and a known decision.",
        )


def _check_questions(options: list[ApprovalOption], questions: list[Question]) -> None:
    if options:
        raise SessionError(
            "INVALID_EVENT", "A questions request carries its options per question."
        )
    if not questions or len(questions) > MAX_QUESTIONS:
        raise SessionError(
            "INVALID_EVENT",
            f"A questions request needs between 1 and {MAX_QUESTIONS} questions.",
        )
    ids = [question.id for question in questions]
    if len(set(ids)) != len(ids) or not all(ids):
        raise SessionError("INVALID_EVENT", "Questions need distinct, non-empty ids.")
    for question in questions:
        option_ids = [option.id for option in question.options]
        if len(option_ids) > MAX_QUESTION_OPTIONS:
            raise SessionError(
                "INVALID_EVENT",
                f"A question offers at most {MAX_QUESTION_OPTIONS} options.",
            )
        if len(set(option_ids)) != len(option_ids) or not all(option_ids):
            raise SessionError(
                "INVALID_EVENT",
                f"The options of question {question.id} need distinct, non-empty ids.",
            )


def _stored_question(question: Question) -> dict[str, Any]:
    return {
        "id": question.id,
        "title": _clip(question.title, _QUESTION_TITLE_CHARS),
        "prompt": _clip(question.prompt, _QUESTION_PROMPT_CHARS),
        "options": [
            {
                "id": option.id,
                "label": _clip(option.label, _OPTION_LABEL_CHARS),
                "description": None
                if option.description is None
                else _clip(option.description, _OPTION_DESCRIPTION_CHARS),
            }
            for option in question.options
        ],
        "multi_select": question.multi_select,
        "allow_custom_answer": question.allow_custom_answer,
    }


def _answer_fields(
    row: ApprovalRequest, answer: RequestResult
) -> tuple[str | None, list[dict[str, Any]] | None]:
    """What an answer stores as: `answer` for an approval, `answers` for questions.

    Checked against the row: the option exists, or every question is answered
    once, with options it offered and words only where it takes them.
    """
    if row.kind == "approval":
        if not isinstance(answer, ApprovalResult):
            raise SessionError(
                "INVALID_ANSWER",
                "This request is an approval; pick one of its options.",
            )
        if answer.option_id not in {option["id"] for option in row.options}:
            raise SessionError(
                "INVALID_ANSWER",
                f"{answer.option_id!r} is not one of this request's options.",
            )
        return answer.option_id, None
    if not isinstance(answer, QuestionsResult):
        raise SessionError(
            "INVALID_ANSWER", "This request asks questions; answer each of them."
        )
    by_id = {entry.question_id: entry for entry in answer.answers}
    if len(by_id) != len(answer.answers):
        raise SessionError("INVALID_ANSWER", "A question was answered twice.")
    unknown = set(by_id) - {question["id"] for question in row.questions}
    if unknown:
        raise SessionError(
            "INVALID_ANSWER",
            f"{sorted(unknown)[0]!r} is not one of this request's questions.",
        )
    stored: list[dict[str, Any]] = []
    for position, question in enumerate(row.questions, start=1):
        entry = by_id.get(question["id"])
        if entry is None:
            raise SessionError(
                "INVALID_ANSWER",
                f"q{position} went unanswered, and every question needs an answer.",
            )
        offered = [option["id"] for option in question["options"]]
        picked = set(entry.selected_option_ids)
        if not picked <= set(offered):
            raise SessionError(
                "INVALID_ANSWER",
                f"q{position} was answered with an option it does not offer.",
            )
        if len(picked) > 1 and not question["multi_select"]:
            raise SessionError("INVALID_ANSWER", f"q{position} takes one option.")
        custom = entry.custom_text.strip() if entry.custom_text is not None else None
        if custom == "":
            custom = None
        if custom is not None:
            if not question["allow_custom_answer"]:
                raise SessionError(
                    "INVALID_ANSWER", f"q{position} does not take a written answer."
                )
            if len(custom) > MAX_CUSTOM_ANSWER_CHARS:
                raise SessionError(
                    "INVALID_ANSWER",
                    f"A written answer is at most {MAX_CUSTOM_ANSWER_CHARS} characters.",
                )
        if not picked and custom is None:
            raise SessionError("INVALID_ANSWER", f"q{position} was left empty.")
        stored.append(
            {
                "question_id": question["id"],
                "selected_option_ids": [o for o in offered if o in picked],
                "custom_text": custom,
            }
        )
    return None, stored


def _past(moment: datetime | None) -> bool:
    return moment is not None and moment <= datetime.now(UTC)
