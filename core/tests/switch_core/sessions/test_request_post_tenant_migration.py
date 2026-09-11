"""Existing permission-card destinations survive the tenant migration."""

from importlib import import_module

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text

from switch_core.bridges.collaboration.session.outbound import SessionRequestCards
from switch_core.db.models import require_tenant_id
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.sessions.publication import refresh_cards

from .test_authority import opened, setup
from .test_publication import Platform


async def test_request_post_tenant_backfill_preserves_card_and_answer_destination(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    cards = SessionRequestCards(
        Platform(),
        bridge_id="bridge",
        posts=SessionRequestPostStore(),
        session_factory=session_factory,
    )
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    migration = import_module(
        "switch_core.migrations.versions.e4f8c1a90372_scope_session_request_posts"
    )

    def roundtrip(connection):
        with Operations.context(MigrationContext.configure(connection)):
            migration.downgrade()
            before = connection.execute(
                text(
                    "SELECT token, external_post_id, room_id, thread_id, form FROM session_request_posts"
                )
            ).one()
            migration.upgrade()
            after = connection.execute(
                text(
                    "SELECT token, external_post_id, room_id, thread_id, form FROM session_request_posts"
                )
            ).one()
            assert after == before
            assert (
                connection.execute(
                    text("SELECT tenant_id FROM session_request_posts")
                ).scalar_one()
                == require_tenant_id()
            )

    async with session_factory() as db:
        connection = await db.connection()
        await connection.run_sync(roundtrip)
        await db.commit()
