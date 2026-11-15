"""`e2c7b9a4d816` adds `chat_reads` and starts every current member of a room
read up to its head, so no chat's history turns unread on upgrade."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.switch_core.test_migration_oidc_identities_backfill import _upgrade_to

_DB = "migration_chat_reads"
_BEFORE = "d4e8a1c5b7f3"
_UNDER_TEST = "e2c7b9a4d816"
_TENANT = "00000000-0000-0000-0000-000000000000"


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


async def test_members_start_read_up_to_the_head(migration_url: str) -> None:
    engine = create_async_engine(migration_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_BEFORE))

        async with engine.begin() as connection:
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(
                text(
                    "INSERT INTO users (id, name, email, role) "
                    "VALUES ('alice', 'alice', 'alice@example.invalid', 'user')"
                )
            )
            for room_id in ("talked", "quiet"):
                await connection.execute(
                    text(
                        "INSERT INTO rooms (id, tenant_id, matrix_room_id, name, "
                        "description) VALUES (:id, :tenant, :transport, :id, '')"
                    ),
                    {"id": room_id, "tenant": _TENANT, "transport": f"!{room_id}"},
                )
            for client_id, kind, user_id in (
                ("c-alice", "member", "alice"),
                ("c-agent", "agent", None),
            ):
                await connection.execute(
                    text(
                        "INSERT INTO clients (id, tenant_id, matrix_user_id, "
                        "display_name, type, user_id) VALUES (:id, :tenant, "
                        ":transport, :id, :type, :user)"
                    ),
                    {
                        "id": client_id,
                        "tenant": _TENANT,
                        "transport": f"@{client_id}",
                        "type": kind,
                        "user": user_id,
                    },
                )
            for client_id, room_id in (
                ("c-alice", "talked"),
                ("c-alice", "quiet"),
                ("c-agent", "talked"),
            ):
                await connection.execute(
                    text(
                        "INSERT INTO client_rooms (client_id, room_id, tenant_id) "
                        "VALUES (:client, :room, :tenant)"
                    ),
                    {"client": client_id, "room": room_id, "tenant": _TENANT},
                )
            for seq in (1, 2, 7):
                await connection.execute(
                    text(
                        "INSERT INTO messages (id, tenant_id, room_id, seq, "
                        "transport_event_id, sender_id, event_type, content) VALUES "
                        "(:id, :tenant, 'talked', :seq, :event, '@x', "
                        "'m.room.message', '{}')"
                    ),
                    {
                        "id": f"m{seq}",
                        "tenant": _TENANT,
                        "seq": seq,
                        "event": f"$e{seq}",
                    },
                )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_UNDER_TEST))

        async with engine.connect() as connection:
            reads = {
                (user_id, room_id): seq
                for user_id, room_id, seq in await connection.execute(
                    text("SELECT user_id, room_id, read_through_seq FROM chat_reads")
                )
            }
    finally:
        await engine.dispose()

    assert reads == {("alice", "talked"): 7, ("alice", "quiet"): 0}
