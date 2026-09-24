"""A signed-in person's side of an agent's sessions: Switch Console and the web.

Approval requests: the person answers as themselves, so the answer is judged
the way the platform judges a message it sends on someone's behalf — the
agent's addressing policy in the request's room, or its owner when the request
has no room.

Room health: the agent's live connections and where its sessions are, for
Console to show and to move a room to another session.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Agent, ApprovalRequest, User, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_protocol, get_session_factory
from switch_core.session_activity.service import SessionActivityService, SwitchUser
from switch_core.sessions.contract import (
    Answer,
    ApprovalResult,
    QuestionsResult,
    RequestResult,
)
from switch_core.sessions.errors import SessionError

router = APIRouter()
Factory = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
CurrentUser = Annotated[User, Depends(get_current_user)]
Protocol = Annotated[ProtocolService, Depends(get_protocol)]


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


class RoomHealth(_Model):
    """For each of the person's agents: its live connections, and the room each
    of its sessions connected to."""

    connections: dict[str, list[str]]
    placements: dict[str, dict[str, str]]


@router.get("/room-health", response_model_by_alias=True)
async def room_health(
    user: CurrentUser, factory: Factory, protocol: Protocol
) -> RoomHealth:
    async with tenant_session(factory, require_tenant_id()) as db:
        agent_ids = list(
            await db.scalars(select(Agent.id).where(Agent.owner_id == user.id))
        )
    registry = protocol.connections
    return RoomHealth(
        connections={
            agent_id: sorted(conn.id for conn in registry.for_agent(agent_id))
            for agent_id in agent_ids
        },
        placements={agent_id: registry.placements(agent_id) for agent_id in agent_ids},
    )


class PlaceBody(_Model):
    room_id: str = Field(min_length=1)


class Placement(_Model):
    room_id: str
    displaced: str | None


@router.post("/{agent_id}/{session_id}/place", response_model_by_alias=True)
async def place_session(
    agent_id: str,
    session_id: str,
    body: PlaceBody,
    user: CurrentUser,
    factory: Factory,
    protocol: Protocol,
) -> Placement:
    """Move a room's messages to this session, as its owner asks from Console.

    The same move a session's own `connect_to_room` makes: the room's events
    are tagged with this session from now on, and the agent's controller
    routes them to it.
    """
    async with tenant_session(factory, require_tenant_id()) as db:
        agent = await db.get(Agent, agent_id)
        if agent is None or agent.owner_id != user.id:
            raise SessionError(
                "NOT_AUTHORIZED", "Only the agent's owner can move its sessions."
            )
        found = await RoomStore().get_with_membership(db, body.room_id, agent_id)
    if found is None:
        raise SessionError("NOT_FOUND", f"Room not found: {body.room_id}")
    if not found[1]:
        raise SessionError("NOT_AUTHORIZED", "The agent is not a member of this room.")
    async with protocol.connections.slots(agent_id):
        _, displaced = protocol.connections.place_session(
            agent_id, session_id, body.room_id
        )
    return Placement(room_id=body.room_id, displaced=displaced)
