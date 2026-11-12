from __future__ import annotations

import secrets
from collections.abc import AsyncIterator

import httpx
import pytest

from switch_core.bridges.collaboration.models import BridgeOperationError
from switch_core.bridges.collaboration.webex.client import WebexClient


class Chunks(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.read = 0
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for _ in range(100):
            self.read += 1
            yield b"1234"

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.parametrize("length", [None, "400"])
async def test_download_stops_at_limit_and_closes_stream(length: str | None) -> None:
    stream = Chunks()

    def respond(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={} if length is None else {"content-length": length},
            stream=stream,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        with pytest.raises(BridgeOperationError, match="8-byte"):
            await WebexClient(http, secrets.token_urlsafe()).download(
                "https://webexapis.com/v1/contents/file", 8
            )
    assert stream.read == (3 if length is None else 0)
    assert stream.closed


async def test_download_preserves_filename_mime_and_bytes() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"].startswith("Bearer ")
        return httpx.Response(
            200,
            headers={
                "content-disposition": "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt",
                "content-type": "text/plain; charset=utf-8",
            },
            content=b"file bytes",
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        attachment = await WebexClient(http, secrets.token_urlsafe()).download(
            "https://webexapis.com/v1/contents/file", 100
        )
    assert (attachment.filename, attachment.mimetype, attachment.data) == (
        "résumé.txt",
        "text/plain",
        b"file bytes",
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://webexapis.com/v1/contents/file",
        "https://example.com/file",
        "https://webexapis.com.evil.example/v1/contents/file",
        "https://webexapis.com:8443/v1/contents/file",
        "https://webexapis.com/v1/people/me",
    ],
)
async def test_attachment_never_sends_bot_token_to_other_hosts(url: str) -> None:
    def respond(_: httpx.Request) -> httpx.Response:
        pytest.fail("Rejected URL reached the HTTP transport")

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        with pytest.raises(
            BridgeOperationError, match="unsupported attachment address"
        ):
            await WebexClient(http, secrets.token_urlsafe()).download(url, 100)


async def test_attachment_redirect_does_not_forward_token() -> None:
    calls: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://example.com/secret"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        with pytest.raises(BridgeOperationError, match="redirected"):
            await WebexClient(http, secrets.token_urlsafe()).download(
                "https://webexapis.com/v1/contents/file", 100
            )
    assert len(calls) == 1


async def test_webhook_listing_follows_pagination() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        if "cursor" in request.url.params:
            return httpx.Response(200, json={"items": [{"id": "second"}]})
        return httpx.Response(
            200,
            json={"items": [{"id": "first"}]},
            headers={
                "link": '<https://webexapis.com/v1/webhooks?cursor=next>; rel="next"'
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        assert await WebexClient(http, secrets.token_urlsafe()).items("webhooks") == [
            {"id": "first"},
            {"id": "second"},
        ]


async def test_pagination_cannot_leak_bot_token() -> None:
    calls = 0

    def respond(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={"items": []},
            headers={"link": '<https://example.com/>; rel="next"'},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        with pytest.raises(BridgeOperationError, match="pagination address"):
            await WebexClient(http, secrets.token_urlsafe()).items("webhooks")
    assert calls == 1
