"""A database error's text never carries the values bound into the query.

`logger.exception` renders the exception's own string, and SQLAlchemy's
default string for a failed statement ends with every bound parameter. Any
error that reaches a catch-and-log would put an email, a message body or a
token into the log pipeline unless the engine hides them.
"""

from __future__ import annotations

import ast
import logging
from collections.abc import Callable
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from switch_core.config import SwitchConfig
from switch_core.db.engine import create_engine_from_config, create_unpooled_engine
from tests.switch_core.db.test_dead_peer_detection import _config_for

_RECOGNISABLE = "sk_live_hidden_parameter_probe_7f3a91"

_SERVICE = Path(__file__).resolve().parents[3] / "switch_core"
# SQLAlchemy's and Alembic's ways of building an engine. Each one in the
# service is a place a database error can be logged from.
_ENGINE_BUILDERS = frozenset(
    {
        "create_engine",
        "create_async_engine",
        "engine_from_config",
        "async_engine_from_config",
    }
)


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


def _engines_showing_bound_values(source: str) -> list[int]:
    """The lines in `source` that build an engine without
    `hide_parameters=True` written on the call."""
    lines: list[int] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = (
            func.id
            if isinstance(func, ast.Name)
            else func.attr
            if isinstance(func, ast.Attribute)
            else None
        )
        if name not in _ENGINE_BUILDERS:
            continue
        hidden = any(
            kw.arg == "hide_parameters"
            and isinstance(kw.value, ast.Constant)
            and kw.value.value is True
            for kw in node.keywords
        )
        if not hidden:
            lines.append(node.lineno)
    return lines


def test_every_engine_the_service_builds_hides_bound_values() -> None:
    """The two shared builders are tested above against a real error; the
    engines built for one job (granting the runtime role, the boot lock,
    checking or running migrations) are held to the same here, so a new one
    cannot be added without it."""
    offenders = {
        str(path.relative_to(_SERVICE)): lines
        for path in sorted(_SERVICE.rglob("*.py"))
        if (lines := _engines_showing_bound_values(path.read_text()))
    }
    assert offenders == {}


def test_the_engine_check_sees_each_way_of_building_one() -> None:
    source = """
create_async_engine(url)
sqlalchemy.create_engine(url, hide_parameters=False)
async_engine_from_config(section, prefix="sqlalchemy.")
create_async_engine(url, **options)
create_async_engine(url, hide_parameters=True)
"""
    assert _engines_showing_bound_values(source) == [2, 3, 4, 5]
