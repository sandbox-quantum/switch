"""This computer's own addresses, where plain http is as private as https.

Nothing between a browser and a server on the loopback address can read what
passes, so a sign-in may come back over plain http there: GitHub, as RFC 8252
does, documents `http://127.0.0.1` callbacks for an app on the person's own
computer. A server Switch Console runs is at `http://127.0.0.1:<port>`.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from starlette.requests import Request

LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def http_on_loopback(url: str) -> bool:
    """Whether `url` is plain http to this computer's own address."""
    parts = urlsplit(url)
    return parts.scheme == "http" and parts.hostname in LOOPBACK_HOSTS


def https_or_loopback(url: str) -> bool:
    """Whether `url` is https, or plain http to this computer's own address."""
    return urlsplit(url).scheme == "https" or http_on_loopback(url)


def secure_cookie(request: Request) -> bool:
    """Whether a cookie set in answer to `request` is marked Secure: always,
    except over plain http to this computer's own address, such as a server
    Switch Console runs. Some browsers drop a Secure cookie set over http even
    there, and on the loopback address nothing in between could read it."""
    return not http_on_loopback(str(request.url))
