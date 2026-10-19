"""How many Postgres connections the deployment's switch-core processes can
hold at once, checked against what the server allows.

Each process holds its pool at worst (DB_POOL_SIZE plus DB_MAX_OVERFLOW) and,
outside the pool, one connection per `LISTEN` it keeps open, plus one for the
database-server sampler when metrics are exported. The pool is sized per
process, so every replica added multiplies it, and a rolling deploy of
several replicas starts one more before it stops an old one. A deployment that
outgrows `max_connections` does not fail at once: it fails under load, when
the last pools fill and new connections are refused.

So the sum is checked at boot, against the server's `max_connections` less
the slots it keeps for superusers. Over budget, a deployment of several
replicas refuses to start, since it is a new configuration and should be
sized before it serves. A single replica only warns: that is the
configuration every existing deployment has, and it may share the server with
other software whose connections are not counted here either way.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from switch_core.config import SwitchConfig

logger = logging.getLogger(__name__)

# The connections each process holds open outside its pool, one per LISTEN:
# `MessageListener`, `AgentSessionActivityListener`, `AgentEventListener` and
# `SignalBus`.
LISTENING_CONNECTIONS = 4


class ConnectionBudgetError(RuntimeError):
    """The deployment's processes could hold more connections than Postgres
    allows."""


@dataclass(frozen=True)
class ConnectionBudget:
    per_process: int
    processes: int
    available: int

    @property
    def needed(self) -> int:
        return self.per_process * self.processes

    def describe(self) -> str:
        return (
            f"{self.processes} switch-core process(es) at once x "
            f"{self.per_process} connection(s) each = {self.needed}, against "
            f"{self.available} the database allows"
        )


def per_process(config: SwitchConfig) -> int:
    """The most connections one process can hold."""
    sampler = 1 if config.observability_enabled and config.otlp_metrics_enabled else 0
    return (
        config.db_pool_size + config.db_max_overflow + LISTENING_CONNECTIONS + sampler
    )


def processes_at_once(replicas: int) -> int:
    """The most processes running at once: every replica, and during a rolling
    deploy of several, the one started before an old one stops. A single
    replica is replaced rather than rolled."""
    return replicas + 1 if replicas > 1 else replicas


async def check_connection_budget(config: SwitchConfig, engine: AsyncEngine) -> None:
    async with engine.connect() as connection:
        max_connections = int(
            (await connection.execute(text("SHOW max_connections"))).scalar_one()
        )
        reserved = int(
            (
                await connection.execute(text("SHOW superuser_reserved_connections"))
            ).scalar_one()
        )
    budget = ConnectionBudget(
        per_process=per_process(config),
        processes=processes_at_once(config.core_replicas),
        available=max_connections - reserved,
    )
    if budget.needed <= budget.available:
        logger.info("Database connection budget: %s.", budget.describe())
        return
    advice = (
        "Lower DB_POOL_SIZE or DB_MAX_OVERFLOW, run fewer replicas, or raise "
        "the server's max_connections."
    )
    if config.core_replicas > 1:
        raise ConnectionBudgetError(
            f"switch-core could hold more database connections than Postgres "
            f"allows: {budget.describe()}. {advice}"
        )
    logger.warning(
        "switch-core could hold more database connections than Postgres "
        "allows: %s. Under load, new connections will be refused. %s",
        budget.describe(),
        advice,
    )
