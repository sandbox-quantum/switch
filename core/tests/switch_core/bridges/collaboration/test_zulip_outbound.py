"""What Switch sends to Zulip, asserted on the wire.

The organization is mocked at the transport, so what is checked is the request
Zulip would receive — form field names, topic, body — rather than the adapter's
own shape, which would keep passing if the calls it makes drifted.
"""

from __future__ import annotations

from urllib.parse import parse_qs

import httpx

from switch_core.bridges.collaboration.zulip.adapter import (
    ZulipAdapter,
    ZulipConnectionConfig,
)
from switch_core.bridges.collaboration.zulip.chunking import MAX_MESSAGE
from switch_core.bridges.collaboration.zulip.http_client import ZulipClient


def _adapter(handler) -> ZulipAdapter:
    adapter = ZulipAdapter(
        config=ZulipConnectionConfig(
            url="https://acme.zulipchat.com",
            email="switch-bot@acme.zulipchat.com",
            api_key="key",
        )
    )
    adapter._client = ZulipClient(
        url="https://acme.zulipchat.com",
        email="switch-bot@acme.zulipchat.com",
        api_key="key",
        transport=httpx.MockTransport(handler),
    )
    return adapter


def _form(request: httpx.Request) -> dict[str, list[str]]:
    return parse_qs(request.content.decode())


async def test_a_message_is_posted_to_the_room_stream_in_its_topic() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"result": "success", "id": 41})

    adapter = _adapter(handler)

    ref = await adapter.send_message("12", "archimedes", "Hello **world**", "Plan")

    assert ref == "41"
    assert seen[0].method == "POST"
    assert seen[0].url.path == "/api/v1/messages"
    form = _form(seen[0])
    assert form["type"] == ["stream"]
    assert form["to"] == ["12"]
    assert form["topic"] == ["Plan"]
    body = form["content"][0]
    # One bot posts for every agent, so the name has to be in the body.
    assert "**archimedes**" in body
    assert body.endswith("Hello **world**")


async def test_a_message_outside_a_thread_lands_in_the_default_topic() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"result": "success", "id": 7})

    adapter = _adapter(handler)

    await adapter.send_message("12", "ada", "top level")

    assert _form(seen[0])["topic"] == ["Switch"]


async def test_a_long_reply_is_split_into_messages_zulip_accepts() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"result": "success", "id": len(seen)})

    adapter = _adapter(handler)

    ref = await adapter.send_message("12", "ada", "word " * 5000, "Plan")

    assert len(seen) > 1
    assert all(len(_form(request)["content"][0]) <= MAX_MESSAGE for request in seen)
    # The thread's first message is what the room replies under.
    assert ref == "1"


async def test_a_room_wide_mention_uses_zulips_own_form() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"result": "success", "id": 1})

    adapter = _adapter(handler)

    await adapter.send_message("12", "ada", "@everyone shipped", room_wide_mention=True)

    body = _form(seen[0])["content"][0]
    assert "@**all**" in body
    assert "@everyone" not in body


async def test_an_edit_and_a_delete_address_the_message_zulip_gave_us() -> None:
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        return httpx.Response(200, json={"result": "success", "msg": ""})

    adapter = _adapter(handler)

    await adapter.update_message("12", "41", "new text")
    await adapter.delete_message("12", "41")

    assert calls == [
        ("PATCH", "/api/v1/messages/41"),
        ("DELETE", "/api/v1/messages/41"),
    ]


async def test_typing_is_only_ever_started() -> None:
    # Zulip expires the indicator itself, so a stop would be a wasted call.
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"result": "success", "msg": ""})

    adapter = _adapter(handler)

    await adapter.send_typing("12", "ada", False)
    assert calls == []

    await adapter.send_typing("12", "ada", True)
    assert calls[0].url.path == "/api/v1/typing"
    form = _form(calls[0])
    assert form["op"] == ["start"]
    assert form["to"] == ["12"]


async def test_a_file_is_uploaded_and_linked_from_the_message() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/api/v1/user_uploads":
            # Zulip's multipart field for the file is `filename`, not `file`.
            assert b'name="filename"' in request.content
            assert b"notes.txt" in request.content
            return httpx.Response(
                200, json={"result": "success", "uri": "/user_uploads/2/ab/notes.txt"}
            )
        return httpx.Response(200, json={"result": "success", "id": 5})

    adapter = _adapter(handler)

    ref = await adapter.send_attachment(
        "12",
        "ada",
        "notes.txt",
        "text/plain",
        b"hello",
        caption="the notes",
        thread_root_id="Plan",
    )

    assert ref == "5"
    assert calls[-1].url.path == "/api/v1/messages"
    body = _form(calls[-1])["content"][0]
    assert "[notes.txt](/user_uploads/2/ab/notes.txt)" in body
    assert "the notes" in body


async def test_a_new_room_becomes_a_stream_the_bot_subscribes_to() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "result": "success",
                "subscribed": {"research-room": {"stream_id": 55}},
                "already_subscribed": {},
            },
        )

    adapter = _adapter(handler)

    stream_id = await adapter.create_channel("research-room", "the room's topic")

    assert stream_id == "55"
    form = _form(seen[0])
    assert seen[0].url.path == "/api/v1/users/me/subscriptions"
    assert '"name": "research-room"' in form["subscriptions"][0]
    assert '"description": "the room\'s topic"' in form["subscriptions"][0]


async def test_a_private_room_asks_for_a_private_stream() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"result": "success", "subscribed": {"secret": {"stream_id": 56}}}
        )

    adapter = _adapter(handler)

    await adapter.create_channel("secret", "topic", channel_type="channel_private")

    form = _form(seen[0])
    # Top-level in Zulip's schema; a subscription item carries only name,
    # description and colour.
    assert form["invite_only"] == ["true"]
    assert "invite_only" not in form["subscriptions"][0]


async def test_the_deeplink_opens_the_stream_in_the_organization() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "result": "success",
                "stream": {"stream_id": 12, "name": "Research Lab"},
            },
        )

    adapter = _adapter(handler)

    assert (
        await adapter.channel_deeplink("12")
        == "https://acme.zulipchat.com/#narrow/stream/12-research-lab"
    )
