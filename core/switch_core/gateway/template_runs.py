"""Runs, as a person sees them: the rooms a template or an agent created, as
a tree, with the controls to let a paused run continue or stop one.

What a run is, and when the server pauses one, is in ``agent_runs``. This is
the read and control surface the Console's Recently used list is built on.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.agent_runs import RunRefused, RunState, run_control
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import (
    get_agent_store,
    get_protocol,
    get_room_store,
    get_session,
)

router = APIRouter()

# Recently used shows a handful of runs, not a history.
RECENT_RUNS = 20


class TemplateRunRoom(BaseModel):
    id: str
    name: str
    parent_room_id: str | None
    created_by_agent_id: str | None
    created_by_agent_name: str | None
    template_name: str | None
    created_at: datetime
    archived: bool


class TemplateRun(BaseModel):
    root_room_id: str
    root_room_name: str
    # Who started it: the person who made the root room, or the agent that
    # did when the run began with an agent working in no room.
    started_by_name: str | None
    template_name: str | None
    started_at: datetime
    last_activity_at: datetime
    state: RunState
    reason: str | None
    changed_by_name: str | None
    paused_repeat_of: str | None
    can_control: bool
    rooms: list[TemplateRunRoom]


async def _run(
    session: AsyncSession,
    protocol: ProtocolService,
    room_store: RoomStore,
    agent_store: AgentStore,
    root_id: str,
    *,
    user: User,
    is_admin: bool,
) -> TemplateRun | None:
    rooms = await room_store.run_rooms(session, root_id)
    root = next((r for r in rooms if r.id == root_id), None)
    if root is None:
        return None
    agent_names: dict[str, str] = {}
    for agent_id in {r.created_by_agent_id for r in rooms if r.created_by_agent_id}:
        agent = await agent_store.get(session, agent_id)
        if agent is not None:
            agent_names[agent_id] = agent.name
    control = run_control(root)
    if root.created_by_agent_id is not None:
        started_by = agent_names.get(root.created_by_agent_id)
    else:
        person = await session.get(User, root.created_by) if root.created_by else None
        started_by = person.name if person else None

    def entry(room: Room) -> TemplateRunRoom:
        return TemplateRunRoom(
            id=room.id,
            name=room.name,
            parent_room_id=room.parent_room_id if room.id != root_id else None,
            created_by_agent_id=room.created_by_agent_id,
            created_by_agent_name=agent_names.get(room.created_by_agent_id or ""),
            template_name=room.template_name,
            created_at=room.created_at,  # type: ignore[arg-type]
            archived=room.archived_at is not None,
        )

    return TemplateRun(
        root_room_id=root.id,
        root_room_name=root.name,
        started_by_name=started_by,
        template_name=next((r.template_name for r in rooms if r.template_name), None),
        started_at=root.created_at,  # type: ignore[arg-type]
        last_activity_at=max(r.created_at for r in rooms),  # type: ignore[type-var]
        state=control.state if control else "running",
        reason=control.reason if control else None,
        changed_by_name=control.by_name if control else None,
        paused_repeat_of=(
            control.repeat_of if control and control.state == "paused" else None
        ),
        can_control=await protocol.run_service().may_control(
            session, root_id, user_id=user.id, is_admin=is_admin
        ),
        rooms=[entry(r) for r in rooms],
    )


@router.get("/template-runs")
async def list_template_runs(
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[TemplateRun]:
    """The viewer's recent runs, newest first: templates they ran and rooms
    their agents created. An admin sees every run in the workspace, so a run
    can be stopped by someone whose Console never saw it start."""
    roots = await room_store.recent_run_roots(
        session, user_id=None if is_admin else user.id, limit=RECENT_RUNS
    )
    runs = [
        await _run(
            session,
            protocol,
            room_store,
            agent_store,
            root_id,
            user=user,
            is_admin=is_admin,
        )
        for root_id in roots
    ]
    return [r for r in runs if r is not None]


async def _control(
    root_id: str,
    state: RunState,
    session: AsyncSession,
    protocol: ProtocolService,
    room_store: RoomStore,
    agent_store: AgentStore,
    user: User,
    is_admin: bool,
) -> TemplateRun:
    service = protocol.run_service()
    if await room_store.get(session, root_id) is None:
        raise HTTPException(status_code=404, detail="No such run")
    if not await service.may_control(
        session, root_id, user_id=user.id, is_admin=is_admin
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                "Only the owner of an agent in this run, the person who ran its "
                "template, or an admin can do that."
            ),
        )
    try:
        await service.set_state(
            root_id,
            "stopped" if state == "stopped" else "running",
            user_id=user.id,
            user_name=user.name,
        )
    except RunRefused as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    run = await _run(
        session,
        protocol,
        room_store,
        agent_store,
        root_id,
        user=user,
        is_admin=is_admin,
    )
    assert run is not None
    return run


@router.post("/template-runs/{root_room_id}/stop")
async def stop_template_run(
    root_room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> TemplateRun:
    """Stop a run: agents can no longer create rooms in it, and each of its
    rooms gets a note saying so. The rooms themselves stay as they are."""
    return await _control(
        root_room_id,
        "stopped",
        session,
        protocol,
        room_store,
        agent_store,
        user,
        is_admin,
    )


@router.post("/template-runs/{root_room_id}/continue")
async def continue_template_run(
    root_room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> TemplateRun:
    """Let a paused run go on. The request that paused it may now be made
    once more; making it again after that pauses the run again."""
    return await _control(
        root_room_id,
        "running",
        session,
        protocol,
        room_store,
        agent_store,
        user,
        is_admin,
    )
