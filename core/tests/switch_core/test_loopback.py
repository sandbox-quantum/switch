"""Which addresses plain http is as private as https on."""

from __future__ import annotations

import pytest
from starlette.requests import Request

from switch_core.loopback import http_on_loopback, https_or_loopback, secure_cookie


@pytest.mark.parametrize(
    "url",
    [
        "https://switch.example.com",
        "https://127.0.0.1:8000",
        "http://127.0.0.1:51001",
        "http://localhost:8000",
        "http://LOCALHOST:8000",
        "http://[::1]:8000",
    ],
)
def test_https_anywhere_and_http_on_loopback_are_accepted(url: str) -> None:
    assert https_or_loopback(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://switch.example.com",
        "http://192.168.1.10:8000",
        "http://127.0.0.1.example.com",
        "http://localhost.example.com",
        "ftp://127.0.0.1",
        "127.0.0.1:8000",
    ],
)
def test_http_anywhere_else_is_not(url: str) -> None:
    assert not https_or_loopback(url)


def test_only_plain_http_counts_as_http_on_loopback() -> None:
    assert http_on_loopback("http://127.0.0.1:8000")
    assert not http_on_loopback("https://127.0.0.1:8000")
    assert not http_on_loopback("http://switch.example.com")


def _request(scheme: str, host: str) -> Request:
    return Request(
        {
            "type": "http",
            "scheme": scheme,
            "server": (host, 8000),
            "path": "/",
            "query_string": b"",
            "headers": [(b"host", f"{host}:8000".encode())],
        }
    )


@pytest.mark.parametrize(
    ("scheme", "host", "secure"),
    [
        ("https", "switch.example.com", True),
        ("http", "switch.example.com", True),
        ("https", "127.0.0.1", True),
        ("http", "127.0.0.1", False),
        ("http", "localhost", False),
    ],
)
def test_a_cookie_is_secure_except_over_http_on_loopback(
    scheme: str, host: str, secure: bool
) -> None:
    assert secure_cookie(_request(scheme, host)) is secure
