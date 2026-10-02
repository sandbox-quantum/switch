"""The outbound policy, and the client that connects only where it allows."""

from __future__ import annotations

import socket
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import pytest_asyncio
from aiohttp import web

from switch_core.config import SwitchConfig
from switch_core.outbound import (
    OutboundPolicy,
    OutboundURLRefused,
    guarded_async_client,
)

_NOTHING_ALLOWED = OutboundPolicy.parse("")


class TestParsing:
    def test_hostnames_and_networks(self) -> None:
        policy = OutboundPolicy.parse(" Mattermost , 10.0.0.0/8,, fd00::/8 ")
        assert policy.allowed_hostnames == frozenset({"mattermost"})
        assert [str(n) for n in policy.allowed_networks] == ["10.0.0.0/8", "fd00::/8"]

    def test_a_compose_service_name_with_an_underscore(self) -> None:
        policy = OutboundPolicy.parse("my_mattermost")
        assert policy.allowed_hostnames == frozenset({"my_mattermost"})

    @pytest.mark.parametrize("entry", ["http://mattermost", "bad host", "-x"])
    def test_anything_else_is_refused(self, entry: str) -> None:
        with pytest.raises(ValueError, match="OUTBOUND_ALLOWED_PRIVATE_HOSTS"):
            OutboundPolicy.parse(entry)

    def test_the_setting_is_checked_at_startup(self) -> None:
        with pytest.raises(ValueError, match="OUTBOUND_ALLOWED_PRIVATE_HOSTS"):
            SwitchConfig(  # type: ignore[call-arg]
                db_host="db",
                db_port="5432",
                db_user="postgres",
                db_name="switch",
                db_password="placeholder",  # gitleaks:allow
                matrix_server_name="switch.local",
                agent_registration_token="token",
                secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                gateway_admin_email="admin@example.com",
                gateway_admin_password="placeholder",  # gitleaks:allow
                outbound_allowed_private_hosts="not a host",
            )


def _resolving_to(monkeypatch: pytest.MonkeyPatch, *addresses: str) -> None:
    async def _getaddrinfo(self: Any, host: str, port: int, **_: Any) -> list[Any]:
        return [
            (
                socket.AF_INET6 if ":" in a else socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                (a, port),
            )
            for a in addresses
        ]

    monkeypatch.setattr("asyncio.base_events.BaseEventLoop.getaddrinfo", _getaddrinfo)


class TestWhatMayBeReached:
    async def test_a_public_address(self) -> None:
        assert await _NOTHING_ALLOWED.resolve("93.184.215.14", 443) == ["93.184.215.14"]

    @pytest.mark.parametrize(
        "address",
        [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.1",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "0.0.0.0",
        ],
    )
    async def test_a_private_address_is_refused(self, address: str) -> None:
        with pytest.raises(OutboundURLRefused, match="not a public address"):
            await _NOTHING_ALLOWED.resolve(address, 80)

    async def test_a_listed_network(self) -> None:
        policy = OutboundPolicy.parse("10.0.0.0/8")
        assert await policy.resolve("10.1.2.3", 80) == ["10.1.2.3"]

    async def test_a_listed_hostname_whatever_it_resolves_to(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _resolving_to(monkeypatch, "10.9.9.9")
        policy = OutboundPolicy.parse("mattermost")
        assert await policy.resolve("Mattermost", 8065) == ["10.9.9.9"]

    async def test_a_public_name_pointing_at_a_private_address(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _resolving_to(monkeypatch, "10.9.9.9")
        with pytest.raises(OutboundURLRefused, match="10.9.9.9"):
            await _NOTHING_ALLOWED.resolve("innocent.example.com", 443)

    async def test_one_private_address_among_public_ones_refuses_the_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _resolving_to(monkeypatch, "93.184.215.14", "127.0.0.1")
        with pytest.raises(OutboundURLRefused):
            await _NOTHING_ALLOWED.resolve("mixed.example.com", 443)

    @pytest.mark.parametrize(
        "address", ["169.254.169.254", "fd00:ec2::254", "100.100.100.200"]
    )
    async def test_metadata_is_refused_even_when_listed(self, address: str) -> None:
        policy = OutboundPolicy.parse("169.254.0.0/16,fd00::/8,100.64.0.0/10")
        with pytest.raises(OutboundURLRefused, match="metadata"):
            await policy.resolve(address, 80)

    async def test_the_gcp_metadata_name_is_refused(self) -> None:
        policy = OutboundPolicy.parse("metadata.google.internal")
        with pytest.raises(OutboundURLRefused, match="metadata"):
            await policy.resolve("metadata.google.internal", 80)


class TestCheckingAURL:
    @pytest.mark.parametrize(
        "url", ["file:///etc/passwd", "gopher://example.com", "example.com/path"]
    )
    async def test_other_schemes_are_refused(self, url: str) -> None:
        with pytest.raises(OutboundURLRefused, match="must use"):
            await _NOTHING_ALLOWED.check_url(url)

    async def test_a_url_with_no_host_is_refused(self) -> None:
        with pytest.raises(OutboundURLRefused, match="no host"):
            await _NOTHING_ALLOWED.check_url("https://")

    async def test_a_private_host_is_refused(self) -> None:
        with pytest.raises(OutboundURLRefused):
            await _NOTHING_ALLOWED.check_url("http://127.0.0.1:8065/")


@pytest_asyncio.fixture
async def local_server() -> AsyncIterator[int]:
    async def ok(_: web.Request) -> web.Response:
        return web.Response(text="ok")

    async def bounce(request: web.Request) -> web.Response:
        port = request.url.port
        raise web.HTTPFound(f"http://127.0.0.1:{port}/ok")

    app = web.Application()
    app.router.add_get("/ok", ok)
    app.router.add_get("/bounce", bounce)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    try:
        yield port
    finally:
        await runner.cleanup()


class TestTheGuardedClient:
    async def test_it_keeps_httpxs_pool_limits(self) -> None:
        """Not httpcore's bare defaults of 10 connections kept idle forever."""
        async with guarded_async_client(_NOTHING_ALLOWED) as client:
            pool = client._transport._pool  # type: ignore[attr-defined]
            assert pool._max_connections == 100
            assert pool._max_keepalive_connections == 20
            assert pool._keepalive_expiry == 5.0

    async def test_a_refused_address_is_never_connected_to(
        self, local_server: int
    ) -> None:
        async with guarded_async_client(_NOTHING_ALLOWED) as client:
            with pytest.raises(OutboundURLRefused):
                await client.get(f"http://127.0.0.1:{local_server}/ok")

    async def test_an_allowed_address_is_reached(self, local_server: int) -> None:
        # Also what proves the client's connections still go through the pool
        # `guarded_async_client` replaces; see the note there.
        policy = OutboundPolicy.parse("127.0.0.1/32")
        async with guarded_async_client(policy) as client:
            response = await client.get(f"http://127.0.0.1:{local_server}/ok")
        assert response.text == "ok"

    async def test_a_redirect_to_a_refused_address_is_not_followed_there(
        self, local_server: int
    ) -> None:
        # `localhost` is allowed by name; the redirect names 127.0.0.1, which is
        # not, so the second connection is refused.
        policy = OutboundPolicy.parse("localhost")
        async with guarded_async_client(policy, follow_redirects=True) as client:
            with pytest.raises(OutboundURLRefused):
                await client.get(f"http://localhost:{local_server}/bounce")

    async def test_proxy_settings_in_the_environment_are_ignored(
        self, local_server: int, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Through a proxy the address checked would be the proxy's.
        monkeypatch.setenv("HTTP_PROXY", "http://proxy.invalid:3128")
        monkeypatch.setenv("ALL_PROXY", "http://proxy.invalid:3128")
        policy = OutboundPolicy.parse("127.0.0.1/32")
        async with guarded_async_client(policy) as client:
            response = await client.get(f"http://127.0.0.1:{local_server}/ok")
        assert response.status_code == httpx.codes.OK
