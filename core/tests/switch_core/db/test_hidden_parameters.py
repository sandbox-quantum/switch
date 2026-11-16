"""A database error's text never carries the values bound into the query.

`logger.exception` renders the exception's own string, and SQLAlchemy's
default string for a failed statement ends with every bound parameter. Any
error that reaches a catch-and-log would put an email, a message body or a
token into the log pipeline unless the engine hides them.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from switch_core.config import SwitchConfig
from switch_core.db.engine import create_engine_from_config, create_unpooled_engine
from tests.switch_core.db.test_dead_peer_detection import _config_for

_RECOGNISABLE = "sk_live_hidden_parameter_probe_7f3a91"


async def _violate_a_constraint(engine: AsyncEngine) -> IntegrityError:
    async with engine.connect() as conn:
        await conn.execute(
            text("CREATE TEMP TABLE probe (id integer PRIMARY KEY, secret text)")
        )
        await conn.execute(
            text("INSERT INTO probe (id, secret) VALUES (:id, :secret)"),
            {"id": 1, "secret": _RECOGNISABLE},
        )
        with pytest.raises(IntegrityError) as caught:
            await conn.execute(
                text("INSERT INTO probe (id, secret) VALUES (:id, :secret)"),
                {"id": 1, "secret": _RECOGNISABLE},
            )
        return caught.value


@pytest.mark.parametrize(
    "build",
    [create_engine_from_config, create_unpooled_engine],
    ids=["pooled", "unpooled"],
)
async def test_a_logged_database_error_leaves_the_bound_values_out(
    postgres_url: str,
    build: Callable[[SwitchConfig], AsyncEngine],
    caplog: pytest.LogCaptureFixture,
) -> None:
    engine = build(_config_for(postgres_url))
    try:
        error = await _violate_a_constraint(engine)
    finally:
        await engine.dispose()

    with caplog.at_level(logging.ERROR):
        try:
            raise error
        except IntegrityError:
            logging.getLogger("probe").exception("insert failed")

    assert "[SQL: INSERT INTO probe" in str(error)
    assert _RECOGNISABLE not in str(error)
    assert _RECOGNISABLE not in caplog.text
    assert error.params is not None and _RECOGNISABLE in error.params
