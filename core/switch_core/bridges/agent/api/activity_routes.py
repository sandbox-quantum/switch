"""What an agent's session host reports: turn steps and approval requests.

The host owns the session; these routes take only what a messaging platform
shows and what the server must check when a person answers. The agent is the
one the API key belongs to, so a host can only ever write for its own agent.
"""

from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_session_factory
from switch_core.db.models import Agent, ApprovalRequest
from switch_core.session_activity.service import (
    MAX_DETAIL_CHARS,
    MAX_OPTIONS,
    MAX_QUESTION_OPTIONS,
    MAX_QUESTIONS,
    MAX_TEXT_CHARS,
    MAX_TITLE_CHARS,
    ApprovalOption,
    Decision,
    Question,
    QuestionOption,
    SessionActivityService,
)

router = APIRouter(prefix="/agent-sessions")
Factory = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
AuthenticatedAgent = Annotated[Agent, Depends(get_agent_from_scope)]

_Id = Annotated[str, Field(min_length=1, max_length=200)]

# Per-tenant usage metering was removed, but shipped Switch Console 0.37 still
# posts a `usage` array on every activity report and `ActivityReport` forbids
# extra fields, so the schema is kept only to accept those reports; the value
# is validated and then discarded.
_MAX_MODEL_CHARS = 200
_MAX_MODELS_PER_TURN = 50
_MAX_TOKENS = 2**53 - 1


class TokenUsageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(max_length=_MAX_MODEL_CHARS)
    input_tokens: int = Field(ge=0, le=_MAX_TOKENS)
    output_tokens: int = Field(ge=0, le=_MAX_TOKENS)
    cache_read_tokens: int = Field(ge=0, le=_MAX_TOKENS)
    cache_write_tokens: int = Field(ge=0, le=_MAX_TOKENS)


class ActivityReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    turn_id: _Id
    item_id: _Id
    kind: Literal[
        "turn", "user-message", "assistant-message", "tool-activity", "notice"
    ]
    revision: int = Field(ge=0)
    status: str = Field(min_length=1, max_length=40)
    title: str = Field(max_length=MAX_TITLE_CHARS)
    text: str = Field(max_length=MAX_TEXT_CHARS)
    command_id: _Id | None
    room_id: _Id | None
    thread_id: _Id | None
    message_id: _Id | None
    occurred_at: datetime
    # Accepted from Switch Console 0.37 and ignored; see the note above.
    usage: list[TokenUsageIn] = Field(
        default_factory=list, max_length=_MAX_MODELS_PER_TURN
    )


class OptionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: _Id
    label: str = Field(min_length=1)
    decision: Decision


class QuestionOptionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: _Id
    label: str
    description: str | None


class QuestionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: _Id
    title: str
    prompt: str
    options: list[QuestionOptionIn] = Field(max_length=MAX_QUESTION_OPTIONS)
    multi_select: bool
    allow_custom_answer: bool


class ApprovalOpen(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: _Id
    turn_id: _Id
    kind: Literal["approval", "questions"]
    title: str = Field(min_length=1, max_length=MAX_TITLE_CHARS)
    detail: str | None = Field(max_length=MAX_DETAIL_CHARS)
    options: list[OptionIn] = Field(max_length=MAX_OPTIONS)
    questions: list[QuestionIn] = Field(max_length=MAX_QUESTIONS)
    room_id: _Id | None
    thread_id: _Id | None
    expires_at: datetime | None


class _Response(BaseModel):
    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, populate_by_name=True
    )


class ActivityReceipt(_Response):
    recorded: bool


class ApprovalView(_Response):
    """A request's outcome for its host. `answers` keeps the stored keys (snake_case)."""

    session_id: str
    request_id: str
    kind: str
    state: str
    answer: str | None
    answers: list[dict[str, Any]] | None
    answered_by: str | None
    answered_at: datetime | None
    expires_at: datetime | None
    delivered_at: datetime | None

    @classmethod
    def of(cls, row: ApprovalRequest) -> "ApprovalView":
        return cls(
            session_id=row.session_id,
            request_id=row.request_id,
            kind=row.kind,
            state=row.state,
            answer=row.answer,
            answers=row.answers,
            answered_by=row.answered_by,
            answered_at=row.answered_at,
            expires_at=row.expires_at,
            delivered_at=row.delivered_at,
        )


@router.post("/{session_id}/activity", response_model_by_alias=True)
async def report_activity(
    session_id: _Id, body: ActivityReport, agent: AuthenticatedAgent, factory: Factory
) -> ActivityReceipt:
    recorded = await SessionActivityService(factory).report_item(
        agent.id,
        session_id,
        turn_id=body.turn_id,
        item_id=body.item_id,
        kind=body.kind,
        revision=body.revision,
        status=body.status,
        title=body.title,
        text=body.text,
        command_id=body.command_id,
        room_id=body.room_id,
        thread_id=body.thread_id,
        message_id=body.message_id,
        occurred_at=body.occurred_at,
    )
    return ActivityReceipt(recorded=recorded)


@router.post("/{session_id}/approvals", response_model_by_alias=True)
async def open_approval(
    session_id: _Id, body: ApprovalOpen, agent: AuthenticatedAgent, factory: Factory
) -> ApprovalView:
    row = await SessionActivityService(factory).open_approval(
        agent.id,
        session_id,
        request_id=body.request_id,
        turn_id=body.turn_id,
        kind=body.kind,
        title=body.title,
        detail=body.detail,
        options=[ApprovalOption(o.id, o.label, o.decision) for o in body.options],
        questions=[
            Question(
                id=q.id,
                title=q.title,
                prompt=q.prompt,
                options=[
                    QuestionOption(o.id, o.label, o.description) for o in q.options
                ],
                multi_select=q.multi_select,
                allow_custom_answer=q.allow_custom_answer,
            )
            for q in body.questions
        ],
        room_id=body.room_id,
        thread_id=body.thread_id,
        expires_at=body.expires_at,
    )
    return ApprovalView.of(row)


@router.post("/{session_id}/approvals/{request_id}/close", response_model_by_alias=True)
async def close_approval(
    session_id: _Id, request_id: _Id, agent: AuthenticatedAgent, factory: Factory
) -> ApprovalView:
    row = await SessionActivityService(factory).close_approval(
        agent.id, session_id, request_id
    )
    return ApprovalView.of(row)


@router.post(
    "/{session_id}/approvals/{request_id}/delivered", response_model_by_alias=True
)
async def mark_delivered(
    session_id: _Id, request_id: _Id, agent: AuthenticatedAgent, factory: Factory
) -> ApprovalView:
    row = await SessionActivityService(factory).mark_delivered(
        agent.id, session_id, request_id
    )
    return ApprovalView.of(row)


@router.get("/approvals/outcomes", response_model_by_alias=True)
async def undelivered_outcomes(
    agent: AuthenticatedAgent, factory: Factory
) -> list[ApprovalView]:
    """Answers and expiries the agent has not acknowledged, oldest first."""
    rows = await SessionActivityService(factory).undelivered_outcomes(agent.id)
    return [ApprovalView.of(row) for row in rows]
