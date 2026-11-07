"""`ZulipClient` against `httpx.MockTransport` — Zulip's HTTP API mocked at
the transport, never the client's own methods.

The client is built with `outbound_policy=None` here, taking the plain
`httpx.AsyncClient` branch (see `client.py`'s constructor), and
`httpx.AsyncClient` itself is monkeypatched to inject `MockTransport` —
the same pattern `test_teams_auth.py`/`test_teams_adapter.py` use.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.zulip.client import (
    BadEventQueueId,
    ZulipApiError,
    ZulipClient,
    ZulipRateLimited,
    ZulipSiteInvalid,
    normalize_site_url,
)


def _client(monkeypatch: pytest.MonkeyPatch, handler: Any) -> ZulipClient:
    real_client = httpx.AsyncClient

    def patched(**kwargs: Any) -> httpx.AsyncClient:
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    return ZulipClient(
        site="https://example.zulipchat.com",
        bot_email="bot@example.com",
        api_key="s3cret",
        outbound_policy=None,
    )


# ── URL validation ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value",
    [
        "http://example.zulipchat.com",  # not https
        "https://user:pass@example.zulipchat.com",  # userinfo
        "https://example.zulipchat.com/some/path",  # a path
        "https://",  # no host
        "not a url",
    ],
)
def test_rejects_bad_site_urls(value: str) -> None:
    with pytest.raises(ZulipSiteInvalid):
        normalize_site_url(value)


def test_normalizes_a_trailing_slash() -> None:
    assert (
        normalize_site_url("https://example.zulipchat.com/")
        == "https://example.zulipchat.com"
    )


def test_keeps_a_nonstandard_port() -> None:
    assert (
        normalize_site_url("https://zulip.internal:8443")
        == "https://zulip.internal:8443"
    )


# ── Auth header ──────────────────────────────────────────────────────────


async def test_sends_http_basic_auth_with_bot_email_and_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers.get("authorization")
        return httpx.Response(200, json={"result": "success", "msg": ""})

    client = _client(monkeypatch, handler)
    await client.get_own_user()
    import base64

    expected = base64.b64encode(b"bot@example.com:s3cret").decode()
    assert seen["authorization"] == f"Basic {expected}"
    await client.aclose()


# ── Error classification ─────────────────────────────────────────────────


async def test_invalid_api_key_raises_with_the_zulip_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "result": "error",
                "msg": "Invalid API key",
                "code": "INVALID_API_KEY",
            },
        )

    client = _client(monkeypatch, handler)
    with pytest.raises(ZulipApiError) as excinfo:
        await client.get_own_user()
    assert excinfo.value.code == "INVALID_API_KEY"
    await client.aclose()


async def test_rate_limit_raises_with_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={
                "result": "error",
                "msg": "API usage exceeded rate limit.",
                "code": "RATE_LIMIT_HIT",
                "retry-after": 2.5,
            },
        )

    client = _client(monkeypatch, handler)
    with pytest.raises(ZulipRateLimited) as excinfo:
        await client.get_own_user()
    assert excinfo.value.retry_after == 2.5
    await client.aclose()


async def test_bad_event_queue_id_is_its_own_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "result": "error",
                "msg": "Bad event queue id",
                "code": "BAD_EVENT_QUEUE_ID",
            },
        )

    client = _client(monkeypatch, handler)
    with pytest.raises(BadEventQueueId):
        await client.get_events(queue_id="stale", last_event_id=-1)
    await client.aclose()


# ── Register / events ────────────────────────────────────────────────────


async def test_register_queue_parses_the_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/register"
        return httpx.Response(
            200,
            json={
                "result": "success",
                "msg": "",
                "queue_id": "q1",
                "last_event_id": -1,
                "max_message_length": 10000,
                "max_file_upload_size_mib": 25,
            },
        )

    client = _client(monkeypatch, handler)
    queue = await client.register_queue()
    assert queue.queue_id == "q1"
    assert queue.max_message_length == 10000
    assert queue.max_file_upload_size_mib == 25
    await client.aclose()


async def test_get_events_passes_queue_id_and_last_event_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json={"result": "success", "msg": "", "events": []})

    client = _client(monkeypatch, handler)
    await client.get_events(queue_id="q1", last_event_id=42)
    assert seen["params"]["queue_id"] == "q1"
    assert seen["params"]["last_event_id"] == "42"
    await client.aclose()


# ── Sending ──────────────────────────────────────────────────────────────


async def test_send_stream_message_posts_the_right_form(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = dict(httpx.QueryParams(request.read().decode()))
        return httpx.Response(200, json={"result": "success", "msg": "", "id": 99})

    client = _client(monkeypatch, handler)
    message_id = await client.send_stream_message(
        stream_id=7, topic="general", content="hi"
    )
    assert message_id == 99
    assert seen["body"] == {
        "type": "stream",
        "to": "7",
        "topic": "general",
        "content": "hi",
    }
    await client.aclose()


async def test_send_direct_message_posts_a_json_user_id_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = dict(httpx.QueryParams(request.read().decode()))
        assert body["type"] == "direct"
        assert body["to"] == "[1, 2]"
        return httpx.Response(200, json={"result": "success", "msg": "", "id": 5})

    client = _client(monkeypatch, handler)
    assert await client.send_direct_message(user_ids=[1, 2], content="hi") == 5
    await client.aclose()


# ── Reactions (idempotent) ────────────────────────────────────────────────


async def test_add_reaction_already_exists_is_not_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "result": "error",
                "msg": "Reaction already exists",
                "code": "REACTION_ALREADY_EXISTS",
            },
        )

    client = _client(monkeypatch, handler)
    await client.add_reaction(1, emoji_name="eyes")  # must not raise
    await client.aclose()


async def test_remove_reaction_does_not_exist_is_not_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "result": "error",
                "msg": "Reaction does not exist",
                "code": "REACTION_DOES_NOT_EXIST",
            },
        )

    client = _client(monkeypatch, handler)
    await client.remove_reaction(1, emoji_name="eyes")  # must not raise
    await client.aclose()


async def test_add_reaction_other_errors_still_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"result": "error", "msg": "nope", "code": "SOMETHING_ELSE"}
        )

    client = _client(monkeypatch, handler)
    with pytest.raises(ZulipApiError):
        await client.add_reaction(1, emoji_name="eyes")
    await client.aclose()


# ── Catch-up / mark read ─────────────────────────────────────────────────


async def test_get_unread_messages_sends_the_is_unread_narrow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={"result": "success", "msg": "", "messages": [], "found_newest": True},
        )

    client = _client(monkeypatch, handler)
    await client.get_unread_messages()
    assert seen["params"]["narrow"] == '[{"operator": "is", "operand": "unread"}]'
    await client.aclose()


async def test_mark_read_is_a_noop_for_an_empty_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"result": "success", "msg": ""})

    client = _client(monkeypatch, handler)
    await client.mark_read([])
    assert called is False
    await client.aclose()


# ── Attachments ────────────────────────────────────────────────────────────


async def test_upload_file_returns_the_url(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"result": "success", "msg": "", "url": "/user_uploads/1/x/f.txt"}
        )

    client = _client(monkeypatch, handler)
    url = await client.upload_file(filename="f.txt", mimetype="text/plain", data=b"hi")
    assert url == "/user_uploads/1/x/f.txt"
    await client.aclose()


async def test_download_file_refuses_a_non_upload_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from switch_core.bridges.collaboration.models import BridgeOperationError

    client = _client(monkeypatch, lambda r: httpx.Response(200))
    with pytest.raises(BridgeOperationError):
        await client.download_file("https://evil.example.com/steal", max_bytes=100)
    await client.aclose()


async def test_download_file_refuses_oversize_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from switch_core.bridges.collaboration.models import BridgeOperationError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 1000)

    client = _client(monkeypatch, handler)
    with pytest.raises(BridgeOperationError):
        await client.download_file("/user_uploads/1/x/big.bin", max_bytes=100)
    await client.aclose()
