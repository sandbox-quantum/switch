from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from switch_core.config import SwitchConfig


def create_engine_from_config(
    config: SwitchConfig, **engine_kwargs: object
) -> AsyncEngine:
    connect_args = dict(config.db_connect_args)
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
