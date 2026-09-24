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
from pydantic import BaseModel, ConfigDict, Field
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
