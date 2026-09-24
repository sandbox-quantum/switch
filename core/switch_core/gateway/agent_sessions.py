"""A signed-in person's side of an agent's sessions: Switch Console and the web.

Approval requests: the person answers as themselves, so the answer is judged
the way the platform judges a message it sends on someone's behalf — the
agent's addressing policy in the request's room, or its owner when the request
has no room.

Where an agent's sessions are and whether it is connected is not answered
here: the agent's room watcher owns both and Console asks it directly.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ApprovalRequest, User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session_factory
from switch_core.session_activity.service import SessionActivityService, SwitchUser
from switch_core.sessions.contract import (
    Answer,
    ApprovalResult,
    QuestionsResult,
    RequestResult,
)

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
    decision: str


class QuestionOptionView(_Model):
    id: str
    label: str
    description: str | None


class QuestionView(_Model):
    id: str
    title: str
    prompt: str
    options: list[QuestionOptionView]
    multi_select: bool
    allow_custom_answer: bool


class AnswerView(_Model):
    question_id: str
    selected_option_ids: list[str]
    custom_text: str | None


class ApprovalRequestView(_Model):
    agent_id: str
    session_id: str
    request_id: str
    turn_id: str
    kind: str
    room_id: str | None
    thread_id: str | None
    title: str
    detail: str | None
    options: list[OptionView]
    questions: list[QuestionView]
    state: str
    expires_at: datetime | None
    answer: str | None
    answers: list[AnswerView] | None
    answered_by: str | None
    answered_at: datetime | None

    @classmethod
    def of(cls, row: ApprovalRequest) -> "ApprovalRequestView":
        return cls(
            agent_id=row.agent_id,
            session_id=row.session_id,
            request_id=row.request_id,
            turn_id=row.turn_id,
            kind=row.kind,
            room_id=row.room_id,
            thread_id=row.thread_id,
            title=row.title,
            detail=row.detail,
            options=[OptionView(**option) for option in row.options],
            questions=[
                QuestionView(
                    id=question["id"],
                    title=question["title"],
                    prompt=question["prompt"],
                    options=[
                        QuestionOptionView(**option) for option in question["options"]
                    ],
                    multi_select=question["multi_select"],
                    allow_custom_answer=question["allow_custom_answer"],
                )
                for question in row.questions
            ],
            state=row.state,
            expires_at=row.expires_at,
            answer=row.answer,
            answers=None
            if row.answers is None
            else [AnswerView(**answer) for answer in row.answers],
            answered_by=row.answered_by,
            answered_at=row.answered_at,
        )


class AnswerIn(_Model):
    question_id: str = Field(min_length=1, max_length=200)
    selected_option_ids: list[str]
    custom_text: str | None


class AnswerBody(_Model):
    """An approval's chosen option (`answer`), or an answer per question (`answers`)."""

    answer: str | None = Field(default=None, min_length=1, max_length=200)
    answers: list[AnswerIn] | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "AnswerBody":
        if (self.answer is None) == (self.answers is None):
            raise ValueError("Give either answer (an approval) or answers (questions).")
        return self

    def result(self) -> RequestResult:
        if self.answer is not None:
            return ApprovalResult(kind="approval", option_id=self.answer)
        assert self.answers is not None
        return QuestionsResult(
            kind="questions",
            answers=[
                Answer(
                    question_id=answer.question_id,
                    selected_option_ids=answer.selected_option_ids,
                    custom_text=answer.custom_text,
                )
                for answer in self.answers
            ],
        )


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
        answer=body.result(),
        answerer=SwitchUser(user.id),
    )
    return ApprovalRequestView.of(row)
