"""What an agent's session host reports: that a session started, its turn steps
and its approval requests.

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
from switch_core.bridges.agent.dependencies import get_session_factory, get_telemetry
from switch_core.db.models import Agent, ApprovalRequest
from switch_core.session_activity.service import (
    MAX_DETAIL_CHARS,
    MAX_MODEL_CHARS,
    MAX_MODELS_PER_TURN,
    MAX_OPTIONS,
    MAX_QUESTION_OPTIONS,
    MAX_QUESTIONS,
    MAX_TEXT_CHARS,
    MAX_TITLE_CHARS,
    MAX_TOKENS,
    ApprovalOption,
    Decision,
    Question,
    QuestionOption,
    SessionActivityService,
    TokenSpend,
)
from switch_core.telemetry import TelemetryService
from switch_core.telemetry.session_start import StartSource, report_session_started

router = APIRouter(prefix="/agent-sessions")
Factory = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
AuthenticatedAgent = Annotated[Agent, Depends(get_agent_from_scope)]
Telemetry = Annotated[TelemetryService | None, Depends(get_telemetry)]

_Id = Annotated[str, Field(min_length=1, max_length=200)]


class SessionStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_source: StartSource


class SessionStartReceipt(BaseModel):
    # False when nothing was sent: telemetry is off, or this session already
    # reported its start. A host acts on neither; it is here for the logs.
    reported: bool


class TokenUsageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(max_length=MAX_MODEL_CHARS)
    input_tokens: int = Field(ge=0, le=MAX_TOKENS)
    output_tokens: int = Field(ge=0, le=MAX_TOKENS)
    cache_read_tokens: int = Field(ge=0, le=MAX_TOKENS)
    cache_write_tokens: int = Field(ge=0, le=MAX_TOKENS)


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
    # Hosts that predate usage reporting do not send it.
    usage: list[TokenUsageIn] = Field(
        default_factory=list, max_length=MAX_MODELS_PER_TURN
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


@router.post("/{session_id}/started")
async def report_started(
    session_id: _Id,
    body: SessionStart,
    agent: AuthenticatedAgent,
    factory: Factory,
    telemetry: Telemetry,
) -> SessionStartReceipt:
    """A session host saying, once, that a new session began and how."""
    reported = await report_session_started(
        telemetry, factory, agent, session_id, body.start_source
    )
    return SessionStartReceipt(reported=reported)


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
        usage=[
            TokenSpend(
                model=u.model,
                input_tokens=u.input_tokens,
                output_tokens=u.output_tokens,
                cache_read_tokens=u.cache_read_tokens,
                cache_write_tokens=u.cache_write_tokens,
            )
            for u in body.usage
        ],
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
