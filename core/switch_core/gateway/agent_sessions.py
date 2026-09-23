"""Approval requests for a signed-in person: Switch Console and the web.

The person answers as themselves, so the answer is judged the way the platform
judges a message it sends on someone's behalf — the agent's addressing policy
in the request's room, or its owner when the request has no room.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ApprovalRequest, User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session_factory
from switch_core.session_activity.service import SessionActivityService, SwitchUser

router = APIRouter()
Factory = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
CurrentUser = Annotated[User, Depends(get_current_user)]


class _Model(BaseModel):
    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, populate_by_name=True
    )


class OptionView(_Model):
    id: str
    label: str


class ApprovalRequestView(_Model):
    agent_id: str
    session_id: str
    request_id: str
    room_id: str | None
    thread_id: str | None
    question: str
    options: list[OptionView]
    state: str
    expires_at: datetime | None
    answer: str | None
    answered_by: str | None
    answered_at: datetime | None

    @classmethod
    def of(cls, row: ApprovalRequest) -> "ApprovalRequestView":
        return cls(
            agent_id=row.agent_id,
            session_id=row.session_id,
            request_id=row.request_id,
            room_id=row.room_id,
            thread_id=row.thread_id,
            question=row.question,
            options=[OptionView(**option) for option in row.options],
            state=row.state,
            expires_at=row.expires_at,
            answer=row.answer,
            answered_by=row.answered_by,
            answered_at=row.answered_at,
        )


class AnswerBody(_Model):
    answer: str = Field(min_length=1, max_length=200)


@router.get("/approvals", response_model_by_alias=True)
async def open_approvals(
    user: CurrentUser, factory: Factory
) -> list[ApprovalRequestView]:
    """Open requests of the agents the signed-in person owns."""
    rows = await SessionActivityService(factory).open_for_owner(user.id)
    return [ApprovalRequestView.of(row) for row in rows]


@router.post(
    "/{agent_id}/{session_id}/approvals/{request_id}/answer",
    response_model_by_alias=True,
)
async def answer_approval(
    agent_id: str,
    session_id: str,
    request_id: str,
    body: AnswerBody,
    user: CurrentUser,
    factory: Factory,
) -> ApprovalRequestView:
    row = await SessionActivityService(factory).answer_approval(
        agent_id,
        session_id,
        request_id,
        answer=body.answer,
        answerer=SwitchUser(user.id),
    )
    return ApprovalRequestView.of(row)
