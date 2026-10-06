"""Outbound requests to URLs a tenant or an agent chose.

A Mattermost server URL or an agent's icon is fetched
by Switch from inside the network it runs in. Unchecked, such a URL can name a
service on that network or the cloud instance-metadata endpoint, and the
request carries whatever credentials go with it.

`OutboundPolicy` decides which addresses may be reached: any public address,
plus the private hosts and networks an operator lists in
`OUTBOUND_ALLOWED_PRIVATE_HOSTS` (a bundled Mattermost, a tailnet server). Link-local addresses, which include the
metadata endpoints, are refused even when listed.

The check is made on the resolved addresses, not on the hostname, so a public
name pointing at a private address is caught. `guarded_async_client` goes
further and connects to the address it checked, so the name cannot resolve
somewhere else between the check and the connection.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpcore
import httpx

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network

# Never reachable, whatever the operator lists: link-local covers the AWS,
# GCP and Azure metadata endpoints, and the other two are metadata endpoints
# outside it.
_ALWAYS_BLOCKED_NETWORKS: tuple[IPNetwork, ...] = (
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("fd00:ec2::254/128"),
    ipaddress.ip_network("100.100.100.200/32"),
)
_ALWAYS_BLOCKED_HOSTNAMES = frozenset({"metadata.google.internal"})

# Underscores are not legal in DNS hostnames but are in Compose service and
# Docker network aliases, which is what most private hosts listed here are.
_HOSTNAME_RE = re.compile(
    r"^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$"
)

_DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443}

# httpx's own defaults, which its pool gets and a bare httpcore pool does not:
# httpcore's are 10 connections with idle ones kept forever.
_POOL_LIMITS = httpx.Limits(
    max_connections=100, max_keepalive_connections=20, keepalive_expiry=5.0
)


class OutboundURLRefused(ValueError):
    """A URL names an address Switch will not connect to on a tenant's behalf."""


@dataclass(frozen=True)
class OutboundPolicy:
    allowed_hostnames: frozenset[str]
    allowed_networks: tuple[IPNetwork, ...]

    @classmethod
    def parse(cls, value: str) -> OutboundPolicy:
        """Read `OUTBOUND_ALLOWED_PRIVATE_HOSTS`: hostnames and CIDRs, comma-separated."""
        hostnames: set[str] = set()
        networks: list[IPNetwork] = []
        for raw in value.split(","):
            entry = raw.strip().lower()
            if not entry:
                continue
            try:
                networks.append(ipaddress.ip_network(entry, strict=False))
                continue
            except ValueError:
                pass
            if not _HOSTNAME_RE.match(entry):
                raise ValueError(
                    f"OUTBOUND_ALLOWED_PRIVATE_HOSTS entry {raw.strip()!r} is "
                    "neither a hostname nor an IP network."
                )
            hostnames.add(entry)
        return cls(
            allowed_hostnames=frozenset(hostnames), allowed_networks=tuple(networks)
        )

    def _refusal(self, hostname: str, address: IPAddress) -> str | None:
        if any(address in network for network in _ALWAYS_BLOCKED_NETWORKS):
            return f"{hostname} resolves to {address}, a link-local or metadata address"
        if address.is_global:
            return None
        if hostname in self.allowed_hostnames:
            return None
        if any(address in network for network in self.allowed_networks):
            return None
        return (
            f"{hostname} resolves to {address}, which is not a public address. "
            "An operator can allow it with OUTBOUND_ALLOWED_PRIVATE_HOSTS."
        )

    async def resolve(self, hostname: str, port: int) -> list[str]:
        """Every address `hostname` resolves to, or refuse if any is not allowed.

        One refused address refuses the name: which of several addresses a
        connection lands on is not ours to choose, so all of them must pass.
        """
        hostname = hostname.lower().rstrip(".").strip("[]")
        if hostname in _ALWAYS_BLOCKED_HOSTNAMES:
            raise OutboundURLRefused(f"{hostname} is a metadata endpoint")
        try:
            literal: IPAddress | None = ipaddress.ip_address(hostname)
        except ValueError:
            literal = None
        if literal is not None:
            candidates: Iterable[str] = [hostname]
        else:
            try:
                infos = await asyncio.get_running_loop().getaddrinfo(
                    hostname, port, type=socket.SOCK_STREAM
                )
            except socket.gaierror as exc:
                raise OutboundURLRefused(f"{hostname} does not resolve: {exc}") from exc
            candidates = [str(info[4][0]) for info in infos]

        addresses: list[str] = []
        for candidate in candidates:
            address = ipaddress.ip_address(candidate.split("%", 1)[0])
            if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
                address = address.ipv4_mapped
            refusal = self._refusal(hostname, address)
            if refusal is not None:
                raise OutboundURLRefused(refusal)
            if str(address) not in addresses:
                addresses.append(str(address))
        if not addresses:
            raise OutboundURLRefused(f"{hostname} resolves to no address")
        return addresses

    async def check_url(
        self, url: str, *, schemes: Iterable[str] = ("http", "https")
    ) -> None:
        """Refuse a URL whose scheme or resolved host is not allowed."""
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in set(schemes):
            raise OutboundURLRefused(
                f"{url!r} must use {' or '.join(sorted(schemes))}, not {scheme or 'no scheme'!r}"
            )
        if not parts.hostname:
            raise OutboundURLRefused(f"{url!r} names no host")
        try:
            port = parts.port or _DEFAULT_PORTS[scheme]
        except ValueError as exc:
            raise OutboundURLRefused(f"{url!r} has an invalid port") from exc
        await self.resolve(parts.hostname, port)


class _GuardedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Connects only to an address the policy allowed, resolved just now."""

    def __init__(self, policy: OutboundPolicy) -> None:
        self._policy = policy
        self._inner = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        addresses = await self._policy.resolve(host, port)
        failure: Exception | None = None
        for address in addresses:
            try:
                return await self._inner.connect_tcp(
                    address,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                failure = exc
        assert failure is not None
        raise failure

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise OutboundURLRefused("a guarded client does not connect to Unix sockets")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


def guarded_async_client(
    policy: OutboundPolicy, *, verify: bool = True, **client_kwargs: Any
) -> httpx.AsyncClient:
    """An `httpx.AsyncClient` that can reach only what `policy` allows.

    Each connection resolves its host, checks every address and connects to a
    checked one, so redirects and re-resolution are covered as well. Proxy
    settings from the environment are ignored: through a proxy, the address
    checked would be the proxy's.

    TLS still verifies against the hostname, because httpcore sends the URL's
    host as SNI whatever address the socket connected to.
    """
    transport = httpx.AsyncHTTPTransport(verify=verify, trust_env=False)
    # httpx exposes no way to hand its pool a network backend, so the pool it
    # built is replaced with an equivalent one that has ours.
    # `test_outbound.py` makes a real request through this client and would
    # fail if httpx stopped routing connections through `_pool`.
    limits = _POOL_LIMITS
    transport._pool = httpcore.AsyncConnectionPool(
        ssl_context=httpx.create_ssl_context(verify=verify, trust_env=False),
        max_connections=limits.max_connections,
        max_keepalive_connections=limits.max_keepalive_connections,
        keepalive_expiry=limits.keepalive_expiry,
        network_backend=_GuardedNetworkBackend(policy),
    )
    return httpx.AsyncClient(transport=transport, trust_env=False, **client_kwargs)
