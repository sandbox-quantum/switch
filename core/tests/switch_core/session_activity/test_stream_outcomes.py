from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.connections import (
    APPROVAL_OUTCOME_PROTOCOL_REVISION,
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.stream import event_stream
from switch_core.db.models import ApprovalRequest
from switch_core.session_activity.listener import SessionActivityListener
from switch_core.session_activity.outcomes import ApprovalOutcomes
from switch_core.session_activity.service import ApprovalOption, PlatformPerson

from .conftest import AGENT, make_agent

SESSION = "session-demo"
OPTIONS = [ApprovalOption("allow", "Allow"), ApprovalOption("deny", "Deny")]


@pytest.fixture
async def approvals(service, postgres_url) -> AsyncIterator[ApprovalOutcomes]:
    listener = SessionActivityListener(
        lambda: create_async_engine(postgres_url, poolclass=NullPool)
    )
    await listener.start()
    try:
        await asyncio.wait_for(listener.connected.wait(), 5)
        # Let the listener's own connect-time resync pass before any stream
        # subscribes, so a test sees only what it caused.
        await asyncio.sleep(0.1)
        yield ApprovalOutcomes(listener, service)
    finally:
        await listener.stop()


def _open_stream(approvals, *, agent_id=AGENT, scope="all", speaks=PROTOCOL_VERSION):
    registry = ConnectionRegistry()
    conn = registry.open(
        agent_id=agent_id,
        connection_id=f"conn-{agent_id}-{scope}",
        scope=scope,
        delivery_filter="addressed",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=speaks),
        expected_generation=None,
    )
    return event_stream(
        conn=conn, registry=registry, buffer=EventBuffer(), approvals=approvals
    )


def _outcome(frame: bytes) -> dict:
    text = frame.decode()
    assert "event: approval_outcome\n" in text, text
    return json.loads(text.split("data: ", 1)[1])


async def _no_frame_within(stream, seconds: float) -> None:
    waiting = asyncio.create_task(anext(stream))
    await asyncio.sleep(seconds)
    assert not waiting.done(), waiting.result()
    waiting.cancel()
    with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
        await waiting


async def _open(service, request_id="req-1", **overrides):
    values = dict(
        request_id=request_id,
        question="Deploy?",
        options=OPTIONS,
        room_id=None,
        thread_id=None,
        expires_at=None,
    )
    values.update(overrides)
    return await service.open_approval(AGENT, SESSION, **values)


async def test_an_answer_is_pushed_down_the_open_stream(service, approvals, people):
    await _open(service)
    stream = _open_stream(approvals)
    try:
        await anext(stream)  # connection_state
        waiting = asyncio.create_task(anext(stream))
        await asyncio.sleep(0.05)
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer="allow",
            answerer=PlatformPerson(people.owner),
        )
        outcome = _outcome(await asyncio.wait_for(waiting, 5))
        assert outcome["session_id"] == SESSION
        assert outcome["request_id"] == "req-1"
        assert outcome["state"] == "answered"
        assert outcome["answer"] == "allow"
        assert outcome["answered_by"] == people.owner
        assert outcome["answered_at"]
    finally:
        await stream.aclose()


async def test_an_outcome_owed_from_before_the_stream_opened_is_sent_first(
    service, approvals, people
):
    await _open(service)
    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="deny", answerer=PlatformPerson(people.owner)
    )
    stream = _open_stream(approvals)
    try:
        await anext(stream)  # connection_state
        outcome = _outcome(await asyncio.wait_for(anext(stream), 5))
        assert (outcome["request_id"], outcome["answer"]) == ("req-1", "deny")
    finally:
        await stream.aclose()


async def test_an_acknowledged_outcome_is_not_sent_again(service, approvals, people):
    await _open(service)
    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    await service.mark_delivered(AGENT, SESSION, "req-1")
    stream = _open_stream(approvals)
    try:
        await anext(stream)  # connection_state
        await _no_frame_within(stream, 0.5)
    finally:
        await stream.aclose()


async def test_an_expiry_is_pushed(service, approvals, session_factory):
    await _open(service, expires_at=datetime.now(UTC) + timedelta(minutes=5))
    stream = _open_stream(approvals)
    try:
        await anext(stream)  # connection_state
        waiting = asyncio.create_task(anext(stream))
        await asyncio.sleep(0.05)
        async with session_factory() as db, db.begin():
            await db.execute(
                update(ApprovalRequest).values(
                    expires_at=datetime.now(UTC) - timedelta(seconds=1)
                )
            )
        await service.expire_due()
        outcome = _outcome(await asyncio.wait_for(waiting, 5))
        assert (outcome["state"], outcome["answer"]) == ("expired", None)
    finally:
        await stream.aclose()


async def test_only_the_agents_own_watcher_stream_hears_its_outcomes(
    service, approvals, people, session_factory
):
    async with session_factory() as db, db.begin():
        await make_agent(db, "other-agent")
    await _open(service)
    other = _open_stream(approvals, agent_id="other-agent")
    session_stream = _open_stream(approvals, scope="single")
    try:
        await anext(other)
        await anext(session_stream)
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer="allow",
            answerer=PlatformPerson(people.owner),
        )
        await _no_frame_within(other, 0.5)
        await _no_frame_within(session_stream, 0.5)
    finally:
        await other.aclose()
        await session_stream.aclose()


async def test_a_stream_without_approvals_carries_none(service, people):
    await _open(service)
    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    stream = _open_stream(None)
    try:
        await anext(stream)
        await _no_frame_within(stream, 0.3)
    finally:
        await stream.aclose()


async def test_a_client_older_than_the_outcome_revision_is_sent_none(
    service, approvals, people
):
    # An older client hands unknown frames to its room-event path and breaks.
    await _open(service)
    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    for speaks in (APPROVAL_OUTCOME_PROTOCOL_REVISION - 1, None):
        stream = _open_stream(approvals, speaks=speaks)
        try:
            await anext(stream)
            await _no_frame_within(stream, 0.3)
        finally:
            await stream.aclose()
