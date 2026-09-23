"""A renewal saying whether a session's own rooms are owed anything.

A worker renews its lease every few seconds anyway. When it asks, the renewal
also says whether the pull would find anything, so a worker whose controller
is routing to it can skip a request whose answer is almost always empty. The
reading has to agree with the pull it stands in for: a no where the pull would
have found work is a room left unanswered.
"""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.bridges.agent.api.session_routes import router as host_router
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import (
    get_collab_lifecycle as host_lifecycle,
)
from switch_core.bridges.agent.dependencies import get_session_factory as host_factory
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import Agent, SdkSession, require_tenant_id
from switch_core.sessions.http import session_error_response
from switch_core.sessions.service import SessionAuthority, SessionError

from .test_authority import setup
from .test_room_pull import (
    AGENT,
    FIRST,
    ROOM,
    SECOND,
    SPARE,
    _add_room,
    _event,
    _lapse_lease,
    _promise_run_out,
    _second_session,
)


async def _owed(service: SessionAuthority, epoch: str) -> bool:
    return await service.renew_reporting_room_work(AGENT, *FIRST, epoch)


async def _lease_expiry(session_factory, session_id: str) -> datetime:
    async with session_factory() as db:
        row = await db.scalar(
            select(SdkSession).where(
                SdkSession.tenant_id == require_tenant_id(),
                SdkSession.id == session_id,
            )
        )
        return row.lease_expires_at


@pytest.mark.asyncio
async def test_the_reading_agrees_with_what_the_pull_would_find(
    session_factory,
) -> None:
    """Owed while a delivery waits, and not once it has been made."""
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    assert await _owed(service, epoch) is False

    sequence = buffer.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    await service.admit_room(AGENT, ROOM, "first", sequence, False, buffer)
    assert await _owed(service, epoch) is True
    assert await service.session_room_reservations(AGENT, *FIRST, epoch)

    await service.submit_room_message(
        AGENT, *FIRST, epoch, ROOM, "first", sequence, False, buffer
    )
    assert await _owed(service, epoch) is False
    assert await service.session_room_reservations(AGENT, *FIRST, epoch) == []


@pytest.mark.asyncio
async def test_a_given_up_delivery_is_not_owed_and_one_that_ran_out_still_is(
    session_factory,
) -> None:
    """A promise that ran out is still the session's to say was not kept."""
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    given_up = buffer.enqueue(AGENT, ROOM, _event(ROOM, "given-up"))
    await service.admit_room(AGENT, ROOM, "given-up", given_up, False, buffer)
    await service.discard_room_reservation(AGENT, ROOM, "given-up")
    assert await _owed(service, epoch) is False

    lapsed = buffer.enqueue(AGENT, ROOM, _event(ROOM, "lapsed"))
    await service.admit_room(AGENT, ROOM, "lapsed", lapsed, False, buffer)
    await _promise_run_out(session_factory, ROOM, "lapsed")
    assert await _owed(service, epoch) is True
    held = await service.session_room_reservations(AGENT, *FIRST, epoch)
    assert [(r.message_id, r.expired) for r in held] == [("lapsed", True)]


@pytest.mark.asyncio
async def test_only_the_sessions_own_rooms_count(session_factory) -> None:
    """A sibling's room is the sibling's to be told about."""
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _add_room(session_factory, SPARE)
    buffer = EventBuffer()
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_room(AGENT, *SECOND, second, SPARE)
    theirs = buffer.enqueue(AGENT, SPARE, _event(SPARE, "theirs"))
    await service.admit_room(AGENT, SPARE, "theirs", theirs, False, buffer)

    assert await _owed(service, first) is False
    assert await service.renew_reporting_room_work(AGENT, *SECOND, second) is True


@pytest.mark.asyncio
async def test_a_no_is_read_again_at_every_renewal(session_factory) -> None:
    """Work reserved after a no, or a room that moves here after one, is found.

    The reading is a moment, not a promise, so what arrives after it has to be
    in the next one — including work in a room this session did not hold when
    it was last told nothing was owed.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _add_room(session_factory, SPARE)
    buffer = EventBuffer()
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_room(AGENT, *SECOND, second, SPARE)
    assert await _owed(service, first) is False

    later = buffer.enqueue(AGENT, ROOM, _event(ROOM, "later"))
    await service.admit_room(AGENT, ROOM, "later", later, False, buffer)
    assert await _owed(service, first) is True
    await service.submit_room_message(
        AGENT, *FIRST, first, ROOM, "later", later, False, buffer
    )
    assert await _owed(service, first) is False

    waiting = buffer.enqueue(AGENT, SPARE, _event(SPARE, "waiting"))
    await service.admit_room(AGENT, SPARE, "waiting", waiting, False, buffer)
    assert await _owed(service, first) is False
    await service.bind_room(AGENT, *FIRST, first, SPARE)
    assert await _owed(service, first) is True
    assert await service.renew_reporting_room_work(AGENT, *SECOND, second) is False


@pytest.mark.asyncio
async def test_it_renews_and_is_fenced_as_a_renewal_is(session_factory) -> None:
    """The same lease, the same host, the same generation, or no answer at all."""
    service, epoch = await setup(session_factory)
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    before = await _lease_expiry(session_factory, FIRST[0])
    await _owed(service, epoch)
    assert await _lease_expiry(session_factory, FIRST[0]) > before

    with pytest.raises(SessionError) as other_agent:
        await service.renew_reporting_room_work("another-agent", *FIRST, epoch)
    assert other_agent.value.code == "NOT_AUTHORIZED"
    with pytest.raises(SessionError) as impostor:
        await service.renew_reporting_room_work(
            AGENT, FIRST[0], "host-elsewhere", epoch
        )
    assert impostor.value.code == "NOT_AUTHORIZED"
    with pytest.raises(SessionError) as stale:
        await service.renew_reporting_room_work(AGENT, *FIRST, "epoch-before")
    assert stale.value.code == "STALE_EPOCH"

    await _lapse_lease(session_factory, FIRST[0])
    with pytest.raises(SessionError) as lapsed:
        await _owed(service, epoch)
    assert lapsed.value.code == "HOST_OFFLINE"


@pytest.mark.asyncio
async def test_the_renewal_route_answers_the_reading_only_when_asked(
    session_factory,
) -> None:
    """A worker that does not ask gets the renewal it always got."""
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    sequence = buffer.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    await service.admit_room(AGENT, ROOM, "first", sequence, False, buffer)

    app = FastAPI()
    app.include_router(host_router, prefix="/host")
    app.add_exception_handler(SessionError, session_error_response)

    async def refresh(session_id):
        return None

    app.dependency_overrides[host_factory] = lambda: session_factory
    app.dependency_overrides[host_lifecycle] = lambda: SimpleNamespace(
        refresh_sdk_session=refresh
    )
    app.dependency_overrides[get_agent_from_scope] = lambda: Agent(id=AGENT)
    body = {"host_id": FIRST[1], "epoch": epoch}
    path = f"/host/sessions/{FIRST[0]}/renew"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        plain = await client.post(path, json=body)
        assert plain.status_code == 200
        assert plain.json() == {"leaseSeconds": 30}

        asked = await client.post(f"{path}?room_work=true", json=body)
        assert asked.status_code == 200
        assert asked.json() == {"leaseSeconds": 30, "roomWork": True}

        await service.submit_room_message(
            AGENT, *FIRST, epoch, ROOM, "first", sequence, False, buffer
        )
        idle = await client.post(f"{path}?room_work=true", json=body)
        assert idle.json() == {"leaseSeconds": 30, "roomWork": False}

        app.dependency_overrides[get_agent_from_scope] = lambda: Agent(id="other-agent")
        forged = await client.post(f"{path}?room_work=true", json=body)
        assert forged.status_code == 403
