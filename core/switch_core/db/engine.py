import logging
import socket
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from switch_core.config import SwitchConfig

# Imported both for its side effect and for what it holds. The side effect is
# the `after_begin` hook that stamps the bound tenant onto every session's
# transaction, registered here rather than at a factory call site so that a
# process building an `async_sessionmaker` by hand is covered too — it still
# needs an engine, and an engine comes from here. What it holds is the session
# class `create_session_factory` binds below.
from switch_core.db import tenant_session

logger = logging.getLogger(__name__)


def dead_peer_socket_options(
    config: SwitchConfig,
) -> tuple[list[tuple[int, int, int]], list[str]]:
    """Socket options bounding how long a vanished server looks alive.

    Returns the `(level, option, value)` triples to set, and the names of the
    options this platform does not have. Linux has all of them. macOS spells
    the keepalive idle option differently and has no user timeout at all, so a
    developer's laptop applies what it can and says what it could not — the
    deployed system is the one that has to survive a failover.
    """
    options: list[tuple[int, int, int]] = []
    unavailable: list[str] = []

    def add(name: str, value: int) -> None:
        option = getattr(socket, name, None)
        if option is None:
            unavailable.append(name)
            return
        options.append((socket.IPPROTO_TCP, option, value))

    if config.db_tcp_keepalive_idle > 0:
        options.append((socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1))
        add("TCP_KEEPIDLE", config.db_tcp_keepalive_idle)
        add("TCP_KEEPINTVL", config.db_tcp_keepalive_interval)
        add("TCP_KEEPCNT", config.db_tcp_keepalive_count)
    if config.db_tcp_user_timeout > 0:
        add("TCP_USER_TIMEOUT", config.db_tcp_user_timeout * 1000)
    return options, unavailable


def _socket_behind(dbapi_connection: Any) -> Any:
    """The socket asyncpg is talking over, or None if it cannot be reached.

    Duck-typed on `setsockopt` rather than checked against `socket.socket`:
    asyncio hands out an `asyncio.trsock.TransportSocket`, which wraps a real
    socket and forwards the call but is not an instance of one.
    """
    driver_connection = getattr(dbapi_connection, "driver_connection", None)
    transport = getattr(driver_connection, "_transport", None)
    if transport is None:
        return None
    sock = transport.get_extra_info("socket")
    return sock if hasattr(sock, "setsockopt") else None


def _with_dead_peer_detection(engine: AsyncEngine, config: SwitchConfig) -> AsyncEngine:
    options, unavailable = dead_peer_socket_options(config)
    if unavailable:
        logger.warning(
            "This platform has no %s, so a Postgres server that stops "
            "answering without closing the connection will take the kernel's "
            "own timeout to be noticed rather than about %ds.",
            ", ".join(unavailable),
            max(
                config.db_tcp_user_timeout,
                config.db_tcp_keepalive_idle
                + config.db_tcp_keepalive_interval * config.db_tcp_keepalive_count,
            ),
        )
    if not options:
        return engine

    @event.listens_for(engine.sync_engine, "connect")
    def _set_socket_options(dbapi_connection: Any, _record: Any) -> None:
        sock = _socket_behind(dbapi_connection)
        if sock is None:
            logger.warning(
                "No socket behind this Postgres connection, so dead-peer "
                "detection is not in force on it: a failover will leave it "
                "looking healthy until the kernel's own timeout expires."
            )
            return
        for level, option, value in options:
            sock.setsockopt(level, option, value)

    return engine


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
    return _with_dead_peer_detection(
        create_async_engine(config.database_url, **defaults), config
    )


def create_unpooled_engine(config: SwitchConfig) -> AsyncEngine:
    """An engine for a connection that is held rather than borrowed.

    A `LISTEN` lives on one connection for the process's life. Every pool
    setting is either meaningless for that or actively harmful — recycling
    would drop the subscription, and the silence afterwards is indistinguishable
    from a quiet room — so it takes the connection arguments and none of the
    pooling.

    It does take the dead-peer socket options, and needs them more than the
    pool does. A pooled connection is checked out, used and pre-pinged, so a
    dead one is found the next time someone wants it; this one is only ever
    read from, and a server that vanishes without saying so leaves it silent
    and indistinguishable from a room where nobody is talking.
    """
    return _with_dead_peer_detection(
        create_async_engine(
            config.database_url,
            poolclass=NullPool,
            connect_args=app_connect_args(config),
        ),
        config,
    )


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """The factory every session in the process comes from.

    `sync_session_class` is what puts the tenant checks on `Session.get`:
    `AsyncSession` does no ORM work of its own, it drives a synchronous
    `Session` underneath, and `get` answered from that session's identity map
    is the one read that reaches neither the row-level-security policy nor the
    `do_orm_execute` hook. See `db/tenant_session.TenantCheckedSession`.
    """
    return async_sessionmaker(
        bind=engine,
        expire_on_commit=False,
        sync_session_class=tenant_session.TenantCheckedSession,
    )
