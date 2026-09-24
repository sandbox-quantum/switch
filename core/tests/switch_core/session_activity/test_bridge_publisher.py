from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.db.models import (
    ApprovalRequestPost,
    BridgeMessageMap,
    TurnStatusPost,
)
from switch_core.session_activity.bridge_publisher import (
    SessionActivityBridgePublisher,
)
from switch_core.session_activity.listener import SessionActivityListener
from switch_core.session_activity.service import ApprovalOption, PlatformPerson
from switch_core.tenant_context import current_tenant_id

from .bridge_fixtures import BridgedRoom, RecordingPlatform, make_bridged_room
from .conftest import AGENT, make_room

SESSION = "session-demo"
OPTIONS = [
    ApprovalOption("allow", "Allow", "accept"),
    ApprovalOption("deny", "Deny", "decline"),
]


@pytest.fixture
async def bridged(session_factory, people) -> BridgedRoom:
    async with session_factory() as db, db.begin():
        return await make_bridged_room(db, member=AGENT)


@pytest.fixture
async def listener(postgres_url) -> AsyncIterator[SessionActivityListener]:
    listener = SessionActivityListener(
        lambda: create_async_engine(postgres_url, poolclass=NullPool)
    )
    await listener.start()
    await asyncio.wait_for(listener.connected.wait(), 5)
    try:
        yield listener
    finally:
        await listener.stop()


@pytest.fixture
def platform() -> RecordingPlatform:
    return RecordingPlatform()


@pytest.fixture
async def publisher(
    session_factory, bridged, listener, platform
) -> AsyncIterator[SessionActivityBridgePublisher]:
    tenant = current_tenant_id()
    assert tenant is not None
    publisher = SessionActivityBridgePublisher(
        adapter=platform,  # type: ignore[arg-type]
        bridge_id=bridged.bridge_id,
        tenant_id=tenant,
        listener=listener,
        session_factory=session_factory,
    )
    publisher.start()
    try:
        yield publisher
    finally:
        await publisher.stop()


async def _open(service, room_id, request_id="req-1", thread_id=None):
    return await service.open_approval(
        AGENT,
        SESSION,
        request_id=request_id,
        question="Run `rm -rf build`?",
        options=OPTIONS,
        room_id=room_id,
        thread_id=thread_id,
        expires_at=None,
    )


async def _card_post(session_factory, request_id="req-1") -> ApprovalRequestPost:
    async with session_factory() as db:
        return (
            await db.execute(
                select(ApprovalRequestPost).where(
                    ApprovalRequestPost.request_id == request_id
                )
            )
        ).scalar_one()


async def test_an_open_request_is_posted_and_redrawn_once_answered(
    service, publisher, platform, bridged, people, session_factory
):
    await _open(service, bridged.room_id)
    [posted] = await platform.wait_for(1)
    assert posted.call == "post_rich"
    assert posted.channel_id == bridged.channel_id
    assert posted.content.request.state == "open"
    assert posted.content.reference.handle == "A1"
    assert [o.decision for o in posted.content.request.content.options] == [
        "accept",
        "decline",
    ]
    post = await _card_post(session_factory)
    assert post.external_post_id == posted.ref
    assert post.token == posted.content.reference.token

    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    _, redrawn = await platform.wait_for(2)
    assert redrawn.call == "update_rich"
    assert redrawn.ref == posted.ref
    request = redrawn.content.request
    assert request.state == "resolved"
    assert request.result.result.option_id == "allow"
    assert request.decided_by.surface == "slack"


async def test_a_request_outside_the_bridge_is_not_posted(
    service, publisher, platform, session_factory
):
    async with session_factory() as db, db.begin():
        elsewhere = await make_room(db, member=AGENT)
    await _open(service, elsewhere)
    await _open(service, None, request_id="req-2")
    await asyncio.sleep(0.5)
    assert platform.drawn == []


async def test_a_card_goes_into_the_thread_it_answers(
    service, publisher, platform, bridged, session_factory
):
    async with session_factory() as db, db.begin():
        db.add(
            BridgeMessageMap(
                bridge_id=bridged.bridge_id,
                external_channel_id=bridged.channel_id,
                transport_event_id="sw_asked",
                external_post_id="1700000000.0001",
            )
        )
    await _open(service, bridged.room_id, thread_id="sw_asked")
    [posted] = await platform.wait_for(1)
    assert posted.thread_ref == "1700000000.0001"
    assert (await _card_post(session_factory)).thread_ref == "1700000000.0001"


async def test_a_refused_post_releases_its_handle(
    service, publisher, platform, bridged, session_factory
):
    platform.refuse_posts = True
    await _open(service, bridged.room_id)
    await asyncio.sleep(0.5)
    async with session_factory() as db:
        assert (await db.execute(select(ApprovalRequestPost))).first() is None


async def test_open_requests_are_posted_on_start(
    service, session_factory, bridged, listener, platform
):
    await _open(service, bridged.room_id)
    tenant = current_tenant_id()
    assert tenant is not None
    publisher = SessionActivityBridgePublisher(
        adapter=platform,  # type: ignore[arg-type]
        bridge_id=bridged.bridge_id,
        tenant_id=tenant,
        listener=listener,
        session_factory=session_factory,
    )
    publisher.start()
    try:
        [posted] = await platform.wait_for(1)
        assert posted.call == "post_rich"
    finally:
        await publisher.stop()


async def test_a_turn_has_one_status_message_edited_as_it_goes(
    service, publisher, platform, bridged, session_factory
):
    lines = [
        ("turn.started", "Started"),
        ("tool.called", "Ran `pytest`"),
        ("tool.called", "Edited `app.py`"),
        ("turn.finished", "Completed"),
    ]
    for seq, (type, summary) in enumerate(lines, start=1):
        await service.report_activity(
            AGENT,
            SESSION,
            seq=seq,
            type=type,
            summary=summary,
            detail={},
            turn_id="turn-1",
            room_id=bridged.room_id,
            thread_id=None,
            occurred_at=datetime(2026, 9, 24, 12, seq, tzinfo=UTC),
        )
        await asyncio.sleep(0.1)
    drawn = await platform.wait_for(2)
    assert drawn[0].call == "send_message"
    assert all(d.call == "update_message" for d in drawn[1:])
    assert {d.ref for d in drawn} == {drawn[0].ref}
    assert drawn[-1].content == "**Finished** · 2 tool calls\nCompleted"
    async with session_factory() as db:
        post = (await db.execute(select(TurnStatusPost))).scalar_one()
    assert (post.tool_calls, post.finished) == (2, True)
