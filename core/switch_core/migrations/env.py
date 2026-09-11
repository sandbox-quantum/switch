import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from switch_core.config import SwitchConfig
from switch_core.db import (
    models as _models,  # noqa: F401 — registers tables with Base.metadata
)
from switch_core.db.base import Base
from switch_core.logging_config import logging_is_configured

config = context.config
# Run from the CLI this is the only logging there is. Run in-process from the
# server, logging is already set up and applying the ini would install a second
# root handler, doubling every line the server goes on to emit.
if config.config_file_name is not None and not logging_is_configured():
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata

switch_config = SwitchConfig()  # type: ignore[call-arg]
# The owner's connection where one is configured, and only there. A migration
# is DDL and the runtime role deliberately cannot run DDL — see
# `SwitchConfig.db_owner_user`. Falling back to the runtime connection keeps
# `alembic` on the command line working against a database whose owner *is*
# the configured user, which is what a developer pointing it at a scratch
# instance has; where the two roles differ, the runtime one produces a
# permission error naming the statement it could not run, which is the right
# failure rather than a silent half-migration.
config.set_main_option(
    "sqlalchemy.url", switch_config.owner_database_url or switch_config.database_url
)


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):  # type: ignore[no-untyped-def]
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args=switch_config.db_connect_args,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
