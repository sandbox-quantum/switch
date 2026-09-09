"""Noticing a Postgres server that stopped answering without saying so.

A managed instance failing over to its standby does not close its sockets. The
connections stay open and look perfectly healthy: nothing is refused, nothing
is reset, reads simply never return. Left to the kernel's defaults that lasts
about fifteen minutes, and for all of it the process reports itself connected
while delivering nothing — the worst failure mode there is.

These tests cover what we ask the kernel for. Whether the kernel then honours
it is a failover test, not a unit test.
"""

from __future__ import annotations

import socket
from typing import TYPE_CHECKING

import pytest

from switch_core.config import SwitchConfig
from switch_core.db.engine import (
    create_engine_from_config,
    create_unpooled_engine,
    dead_peer_socket_options,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from sqlalchemy.ext.asyncio import AsyncEngine

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_password="pw",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    jwt_secret_key="jwt",
    gateway_admin_email="admin@example.com",
    gateway_admin_password="pw",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def _config_for(postgres_url: str, **overrides: object) -> SwitchConfig:
    """A config pointing at the throwaway container behind `postgres_url`."""
    credentials, _, location = postgres_url.split("://", 1)[1].rpartition("@")
    user, _, password = credentials.partition(":")
    hostport, _, name = location.partition("/")
    host, _, port = hostport.partition(":")
    return _config(
        db_host=host,
        db_port=port,
        db_user=user,
        db_password=password,
        db_name=name,
        **overrides,
    )


def _named(name: str) -> int | None:
    return getattr(socket, name, None)


class TestWhatWeAskFor:
    def test_keepalive_is_on_by_default(self) -> None:
        options, _ = dead_peer_socket_options(_config())

        assert (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1) in options

    def test_the_defaults_notice_within_a_minute(self) -> None:
        config = _config()
        idle = config.db_tcp_keepalive_idle
        probes = config.db_tcp_keepalive_interval * config.db_tcp_keepalive_count

        assert idle + probes < 60
        assert config.db_tcp_user_timeout < 60

    def test_the_user_timeout_is_asked_for_in_milliseconds(self) -> None:
        # The setting is seconds, because every other timeout in the config is.
        # TCP_USER_TIMEOUT is milliseconds, and getting that wrong by a factor
        # of a thousand is silent in both directions.
        option = _named("TCP_USER_TIMEOUT")
        if option is None:
            pytest.skip("this platform has no TCP_USER_TIMEOUT")
        options, _ = dead_peer_socket_options(_config(db_tcp_user_timeout=30))

        assert (socket.IPPROTO_TCP, option, 30_000) in options

    def test_zero_keepalive_idle_asks_for_no_keepalive_at_all(self) -> None:
        options, _ = dead_peer_socket_options(_config(db_tcp_keepalive_idle=0))

        assert not any(option == socket.SO_KEEPALIVE for _, option, _ in options)
        assert not any(name in str(options) for name in ("KEEPINTVL", "KEEPCNT"))

    def test_zero_user_timeout_asks_for_none(self) -> None:
        option = _named("TCP_USER_TIMEOUT")
        if option is None:
            pytest.skip("this platform has no TCP_USER_TIMEOUT")
        options, _ = dead_peer_socket_options(_config(db_tcp_user_timeout=0))

        assert not any(candidate == option for _, candidate, _ in options)

    def test_disabling_both_asks_for_nothing(self) -> None:
        options, _ = dead_peer_socket_options(
            _config(db_tcp_keepalive_idle=0, db_tcp_user_timeout=0)
        )

        assert options == []

    def test_an_option_this_platform_lacks_is_reported_not_dropped(self) -> None:
        # Silence here would mean a laptop and a cluster quietly disagreeing
        # about whether a failover is survivable.
        _, unavailable = dead_peer_socket_options(_config())
        expected = [
            name
            for name in (
                "TCP_KEEPIDLE",
                "TCP_KEEPINTVL",
                "TCP_KEEPCNT",
                "TCP_USER_TIMEOUT",
            )
            if _named(name) is None
        ]

        assert unavailable == expected


class TestOnARealConnection:
    """The options have to reach the socket, not just the option list."""

    @pytest.fixture(params=["pooled", "held"])
    def make_engine(
        self, request: pytest.FixtureRequest
    ) -> Callable[[SwitchConfig], AsyncEngine]:
        if request.param == "pooled":
            return create_engine_from_config
        return create_unpooled_engine

    async def _read(self, engine: AsyncEngine, level: int, option: int) -> int:
        """One socket option, read while the connection is still open.

        The unpooled engine closes its connection on the way out of the block,
        so this cannot hand the socket back to the caller and read it there.
        """
        async with engine.connect() as connection:
            raw = await connection.get_raw_connection()
            transport = raw.driver_connection._transport  # type: ignore[union-attr]
            sock = transport.get_extra_info("socket")
            return int(sock.getsockopt(level, option))

    async def test_keepalive_is_set_on_the_socket(
        self,
        postgres_url: str,
        make_engine: Callable[[SwitchConfig], AsyncEngine],
    ) -> None:
        engine = make_engine(_config_for(postgres_url))
        try:
            keepalive = await self._read(engine, socket.SOL_SOCKET, socket.SO_KEEPALIVE)

            # Non-zero rather than 1: BSD reads a boolean socket option back as
            # the option's own bit, so macOS answers 8 where Linux answers 1.
            assert keepalive != 0
        finally:
            await engine.dispose()

    @pytest.mark.parametrize(
        ("name", "setting", "scale"),
        [
            ("TCP_KEEPIDLE", "db_tcp_keepalive_idle", 1),
            ("TCP_KEEPINTVL", "db_tcp_keepalive_interval", 1),
            ("TCP_KEEPCNT", "db_tcp_keepalive_count", 1),
            ("TCP_USER_TIMEOUT", "db_tcp_user_timeout", 1000),
        ],
    )
    async def test_each_configured_value_reaches_the_socket(
        self,
        postgres_url: str,
        make_engine: Callable[[SwitchConfig], AsyncEngine],
        name: str,
        setting: str,
        scale: int,
    ) -> None:
        option = _named(name)
        if option is None:
            pytest.skip(f"this platform has no {name}")
        engine = make_engine(_config_for(postgres_url, **{setting: 7}))
        try:
            value = await self._read(engine, socket.IPPROTO_TCP, option)

            assert value == 7 * scale
        finally:
            await engine.dispose()

    async def test_nothing_is_set_when_it_is_all_turned_off(
        self,
        postgres_url: str,
        make_engine: Callable[[SwitchConfig], AsyncEngine],
    ) -> None:
        config = _config_for(
            postgres_url, db_tcp_keepalive_idle=0, db_tcp_user_timeout=0
        )
        engine = make_engine(config)
        try:
            keepalive = await self._read(engine, socket.SOL_SOCKET, socket.SO_KEEPALIVE)

            assert keepalive == 0
        finally:
            await engine.dispose()
