"""Core's host name and the private ranges it resolves to: checked, and anything else refused."""

from __future__ import annotations

import pytest

from switch_hosted_controller.server_endpoint import (
    MAX_SERVER_CIDRS,
    EndpointError,
    check_server_url,
    server_cidrs,
    server_host,
)


def test_a_host_name_is_taken_and_an_address_or_odd_name_refused() -> None:
    assert server_host("switch-core.example.net") == "switch-core.example.net"
    for bad in (
        "10.0.0.10",
        "localhost",
        "Core.Example.net",
        "a..b",
        "-a.example",
        "a.example;rm",
        7,
        None,
    ):
        with pytest.raises(EndpointError):
            server_host(bad)


def test_private_narrow_ranges_are_taken_in_order() -> None:
    assert server_cidrs(["10.0.1.0/28", "172.16.0.0/24", "192.168.4.4/32"]) == (
        "10.0.1.0/28",
        "172.16.0.0/24",
        "192.168.4.4/32",
    )


@pytest.mark.parametrize(
    "bad",
    [
        [],
        "10.0.1.0/28",
        ["10.0.1.0"],  # no prefix
        ["0.0.0.0/0"],
        ["10.0.0.0/8"],
        ["10.0.0.0/23"],  # wider than /24
        ["8.8.8.0/24"],  # public
        ["100.64.0.0/24"],  # shared address space: not private
        ["127.0.0.0/24"],
        ["169.254.169.0/24"],  # link-local, metadata included
        ["224.0.0.0/24"],
        ["10.0.1.5/28"],  # not written as its network address
        ["10.0.1.0/28", "10.0.1.0/28"],
        ["fd00::/64"],
        [f"10.0.{n}.0/28" for n in range(MAX_SERVER_CIDRS + 1)],
    ],
)
def test_anything_else_is_refused(bad: object) -> None:
    with pytest.raises(EndpointError):
        server_cidrs(bad)


def test_the_url_is_exactly_https_and_the_host() -> None:
    assert check_server_url("https://switch-core.example.net/", "switch-core.example.net") == (
        "https://switch-core.example.net"
    )
    for bad in (
        "http://switch-core.example.net",
        "https://switch-core.example.net:8443",
        "https://switch-core.example.net/api",
        "https://other.example.net",
        "https://user@switch-core.example.net",
    ):
        with pytest.raises(EndpointError):
            check_server_url(bad, "switch-core.example.net")
