"""What an agent's session host reports: activity lines and approval requests.

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
    MAX_OPTIONS,
    MAX_SUMMARY_CHARS,
    ApprovalOption,
    Decision,
    SessionActivityService,
)

router = APIRouter(prefix="/agent-sessions")
Factory = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
AuthenticatedAgent = Annotated[Agent, Depends(get_agent_from_scope)]

_Id = Annotated[str, Field(min_length=1, max_length=200)]


class ActivityReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seq: int = Field(ge=0)
    type: Literal[
        "turn.started", "tool.called", "tool.finished", "turn.finished", "notice"
    ]
    summary: str = Field(min_length=1, max_length=MAX_SUMMARY_CHARS)
    detail: dict[str, Any] = Field(default_factory=dict)
    turn_id: _Id | None
    room_id: _Id | None
    thread_id: _Id | None
    occurred_at: datetime


class OptionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: _Id
    label: str = Field(min_length=1, max_length=200)
    decision: Decision


class ApprovalOpen(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: _Id
    question: str = Field(min_length=1, max_length=4000)
    options: list[OptionIn] = Field(min_length=1, max_length=MAX_OPTIONS)
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
    session_id: str
    request_id: str
    state: str
    answer: str | None
    answered_by: str | None
    answered_at: datetime | None
    expires_at: datetime | None
    delivered_at: datetime | None

    @classmethod
    def of(cls, row: ApprovalRequest) -> "ApprovalView":
        return cls(
            session_id=row.session_id,
            request_id=row.request_id,
            state=row.state,
            answer=row.answer,
            answered_by=row.answered_by,
            answered_at=row.answered_at,
            expires_at=row.expires_at,
            delivered_at=row.delivered_at,
        )


@router.post("/{session_id}/activity", response_model_by_alias=True)
async def report_activity(
    session_id: _Id, body: ActivityReport, agent: AuthenticatedAgent, factory: Factory
) -> ActivityReceipt:
    recorded = await SessionActivityService(factory).report_activity(
        agent.id,
        session_id,
        seq=body.seq,
        type=body.type,
        summary=body.summary,
        detail=body.detail,
        turn_id=body.turn_id,
        room_id=body.room_id,
        thread_id=body.thread_id,
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
        question=body.question,
        options=[ApprovalOption(o.id, o.label, o.decision) for o in body.options],
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
