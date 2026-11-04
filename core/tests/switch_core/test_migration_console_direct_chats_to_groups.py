"""`d4e8a1c5b7f3` turns a Switch Console direct chat that already has another
person into a group. Seeds one chat of each kind that must stay direct (only
its creator, an owner-grant holder, a bridged direct room) beside one that
gained a person, and checks only that one changes."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.switch_core.test_migration_oidc_identities_backfill import _upgrade_to

_DB = "migration_console_direct_chats_to_groups"
_BEFORE = "e5a9c3d71f08"
_UNDER_TEST = "d4e8a1c5b7f3"
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


async def test_only_a_console_direct_chat_with_another_person_becomes_a_group(
    migration_url: str,
) -> None:
    engine = create_async_engine(migration_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_BEFORE))

        async with engine.begin() as connection:
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            for room_id, metadata in (
                ("alone", '{"chat_operation_id": "op-1"}'),
                ("granted", '{"chat_operation_id": "op-2"}'),
                ("joined", '{"chat_operation_id": "op-3"}'),
                ("bridged", None),
            ):
                await connection.execute(
                    text(
                        "INSERT INTO rooms (id, tenant_id, matrix_room_id, name, "
                        "description, channel_type, created_by, owner_id, metadata) "
                        "VALUES (:id, :tenant, :transport, :id, '', 'direct', "
                        "'alice', 'alice', CAST(:metadata AS jsonb))"
                    ),
                    {
                        "id": room_id,
                        "tenant": _TENANT,
                        "transport": f"!{room_id}:test",
                        "metadata": metadata,
                    },
                )
            for client_id, user_id in (("c-alice", "alice"), ("c-bob", "bob")):
                await connection.execute(
                    text(
                        "INSERT INTO clients (id, tenant_id, matrix_user_id, "
                        "display_name, type, user_id) VALUES (:id, :tenant, "
                        ":transport, :user, 'member', :user)"
                    ),
                    {
                        "id": client_id,
                        "tenant": _TENANT,
                        "transport": f"@{client_id}:test",
                        "user": user_id,
                    },
                )
            for client_id, room_id in (
                ("c-alice", "alone"),
                ("c-alice", "granted"),
                ("c-bob", "granted"),
                ("c-alice", "joined"),
                ("c-bob", "joined"),
                ("c-bob", "bridged"),
            ):
                await connection.execute(
                    text(
                        "INSERT INTO client_rooms (client_id, room_id, tenant_id) "
                        "VALUES (:client, :room, :tenant)"
                    ),
                    {"client": client_id, "room": room_id, "tenant": _TENANT},
                )
            await connection.execute(
                text(
                    "INSERT INTO chat_owner_grants (tenant_id, user_id, room_id) "
                    "VALUES (:tenant, 'bob', 'granted')"
                ),
                {"tenant": _TENANT},
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_UNDER_TEST))

        async with engine.connect() as connection:
            types = dict(
                (
                    await connection.execute(text("SELECT id, channel_type FROM rooms"))
                ).all()
            )
    finally:
        await engine.dispose()

    assert types == {
        "alone": "direct",
        "granted": "direct",
        "joined": "channel_private",
        "bridged": "direct",
    }
