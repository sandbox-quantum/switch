"""The Lark adapter against a stand-in for Lark's open platform.

Lark's API is mocked at the transport, and its long connection at the frame:
what the adapter is handed is what Lark sends, and what it sends back is
read off the wire.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import RequestCard
from switch_core.bridges.collaboration.lark.adapter import (
    LarkAdapter,
    LarkConnectionConfig,
)
from switch_core.bridges.collaboration.lark.client import (
    ACK,
    LarkApi,
    LarkApiError,
    LarkCredentialsRefused,
    LarkDisconnected,
    LarkSocket,
)
from switch_core.bridges.collaboration.lark.markup import (
    chunk,
    from_post,
    from_text,
    to_lark,
)
from switch_core.bridges.collaboration.lark.protocol import (
    DATA,
    Frame,
    FrameError,
    acknowledge,
    decode,
    encode,
    ping,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    parse_answer_position,
)

from .session_fixtures import open_request

APP_ID = "cli_a1b2c3d4e5f6a7b8"
BOT = "ou_bot00000000000000000000000000000"
ADA = "ou_ada00000000000000000000000000000"
CHAT = "oc_chat0000000000000000000000000000"
HOST = "https://open.larksuite.com"


class FakeLark:
    """Lark's open platform, answering what the adapter calls and keeping it."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.secret = "right-secret"
        self.chat_type = "private"
        self.files: dict[str, bytes] = {"img_1": b"\x89PNG\r\n\x1a\nimage"}
        self.title = "coder"

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body: Any = None
        if request.content and request.headers.get("content-type", "").startswith(
            "application/json"
        ):
            body = json.loads(request.content)
        self.calls.append((request.method, path, body))
        if path == "/open-apis/auth/v3/tenant_access_token/internal":
            if body["app_secret"] != self.secret:
                return httpx.Response(
                    200, json={"code": 10014, "msg": "app secret invalid"}
                )
            return httpx.Response(
                200, json={"code": 0, "tenant_access_token": "t-1", "expire": 7200}
            )
        if request.headers.get("authorization") != "Bearer t-1":
            return httpx.Response(200, json={"code": 99991663, "msg": "token invalid"})
        if path == "/open-apis/bot/v3/info":
            return httpx.Response(
                200, json={"code": 0, "bot": {"open_id": BOT, "app_name": "Switch Dev"}}
            )
        if path == f"/open-apis/im/v1/chats/{CHAT}":
            return _ok(
                {
                    "chat_mode": "group",
                    "chat_type": self.chat_type,
                    "name": "switch-test",
                }
            )
        if path == f"/open-apis/contact/v3/users/{ADA}":
            return _ok({"user": {"name": "Ada Lovelace"}})
        if path.startswith("/open-apis/im/v1/messages/om_1/resources/"):
            key = path.rsplit("/", 1)[-1]
            return httpx.Response(200, content=self.files[key])
        if path == "/open-apis/im/v1/messages" and request.method == "POST":
            return _ok({"message_id": f"om_out{len(self.calls)}"})
        if path.endswith("/reply"):
            return _ok({"message_id": f"om_reply{len(self.calls)}"})
        if path == "/open-apis/im/v1/messages/om_out" and request.method == "GET":
            post = {"title": self.title, "content": [[{"tag": "md", "text": "old"}]]}
            return _ok({"items": [{"body": {"content": json.dumps(post)}}]})
        if path.startswith("/open-apis/im/v1/messages/") and request.method in (
            "PUT",
            "PATCH",
            "DELETE",
        ):
            return _ok({})
        if path == f"/open-apis/im/v1/chats/{CHAT}/members":
            return _ok({})
        if path == "/open-apis/im/v1/chats" and request.method == "POST":
            # Lark keeps a name cut to 60 characters, and says which it kept.
            return _ok(
                {"chat_id": "oc_new00000000000000000000000000000", "name": body["name"]}
            )
        return httpx.Response(404, json={"code": 404, "msg": f"no fake for {path}"})


def _ok(data: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json={"code": 0, "msg": "success", "data": data})


def _config(**overrides: Any) -> LarkConnectionConfig:
    return LarkConnectionConfig(
        **{"app_id": APP_ID, "app_secret": "right-secret", **overrides}
    )


@pytest.fixture
def lark() -> FakeLark:
    return FakeLark()


@pytest.fixture
async def adapter(lark: FakeLark) -> LarkAdapter:
    adapter = LarkAdapter(config=_config())
    adapter._api = LarkApi(
        host=HOST, app_id=APP_ID, app_secret="right-secret", http=lark.client()
    )
    received: list[Any] = []

    async def keep(item: Any) -> None:
        received.append(item)

    adapter.set_listening(False)
    await adapter.start(keep, keep, keep, keep, keep)
    adapter.set_interaction_handler(keep)
    adapter.received = received  # type: ignore[attr-defined]
    return adapter


def _message(text: str, **fields: Any) -> dict[str, Any]:
    message = {
        "chat_id": CHAT,
        "chat_type": "group",
        "message_id": "om_1",
        "message_type": "text",
        "content": json.dumps({"text": text}),
        "mentions": [],
        **fields,
    }
    return {
        "schema": "2.0",
        "header": {"event_id": "ev-1", "event_type": "im.message.receive_v1"},
        "event": {
            "message": message,
            "sender": {"sender_id": {"open_id": ADA}, "sender_type": "user"},
        },
    }


BOT_MENTION = {"key": "@_user_1", "id": {"open_id": BOT}, "name": "Switch Dev"}


# ── Config ───────────────────────────────────────────────────────────────────


def test_a_config_takes_lark_or_feishu() -> None:
    assert _config().host == "https://open.larksuite.com"
    assert _config(region="feishu").host == "https://open.feishu.cn"
    assert _config(app_id=f"  {APP_ID} ").app_id == APP_ID


@pytest.mark.parametrize(
    ("field", "value", "says"),
    [
        ("app_id", "a1b2c3", "starts with cli_"),
        ("app_secret", "   ", "App Secret"),
        ("region", "china", "lark"),
    ],
)
def test_a_config_it_cannot_use_is_refused(field: str, value: str, says: str) -> None:
    with pytest.raises(ValidationError, match=says):
        _config(**{field: value})


def test_one_bridge_per_app() -> None:
    assert LarkAdapter.claimed_workspace({"app_id": APP_ID}) == f"lark lark {APP_ID}"
    assert LarkAdapter.outbound_urls({"region": "feishu"}) == ["https://open.feishu.cn"]


async def test_wrong_credentials_are_refused_with_larks_words(
    lark: FakeLark, monkeypatch: pytest.MonkeyPatch
) -> None:
    lark.secret = "another"
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.lark.adapter.LarkApi",
        lambda **kwargs: LarkApi(**kwargs, http=lark.client()),
    )
    with pytest.raises(BridgeCredentialError, match="app secret invalid"):
        await LarkAdapter.verify_credentials({"app_id": APP_ID, "app_secret": "x"})


def test_failures_are_classified() -> None:
    assert LarkAdapter.classify_failure(LarkCredentialsRefused("no")) == "auth_failed"
    assert (
        LarkAdapter.classify_failure(LarkApiError(230002, "no", status=400))
        == "platform_error"
    )
    assert LarkAdapter.classify_failure(LarkDisconnected("gone")) == "network"
    assert LarkAdapter.classify_failure(httpx.ConnectError("down")) == "network"
    assert LarkAdapter.classify_failure(ValueError("other")) is None


# ── The long connection ──────────────────────────────────────────────────────


def test_a_frame_survives_the_wire() -> None:
    frame = Frame(
        seq_id=7,
        log_id=2**40,
        service=12,
        method=DATA,
        headers=[("type", "event"), ("message_id", "m1")],
        payload=b'{"a": 1}',
    )
    assert decode(encode(frame)) == frame


def test_a_ping_and_an_acknowledgement() -> None:
    assert decode(encode(ping(5))).headers == [("type", "ping")]
    frame = Frame(seq_id=3, service=5, method=DATA, headers=[("type", "event")])
    answer = decode(encode(acknowledge(frame, ACK)))
    assert (answer.seq_id, answer.method, answer.payload) == (3, DATA, ACK)
    assert answer.header("biz_rt") is not None


def test_a_frame_cut_short_is_refused() -> None:
    with pytest.raises(FrameError):
        decode(encode(Frame(payload=b"x" * 20))[:-5])


async def test_a_split_event_is_handled_once_whole() -> None:
    handled: list[dict[str, Any]] = []

    async def handler(kind: str, body: dict[str, Any]) -> bytes:
        handled.append(body)
        return ACK

    socket = LarkSocket(
        LarkApi(host=HOST, app_id=APP_ID, app_secret="s"), handler, name="t"
    )
    body = json.dumps({"header": {"event_type": "x"}}).encode()
    parts = [body[:10], body[10:]]

    def part(seq: int) -> Frame:
        return Frame(
            method=DATA,
            headers=[
                ("type", "event"),
                ("message_id", "m"),
                ("sum", "2"),
                ("seq", str(seq)),
            ],
            payload=parts[seq],
        )

    assert await socket._on_data(part(1)) is None
    assert await socket._on_data(part(0)) == ACK
    assert handled == [{"header": {"event_type": "x"}}]


# ── Inbound ──────────────────────────────────────────────────────────────────


async def test_a_message_reaches_the_room(adapter: LarkAdapter) -> None:
    await adapter._on_push(
        "event",
        _message("@_user_1 hello", mentions=[BOT_MENTION], root_id="om_root"),
    )
    [message] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(message, InboundMessage)
    assert message.content == "@Switch Dev hello"
    assert (message.channel_id, message.channel_type) == (CHAT, "channel_private")
    assert (message.sender_id, message.sender_name) == (ADA, "Ada Lovelace")
    assert (message.message_ref, message.root_id) == ("om_1", "om_root")
    assert message.channel_name == "switch-test"
    assert message.self_mention_token == BOT


async def test_a_public_group_and_a_direct_chat(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    lark.chat_type = "public"
    assert await adapter.get_channel_type(CHAT) == "channel_public"
    await adapter._on_push("event", _message("hi", chat_type="p2p"))
    [message] = adapter.received  # type: ignore[attr-defined]
    assert message.channel_type == "direct"
    assert message.self_mention_token is None


async def test_the_bots_own_message_is_ignored(adapter: LarkAdapter) -> None:
    body = _message("echo")
    body["event"]["sender"]["sender_id"]["open_id"] = BOT
    await adapter._on_push("event", body)
    assert adapter.received == []  # type: ignore[attr-defined]


@pytest.mark.parametrize("text", ["!help me", "@_user_1 !help me"])
async def test_a_bang_command(adapter: LarkAdapter, text: str) -> None:
    await adapter._on_push("event", _message(text, mentions=[BOT_MENTION]))
    [command] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(command, InboundCommand)
    assert (command.command, command.args, command.message_ref) == (
        "help",
        "me",
        "om_1",
    )


async def test_an_image_comes_as_an_attachment(adapter: LarkAdapter) -> None:
    body = _message(
        "", message_type="image", content=json.dumps({"image_key": "img_1"})
    )
    await adapter._on_push("event", body)
    [message] = adapter.received  # type: ignore[attr-defined]
    [attachment] = message.attachments
    assert (attachment.mimetype, attachment.data[:4]) == ("image/png", b"\x89PNG")
    assert attachment.filename.endswith(".png")


async def test_an_oversized_file_is_refused_visibly(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    lark.files["img_1"] = b"x" * 64
    adapter.set_max_attachment_bytes(32)
    body = _message(
        "", message_type="image", content=json.dumps({"image_key": "img_1"})
    )
    await adapter._on_push("event", body)
    [message] = adapter.received  # type: ignore[attr-defined]
    assert message.attachments == []
    [failure] = message.attachment_failures
    assert "larger than" in failure.reason


async def test_a_card_press_is_an_interaction(adapter: LarkAdapter) -> None:
    await adapter._on_push(
        "card",
        {
            "schema": "2.0",
            "header": {"event_type": "card.action.trigger"},
            "event": {
                "operator": {"open_id": ADA},
                "action": {
                    "value": {"switch_action": "switch:answer:2", "switch_value": "tok"}
                },
                "context": {"open_chat_id": CHAT, "open_message_id": "om_card"},
            },
        },
    )
    [press] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(press, InboundInteraction)
    assert (
        press.channel_id,
        press.sender_id,
        press.sender_name,
        press.sender_display_name,
    ) == (CHAT, ADA, "Ada Lovelace", "Ada Lovelace")
    assert (press.action_id, press.value, press.message_ref) == (
        "switch:answer:2",
        "tok",
        "om_card",
    )


async def test_an_event_that_fails_is_still_acknowledged(adapter: LarkAdapter) -> None:
    body = _message("hi")
    body["event"]["message"]["content"] = "{not json"
    assert await adapter._on_push("event", body) == ACK


# ── Outbound ─────────────────────────────────────────────────────────────────


def _sent(lark: FakeLark, method: str, suffix: str) -> list[Any]:
    return [
        body for m, path, body in lark.calls if m == method and path.endswith(suffix)
    ]


async def test_a_reply_is_a_post_titled_with_the_agent(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    ref = await adapter.send_message(
        CHAT, "coder", adapter.translate_outbound("**done**")
    )
    assert ref and ref.startswith("om_out")
    [body] = _sent(lark, "POST", "/im/v1/messages")
    assert (body["receive_id"], body["msg_type"]) == (CHAT, "post")
    post = json.loads(body["content"])["en_us"]
    assert post["title"] == "coder"
    assert post["content"] == [[{"tag": "md", "text": "**done**"}]]


async def test_a_reply_in_a_thread_stays_in_it(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    await adapter.send_message(CHAT, "coder", "ok", "om_root")
    [body] = _sent(lark, "POST", "/im/v1/messages/om_root/reply")
    assert body["reply_in_thread"] is True


async def test_a_long_reply_is_split_in_order(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    text = "\n\n".join(f"paragraph {n} " + "x" * 900 for n in range(9))
    await adapter.send_message(CHAT, "coder", text)
    bodies = _sent(lark, "POST", "/im/v1/messages")
    texts = [json.loads(b["content"])["en_us"]["content"][0][0]["text"] for b in bodies]
    assert len(texts) > 1 and all(len(t) <= 4000 for t in texts)
    assert "".join(texts).replace("\n", "") == text.replace("\n", "")


async def test_an_edit_keeps_the_title_and_a_delete_recalls(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    await adapter.update_message(CHAT, "om_out", "new words")
    [body] = _sent(lark, "PUT", "/im/v1/messages/om_out")
    post = json.loads(body["content"])["en_us"]
    assert (post["title"], post["content"][0][0]["text"]) == ("coder", "new words")
    await adapter.delete_message(CHAT, "om_out")
    assert ("DELETE", "/open-apis/im/v1/messages/om_out", None) in lark.calls


async def test_a_file_too_big_for_lark_is_named_in_the_chat(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    await adapter.send_attachment(
        CHAT, "coder", "big.zip", "application/zip", b"x" * (31 << 20)
    )
    assert not [c for c in lark.calls if c[1].endswith("/im/v1/files")]
    [body] = _sent(lark, "POST", "/im/v1/messages")
    assert (
        "couldn't send big.zip"
        in json.loads(body["content"])["en_us"]["content"][0][0]["text"]
    )


async def test_a_request_card_has_a_button_per_option(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    card = open_request()
    await adapter.post_rich(
        CHAT, "coder", RequestCard(card, RequestReference(token="tok", handle="R1"))
    )
    [body] = _sent(lark, "POST", "/im/v1/messages")
    assert body["msg_type"] == "interactive"
    drawn = json.loads(body["content"])
    assert drawn["header"]["title"]["content"] == "coder"
    assert drawn["config"]["update_multi"] is True
    [actions] = [e for e in drawn["elements"] if e["tag"] == "action"]
    values = [b["value"] for b in actions["actions"]]
    assert values and all(v["switch_value"] == "tok" for v in values)
    positions = [parse_answer_position(v["switch_action"]) for v in values]
    assert positions == list(range(1, len(values) + 1))
    assert "`" not in drawn["elements"][0]["content"]


async def test_deleting_a_room_takes_the_bot_out_of_the_group(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    outcome = await adapter.retire_channel(CHAT)
    assert outcome.outcome == "left"
    [body] = _sent(lark, "DELETE", f"/im/v1/chats/{CHAT}/members")
    assert body == {"id_list": [APP_ID]}


async def test_a_quiet_copy_opens_no_connection(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    assert adapter._runner is None
    assert not [c for c in lark.calls if c[1] == "/callback/ws/endpoint"]


# ── Markup ───────────────────────────────────────────────────────────────────


def test_headings_and_tables_are_drawn_the_way_lark_can() -> None:
    drawn = to_lark("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**kept**")
    assert drawn.startswith("**Title**")
    assert "```\n| a | b |" in drawn
    assert drawn.endswith("**kept**")


def test_a_code_block_cut_in_two_is_closed_and_reopened() -> None:
    text = "```python\n" + "\n".join(f"line_{n} = {n}" for n in range(400)) + "\n```"
    parts = chunk(text, 1000)
    assert len(parts) > 1
    assert all(p.count("```") % 2 == 0 for p in parts)
    assert all(p.startswith("```") for p in parts[1:])


def test_mentions_and_posts_come_back_as_markdown() -> None:
    assert (
        from_text(
            "@_user_1 hi @_user_10",
            [
                {"key": "@_user_1", "name": "Bot"},
                {"key": "@_user_10", "name": "Ada"},
            ],
        )
        == "@Bot hi @Ada"
    )
    post = {
        "title": "Plan",
        "content": [
            [
                {"tag": "text", "text": "ship ", "style": ["bold"]},
                {"tag": "a", "text": "docs", "href": "https://example.test"},
                {"tag": "img", "image_key": "img_9"},
            ],
            [{"tag": "code_block", "language": "PYTHON", "text": "x = 1"}],
        ],
    }
    text, images = from_post(post, [])
    assert text.startswith("**Plan**\n**ship **[docs](https://example.test)")
    assert "```python\nx = 1\n```" in text
    assert images == ["img_9"]


async def test_creating_a_room_makes_a_group_chat_named_as_lark_kept_it(
    adapter: LarkAdapter, lark: FakeLark
) -> None:
    created = await adapter.create_channel(
        "r" * 70, "Ship 2.0", channel_type="channel_private"
    )
    assert (created.id, created.name) == (
        "oc_new00000000000000000000000000000",
        "r" * 60,
    )
    [body] = [
        b
        for m, path, b in lark.calls
        if m == "POST" and path == "/open-apis/im/v1/chats"
    ]
    assert (body["chat_type"], body["description"]) == ("private", "Ship 2.0")
