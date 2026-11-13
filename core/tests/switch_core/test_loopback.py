"""Which addresses plain http is as private as https on."""

from __future__ import annotations

import pytest

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


@pytest.mark.parametrize(
    ("url", "secure"),
    [
        ("https://switch.example.com", True),
        ("http://switch.example.com", True),
        ("https://127.0.0.1:8000", True),
        ("http://127.0.0.1:8000", False),
        ("http://localhost:8000", False),
    ],
)
def test_a_cookie_is_secure_except_over_http_on_loopback(
    url: str, secure: bool
) -> None:
    assert secure_cookie(url) is secure
