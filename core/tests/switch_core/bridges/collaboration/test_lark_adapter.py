"""The Lark / Feishu adapter, against a fake of Lark's Open Platform API.

Lark is mocked at the HTTP transport, so every request the adapter makes is
the request Lark would see, and webhook deliveries are built and signed the
way Lark builds and signs them.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import (
    RequestCard,
    RichContentFailed,
    TurnActivity,
)
from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.lark.adapter import (
    MAX_FILE_UPLOAD,
    MAX_MESSAGE,
    LarkAdapter,
    LarkConnectionConfig,
    _button_label,
)
from switch_core.bridges.collaboration.lark.client import LarkApiError, decrypt
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    position_action,
)

from .session_fixtures import _item, _turn, open_request

ENCRYPT_KEY = "test-encrypt-key"
VERIFICATION_TOKEN = "test-verification-token"
BOT_OPEN_ID = "ou_bot"
CHAT = "oc_chat"
ALICE = "ou_alice"

CONFIG = {
    "region": "lark",
    "app_id": "cli_test",
    "app_secret": "test-app-secret",
    "encrypt_key": ENCRYPT_KEY,
    "verification_token": VERIFICATION_TOKEN,
}


# ── A fake Lark ───────────────────────────────────────────────────────────────


class FakeLark:
    """Lark's API as far as the adapter uses it, recording every request."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.token_calls = 0
        self.next_id = 0
        self.routes: dict[
            tuple[str, str], Callable[[httpx.Request], httpx.Response]
        ] = {}
        self.names = {ALICE: "Alice"}
        self.chats: dict[str, dict[str, Any]] = {
            CHAT: {"chat_mode": "group", "chat_type": "private", "name": "Payments"}
        }
        self.files: dict[str, bytes] = {}
        self.titles: dict[str, str] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        route = self.routes.get((request.method, path))
        if route is not None:
            return route(request)
        if path == "/open-apis/auth/v3/tenant_access_token/internal":
            self.token_calls += 1
            return _ok(
                tenant_access_token=f"t-{self.token_calls}", expire=7200, top=True
            )
        if path == "/open-apis/bot/v3/info":
            return httpx.Response(
                200,
                json={"code": 0, "bot": {"open_id": BOT_OPEN_ID, "app_name": "Switch"}},
            )
        if path.startswith("/open-apis/contact/v3/users/"):
            open_id = path.rsplit("/", 1)[1]
            if open_id not in self.names:
                return _refused(41050, "no user authority")
            return _ok(user={"name": self.names[open_id]})
        if request.method == "GET" and path.startswith("/open-apis/im/v1/chats/"):
            return _ok(**self.chats[path.rsplit("/", 1)[1]])
        if request.method == "POST" and (
            path == "/open-apis/im/v1/messages" or path.endswith("/reply")
        ):
            self.next_id += 1
            message_id = f"om_{self.next_id}"
            body = json.loads(request.content)
            if body["msg_type"] == "post":
                self.titles[message_id] = json.loads(body["content"])["en_us"]["title"]
            return _ok(message_id=message_id)
        if request.method == "GET" and path.startswith("/open-apis/im/v1/messages/"):
            message_id = path.split("/")[5]
            if "/resources/" in path:
                return httpx.Response(200, content=self.files[path.rsplit("/", 1)[1]])
            content = json.dumps(
                {"title": self.titles.get(message_id, ""), "content": []}
            )
            return _ok(items=[{"body": {"content": content}}])
        if request.method in ("PUT", "PATCH", "DELETE"):
            return _ok()
        if path == "/open-apis/im/v1/images":
            return _ok(image_key="img_1")
        if path == "/open-apis/im/v1/files":
            return _ok(file_key="file_1")
        if path == "/open-apis/im/v1/chats":
            return _ok(chat_id="oc_new")
        raise AssertionError(f"unexpected {request.method} {path}")

    def sent(self) -> list[dict[str, Any]]:
        return [
            json.loads(r.content)
            for r in self.requests
            if r.method == "POST"
            and (
                r.url.path == "/open-apis/im/v1/messages"
                or r.url.path.endswith("/reply")
            )
        ]


def _ok(top: bool = False, **data: Any) -> httpx.Response:
    if top:
        return httpx.Response(200, json={"code": 0, "msg": "ok", **data})
    return httpx.Response(200, json={"code": 0, "msg": "ok", "data": data})


def _refused(code: int, msg: str) -> httpx.Response:
    return httpx.Response(200, json={"code": code, "msg": msg})


def _adapter(lark: FakeLark | None = None) -> tuple[LarkAdapter, FakeLark]:
    lark = lark or FakeLark()
    adapter = LarkAdapter(
        config=LarkConnectionConfig.model_validate(CONFIG),
        transport=httpx.MockTransport(lark),
    )
    return adapter, lark


class Inbox:
    def __init__(self) -> None:
        self.events: list[object] = []

    async def __call__(self, event: object) -> None:
        self.events.append(event)


async def _started(lark: FakeLark | None = None) -> tuple[LarkAdapter, FakeLark, Inbox]:
    adapter, lark = _adapter(lark)
    inbox = Inbox()
    await adapter.start(inbox, inbox, inbox, inbox, inbox)
    adapter.set_interaction_handler(inbox)
    return adapter, lark, inbox


# ── Deliveries, built the way Lark builds them ────────────────────────────────


def _encrypt(plaintext: bytes, key: str = ENCRYPT_KEY) -> str:
    iv = os.urandom(16)
    pad = 16 - len(plaintext) % 16
    encryptor = Cipher(
        algorithms.AES(hashlib.sha256(key.encode()).digest()), modes.CBC(iv)
    ).encryptor()
    sealed = encryptor.update(plaintext + bytes([pad]) * pad) + encryptor.finalize()
    return base64.b64encode(iv + sealed).decode()


def _event(
    event_type: str, event: dict[str, Any], event_id: str = "ev-1"
) -> dict[str, Any]:
    return {
        "schema": "2.0",
        "header": {
            "event_id": event_id,
            "event_type": event_type,
            "token": VERIFICATION_TOKEN,
            "create_time": "1700000000000",
            "app_id": "cli_test",
            "tenant_key": "tenant",
        },
        "event": event,
    }


def _delivery(
    payload: dict[str, Any],
    *,
    key: str = ENCRYPT_KEY,
    signed: bool = True,
    timestamp: int | None = None,
) -> WebhookRequest:
    body = json.dumps({"encrypt": _encrypt(json.dumps(payload).encode(), key)}).encode()
    headers: dict[str, str] = {}
    if signed:
        ts = str(int(time.time()) if timestamp is None else timestamp)
        nonce = "n0nce"
        headers = {
            "x-lark-request-timestamp": ts,
            "x-lark-request-nonce": nonce,
            "x-lark-signature": hashlib.sha256(
                (ts + nonce + key).encode() + body
            ).hexdigest(),
        }
    return WebhookRequest(method="POST", headers=headers, query={}, body=body)


def _message(
    text: str = "hello",
    *,
    kind: str = "text",
    content: dict[str, Any] | None = None,
    sender: str = ALICE,
    sender_type: str = "user",
    root_id: str | None = None,
    mentions: list[dict[str, Any]] | None = None,
    chat_type: str = "group",
) -> dict[str, Any]:
    return {
        "sender": {"sender_id": {"open_id": sender}, "sender_type": sender_type},
        "message": {
            "message_id": "om_in",
            "root_id": root_id,
            "chat_id": CHAT,
            "chat_type": chat_type,
            "message_type": kind,
            "content": json.dumps(content if content is not None else {"text": text}),
            "mentions": mentions or [],
        },
    }


async def _deliver(adapter: LarkAdapter, payload: dict[str, Any]) -> None:
    request = _delivery(payload)
    await adapter.verify_webhook(request)
    parsed = adapter.parse_webhook(request)
    await adapter.dispatch_event(
        envelope_type=parsed.envelope_type, payload=parsed.payload
    )


# ── Registration and config ───────────────────────────────────────────────────


def test_lark_is_registered() -> None:
    registration = next(p for p in PLATFORMS if p.key == "lark")
    assert registration.adapter is LarkAdapter
    assert LarkAdapter.icon_svg()
    assert LarkAdapter.receives_webhooks


def test_a_valid_config_parses_and_defaults_to_lark() -> None:
    config = LarkConnectionConfig.model_validate(
        {k: v for k, v in CONFIG.items() if k != "region"}
    )
    assert config.region == "lark"
    assert (
        LarkConnectionConfig.model_validate({**CONFIG, "region": "feishu"}).region
        == "feishu"
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("app_id", "   "),
        ("app_id", "app-123"),
        ("app_secret", ""),
        ("encrypt_key", ""),
        ("verification_token", " "),
        ("region", "mars"),
    ],
)
def test_an_unusable_config_is_refused(field: str, value: str) -> None:
    with pytest.raises(ValidationError):
        LarkConnectionConfig.model_validate({**CONFIG, field: value})


def test_every_secret_is_masked_on_the_connect_form() -> None:
    properties = LarkConnectionConfig.model_json_schema()["properties"]
    assert properties["encrypt_key"]["format"] == "password"
    # Masked by Console on their names.
    assert {"app_secret", "verification_token"} <= properties.keys()


def test_outbound_urls_name_the_regions_host() -> None:
    assert LarkAdapter.outbound_urls(CONFIG) == ["https://open.larksuite.com"]
    assert LarkAdapter.outbound_urls({**CONFIG, "region": "feishu"}) == [
        "https://open.feishu.cn"
    ]


async def test_verify_credentials_reports_lark_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lark = FakeLark()
    lark.routes[("POST", "/open-apis/auth/v3/tenant_access_token/internal")] = (
        lambda _r: _refused(10014, "app secret invalid")
    )
    original = httpx.AsyncClient.__init__

    def with_fake(self: httpx.AsyncClient, *a: Any, **k: Any) -> None:
        k["transport"] = httpx.MockTransport(lark)
        original(self, *a, **k)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", with_fake)
    with pytest.raises(BridgeCredentialError, match="app secret invalid"):
        await LarkAdapter.verify_credentials(CONFIG)


def test_failures_are_classified() -> None:
    assert (
        LarkAdapter.classify_failure(LarkApiError("x", code=10014, auth=True))
        == "auth_failed"
    )
    assert (
        LarkAdapter.classify_failure(LarkApiError("x", code=230001)) == "platform_error"
    )
    assert LarkAdapter.classify_failure(httpx.ConnectError("down")) == "network"
    assert LarkAdapter.classify_failure(ValueError("not ours")) is None


# ── Webhook authenticity ──────────────────────────────────────────────────────


async def test_a_signed_encrypted_event_is_accepted() -> None:
    adapter, _ = _adapter()
    await adapter.verify_webhook(_delivery(_event("im.message.receive_v1", _message())))


async def test_an_event_signed_with_another_key_is_refused() -> None:
    adapter, _ = _adapter()
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            _delivery(_event("im.message.receive_v1", _message()), key="another-key")
        )


async def test_a_tampered_body_is_refused() -> None:
    adapter, _ = _adapter()
    request = _delivery(_event("im.message.receive_v1", _message()))
    tampered = WebhookRequest(
        method="POST", headers=request.headers, query={}, body=request.body + b" "
    )
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(tampered)


@pytest.mark.parametrize("offset", [-9 * 3600, 600])
async def test_a_delivery_outside_its_time_window_is_refused(offset: int) -> None:
    adapter, _ = _adapter()
    with pytest.raises(WebhookAuthenticityError, match="time window"):
        await adapter.verify_webhook(
            _delivery(
                _event("im.message.receive_v1", _message()),
                timestamp=int(time.time()) + offset,
            )
        )


async def test_a_retry_hours_later_is_still_accepted() -> None:
    """Lark retries with the original timestamp; the receipt dedupes it."""
    adapter, _ = _adapter()
    await adapter.verify_webhook(
        _delivery(
            _event("im.message.receive_v1", _message()),
            timestamp=int(time.time()) - 6 * 3600,
        )
    )


async def test_the_address_check_is_answered_with_its_challenge() -> None:
    adapter, _ = _adapter()
    check = {
        "type": "url_verification",
        "challenge": "c-123",
        "token": VERIFICATION_TOKEN,
    }
    request = _delivery(check, signed=False)
    await adapter.verify_webhook(request)
    parsed = adapter.parse_webhook(request)
    assert parsed.handshake is not None
    assert json.loads(parsed.handshake) == {"challenge": "c-123"}
    assert parsed.external_event_id is None


async def test_an_address_check_with_the_wrong_token_is_refused() -> None:
    adapter, _ = _adapter()
    check = {"type": "url_verification", "challenge": "c", "token": "someone-else"}
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_delivery(check, signed=False))


async def test_an_unsigned_event_is_refused() -> None:
    adapter, _ = _adapter()
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            _delivery(_event("im.message.receive_v1", _message()), signed=False)
        )


async def test_an_unencrypted_unsigned_body_is_refused() -> None:
    adapter, _ = _adapter()
    body = json.dumps(
        {"type": "url_verification", "challenge": "c", "token": VERIFICATION_TOKEN}
    )
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            WebhookRequest(method="POST", headers={}, query={}, body=body.encode())
        )


async def test_a_get_is_refused() -> None:
    adapter, _ = _adapter()
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            WebhookRequest(method="GET", headers={}, query={}, body=b"")
        )


def test_a_malformed_body_is_refused() -> None:
    adapter, _ = _adapter()
    with pytest.raises(WebhookPayloadError):
        adapter.parse_webhook(
            WebhookRequest(method="POST", headers={}, query={}, body=b"{oops")
        )


def test_a_v1_event_is_refused() -> None:
    adapter, _ = _adapter()
    with pytest.raises(WebhookPayloadError, match="2.0"):
        adapter.parse_webhook(_delivery({"uuid": "u", "event": {"type": "message"}}))


def test_an_event_without_this_apps_token_is_refused() -> None:
    adapter, _ = _adapter()
    payload = _event("im.message.receive_v1", _message())
    payload["header"]["token"] = "someone-else"
    with pytest.raises(WebhookPayloadError, match="Verification Token"):
        adapter.parse_webhook(_delivery(payload))


def test_a_retried_delivery_carries_the_same_event_id() -> None:
    adapter, _ = _adapter()
    payload = _event("im.message.receive_v1", _message(), event_id="ev-42")
    first = adapter.parse_webhook(_delivery(payload))
    retry = adapter.parse_webhook(_delivery(payload))
    assert first.external_event_id == retry.external_event_id == "ev-42"
    assert first.envelope_type == "im.message.receive_v1"
    assert not first.answers_inline


def test_decrypt_refuses_a_ciphertext_under_another_key() -> None:
    sealed = _encrypt(b'{"a": 1}', "right-key")
    assert decrypt(sealed, "right-key") == b'{"a": 1}'
    with pytest.raises(ValueError):
        decrypt(sealed, "wrong-key")


# ── Inbound ───────────────────────────────────────────────────────────────────


async def test_a_message_reaches_the_room_with_names_and_thread() -> None:
    adapter, _, inbox = await _started()
    payload = _message(
        "@_user_1 please review",
        root_id="om_root",
        mentions=[{"key": "@_user_1", "id": {"open_id": "ou_bob"}, "name": "Bob"}],
    )
    await _deliver(adapter, _event("im.message.receive_v1", payload))

    [message] = inbox.events
    assert isinstance(message, InboundMessage)
    assert message.content == "@Bob please review"
    assert message.sender_id == ALICE
    assert message.sender_name == "Alice"
    assert message.channel_id == CHAT
    assert message.channel_type == "channel_private"
    assert message.channel_name == "Payments"
    assert message.root_id == "om_root"
    assert message.message_ref == "om_in"
    assert message.self_mention_token is None
    assert not message.sender_is_app


async def test_a_mention_of_the_bot_is_flagged() -> None:
    adapter, _, inbox = await _started()
    payload = _message(
        "@_user_1 hi",
        mentions=[
            {"key": "@_user_1", "id": {"open_id": BOT_OPEN_ID}, "name": "Switch"}
        ],
    )
    await _deliver(adapter, _event("im.message.receive_v1", payload))
    [message] = inbox.events
    assert isinstance(message, InboundMessage)
    assert message.self_mention_token == BOT_OPEN_ID


async def test_a_direct_chat_is_direct_without_a_lookup() -> None:
    adapter, lark, inbox = await _started()
    await _deliver(adapter, _event("im.message.receive_v1", _message(chat_type="p2p")))
    [message] = inbox.events
    assert isinstance(message, InboundMessage)
    assert message.channel_type == "direct"
    assert not any("/im/v1/chats/" in r.url.path for r in lark.requests)


async def test_the_bots_own_message_is_ignored() -> None:
    adapter, _, inbox = await _started()
    await _deliver(
        adapter, _event("im.message.receive_v1", _message(sender=BOT_OPEN_ID))
    )
    assert inbox.events == []


async def test_another_apps_message_is_relayed_as_an_app() -> None:
    adapter, lark, inbox = await _started()
    lark.names["ou_app"] = "Datadog"
    await _deliver(
        adapter,
        _event("im.message.receive_v1", _message(sender="ou_app", sender_type="app")),
    )
    [message] = inbox.events
    assert isinstance(message, InboundMessage)
    assert message.sender_is_app


async def test_a_name_lark_will_not_give_falls_back_to_the_id() -> None:
    adapter, _, inbox = await _started()
    await _deliver(
        adapter, _event("im.message.receive_v1", _message(sender="ou_stranger"))
    )
    [message] = inbox.events
    assert isinstance(message, InboundMessage)
    assert message.sender_name == "ou_stranger"


async def test_names_are_looked_up_once() -> None:
    adapter, lark, _ = await _started()
    for n in range(3):
        await _deliver(
            adapter, _event("im.message.receive_v1", _message(), event_id=f"e{n}")
        )
    lookups = [r for r in lark.requests if r.url.path.startswith("/open-apis/contact/")]
    assert len(lookups) == 1


async def test_a_bang_command_is_a_command() -> None:
    adapter, _, inbox = await _started()
    await _deliver(
        adapter, _event("im.message.receive_v1", _message("!reset @helper now"))
    )
    [command] = inbox.events
    assert isinstance(command, InboundCommand)
    assert command.command == "reset"
    assert command.args == "@helper now"
    assert command.message_ref == "om_in"


async def test_a_post_is_read_as_markdown() -> None:
    adapter, _, inbox = await _started()
    post = {
        "title": "Deploy",
        "content": [
            [
                {"tag": "text", "text": "see "},
                {"tag": "a", "text": "the log", "href": "https://example.com/log"},
                {"tag": "text", "text": " "},
                {"tag": "at", "user_id": "ou_bob", "user_name": "Bob"},
            ],
            [{"tag": "code_block", "language": "bash", "text": "make deploy"}],
        ],
    }
    await _deliver(
        adapter, _event("im.message.receive_v1", _message(kind="post", content=post))
    )
    [message] = inbox.events
    assert isinstance(message, InboundMessage)
    assert message.content.startswith(
        "**Deploy**\nsee [the log](https://example.com/log) @Bob"
    )
    assert "```bash\nmake deploy\n```" in message.content


async def test_an_image_is_downloaded_as_an_attachment() -> None:
    adapter, lark, inbox = await _started()
    lark.files["img_k"] = b"\x89PNG..."
    await _deliver(
        adapter,
        _event(
            "im.message.receive_v1",
            _message(kind="image", content={"image_key": "img_k"}),
        ),
    )
    [message] = inbox.events
    assert isinstance(message, InboundMessage)
    [attachment] = message.attachments
    assert attachment.data == b"\x89PNG..."
    assert attachment.mimetype == "image/png"
    download = next(r for r in lark.requests if "/resources/" in r.url.path)
    assert download.url.path == "/open-apis/im/v1/messages/om_in/resources/img_k"
    assert download.url.params["type"] == "image"


async def test_an_oversized_file_is_disclosed_not_dropped() -> None:
    adapter, lark, inbox = await _started()
    adapter.set_max_attachment_bytes(10)
    lark.files["file_k"] = b"x" * 100
    await _deliver(
        adapter,
        _event(
            "im.message.receive_v1",
            _message(
                kind="file", content={"file_key": "file_k", "file_name": "big.zip"}
            ),
        ),
    )
    [message] = inbox.events
    assert isinstance(message, InboundMessage)
    assert message.attachments == []
    [failure] = message.attachment_failures
    assert failure.filename == "big.zip"
    assert "limit" in failure.reason


async def test_a_sticker_is_said_rather_than_empty() -> None:
    adapter, _, inbox = await _started()
    await _deliver(
        adapter,
        _event(
            "im.message.receive_v1", _message(kind="sticker", content={"file_key": "s"})
        ),
    )
    [message] = inbox.events
    assert isinstance(message, InboundMessage)
    assert message.content == "_[sticker message]_"


async def test_the_bot_joining_a_chat_creates_its_room() -> None:
    adapter, _, inbox = await _started()
    await _deliver(
        adapter,
        _event("im.chat.member.bot.added_v1", {"chat_id": CHAT, "name": "Payments"}),
    )
    [join] = inbox.events
    assert join == InboundAppJoin(
        channel_id=CHAT, channel_type="channel_private", channel_name="Payments"
    )


async def test_people_joining_a_chat_are_reported() -> None:
    adapter, _, inbox = await _started()
    await _deliver(
        adapter,
        _event(
            "im.chat.member.user.added_v1",
            {
                "chat_id": CHAT,
                "users": [{"name": "Carol", "user_id": {"open_id": "ou_carol"}}],
            },
        ),
    )
    [join] = inbox.events
    assert isinstance(join, InboundUserJoin)
    assert join.external_user_id == "ou_carol"
    assert join.external_username == "Carol"


async def test_a_press_on_a_card_button_is_an_interaction() -> None:
    adapter, _, inbox = await _started()
    await _deliver(
        adapter,
        _event(
            "card.action.trigger",
            {
                "operator": {"open_id": ALICE},
                "action": {
                    "tag": "button",
                    "value": {"switch_token": "tok-1", "switch_position": 2},
                },
                "context": {"open_message_id": "om_card", "open_chat_id": CHAT},
            },
        ),
    )
    [press] = inbox.events
    assert press == InboundInteraction(
        channel_id=CHAT,
        sender_id=ALICE,
        sender_name="Alice",
        action_id=position_action(2),
        value="tok-1",
        message_ref="om_card",
    )


async def test_a_press_on_someone_elses_card_is_ignored() -> None:
    adapter, _, inbox = await _started()
    await _deliver(
        adapter,
        _event(
            "card.action.trigger",
            {
                "operator": {"open_id": ALICE},
                "action": {"tag": "button", "value": {"anything": "else"}},
                "context": {"open_message_id": "om_card", "open_chat_id": CHAT},
            },
        ),
    )
    assert inbox.events == []


async def test_an_unknown_event_is_ignored() -> None:
    adapter, _, inbox = await _started()
    await _deliver(adapter, _event("im.message.reaction.created_v1", {}))
    assert inbox.events == []


# ── Outbound ──────────────────────────────────────────────────────────────────


async def test_a_message_is_posted_under_the_agents_name() -> None:
    adapter, lark, _ = await _started()
    ref = await adapter.send_message(CHAT, "helper", "**done**")
    assert ref == "om_1"
    [request] = [r for r in lark.requests if r.url.path == "/open-apis/im/v1/messages"]
    assert request.url.params["receive_id_type"] == "chat_id"
    assert request.headers["authorization"] == "Bearer t-1"
    body = json.loads(request.content)
    assert body["receive_id"] == CHAT
    assert body["msg_type"] == "post"
    assert body["uuid"]
    assert json.loads(body["content"]) == {
        "en_us": {"title": "helper", "content": [[{"tag": "md", "text": "**done**"}]]}
    }


async def test_a_reply_stays_in_its_thread() -> None:
    adapter, lark, _ = await _started()
    await adapter.send_message(CHAT, "helper", "on it", thread_root_id="om_root")
    [body] = lark.sent()
    assert lark.requests[-1].url.path == "/open-apis/im/v1/messages/om_root/reply"
    assert body["reply_in_thread"] is True


async def test_a_long_reply_is_split_and_the_first_piece_is_its_ref() -> None:
    adapter, lark, _ = await _started()
    ref = await adapter.send_message(CHAT, "helper", ("word " * 400 + "\n") * 6)
    sent = lark.sent()
    assert len(sent) > 1
    assert ref == "om_1"
    for body in sent:
        assert (
            len(json.loads(body["content"])["en_us"]["content"][0][0]["text"])
            <= MAX_MESSAGE
        )


async def test_a_refused_send_returns_none() -> None:
    adapter, lark, _ = await _started()
    lark.routes[("POST", "/open-apis/im/v1/messages")] = lambda _r: _refused(
        230002, "bot not in chat"
    )
    assert await adapter.send_message(CHAT, "helper", "hi") is None


async def test_a_lost_answer_is_retried_with_the_same_idempotency_key() -> None:
    adapter, lark, _ = await _started()
    attempts: list[dict[str, Any]] = []

    def flaky(request: httpx.Request) -> httpx.Response:
        attempts.append(json.loads(request.content))
        if len(attempts) == 1:
            raise httpx.ReadTimeout("lost")
        return _ok(message_id="om_9")

    lark.routes[("POST", "/open-apis/im/v1/messages")] = flaky
    assert await adapter.send_message(CHAT, "helper", "hi") == "om_9"
    assert len(attempts) == 2
    assert attempts[0]["uuid"] == attempts[1]["uuid"]


async def test_an_expired_token_is_renewed_and_the_call_made_again() -> None:
    adapter, lark, _ = await _started()
    calls = 0

    def expired_once(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return _refused(99991663, "tenant access token invalid")
        assert request.headers["authorization"] == "Bearer t-2"
        return _ok(message_id="om_5")

    lark.routes[("POST", "/open-apis/im/v1/messages")] = expired_once
    assert await adapter.send_message(CHAT, "helper", "hi") == "om_5"
    assert lark.token_calls == 2


async def test_an_edit_keeps_the_agents_title() -> None:
    adapter, lark, _ = await _started()
    ref = await adapter.send_message(CHAT, "helper", "draft")
    assert ref is not None
    await adapter.update_message(CHAT, ref, "final")
    put = next(r for r in lark.requests if r.method == "PUT")
    assert put.url.path == f"/open-apis/im/v1/messages/{ref}"
    content = json.loads(json.loads(put.content)["content"])
    assert content["en_us"]["title"] == "helper"
    assert content["en_us"]["content"] == [[{"tag": "md", "text": "final"}]]


async def test_a_delete_reaches_lark() -> None:
    adapter, lark, _ = await _started()
    await adapter.delete_message(CHAT, "om_7")
    assert lark.requests[-1].method == "DELETE"
    assert lark.requests[-1].url.path == "/open-apis/im/v1/messages/om_7"


async def test_an_image_is_uploaded_and_posted_under_the_agents_line() -> None:
    adapter, lark, _ = await _started()
    ref = await adapter.send_attachment(
        CHAT, "helper", "chart.png", "image/png", b"png"
    )
    sent = lark.sent()
    assert [b["msg_type"] for b in sent] == ["post", "image"]
    assert json.loads(sent[1]["content"]) == {"image_key": "img_1"}
    assert ref == "om_1"
    upload = next(r for r in lark.requests if r.url.path == "/open-apis/im/v1/images")
    assert b'name="image_type"' in upload.content


async def test_a_file_is_uploaded_with_its_type() -> None:
    adapter, lark, _ = await _started()
    await adapter.send_attachment(
        CHAT, "helper", "report.pdf", "application/pdf", b"%PDF"
    )
    upload = next(r for r in lark.requests if r.url.path == "/open-apis/im/v1/files")
    assert b"pdf" in upload.content
    assert lark.sent()[-1]["msg_type"] == "file"


async def test_a_file_over_larks_limit_is_refused_in_the_chat() -> None:
    adapter, lark, _ = await _started()
    await adapter.send_attachment(
        CHAT,
        "helper",
        "huge.bin",
        "application/octet-stream",
        b"x" * (MAX_FILE_UPLOAD + 1),
    )
    assert not any(r.url.path == "/open-apis/im/v1/files" for r in lark.requests)
    [body] = lark.sent()
    assert (
        "Could not send huge.bin"
        in json.loads(body["content"])["en_us"]["content"][0][0]["text"]
    )


# ── Request cards ─────────────────────────────────────────────────────────────


def _card(**kwargs: Any) -> RequestCard:
    return RequestCard(
        open_request(), RequestReference(token="tok-1", handle="R7"), **kwargs
    )


def _drawn(body: dict[str, Any]) -> dict[str, Any]:
    return json.loads(body["content"])


async def test_an_open_request_is_a_card_with_a_button_per_option() -> None:
    adapter, lark, _ = await _started()
    ref = await adapter.post_rich(CHAT, "helper", _card(), thread_root_id="om_root")
    assert ref == "om_1"
    [body] = lark.sent()
    assert body["msg_type"] == "interactive"
    card = _drawn(body)
    assert card["config"]["update_multi"] is True
    assert card["header"]["title"]["content"] == "helper"
    [markdown, actions] = card["elements"]
    assert markdown["tag"] == "markdown" and markdown["content"]
    values = [button["value"] for button in actions["actions"]]
    assert values and all(v["switch_token"] == "tok-1" for v in values)
    assert [v["switch_position"] for v in values] == list(range(1, len(values) + 1))


async def test_a_settled_request_has_no_buttons() -> None:
    adapter, lark, _ = await _started()
    settled = RequestCard(
        open_request().model_copy(update={"state": "submitting"}),
        RequestReference(token="tok-1", handle="R7"),
    )
    await adapter.update_rich(CHAT, "helper", "om_card", settled, None)
    patch = next(r for r in lark.requests if r.method == "PATCH")
    assert patch.url.path == "/open-apis/im/v1/messages/om_card"
    card = json.loads(json.loads(patch.content)["content"])
    assert [e["tag"] for e in card["elements"]] == ["markdown"]


async def test_a_refused_card_is_reported_for_the_fallback() -> None:
    adapter, lark, _ = await _started()
    lark.routes[("POST", "/open-apis/im/v1/messages")] = lambda _r: _refused(
        230099, "card invalid"
    )
    with pytest.raises(RichContentFailed):
        await adapter.post_rich(CHAT, "helper", _card())


# ── Chats ─────────────────────────────────────────────────────────────────────


async def test_a_channel_is_created_as_a_group_chat() -> None:
    adapter, lark, _ = await _started()
    chat_id = await adapter.create_channel(
        "payments", "Card payments", channel_type="channel_private"
    )
    assert chat_id == "oc_new"
    body = json.loads(lark.requests[-1].content)
    assert body == {
        "name": "payments",
        "description": "Card payments",
        "chat_mode": "group",
        "chat_type": "private",
    }
    assert await adapter.get_channel_type("oc_new") == "channel_private"


async def test_a_direct_chat_cannot_be_created() -> None:
    adapter, _, _ = await _started()
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("dm", "", channel_type="direct")


async def test_a_refused_channel_carries_larks_reason() -> None:
    adapter, lark, _ = await _started()
    lark.routes[("POST", "/open-apis/im/v1/chats")] = lambda _r: _refused(
        232025, "no permission"
    )
    with pytest.raises(BridgeOperationError, match="no permission"):
        await adapter.create_channel("x", "y")


async def test_people_lark_will_not_add_are_handed_back() -> None:
    adapter, lark, _ = await _started()
    lark.routes[("POST", f"/open-apis/im/v1/chats/{CHAT}/members")] = lambda _r: _ok(
        invalid_id_list=["ou_guest"]
    )
    left_out = await adapter.add_users_to_channel(
        CHAT, ["Alice", "Guest"], [ALICE, "ou_guest"]
    )
    assert left_out == ["ou_guest"]


async def test_deleting_a_room_takes_the_bot_out_of_the_chat() -> None:
    adapter, lark, _ = await _started()
    outcome = await adapter.retire_channel(CHAT)
    assert outcome.outcome == "left"
    request = lark.requests[-1]
    assert request.method == "DELETE"
    assert request.url.params["member_id_type"] == "app_id"
    assert json.loads(request.content) == {"id_list": ["cli_test"]}


async def test_a_chat_link_opens_lark() -> None:
    adapter, _ = _adapter()
    link = await adapter.channel_deeplink(CHAT)
    assert link == f"https://applink.larksuite.com/client/chat/open?openChatId={CHAT}"


# ── Turn activity ─────────────────────────────────────────────────────────────


def test_lark_draws_session_activity() -> None:
    assert LarkAdapter.draws_session_activity


async def test_a_turn_is_posted_under_the_agent_and_redrawn_in_place() -> None:
    adapter, lark, _ = await _started()
    running = TurnActivity(
        [_item(kind="assistant-message", title="", text="Looking into it")],
        _turn("running"),
    )
    ref = await adapter.post_rich(CHAT, "helper", running, thread_root_id="om_root")
    [posted] = lark.sent()
    assert posted["msg_type"] == "post"
    assert json.loads(posted["content"])["en_us"]["title"] == "helper"

    done = TurnActivity(
        [_item(kind="assistant-message", title="", text="Fixed")], _turn("completed")
    )
    await adapter.update_rich(CHAT, "helper", ref, done, "om_root")
    put = next(r for r in lark.requests if r.method == "PUT")
    assert put.url.path == f"/open-apis/im/v1/messages/{ref}"
    content = json.loads(json.loads(put.content)["content"])
    assert content["en_us"]["title"] == "helper"
    # The redraw names its agent without reading the message back.
    assert not any(
        r.method == "GET" and r.url.path.endswith(ref) for r in lark.requests
    )


async def test_a_refused_redraw_is_reported() -> None:
    adapter, lark, _ = await _started()
    lark.routes[("PUT", "/open-apis/im/v1/messages/om_1")] = lambda _r: _refused(
        230001, "too old"
    )
    with pytest.raises(RichContentFailed):
        await adapter.update_rich(
            CHAT, "helper", "om_1", TurnActivity([], _turn("completed")), None
        )


def test_a_long_option_is_clipped_on_its_button() -> None:
    assert _button_label(2, "Decline") == "2. Decline"
    clipped = _button_label(1, "Approve running the migration against production " * 3)
    assert (
        len(clipped) <= 40
        and clipped.startswith("1. Approve")
        and clipped.endswith("…")
    )
    assert _button_label(3, "  ") == "3. Option 3"
