from datetime import UTC, datetime

from switch_core.db.models import SessionActivityEvent
from switch_core.sessions.publication import SessionPublisher

from .test_authority import opened, setup
from .test_publication import Platform
from .test_publication_retries import cards_for


async def test_a_session_on_the_snapshot_alone_is_still_published(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = Platform()

    await SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    ).publish_pending()

    assert len(platform.posts) == 1


async def test_a_session_reporting_activity_is_left_to_the_new_publisher(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    async with session_factory() as db, db.begin():
        db.add(
            SessionActivityEvent(
                agent_id="agent-demo",
                session_id="session-demo",
                seq=1,
                type="turn.started",
                summary="Started",
                detail={},
                occurred_at=datetime(2026, 9, 24, tzinfo=UTC),
            )
        )
    platform = Platform()

    await SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    ).publish_pending()

    assert platform.posts == []
