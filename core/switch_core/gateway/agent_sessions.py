"""A signed-in person's side of an agent's sessions: Switch Console and the web.

Approval requests: the person answers as themselves, so the answer is judged
the way the platform judges a message it sends on someone's behalf — the
agent's addressing policy in the request's room, or its owner when the request
has no room.

Commands: the agent's owner drives its sessions from Console. Switch sets the
command's origin from the signed-in person and relays it to the agent's
watcher stream; the session's host records what became of it in its own
journal, which Console reads.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Agent, ApprovalRequest, User, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_protocol, get_session_factory
from switch_core.session_activity.service import SessionActivityService, SwitchUser
from switch_core.sessions.contract import Command, CommandBody, Origin
from switch_core.sessions.errors import SessionError

router = APIRouter()
Factory = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
CurrentUser = Annotated[User, Depends(get_current_user)]
Protocol = Annotated[ProtocolService, Depends(get_protocol)]
MAX_COMMAND_BYTES = 60 * 1024


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


class RelayCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    command_id: str = Field(alias="commandId", min_length=1, max_length=200)
    epoch: str = Field(min_length=1, max_length=200)
    body: CommandBody


class RelayReceipt(_Model):
    command_id: str
    relayed: bool


@router.post("/{agent_id}/{session_id}/commands", response_model_by_alias=True)
async def relay_command(
    agent_id: str,
    session_id: str,
    body: RelayCommand,
    user: CurrentUser,
    factory: Factory,
    protocol: Protocol,
) -> RelayReceipt:
    """Relay a command to the agent's watcher, for the session it names.

    Refused when no watcher of the agent's is connected: nothing holds the
    command for later, so saying it was sent would be untrue.
    """
    async with tenant_session(factory, require_tenant_id()) as db:
        agent = await db.get(Agent, agent_id)
    if agent is None or agent.owner_id != user.id:
        raise SessionError(
            "NOT_AUTHORIZED", "Only the agent's owner can drive its sessions."
        )
    command = Command(
        contract_version=1,
        command_id=body.command_id,
        session_id=session_id,
        epoch=body.epoch,
        origin=Origin(
            surface="console",
            actor_id=user.id,
            room_id=None,
            thread_id=None,
            message_id=None,
        ),
        body=body.body,
    )
    frame = command.model_dump(mode="json", by_alias=True)
    if len(command.model_dump_json(by_alias=True).encode("utf-8")) > MAX_COMMAND_BYTES:
        raise SessionError("PAYLOAD_TOO_LARGE", "Command exceeds 60 KiB.")
    if not protocol.connections.relay_session_command(agent_id, frame):
        raise SessionError(
            "HOST_OFFLINE",
            f"No watcher of agent {agent.name} is connected to Switch, so the "
            "command was not sent. Start the agent's watcher and try again.",
        )
    return RelayReceipt(command_id=command.command_id, relayed=True)
