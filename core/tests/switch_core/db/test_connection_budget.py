"""The boot check of how many connections the deployment's processes can hold
against what Postgres allows, on a real server so `SHOW` answers as it does in
production."""

from __future__ import annotations

import logging

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.connection_budget import (
    LISTENING_CONNECTIONS,
    ConnectionBudgetError,
    check_connection_budget,
    per_process,
    processes_at_once,
)
from tests.switch_core.observability.test_bootstrap import _config


def test_one_replica_is_replaced_and_several_are_rolled() -> None:
    assert processes_at_once(1) == 1
    assert processes_at_once(3) == 4


def test_a_process_holds_its_pool_and_its_listeners(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(monkeypatch, DB_POOL_SIZE="10", DB_MAX_OVERFLOW="5")
    assert per_process(config) == 15 + LISTENING_CONNECTIONS


def test_exporting_metrics_adds_the_sampler(monkeypatch: pytest.MonkeyPatch) -> None:
    config = _config(
        monkeypatch,
        DB_POOL_SIZE="10",
        DB_MAX_OVERFLOW="5",
        OTLP_ENDPOINT="https://collector.example",
        DEPLOYMENT_ID="0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10",
    )
    assert per_process(config) == 15 + LISTENING_CONNECTIONS + 1


def _sized(monkeypatch: pytest.MonkeyPatch, replicas: int, pool: int) -> SwitchConfig:
    return _config(
        monkeypatch,
        CORE_REPLICAS=str(replicas),
        DB_POOL_SIZE=str(pool),
        DB_MAX_OVERFLOW="0",
    )


async def test_a_deployment_within_budget_starts(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await check_connection_budget(
        _sized(monkeypatch, replicas=2, pool=5), session_factory.kw["bind"]
    )


async def test_several_replicas_over_budget_refuse_to_start(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    with pytest.raises(ConnectionBudgetError, match="3 switch-core process"):
        await check_connection_budget(
            _sized(monkeypatch, replicas=2, pool=1000), session_factory.kw["bind"]
        )


async def test_one_replica_over_budget_warns_and_starts(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="switch_core.db.connection_budget"):
        await check_connection_budget(
            _sized(monkeypatch, replicas=1, pool=1000), session_factory.kw["bind"]
        )
    assert "more database connections than Postgres allows" in caplog.text
