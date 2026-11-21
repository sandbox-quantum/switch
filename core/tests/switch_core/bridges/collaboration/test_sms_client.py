from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from urllib.parse import parse_qs

import httpx
import pytest

from switch_core.bridges.collaboration.sms.client import (
    MediaRefused,
    MediaTooLarge,
    TwilioClient,
    TwilioError,
)

SID = "AC" + "0" * 32
TOKEN = "test-auth-token"
NUMBER = "+14155550100"
MEDIA_URL = f"https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages/MM1/Media/ME1"


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> TwilioClient:
    return TwilioClient(
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        account_sid=SID,
        auth_token=TOKEN,
    )


async def test_account_authenticates_with_the_sid_and_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/2010-04-01/Accounts/{SID}.json"
        assert request.headers["authorization"].startswith("Basic ")
        return httpx.Response(200, json={"status": "active"})

    assert (await _client(handler).account())["status"] == "active"


async def test_refusal_carries_twilios_code_and_words() -> None:
    client = _client(
        lambda _: httpx.Response(
            401, json={"code": 20003, "message": "Authenticate", "status": 401}
        )
    )
    with pytest.raises(TwilioError, match="code 20003") as caught:
        await client.account()
    assert (caught.value.status, caught.value.code) == (401, 20003)
    assert caught.value.message == "Authenticate"


async def test_error_text_explains_and_links_with_the_number_masked() -> None:
    client = _client(
        lambda _: httpx.Response(
            400, json={"code": 21211, "message": "Invalid To: +14155550101"}
        )
    )
    with pytest.raises(TwilioError) as caught:
        await client.account()
    assert str(caught.value) == (
        "Invalid To: ...0101 (HTTP 400, code 21211). "
        "See https://www.twilio.com/docs/api/errors/21211"
    )


async def test_refusal_that_is_not_json_still_raises() -> None:
    client = _client(lambda _: httpx.Response(502, text="<html>bad gateway</html>"))
    with pytest.raises(TwilioError, match="HTTP 502"):
        await client.account()


async def test_incoming_number_needs_the_whole_number_to_match() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["PhoneNumber"] == NUMBER
        return httpx.Response(
            200,
            json={"incoming_phone_numbers": [{"phone_number": NUMBER + "9"}]},
        )

    assert await _client(handler).incoming_number(NUMBER) is None


async def test_incoming_number_found() -> None:
    record = {"phone_number": NUMBER, "capabilities": {"sms": True}}
    client = _client(
        lambda _: httpx.Response(200, json={"incoming_phone_numbers": [record]})
    )
    assert await client.incoming_number(NUMBER) == record


async def test_send_message_posts_the_form_and_returns_the_sid() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/2010-04-01/Accounts/{SID}/Messages.json"
        assert parse_qs(request.content.decode()) == {
            "From": [NUMBER],
            "To": ["+14155550101"],
            "Body": ["hello"],
            "SmartEncoded": ["true"],
            "StatusCallback": ["https://example.com/events"],
        }
        return httpx.Response(201, json={"sid": "SM1"})

    sid = await _client(handler).send_message(
        from_number=NUMBER,
        to="+14155550101",
        body="hello",
        status_callback="https://example.com/events",
    )
    assert sid == "SM1"


async def test_media_redirect_does_not_carry_credentials_off_twilio() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.host == "api.twilio.com":
            return httpx.Response(
                307, headers={"location": "https://media.example.com/file"}
            )
        return httpx.Response(
            200, content=b"image", headers={"content-type": "image/png"}
        )

    content = await _client(handler).download_media(MEDIA_URL, max_bytes=100)
    assert content == b"image"
    assert "authorization" in seen[0].headers
    assert "authorization" not in seen[1].headers


async def test_media_on_another_host_gets_no_credentials() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in request.headers
        return httpx.Response(200, content=b"x")

    await _client(handler).download_media("https://other.example/x", max_bytes=10)


async def test_media_over_plain_http_is_refused() -> None:
    client = _client(lambda _: httpx.Response(200, content=b"x"))
    with pytest.raises(MediaRefused, match="not https"):
        await client.download_media("http://api.twilio.com/x", max_bytes=10)


async def test_endless_media_redirect_is_refused() -> None:
    client = _client(lambda _: httpx.Response(302, headers={"location": MEDIA_URL}))
    with pytest.raises(MediaRefused, match="too many"):
        await client.download_media(MEDIA_URL, max_bytes=10)


async def test_media_declared_too_large_is_refused() -> None:
    client = _client(
        lambda _: httpx.Response(
            200, content=b"x" * 11, headers={"content-length": "11"}
        )
    )
    with pytest.raises(MediaTooLarge):
        await client.download_media(MEDIA_URL, max_bytes=10)


async def test_media_larger_than_declared_is_refused() -> None:
    async def chunks() -> AsyncIterator[bytes]:
        yield b"x" * 11

    client = _client(
        lambda _: httpx.Response(200, content=chunks(), headers={"content-length": "1"})
    )
    with pytest.raises(MediaTooLarge):
        await client.download_media(MEDIA_URL, max_bytes=10)
