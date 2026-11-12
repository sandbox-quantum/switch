"""The Cloud API client, against an in-process transport standing in for Meta."""

from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Callable

import httpx
import pytest

from switch_core.bridges.collaboration.whatsapp.client import (
    GRAPH_ROOT,
    CloudApi,
    MediaTooLarge,
    WhatsAppApiError,
    inspect_token,
)

TOKEN = "test-access-token"
SECRET = "test-app-secret"
PHONE_ID = "1111111111"
PROOF = hmac.new(SECRET.encode(), TOKEN.encode(), hashlib.sha256).hexdigest()


class Recorder:
    def __init__(self, respond: Callable[[httpx.Request], httpx.Response]) -> None:
        self.respond = respond
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.respond(request)


def _client(recorder: Recorder) -> CloudApi:
    return CloudApi(
        http=httpx.AsyncClient(transport=httpx.MockTransport(recorder)),
        access_token=TOKEN,
        app_secret=SECRET,
        phone_number_id=PHONE_ID,
    )


def _graph_error(
    status: int, code: int, message: str, subcode: int | None = None
) -> httpx.Response:
    error: dict[str, object] = {
        "message": message,
        "type": "OAuthException",
        "code": code,
    }
    if subcode is not None:
        error["error_subcode"] = subcode
    return httpx.Response(status, json={"error": error})


async def test_a_send_is_signed_with_the_token_and_the_app_secret_proof() -> None:
    recorder = Recorder(
        lambda _: httpx.Response(200, json={"messages": [{"id": "wamid.SENT"}]})
    )

    ref = await _client(recorder).send({"type": "text", "to": "15550001111"})

    assert ref == "wamid.SENT"
    (request,) = recorder.requests
    assert request.url.copy_with(params=None) == httpx.URL(
        f"{GRAPH_ROOT}/{PHONE_ID}/messages"
    )
    assert request.url.params["appsecret_proof"] == PROOF
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert json.loads(request.content) == {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "type": "text",
        "to": "15550001111",
    }


async def test_a_graph_error_carries_meta_s_code_and_wording() -> None:
    recorder = Recorder(
        lambda _: _graph_error(400, 131047, "Re-engagement message", subcode=2494010)
    )

    with pytest.raises(WhatsAppApiError) as raised:
        await _client(recorder).send({"type": "text", "to": "15550001111"})

    assert raised.value.status == 400
    assert raised.value.code == 131047
    assert raised.value.subcode == 2494010
    assert "Re-engagement message" in str(raised.value)
    assert raised.value.window_closed
    assert not raised.value.credentials_rejected


@pytest.mark.parametrize("code", [0, 102, 190])
async def test_a_rejected_token_is_recognised_as_a_credential_failure(
    code: int,
) -> None:
    recorder = Recorder(lambda _: _graph_error(401, code, "Invalid OAuth access token"))

    with pytest.raises(WhatsAppApiError) as raised:
        await _client(recorder).send({"type": "text", "to": "15550001111"})

    assert raised.value.credentials_rejected


async def test_an_unreadable_error_body_still_fails_with_the_status() -> None:
    recorder = Recorder(lambda _: httpx.Response(502, text="<html>bad gateway</html>"))

    with pytest.raises(WhatsAppApiError) as raised:
        await _client(recorder).send({"type": "text", "to": "15550001111"})

    assert raised.value.status == 502
    assert raised.value.code is None


async def test_a_send_without_a_message_id_is_an_error_not_a_success() -> None:
    recorder = Recorder(lambda _: httpx.Response(200, json={"messages": []}))

    with pytest.raises(WhatsAppApiError):
        await _client(recorder).send({"type": "text", "to": "15550001111"})


async def test_mark_read_with_typing_sends_the_typing_indicator() -> None:
    recorder = Recorder(lambda _: httpx.Response(200, json={"success": True}))

    await _client(recorder).mark_read("wamid.IN", typing=True)

    assert json.loads(recorder.requests[0].content) == {
        "messaging_product": "whatsapp",
        "status": "read",
        "message_id": "wamid.IN",
        "typing_indicator": {"type": "text"},
    }


async def test_media_is_uploaded_as_multipart_and_its_id_returned() -> None:
    recorder = Recorder(lambda _: httpx.Response(200, json={"id": "MEDIA-1"}))

    media_id = await _client(recorder).upload_media(
        filename="report.pdf", mimetype="application/pdf", data=b"%PDF-1.7"
    )

    assert media_id == "MEDIA-1"
    (request,) = recorder.requests
    assert request.url.path.endswith(f"/{PHONE_ID}/media")
    assert request.url.params["appsecret_proof"] == PROOF
    body = request.content
    assert b'name="messaging_product"' in body and b"whatsapp" in body
    assert b'filename="report.pdf"' in body and b"%PDF-1.7" in body


async def test_media_is_looked_up_then_downloaded_with_the_token() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.host == "graph.facebook.com":
            return httpx.Response(
                200,
                json={
                    "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
                    "mime_type": "image/jpeg",
                    "file_size": 1234,
                    "id": "MEDIA-IN",
                },
            )
        return httpx.Response(200, content=b"\xff\xd8jpeg")

    recorder = Recorder(respond)
    client = _client(recorder)

    media = await client.media("MEDIA-IN")
    data = await client.download(media.url, limit=1024)

    assert media.mimetype == "image/jpeg"
    assert media.size == 1234
    assert data == b"\xff\xd8jpeg"
    lookup, download = recorder.requests
    assert lookup.url.path.endswith("/MEDIA-IN")
    assert download.headers["authorization"] == f"Bearer {TOKEN}"
    assert "appsecret_proof" not in download.url.params


async def test_inspect_token_asks_with_the_app_s_own_token() -> None:
    recorder = Recorder(
        lambda _: httpx.Response(
            200,
            json={
                "data": {
                    "app_id": "222",
                    "is_valid": True,
                    "scopes": ["whatsapp_business_messaging"],
                }
            },
        )
    )

    data = await inspect_token(
        httpx.AsyncClient(transport=httpx.MockTransport(recorder)),
        access_token=TOKEN,
        app_id="222",
        app_secret=SECRET,
    )

    assert data["app_id"] == "222"
    (request,) = recorder.requests
    assert request.url.path.endswith("/debug_token")
    assert request.url.params["input_token"] == TOKEN
    assert "access_token" not in request.url.params
    assert request.headers["authorization"] == f"Bearer 222|{SECRET}"


async def test_a_download_stops_once_it_runs_past_its_limit() -> None:
    recorder = Recorder(lambda _: httpx.Response(200, content=b"x" * 4096))

    with pytest.raises(MediaTooLarge):
        await _client(recorder).download(
            "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
            limit=1024,
        )


async def test_a_redirect_is_not_taken_as_the_file() -> None:
    recorder = Recorder(
        lambda _: httpx.Response(
            302, headers={"location": "https://elsewhere.example/"}
        )
    )

    with pytest.raises(WhatsAppApiError):
        await _client(recorder).download(
            "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
            limit=1024,
        )


async def test_a_media_lookup_naming_another_host_is_refused() -> None:
    recorder = Recorder(
        lambda _: httpx.Response(
            200, json={"url": "http://169.254.169.254/latest", "id": "1"}
        )
    )

    with pytest.raises(WhatsAppApiError, match="no WhatsApp media address"):
        await _client(recorder).media("1")
