"""Every connection names the process it belongs to and what it is for."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from switch_core.db.engine import (
    APPLICATION_NAME_BYTES,
    connection_name,
    create_engine_from_config,
    create_unpooled_engine,
)
from switch_core.process_identity import new_process_id
from tests.switch_core.db.test_dead_peer_detection import _config_for


def test_a_name_that_fits_is_the_process_and_the_role() -> None:
    assert connection_name("replica-1-0a1b2c3d", "signals") == (
        "replica-1-0a1b2c3d signals"
    )


def test_a_long_pod_name_gives_way_to_the_suffix_and_the_role() -> None:
    process_id = new_process_id("p" * 63)

    name = connection_name(process_id, "session-activity")

    assert len(name.encode()) == APPLICATION_NAME_BYTES
    assert name.endswith(f"{process_id[-9:]} session-activity")
    assert name.startswith("p" * 30)


def test_a_cut_never_splits_a_character() -> None:
    name = connection_name("é" * 40 + "-0a1b2c3d", "pool")

    assert len(name.encode()) <= APPLICATION_NAME_BYTES
    assert name.endswith("-0a1b2c3d pool")


def test_a_role_that_leaves_no_room_for_the_process_is_refused() -> None:
    with pytest.raises(ValueError, match="No room"):
        connection_name("replica-1-0a1b2c3d", "r" * 60)


async def test_pooled_and_held_connections_carry_it(postgres_url: str) -> None:
    config = _config_for(postgres_url)
    for expected, engine in (
        (
            "replica-1-0a1b2c3d pool",
            create_engine_from_config(config, "replica-1-0a1b2c3d pool"),
        ),
        (
            "replica-1-0a1b2c3d signals",
            create_unpooled_engine(config, "replica-1-0a1b2c3d signals"),
        ),
    ):
        try:
            async with engine.connect() as connection:
                name = await connection.scalar(
                    text(
                        "SELECT application_name FROM pg_stat_activity "
                        "WHERE pid = pg_backend_pid()"
                    )
                )
        finally:
            await engine.dispose()
        assert name == expected
