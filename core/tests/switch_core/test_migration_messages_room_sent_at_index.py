"""An operator can build `ix_messages_room_sent_at` ahead of the upgrade.

`c71a4f9d2b83` builds the index inside the migration's transaction, which
holds every send until it commits. A deployment with a large `messages` table
builds it `CONCURRENTLY` by hand first, and the revision must then pass over it
rather than fail on the name.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.switch_core.test_migration_oidc_identities_backfill import _upgrade_to

_DB = "migration_messages_room_sent_at_index"
_PRE_MIGRATION_REVISION = "b5d2e08c17af"
_MIGRATION_UNDER_TEST = "c71a4f9d2b83"


@pytest.fixture
async def migration_url(postgres_url: str) -> Any:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_DB}"'))
    await admin.dispose()

    base, _, _ = postgres_url.rpartition("/")
    try:
        yield f"{base}/{_DB}"
    finally:
        admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await admin.dispose()


async def _index_definitions(engine: Any) -> list[str]:
    async with engine.connect() as connection:
        rows = await connection.execute(
            text(
                "SELECT indexdef FROM pg_indexes "
                "WHERE tablename = 'messages' "
                "AND indexname = 'ix_messages_room_sent_at'"
            )
        )
        return [row[0] for row in rows]


@pytest.mark.parametrize(
    "built_by_hand", [True, False], ids=["prebuilt", "not-prebuilt"]
)
async def test_the_revision_builds_the_index_or_keeps_the_one_already_there(
    migration_url: str, built_by_hand: bool
) -> None:
    engine = create_async_engine(migration_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        if built_by_hand:
            autocommit = engine.execution_options(isolation_level="AUTOCOMMIT")
            async with autocommit.connect() as connection:
                await connection.execute(
                    text(
                        "CREATE INDEX CONCURRENTLY ix_messages_room_sent_at "
                        "ON messages (room_id, sent_at)"
                    )
                )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        definitions = await _index_definitions(engine)
    finally:
        await engine.dispose()

    assert definitions == [
        "CREATE INDEX ix_messages_room_sent_at ON public.messages "
        "USING btree (room_id, sent_at)"
    ]
