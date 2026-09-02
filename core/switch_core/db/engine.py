from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from switch_core.config import SwitchConfig


def app_connect_args(config: SwitchConfig) -> dict[str, object]:
    """asyncpg connect args for the application engine.

    A superset of `config.db_connect_args`, which is also what Alembic builds
    its engine from (`migrations/env.py`). Anything added here therefore
    governs the running server and never a migration — which is the point for
    `idle_in_transaction_session_timeout`, since a migration can legitimately
    sit between two statements and being killed there is far worse than a
    request that hangs.
    """
    connect_args = dict(config.db_connect_args)
    timeout = config.db_idle_in_transaction_session_timeout
    if timeout is not None:
        connect_args["server_settings"] = {
            "idle_in_transaction_session_timeout": timeout
        }
    return connect_args


def create_engine_from_config(
    config: SwitchConfig, **engine_kwargs: object
) -> AsyncEngine:
    connect_args = app_connect_args(config)
    override_connect_args = engine_kwargs.pop("connect_args", {})
    if isinstance(override_connect_args, dict):
        connect_args.update(override_connect_args)
    defaults: dict[str, object] = {
        "pool_size": config.db_pool_size,
        "max_overflow": config.db_max_overflow,
        "pool_recycle": config.db_pool_recycle,
        "pool_pre_ping": config.db_pool_pre_ping,
        "pool_timeout": config.db_pool_timeout,
        "connect_args": connect_args,
    }
    defaults.update(engine_kwargs)
    return create_async_engine(config.database_url, **defaults)


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(bind=engine, expire_on_commit=False)
