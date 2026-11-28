"""Where a box reaches Core directly: a host name, and the few private address ranges it may resolve to.

Core may sit behind one address or behind a private endpoint with one address per zone (a cloud's private link),
always under a host name whose certificate is checked by name. The box operator and the node gate take the name for
Core's URL and for `NO_PROXY`, and the ranges for the network policy's one direct route out (443 only). The policy is
what bounds a box: if the name ever resolved anywhere else, the connection would be blocked, so a wrong name fails
closed.

The ranges are checked here, and anything else refuses to start: IPv4 only, each a private range (never public,
loopback, link-local or multicast) of `/24` or narrower, at most `MAX_SERVER_CIDRS` of them, none repeated, each
written as its network address.
"""

from __future__ import annotations

import ipaddress
import re

#: The most direct ranges a deployment may list: one per zone's endpoint subnet, with room for a few zones.
MAX_SERVER_CIDRS = 4
#: The widest range accepted: a `/24`, never a `/16` or a `/0`.
WIDEST_PREFIX = 24

# A lower-case DNS name with at least one dot, each label 1 to 63 characters, not an address.
_LABEL = r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
HOST_RE = re.compile(rf"(?=.{{1,253}}$){_LABEL}(\.{_LABEL})+")
_ADDRESS_RE = re.compile(r"[0-9.]+")


class EndpointError(ValueError):
    """The server endpoint's settings are off: the caller refuses to start."""


def server_host(value: object) -> str:
    """The host name a box reaches Core at, checked."""
    if not isinstance(value, str) or not HOST_RE.fullmatch(value) or _ADDRESS_RE.fullmatch(value):
        raise EndpointError("server_host must be a lower-case host name, not an address")
    return value


def server_cidrs(value: object) -> tuple[str, ...]:
    """The private ranges Core's host name resolves to, checked, in the order given."""
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_SERVER_CIDRS:
        raise EndpointError(f"server_cidrs must list 1 to {MAX_SERVER_CIDRS} address ranges")
    found: list[str] = []
    for item in value:
        if not isinstance(item, str) or "/" not in item:
            raise EndpointError("each of server_cidrs must be an IPv4 range like 192.0.2.0/27")
        try:
            network = ipaddress.IPv4Network(item, strict=True)
        except ValueError:
            raise EndpointError(
                f"{item!r} in server_cidrs isn't an IPv4 range written as its network address"
            ) from None
        if network.prefixlen < WIDEST_PREFIX:
            raise EndpointError(f"{item} in server_cidrs is wider than a /{WIDEST_PREFIX}")
        if (
            not network.is_private
            or network.is_loopback
            or network.is_link_local
            or network.is_multicast
            or network.is_unspecified
        ):
            raise EndpointError(f"{item} in server_cidrs isn't a private range")
        if str(network) in found:
            raise EndpointError(f"{item} is listed twice in server_cidrs")
        found.append(str(network))
    return tuple(found)


def check_server_url(url: object, host: str) -> str:
    """`server_url`, which must be `https://<server_host>` exactly (a path or port would escape the checks)."""
    if not isinstance(url, str) or url.rstrip("/") != f"https://{host}":
        raise EndpointError("server_url must be https:// followed by server_host, and nothing else")
    return url.rstrip("/")
