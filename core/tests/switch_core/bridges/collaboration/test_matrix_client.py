from __future__ import annotations

import json

import httpx
import pytest

from switch_core.bridges.collaboration.matrix.client import MatrixApiError, MatrixClient
from switch_core.bridges.collaboration.matrix.config import MatrixConnectionConfig


def _config() -> MatrixConnectionConfig:
    return MatrixConnectionConfig(
        homeserver_url="https://matrix.example.org",
        access_token="token",
    )


async def test_whoami_calls_the_account_endpoint_with_the_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"user_id": "@switch:example.org"})

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        assert await client.whoami() == "@switch:example.org"
    finally:
        await client.close()

    assert seen[0].method == "GET"
    assert seen[0].url.path == "/_matrix/client/v3/account/whoami"
    assert seen[0].headers["Authorization"] == "Bearer token"


async def test_send_event_returns_the_event_id() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"event_id": "$event"})

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        event_id = await client.send_event(
            "!room:example.org",
            "m.room.message",
            {"msgtype": "m.text", "body": "hello"},
            txn_id="txn",
        )
    finally:
        await client.close()

    assert event_id == "$event"
    assert seen[0].method == "PUT"
    assert seen[0].url.raw_path.endswith(
        b"/rooms/%21room%3Aexample.org/send/m.room.message/txn"
    )
    assert json.loads(seen[0].content) == {"msgtype": "m.text", "body": "hello"}


async def test_redaction_uses_the_provided_transaction_id() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"event_id": "$redaction"})

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        await client.redact("!room:example.org", "$event", "deleted", txn_id="stable")
    finally:
        await client.close()

    assert seen[0].url.raw_path.endswith(b"/redact/%24event/stable")


async def test_a_matrix_refusal_keeps_its_errcode() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401, json={"errcode": "M_UNKNOWN_TOKEN", "error": "unknown token"}
        )

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(MatrixApiError) as caught:
            await client.whoami()
    finally:
        await client.close()

    assert caught.value.status == 401
    assert caught.value.errcode == "M_UNKNOWN_TOKEN"
    assert caught.value.message == "unknown token"


async def test_a_homeserver_under_a_path_keeps_that_path() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"user_id": "@switch:example.org"})

    config = MatrixConnectionConfig(
        homeserver_url="https://matrix.example.org/prefix",
        access_token="token",
    )
    client = MatrixClient(config, transport=httpx.MockTransport(handler))
    try:
        await client.whoami()
    finally:
        await client.close()

    assert seen[0].url.path == "/prefix/_matrix/client/v3/account/whoami"


async def test_room_state_reads_the_state_array() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {
                    "type": "m.room.encryption",
                    "state_key": "",
                    "content": {"algorithm": "m.megolm.v1.aes-sha2"},
                }
            ],
        )

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        state = await client.room_state("!room:example.org")
    finally:
        await client.close()

    assert state[0]["type"] == "m.room.encryption"


async def test_media_download_uses_authenticated_client_endpoint_and_mxc_parts() -> (
    None
):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=b"file")

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        assert await client.download_media("mxc://example.org/abc") == b"file"
    finally:
        await client.close()

    assert seen[0].url.path == "/_matrix/client/v1/media/download/example.org/abc"
    assert seen[0].headers["Authorization"] == "Bearer token"


async def test_media_download_raises_on_unavailable_media() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={"errcode": "M_NOT_FOUND", "error": "media unavailable"},
        )

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(MatrixApiError) as caught:
            await client.download_media("mxc://example.org/missing")
    finally:
        await client.close()

    assert caught.value.status == 404
    assert caught.value.errcode == "M_NOT_FOUND"


@pytest.mark.parametrize("uri", ["", "https://example.org/file", "mxc://", "mxc:///id"])
async def test_media_download_rejects_invalid_mxc_uris(uri: str) -> None:
    client = MatrixClient(
        _config(),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"")),
    )
    try:
        with pytest.raises(MatrixApiError) as caught:
            await client.download_media(uri)
    finally:
        await client.close()

    assert caught.value.status == 400


async def test_creating_a_private_room_sends_an_invite_only_preset() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"room_id": "!new:example.org"})

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        room_id = await client.create_room(
            "Private",
            "topic",
            public=False,
            invite=["@alice:example.org"],
            is_direct=False,
        )
    finally:
        await client.close()

    assert room_id == "!new:example.org"
    body = json.loads(seen[0].content)
    assert body["preset"] == "private_chat"
    assert body["visibility"] == "private"
    assert body["invite"] == ["@alice:example.org"]


async def test_sync_passes_the_since_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"next_batch": "s2", "rooms": {}})

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        body = await client.sync("s1")
    finally:
        await client.close()

    assert body["next_batch"] == "s2"
    assert seen[0].url.params["since"] == "s1"


async def test_a_request_failure_is_not_a_matrix_refusal() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    client = MatrixClient(_config(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(httpx.ConnectError):
            await client.whoami()
    finally:
        await client.close()
