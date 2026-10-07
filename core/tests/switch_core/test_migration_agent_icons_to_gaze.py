"""`2f6919dcdead` moves generated agent icons from DiceBear bottts to gaze.

An agent's icon is a stored URL, so agents given the old robot keep it until the
row changes. This seeds every kind of stored icon, runs the migration up and
back down, and checks only the generated robots moved, each keeping its seed.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from switch_core.agent_icon import generated_icon_url
from tests.switch_core.test_migration_definitions_advanced_config import _migrate_to

_DB = "migration_agent_icons_to_gaze"
_PRE_MIGRATION_REVISION = "fabf9b9bff78"
_MIGRATION_UNDER_TEST = "2f6919dcdead"

_ROBOT = "https://api.dicebear.com/9.x/bottts/png"
_CUSTOM = "https://icons.example/reviewer.png"
_OTHER_STYLE = "https://api.dicebear.com/9.x/identicon/png?seed=chosen"


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


async def _insert(engine: AsyncEngine, icons: dict[str, str | None]) -> None:
    async with engine.begin() as connection:
        # The agents' tenants, clients and keys are beside the point here.
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        for name, icon_url in icons.items():
            await connection.execute(
                text(
                    "INSERT INTO agents (tenant_id, id, name, description, icon_url, "
                    "agent_type, connector_type, integration_profile, client_id, "
                    "api_key_id) VALUES ('t', :name, :name, '', :icon_url, "
                    "'auto_session', 'mcp', '{}', :name, :name)"
                ),
                {"name": name, "icon_url": icon_url},
            )


async def _icons(engine: AsyncEngine) -> dict[str, str | None]:
    async with engine.connect() as connection:
        result = await connection.execute(text("SELECT name, icon_url FROM agents"))
        return {row.name: row.icon_url for row in result}


async def test_generated_robots_become_gaze_and_back(migration_url: str) -> None:
    engine = create_async_engine(migration_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate_to(_PRE_MIGRATION_REVISION, downgrade=False)
            )
        await _insert(
            engine,
            {
                "named": f"{_ROBOT}?seed=named&size=256",
                "picked": f"{_ROBOT}?seed=named-2-7&size=256",
                "random": f"{_ROBOT}?seed=0b6c4f0e-8e1a-4f7e-9d65-0c2b5a3e9f11&size=256",
                "escaped": f"{_ROBOT}?size=256&seed=a%26b",
                "unseeded": f"{_ROBOT}?size=256",
                "custom": _CUSTOM,
                "other-style": _OTHER_STYLE,
                "lookalike": "https://api.dicebear.com.example/9.x/bottts/png?seed=x",
                "none": None,
            },
        )

        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate_to(_MIGRATION_UNDER_TEST, downgrade=False)
            )
        upgraded = await _icons(engine)

        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate_to(_PRE_MIGRATION_REVISION, downgrade=True)
            )
        downgraded = await _icons(engine)
    finally:
        await engine.dispose()

    untouched = {
        "custom": _CUSTOM,
        "other-style": _OTHER_STYLE,
        "lookalike": "https://api.dicebear.com.example/9.x/bottts/png?seed=x",
        "none": None,
    }
    # The migration's frozen URL is the one the server generates today, so an
    # agent moved by it looks the same as one created after it.
    assert upgraded == {
        "named": generated_icon_url("named"),
        "picked": generated_icon_url("named-2-7"),
        "random": generated_icon_url("0b6c4f0e-8e1a-4f7e-9d65-0c2b5a3e9f11"),
        "escaped": generated_icon_url("a&b"),
        "unseeded": generated_icon_url("unseeded"),
        **untouched,
    }
    assert downgraded == {
        "named": f"{_ROBOT}?seed=named&size=256",
        "picked": f"{_ROBOT}?seed=named-2-7&size=256",
        "random": f"{_ROBOT}?seed=0b6c4f0e-8e1a-4f7e-9d65-0c2b5a3e9f11&size=256",
        "escaped": f"{_ROBOT}?seed=a%26b&size=256",
        "unseeded": f"{_ROBOT}?seed=unseeded&size=256",
        **untouched,
    }
