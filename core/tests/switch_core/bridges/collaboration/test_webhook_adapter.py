"""The generic webhook platform: a chat app Switch has no adapter for.

Outbound events are driven through an `httpx.MockTransport`, so the signed
request that would reach the receiver is what is asserted on. Inbound events
are driven through `verify_webhook` / `parse_webhook` / `dispatch_event`, and
once through the real webhook route.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections.abc import Callable
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

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
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    RequestReference,
)
from switch_core.bridges.collaboration.webhook import adapter as webhook_module
from switch_core.bridges.collaboration.webhook.adapter import (
    _MAX_MESSAGE_CHARS,
    WebhookAdapter,
    WebhookConnectionConfig,
    sign,
)
from switch_core.bridges.collaboration.webhook.chunking import split_markdown
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.gateway.collaborations import list_bridge_types
from switch_core.outbound import OutboundPolicy, OutboundURLRefused

from .session_fixtures import _item, _turn, open_request
from .test_lifecycle_tenant_binding import _service
from .test_platform_self_contained import _hook_bridge, _RunningBridge

SIGNING_SECRET = "signing-secret-0123456789"
INBOUND_TOKEN = "inbound-token-0123456789"
OUTBOUND_URL = "https://chat.example/switch"
CHANNEL = "room-1"


def _config(**overrides: Any) -> WebhookConnectionConfig:
    return WebhookConnectionConfig.model_validate(
        {
            "outbound_url": OUTBOUND_URL,
            "signing_secret": SIGNING_SECRET,
            "inbound_token": INBOUND_TOKEN,
            **overrides,
        }
    )


class _Heard:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.interactions: list[InboundInteraction] = []
        self.app_joins: list[InboundAppJoin] = []
        self.agent_joins: list[InboundAgentJoin] = []
        self.user_joins: list[InboundUserJoin] = []


async def _started(adapter: WebhookAdapter) -> _Heard:
    heard = _Heard()

    async def on_message(event: InboundMessage) -> None:
        heard.messages.append(event)

    async def on_command(event: InboundCommand) -> None:
        heard.commands.append(event)

    async def on_agent(event: InboundAgentJoin) -> None:
        heard.agent_joins.append(event)

    async def on_user(event: InboundUserJoin) -> None:
        heard.user_joins.append(event)

    async def on_app(event: InboundAppJoin) -> None:
        heard.app_joins.append(event)

    async def on_interaction(event: InboundInteraction) -> None:
        heard.interactions.append(event)

    adapter.set_interaction_handler(on_interaction)
    await adapter.start(on_message, on_command, on_agent, on_user, on_app)
    return heard


class _Receiver:
    """The chat app: records what Switch posts and answers as told."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status = 200
        self.reply: dict[str, Any] | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.reply is not None:
            return httpx.Response(self.status, json=self.reply)
        return httpx.Response(self.status)

    def events(self) -> list[dict[str, Any]]:
        return [json.loads(request.content) for request in self.requests]


@pytest.fixture
def receiver() -> _Receiver:
    return _Receiver()


@pytest.fixture
async def adapter(receiver: _Receiver) -> WebhookAdapter:
    adapter = WebhookAdapter(config=_config())
    adapter._client = httpx.AsyncClient(transport=httpx.MockTransport(receiver))
    return adapter


# ── Config ───────────────────────────────────────────────────────────────────


class TestConfig:
    def test_a_valid_config_parses(self) -> None:
        assert _config().outbound_url == OUTBOUND_URL

    @pytest.mark.parametrize(
        "url", ["http://localhost:9000/hook", "http://127.0.0.1:9000/hook"]
    )
    def test_plain_http_is_allowed_on_loopback_only(self, url: str) -> None:
        assert _config(outbound_url=url).outbound_url == url

    @pytest.mark.parametrize(
        ("url", "message"),
        [
            ("http://chat.example/hook", "must be https"),
            ("ftp://chat.example/hook", "http\\(s\\) URL"),
            ("https:///hook", "http\\(s\\) URL"),
            ("not a url", "http\\(s\\) URL"),
            ("https://user:pw@chat.example/hook", "must not carry credentials"),
        ],
    )
    def test_an_unusable_url_is_refused(self, url: str, message: str) -> None:
        with pytest.raises(ValidationError, match=message):
            _config(outbound_url=url)

    @pytest.mark.parametrize("field", ["signing_secret", "inbound_token"])
    def test_a_short_secret_is_refused_without_echoing_it(self, field: str) -> None:
        with pytest.raises(ValidationError) as refused:
            _config(**{field: "hunter2"})
        assert "hunter2" not in str(refused.value)

    def test_the_secrets_are_masked_in_the_connect_form(self) -> None:
        properties = WebhookConnectionConfig.model_json_schema()["properties"]
        assert properties["signing_secret"]["format"] == "password"
        assert properties["inbound_token"]["format"] == "password"

    def test_the_outbound_url_is_what_the_outbound_policy_checks(self) -> None:
        assert WebhookAdapter.outbound_urls(_config().model_dump()) == [OUTBOUND_URL]


# ── Declaration ──────────────────────────────────────────────────────────────


class TestDeclaration:
    def test_it_is_registered_under_webhook(self) -> None:
        registration = next(p for p in PLATFORMS if p.key == "webhook")
        assert registration.adapter is WebhookAdapter
        assert registration.config is WebhookConnectionConfig

    def test_it_names_itself_and_ships_an_icon(self) -> None:
        platform = WebhookAdapter.describe("webhook")
        assert platform.display_name == "Webhook"
        assert platform.icon_svg is not None and platform.icon_svg.startswith("<svg")

    def test_its_capabilities_are_declared(self) -> None:
        assert WebhookAdapter.receives_webhooks is True
        assert WebhookAdapter.draws_session_activity is True
        assert WebhookAdapter.supports_channel_creation is False
        assert WebhookAdapter.supports_directory_search is False
        assert WebhookAdapter.renders_custom_url_schemes is False

    async def test_the_gateway_lists_it(self) -> None:
        service = _service(MagicMock())
        service.register_adapter("webhook", WebhookAdapter, WebhookConnectionConfig)
        listed = {t.key: t for t in await list_bridge_types(service, MagicMock())}
        assert listed["webhook"].receives_webhooks is True
        assert listed["webhook"].channel_creation_supported is False
        assert set(listed["webhook"].config_schema["required"]) == {
            "outbound_url",
            "signing_secret",
            "inbound_token",
        }

    async def test_it_cannot_create_a_channel(self, adapter: WebhookAdapter) -> None:
        with pytest.raises(ChannelCreationUnsupported):
            await adapter.create_channel("general", "")


# ── Outbound ─────────────────────────────────────────────────────────────────


class TestOutboundRequests:
    async def test_every_event_is_signed_over_its_timestamp_and_raw_body(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.send_message(CHANNEL, "builder", "hello")

        request = receiver.requests[0]
        timestamp = request.headers["x-switch-timestamp"]
        expected = hmac.new(
            SIGNING_SECRET.encode(),
            timestamp.encode() + b"." + request.content,
            hashlib.sha256,
        ).hexdigest()
        assert request.headers["x-switch-signature-256"] == f"sha256={expected}"
        assert request.headers["x-switch-event"] == "message.created"
        assert abs(time.time() - int(timestamp)) < 5
        assert request.headers["content-type"] == "application/json"

    async def test_the_envelope_carries_the_schema_version_and_a_fresh_event_id(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.send_message(CHANNEL, "builder", "one")
        await adapter.send_message(CHANNEL, "builder", "two")

        first, second = receiver.events()
        assert first["schema_version"] == 1
        assert first["event"] == "message.created"
        assert first["event_id"] != second["event_id"]
        assert first["created_at"]

    async def test_message_created_carries_the_message(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        ref = await adapter.send_message(
            CHANNEL, "builder", "hi **there**", "root-9", room_wide_mention=True
        )

        data = receiver.events()[0]["data"]
        assert data["channel_id"] == CHANNEL
        assert data["message_id"] == ref
        assert data["thread_root_id"] == "root-9"
        assert data["sender_name"] == "builder"
        assert data["sender_type"] == "agent"
        assert data["content"] == "hi **there**"
        assert data["room_wide_mention"] is True
        assert data["attachments"] == []

    async def test_a_message_id_the_receiver_returns_is_the_message_ref(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        receiver.reply = {"message_id": "their-id-1"}
        assert await adapter.send_message(CHANNEL, "builder", "hi") == "their-id-1"

    async def test_without_one_the_ref_is_the_id_sent(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        ref = await adapter.send_message(CHANNEL, "builder", "hi")
        assert ref == receiver.events()[0]["data"]["message_id"]

    async def test_an_admin_message_is_rendered_and_marked_as_admin(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.admin_message(CHANNEL, "No agents here.", "root-1")

        data = receiver.events()[0]["data"]
        assert data["sender_type"] == "admin"
        assert data["sender_name"] == "Switch"
        assert data["thread_root_id"] == "root-1"
        assert data["content"] == "No agents here."

    async def test_edit_and_delete_address_the_message_by_its_ref(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.update_message(CHANNEL, "m-1", "edited")
        await adapter.delete_message(CHANNEL, "m-1")

        updated, deleted = receiver.events()
        assert updated["event"] == "message.updated"
        assert updated["data"] == {
            "channel_id": CHANNEL,
            "message_id": "m-1",
            "content": "edited",
            "thread_root_id": None,
        }
        assert deleted["event"] == "message.deleted"
        assert deleted["data"] == {"channel_id": CHANNEL, "message_id": "m-1"}

    async def test_typing_is_reported(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.send_typing(CHANNEL, "builder", True)

        assert receiver.events()[0]["event"] == "typing.updated"
        assert receiver.events()[0]["data"] == {
            "channel_id": CHANNEL,
            "sender_name": "builder",
            "is_typing": True,
        }

    async def test_a_typing_hint_that_fails_is_logged_not_raised(
        self,
        adapter: WebhookAdapter,
        receiver: _Receiver,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        receiver.status = 500
        await adapter.send_typing(CHANNEL, "builder", True)
        assert "Could not send a typing indicator" in caplog.text

    async def test_files_go_out_as_one_message_with_their_bytes(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.send_attachments(
            CHANNEL,
            "builder",
            [
                OutboundAttachment(
                    filename="a.txt", mimetype="text/plain", data=b"alpha"
                ),
                OutboundAttachment(
                    filename="b.png", mimetype="image/png", data=b"\x89PNG"
                ),
            ],
            caption="two files",
        )

        assert len(receiver.requests) == 1
        data = receiver.events()[0]["data"]
        assert data["content"] == "two files"
        assert [a["filename"] for a in data["attachments"]] == ["a.txt", "b.png"]
        assert base64.b64decode(data["attachments"][0]["data_base64"]) == b"alpha"
        assert data["attachments"][0]["size"] == 5
        assert data["attachments"][1]["mimetype"] == "image/png"

    async def test_a_caption_is_translated_like_any_other_outbound_text(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.send_attachment(
            CHANNEL, "builder", "a.txt", "text/plain", b"a", caption="ping @everyone"
        )

        assert "@everyone" not in receiver.events()[0]["data"]["content"]

    async def test_one_file_is_a_single_attachment_message(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.send_attachment(
            CHANNEL, "builder", "a.txt", "text/plain", b"alpha", thread_root_id="r"
        )
        data = receiver.events()[0]["data"]
        assert data["content"] == ""
        assert data["thread_root_id"] == "r"
        assert len(data["attachments"]) == 1


class TestLongReplies:
    async def test_a_long_plain_reply_is_split_on_paragraphs_into_ordered_messages(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        paragraphs = [f"Paragraph {n}. " + "word " * 300 for n in range(12)]
        body = "\n\n".join(paragraphs)
        assert len(body) > _MAX_MESSAGE_CHARS

        ref = await adapter.send_message(CHANNEL, "builder", body, "root-1")

        sent = [event["data"] for event in receiver.events()]
        assert len(sent) > 1
        assert all(len(data["content"]) <= _MAX_MESSAGE_CHARS for data in sent)
        assert all(data["thread_root_id"] == "root-1" for data in sent)
        assert sent[0]["message_id"] == ref
        assert len({data["message_id"] for data in sent}) == len(sent)
        assert "\n\n".join(data["content"] for data in sent) == body
        assert all(data["content"].startswith("Paragraph") for data in sent), (
            "no piece starts mid-paragraph"
        )

    async def test_a_long_reply_with_a_code_block_keeps_every_fence_balanced(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        code = "\n".join(f"value_{n} = {n}" for n in range(1200))
        body = f"Here is the script:\n\n```python\n{code}\n```\n\nThat is all."
        assert len(body) > 2 * _MAX_MESSAGE_CHARS

        await adapter.send_message(CHANNEL, "builder", body)

        pieces = [event["data"]["content"] for event in receiver.events()]
        assert len(pieces) >= 3
        for piece in pieces:
            assert len(piece) <= _MAX_MESSAGE_CHARS
            assert piece.count("```") % 2 == 0
        assert pieces[0].endswith("\n```")
        assert pieces[1].startswith("```python\n")
        assert pieces[-1].endswith("That is all.")
        recovered = "".join(
            line + "\n"
            for piece in pieces
            for line in piece.split("\n")
            if line.startswith("value_")
        )
        assert recovered == "".join(f"value_{n} = {n}\n" for n in range(1200))

    async def test_a_top_level_reply_threads_its_later_pieces_under_the_first(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        body = "\n".join("line of text " * 10 for _ in range(200))

        ref = await adapter.send_message(CHANNEL, "builder", body)

        first, *later = [event["data"] for event in receiver.events()]
        assert first["thread_root_id"] is None
        assert later
        assert all(data["thread_root_id"] == ref for data in later)

    async def test_later_pieces_thread_under_the_receivers_id_for_the_first(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        receiver.reply = {"message_id": "their-id"}
        body = "\n".join("line of text " * 10 for _ in range(200))

        await adapter.send_message(CHANNEL, "builder", body)

        _, *later = [event["data"] for event in receiver.events()]
        assert later and all(d["thread_root_id"] == "their-id" for d in later)

    async def test_only_the_first_piece_carries_the_files_and_the_page(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        body = "\n".join("line of text " * 10 for _ in range(200))

        await adapter._create_message(
            CHANNEL,
            "builder",
            body,
            None,
            sender_type="agent",
            room_wide_mention=True,
            attachments=[
                OutboundAttachment(filename="a.txt", mimetype="text/plain", data=b"a")
            ],
        )

        first, *later = [event["data"] for event in receiver.events()]
        assert later
        assert first["room_wide_mention"] is True
        assert len(first["attachments"]) == 1
        assert all(not d["room_wide_mention"] and not d["attachments"] for d in later)

    async def test_a_receiver_id_for_the_first_piece_is_the_ref(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        receiver.reply = {"message_id": "their-id"}
        body = "\n".join("line of text " * 10 for _ in range(200))

        assert await adapter.send_message(CHANNEL, "builder", body) == "their-id"

    async def test_a_failure_part_way_is_raised_not_hidden(
        self, receiver: _Receiver
    ) -> None:
        calls = 0

        def fail_second(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200 if calls == 1 else 500)

        adapter = WebhookAdapter(config=_config())
        adapter._client = httpx.AsyncClient(transport=httpx.MockTransport(fail_second))
        body = "\n".join("line of text " * 10 for _ in range(200))

        with pytest.raises(BridgeOperationError, match="500"):
            await adapter.send_message(CHANNEL, "builder", body)

    async def test_an_admin_notice_is_split_too(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.admin_message(
            CHANNEL, "\n".join("notice line " * 10 for _ in range(200))
        )

        assert len(receiver.requests) > 1
        assert all(
            event["data"]["sender_type"] == "admin" for event in receiver.events()
        )


class TestSplitMarkdown:
    def test_a_short_body_is_one_piece_untouched(self) -> None:
        assert split_markdown("hello\n\n```\ncode\n```", 100) == [
            "hello\n\n```\ncode\n```"
        ]

    def test_it_prefers_a_paragraph_then_a_line_then_a_space(self) -> None:
        ten = "a" * 10
        assert split_markdown(f"{ten}\n\nbbbb cccccccc", 20) == [
            ten,
            "bbbb cccccccc",
        ]
        assert split_markdown(f"{ten}\nbbbbbbbb cc", 20) == [ten, "bbbbbbbb cc"]
        assert split_markdown(f"{ten} bbbbbbbbbbbb c", 20) == [
            ten,
            "bbbbbbbbbbbb c",
        ]

    def test_a_word_longer_than_the_limit_is_cut_hard(self) -> None:
        pieces = split_markdown("x" * 100, 30)
        assert all(len(piece) <= 30 for piece in pieces)
        assert "".join(pieces) == "x" * 100

    def test_an_open_fence_is_closed_and_reopened_with_its_language(self) -> None:
        body = "```js\n" + "\n".join(f"let a{n};" for n in range(100)) + "\n```"

        pieces = split_markdown(body, 120)

        assert len(pieces) > 1
        assert pieces[0].startswith("```js\n") and pieces[0].endswith("\n```")
        assert all(piece.startswith("```js\n") for piece in pieces[1:])
        assert all(piece.endswith("\n```") for piece in pieces)
        assert all(len(piece) <= 120 for piece in pieces)

    def test_a_longer_fence_is_closed_with_the_same_length(self) -> None:
        body = "````md\n" + "\n".join(f"```inner {n}```" for n in range(60)) + "\n````"

        pieces = split_markdown(body, 150)

        assert all(len(piece) <= 150 for piece in pieces)
        assert pieces[0].endswith("\n````")
        assert pieces[1].startswith("````md\n")

    def test_text_after_a_closed_fence_is_not_wrapped_in_one(self) -> None:
        body = "```\ncode\n```\n" + "plain words here " * 30

        pieces = split_markdown(body, 100)

        assert pieces[0].startswith("```\ncode\n```")
        assert all("```" not in piece for piece in pieces[1:])

    @pytest.mark.parametrize("limit", [1, 2, 5, 8, 12, 20, 40])
    def test_a_tiny_limit_on_a_fenced_body_terminates_within_the_limit(
        self, limit: int
    ) -> None:
        body = "```python\n" + "x\n" * 50 + "```\nafter"

        pieces = split_markdown(body, limit)

        assert all(len(piece) <= limit for piece in pieces)
        assert sum(piece.count("x") for piece in pieces) == 50
        assert "after" in "".join(pieces).replace("\n", "")

    def test_a_limit_no_larger_than_the_reopened_fence_falls_back_to_plain_text(
        self,
    ) -> None:
        body = "```python\n" + "word " * 40 + "\n```"

        pieces = split_markdown(body, 10)

        assert all(len(piece) <= 10 for piece in pieces)
        assert "".join(piece for piece in pieces).count("word") == 40

    def test_a_non_positive_limit_is_refused(self) -> None:
        with pytest.raises(ValueError, match="at least 1"):
            split_markdown("text", 0)

    def test_an_absurd_info_string_cannot_stall_the_split(self) -> None:
        body = "```" + "x" * 500 + "\n" + "line\n" * 400 + "```"

        pieces = split_markdown(body, 200)

        assert all(len(piece) <= 200 for piece in pieces)
        assert len(pieces) < 40


class TestOutboundFailures:
    async def test_a_typing_hint_the_receiver_rejects_is_logged_not_raised(
        self,
        adapter: WebhookAdapter,
        receiver: _Receiver,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        receiver.status = 401
        await adapter.send_typing(CHANNEL, "builder", True)
        assert "Could not send a typing indicator" in caplog.text

    @pytest.mark.parametrize("status", [401, 403])
    async def test_a_rejected_signature_is_a_credential_error(
        self, adapter: WebhookAdapter, receiver: _Receiver, status: int
    ) -> None:
        receiver.status = status
        with pytest.raises(BridgeCredentialError, match="signing secret"):
            await adapter.send_message(CHANNEL, "builder", "hi")

    async def test_any_other_refusal_is_an_operation_error(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        receiver.status = 500
        with pytest.raises(BridgeOperationError, match="500"):
            await adapter.send_message(CHANNEL, "builder", "hi")

    async def test_a_redirect_is_a_refusal_and_is_not_followed(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        receiver.status = 302
        with pytest.raises(BridgeOperationError, match="302"):
            await adapter.send_message(CHANNEL, "builder", "hi")
        assert len(receiver.requests) == 1

    async def test_an_unreachable_receiver_is_an_operation_error(self) -> None:
        def unreachable(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        adapter = WebhookAdapter(config=_config())
        adapter._client = httpx.AsyncClient(transport=httpx.MockTransport(unreachable))
        with pytest.raises(BridgeOperationError, match="chat.example"):
            await adapter.send_message(CHANNEL, "builder", "hi")

    async def test_an_address_the_outbound_policy_refuses_is_an_operation_error(
        self,
    ) -> None:
        def refused(request: httpx.Request) -> httpx.Response:
            raise OutboundURLRefused("chat.example resolves to a private address")

        adapter = WebhookAdapter(config=_config())
        adapter._client = httpx.AsyncClient(transport=httpx.MockTransport(refused))
        with pytest.raises(BridgeOperationError, match="private address"):
            await adapter.send_message(CHANNEL, "builder", "hi")


class TestVerifyCredentials:
    @pytest.fixture
    def receiver_at(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> Callable[[_Receiver], list[tuple[OutboundPolicy, dict[str, Any]]]]:
        def install(receiver: _Receiver) -> list[tuple[OutboundPolicy, dict[str, Any]]]:
            guarded_calls: list[tuple[OutboundPolicy, dict[str, Any]]] = []

            def guarded(policy: OutboundPolicy, **kwargs: Any) -> httpx.AsyncClient:
                guarded_calls.append((policy, kwargs))
                return httpx.AsyncClient(transport=httpx.MockTransport(receiver))

            monkeypatch.setattr(webhook_module, "guarded_async_client", guarded)
            return guarded_calls

        return install

    async def test_a_healthy_receiver_passes(
        self,
        receiver: _Receiver,
        receiver_at: Callable[[_Receiver], list[tuple[OutboundPolicy, dict[str, Any]]]],
    ) -> None:
        receiver_at(receiver)

        await WebhookAdapter.verify_credentials(_config().model_dump())

        assert receiver.requests[0].headers["x-switch-event"] == "health.check"
        assert receiver.events()[0]["event"] == "health.check"

    async def test_the_check_goes_through_the_guarded_client_with_the_deployments_policy(
        self,
        receiver: _Receiver,
        receiver_at: Callable[[_Receiver], list[tuple[OutboundPolicy, dict[str, Any]]]],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv(
            "OUTBOUND_ALLOWED_PRIVATE_HOSTS", "chat.internal,10.1.0.0/16"
        )
        calls = receiver_at(receiver)

        await WebhookAdapter.verify_credentials(_config().model_dump())

        ((policy, kwargs),) = calls
        assert policy.allowed_hostnames == frozenset({"chat.internal"})
        assert len(policy.allowed_networks) == 1
        assert kwargs["follow_redirects"] is False

    async def test_with_no_allowed_hosts_the_policy_allows_none(
        self,
        receiver: _Receiver,
        receiver_at: Callable[[_Receiver], list[tuple[OutboundPolicy, dict[str, Any]]]],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.delenv("OUTBOUND_ALLOWED_PRIVATE_HOSTS", raising=False)
        calls = receiver_at(receiver)

        await WebhookAdapter.verify_credentials(_config().model_dump())

        assert calls[0][0] == OutboundPolicy.parse("")

    async def test_a_private_receiver_is_refused_at_connect_time(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OUTBOUND_ALLOWED_PRIVATE_HOSTS", raising=False)
        config = _config(outbound_url="https://169.254.169.254/hook")

        with pytest.raises(BridgeOperationError, match="metadata"):
            await WebhookAdapter.verify_credentials(config.model_dump())

    async def test_a_receiver_that_rejects_the_signature_fails_the_connection(
        self,
        receiver: _Receiver,
        receiver_at: Callable[[_Receiver], list[tuple[OutboundPolicy, dict[str, Any]]]],
    ) -> None:
        receiver.status = 401
        receiver_at(receiver)

        with pytest.raises(BridgeCredentialError):
            await WebhookAdapter.verify_credentials(_config().model_dump())

    async def test_a_receiver_that_errors_fails_the_connection(
        self,
        receiver: _Receiver,
        receiver_at: Callable[[_Receiver], list[tuple[OutboundPolicy, dict[str, Any]]]],
    ) -> None:
        receiver.status = 502
        receiver_at(receiver)

        with pytest.raises(BridgeOperationError, match="502"):
            await WebhookAdapter.verify_credentials(_config().model_dump())


# ── Session activity and request cards ───────────────────────────────────────


class TestRichContent:
    async def test_a_running_turn_posts_status_and_a_stop_control(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await _started(adapter)

        ref = await adapter.post_rich(
            CHANNEL,
            "builder",
            TurnActivity([_item()], _turn("running"), interrupt_turn_id="turn-1"),
            "root-1",
        )

        event = receiver.events()[0]
        assert event["event"] == "activity.updated"
        data = event["data"]
        assert data["message_id"] == ref
        assert data["thread_root_id"] == "root-1"
        assert data["agent_name"] == "builder"
        assert data["status"] == "running"
        assert "Working" in data["text"]
        assert data["log"] == ""
        assert data["interrupt"]["action_id"] == INTERRUPT_ACTION
        assert data["interrupt"]["value"] == "turn-1"

    async def test_an_ended_turn_carries_its_log_and_no_stop_control(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await _started(adapter)

        await adapter.update_rich(
            CHANNEL,
            "builder",
            "m-1",
            TurnActivity(
                [_item(title="Ran the tests")],
                _turn("completed"),
                interrupt_turn_id="turn-1",
                elapsed_seconds=12,
            ),
            None,
        )

        data = receiver.events()[0]["data"]
        assert receiver.events()[0]["event"] == "activity.updated"
        assert data["message_id"] == "m-1"
        assert "Ran the tests" in data["log"]
        assert data["interrupt"] is None
        assert data["elapsed_seconds"] == 12

    async def test_no_stop_control_is_offered_where_a_press_has_nowhere_to_go(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await adapter.post_rich(
            CHANNEL,
            "builder",
            TurnActivity([], _turn("running"), interrupt_turn_id="turn-1"),
            None,
        )
        assert receiver.events()[0]["data"]["interrupt"] is None

    async def test_an_open_request_carries_controls_and_the_typed_fallback(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await _started(adapter)
        request = open_request()

        await adapter.post_rich(
            CHANNEL,
            "builder",
            RequestCard(request, RequestReference(token="tok-1", handle="R7")),
            None,
        )

        event = receiver.events()[0]
        assert event["event"] == "request.opened"
        data = event["data"]
        assert data["request_id"] == request.request_id
        assert data["handle"] == "R7"
        assert data["state"] == "open"
        assert data["answerable"] is True
        assert data["kind"] in {"approval", "questions"}
        assert "R7" in data["text"]
        assert data["controls"]
        first = data["controls"][0]
        assert first["position"] == 1
        assert first["action_id"] == "switch:request-option:1"
        assert first["value"] == "tok-1"

    async def test_a_redrawn_request_is_request_updated(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        await _started(adapter)

        await adapter.update_rich(
            CHANNEL,
            "builder",
            "m-2",
            RequestCard(
                open_request(),
                RequestReference(token="tok-1", handle="R7"),
                unavailable_reason="Answer this in Switch Console.",
            ),
            None,
        )

        event = receiver.events()[0]
        assert event["event"] == "request.updated"
        assert event["data"]["message_id"] == "m-2"
        assert event["data"]["answerable"] is False
        assert event["data"]["controls"] == []
        assert "Switch Console" in event["data"]["text"]

    async def test_a_refusal_is_a_rich_content_failure_carrying_the_text(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        receiver.status = 500

        with pytest.raises(RichContentFailed) as failed:
            await adapter.post_rich(
                CHANNEL, "builder", TurnActivity([], _turn("running")), None
            )
        assert failed.value.text
        assert isinstance(failed.value.__cause__, BridgeOperationError)

        with pytest.raises(RichContentFailed):
            await adapter.update_rich(
                CHANNEL, "builder", "m-1", TurnActivity([], _turn("running")), None
            )


# ── Inbound: authentication ──────────────────────────────────────────────────


def _post(body: bytes = b"{}", headers: dict[str, str] | None = None) -> WebhookRequest:
    return WebhookRequest(method="POST", headers=headers or {}, query={}, body=body)


def _signed(
    body: bytes, *, secret: str = SIGNING_SECRET, timestamp: int | None = None
) -> WebhookRequest:
    stamp = str(int(time.time()) if timestamp is None else timestamp)
    return _post(
        body,
        {
            "x-switch-timestamp": stamp,
            "x-switch-signature-256": sign(secret, stamp, body),
        },
    )


class TestVerifyWebhook:
    async def test_a_bearer_token_is_accepted(self, adapter: WebhookAdapter) -> None:
        await adapter.verify_webhook(
            _post(headers={"authorization": f"Bearer {INBOUND_TOKEN}"})
        )

    async def test_the_bearer_scheme_is_case_insensitive(
        self, adapter: WebhookAdapter
    ) -> None:
        await adapter.verify_webhook(
            _post(headers={"authorization": f"bearer {INBOUND_TOKEN}"})
        )

    async def test_the_webhook_token_header_is_accepted(
        self, adapter: WebhookAdapter
    ) -> None:
        await adapter.verify_webhook(_post(headers={"x-webhook-token": INBOUND_TOKEN}))

    async def test_a_fresh_signature_is_accepted(self, adapter: WebhookAdapter) -> None:
        await adapter.verify_webhook(_signed(b'{"a":1}'))

    @pytest.mark.parametrize(
        "headers",
        [
            {},
            {"authorization": "Bearer wrong-token-0123456789"},
            {"authorization": INBOUND_TOKEN},
            {"authorization": "Bearer "},
            {"x-webhook-token": "wrong-token-0123456789"},
            {"x-webhook-token": ""},
        ],
    )
    async def test_anything_else_is_refused(
        self, adapter: WebhookAdapter, headers: dict[str, str]
    ) -> None:
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(_post(headers=headers))

    async def test_a_signature_from_another_secret_is_refused(
        self, adapter: WebhookAdapter
    ) -> None:
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                _signed(b"{}", secret="someone-elses-secret-0123")
            )

    async def test_a_signature_over_a_different_body_is_refused(
        self, adapter: WebhookAdapter
    ) -> None:
        genuine = _signed(b'{"a":1}')
        tampered = _post(b'{"a":2}', dict(genuine.headers))
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(tampered)

    async def test_a_stale_signature_is_refused(self, adapter: WebhookAdapter) -> None:
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                _signed(b"{}", timestamp=int(time.time()) - 3600)
            )

    async def test_a_signature_without_a_timestamp_is_refused(
        self, adapter: WebhookAdapter
    ) -> None:
        genuine = _signed(b"{}")
        headers = {
            k: v for k, v in genuine.headers.items() if k != "x-switch-timestamp"
        }
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(_post(b"{}", headers))

    async def test_a_signed_address_check_is_accepted(
        self, adapter: WebhookAdapter
    ) -> None:
        stamp = str(int(time.time()))
        await adapter.verify_webhook(
            WebhookRequest(
                method="GET",
                headers={
                    "x-switch-timestamp": stamp,
                    "x-switch-signature-256": sign(SIGNING_SECRET, stamp, b""),
                },
                query={"challenge": "abc"},
                body=b"",
            )
        )

    @pytest.mark.parametrize("method", ["GET", "POST"])
    async def test_an_absurdly_long_timestamp_is_refused_not_a_crash(
        self, adapter: WebhookAdapter, method: str
    ) -> None:
        stamp = "9" * 10_000
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                WebhookRequest(
                    method=method,
                    headers={
                        "x-switch-timestamp": stamp,
                        "x-switch-signature-256": sign(SIGNING_SECRET, stamp, b""),
                    },
                    query={},
                    body=b"",
                )
            )

    async def test_the_query_token_proves_only_an_address_check(
        self, adapter: WebhookAdapter
    ) -> None:
        check = WebhookRequest(
            method="GET", headers={}, query={"token": INBOUND_TOKEN}, body=b""
        )
        await adapter.verify_webhook(check)

        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                WebhookRequest(
                    method="POST",
                    headers={},
                    query={"token": INBOUND_TOKEN},
                    body=b"{}",
                )
            )


# ── Inbound: parsing ─────────────────────────────────────────────────────────


def _event(event_type: str, **fields: Any) -> bytes:
    return json.dumps(
        {"schema_version": 1, "event_id": "evt-1", "type": event_type, **fields}
    ).encode()


_MESSAGE = {
    "channel_id": CHANNEL,
    "sender_id": "u-1",
    "sender_name": "ada",
    "text": "hello",
}


class TestParseWebhook:
    def test_an_address_check_echoes_its_challenge(
        self, adapter: WebhookAdapter
    ) -> None:
        parsed = adapter.parse_webhook(
            WebhookRequest(
                method="GET", headers={}, query={"challenge": "abc123"}, body=b""
            )
        )
        assert parsed.handshake == "abc123"
        assert parsed.external_event_id is None

    def test_an_address_check_without_a_challenge_is_refused(
        self, adapter: WebhookAdapter
    ) -> None:
        with pytest.raises(WebhookPayloadError, match="challenge"):
            adapter.parse_webhook(
                WebhookRequest(method="GET", headers={}, query={}, body=b"")
            )

    def test_the_event_id_is_the_external_event_id(
        self, adapter: WebhookAdapter
    ) -> None:
        parsed = adapter.parse_webhook(_post(_event("message", **_MESSAGE)))
        assert parsed.external_event_id == "evt-1"
        assert parsed.envelope_type == "message"
        assert parsed.handshake is None
        assert parsed.answers_inline is False

    def test_a_retried_delivery_carries_the_same_event_id(
        self, adapter: WebhookAdapter
    ) -> None:
        body = _event("message", **_MESSAGE)
        assert (
            adapter.parse_webhook(_post(body)).external_event_id
            == adapter.parse_webhook(_post(body)).external_event_id
        )

    @pytest.mark.parametrize("body", [b"not json", b"[]", b'"text"'])
    def test_a_body_that_is_not_an_object_is_refused(
        self, adapter: WebhookAdapter, body: bytes
    ) -> None:
        with pytest.raises(WebhookPayloadError):
            adapter.parse_webhook(_post(body))

    @pytest.mark.parametrize("version", [None, 0, 2, "1"])
    def test_only_schema_version_1_is_accepted(
        self, adapter: WebhookAdapter, version: object
    ) -> None:
        body = json.dumps(
            {"schema_version": version, "event_id": "e", "type": "message", **_MESSAGE}
        ).encode()
        with pytest.raises(WebhookPayloadError, match="schema_version must be 1"):
            adapter.parse_webhook(_post(body))

    def test_an_event_without_an_id_is_refused(self, adapter: WebhookAdapter) -> None:
        body = json.dumps({"schema_version": 1, "type": "message", **_MESSAGE}).encode()
        with pytest.raises(WebhookPayloadError, match="event_id"):
            adapter.parse_webhook(_post(body))

    @pytest.mark.parametrize("event_type", ["message.edited", "message.deleted"])
    def test_edits_and_deletes_are_refused_loudly(
        self, adapter: WebhookAdapter, event_type: str
    ) -> None:
        with pytest.raises(WebhookPayloadError, match="cannot be relayed"):
            adapter.parse_webhook(_post(_event(event_type, channel_id=CHANNEL)))

    @pytest.mark.parametrize("event_type", [[1, 2], {"a": 1}, 7, None])
    def test_a_type_that_is_not_a_string_is_refused_not_a_crash(
        self, adapter: WebhookAdapter, event_type: object
    ) -> None:
        body = json.dumps(
            {"schema_version": 1, "event_id": "e", "type": event_type}
        ).encode()
        with pytest.raises(WebhookPayloadError, match="unsupported event type"):
            adapter.parse_webhook(_post(body))

    def test_an_unknown_type_names_the_supported_ones(
        self, adapter: WebhookAdapter
    ) -> None:
        with pytest.raises(WebhookPayloadError, match="supported: .*message"):
            adapter.parse_webhook(_post(_event("telepathy")))

    @pytest.mark.parametrize(
        "fields",
        [
            {**_MESSAGE, "text": "  "},
            {**_MESSAGE, "channel_id": ""},
            {k: v for k, v in _MESSAGE.items() if k != "sender_id"},
            {**_MESSAGE, "channel_type": "spaceship"},
            {**_MESSAGE, "attachments": [{"filename": "a.txt"}]},
            {
                **_MESSAGE,
                "attachments": [
                    {"filename": "a.txt", "data_base64": "AA==", "url": "https://x/a"}
                ],
            },
        ],
    )
    def test_a_malformed_message_is_refused_without_echoing_its_values(
        self, adapter: WebhookAdapter, fields: dict[str, Any]
    ) -> None:
        with pytest.raises(WebhookPayloadError) as refused:
            adapter.parse_webhook(_post(_event("message", **fields)))
        assert "hello" not in str(refused.value)

    def test_attachments_alone_make_a_message(self, adapter: WebhookAdapter) -> None:
        adapter.parse_webhook(
            _post(
                _event(
                    "message",
                    **{
                        **_MESSAGE,
                        "text": "",
                        "attachments": [{"filename": "a.txt", "data_base64": "AA=="}],
                    },
                )
            )
        )

    def test_a_command_needs_a_valid_name(self, adapter: WebhookAdapter) -> None:
        fields = {k: v for k, v in _MESSAGE.items() if k != "text"}
        with pytest.raises(WebhookPayloadError, match="command"):
            adapter.parse_webhook(_post(_event("command", command="rm -rf", **fields)))

    def test_an_interaction_needs_the_message_it_was_on(
        self, adapter: WebhookAdapter
    ) -> None:
        with pytest.raises(WebhookPayloadError, match="message_id"):
            adapter.parse_webhook(
                _post(
                    _event(
                        "interaction",
                        channel_id=CHANNEL,
                        sender_id="u-1",
                        sender_name="ada",
                        action_id="switch:request-option:1",
                        value="tok-1",
                    )
                )
            )


# ── Inbound: dispatch ────────────────────────────────────────────────────────


async def _dispatch(adapter: WebhookAdapter, body: bytes) -> None:
    parsed = adapter.parse_webhook(_post(body))
    await adapter.dispatch_event(
        envelope_type=parsed.envelope_type, payload=parsed.payload
    )


class TestDispatchMessages:
    async def test_a_message_becomes_an_inbound_message(
        self, adapter: WebhookAdapter
    ) -> None:
        heard = await _started(adapter)

        await _dispatch(
            adapter,
            _event(
                "message",
                **_MESSAGE,
                message_id="m-9",
                thread_root_id="root-3",
                channel_type="group",
                channel_name="Ops",
            ),
        )

        (message,) = heard.messages
        assert message.channel_id == CHANNEL
        assert message.channel_type == "group"
        assert message.channel_name == "Ops"
        assert message.sender_id == "u-1"
        assert message.sender_name == "ada"
        assert message.content == "hello"
        assert message.message_ref == "m-9"
        assert message.root_id == "root-3"
        assert message.attachments == []

    async def test_without_a_message_id_the_event_id_is_the_ref(
        self, adapter: WebhookAdapter
    ) -> None:
        heard = await _started(adapter)
        await _dispatch(adapter, _event("message", **_MESSAGE))
        assert heard.messages[0].message_ref == "evt-1"
        assert heard.messages[0].channel_type == "channel_public"

    async def test_a_bang_command_in_text_is_routed_as_a_command(
        self, adapter: WebhookAdapter
    ) -> None:
        heard = await _started(adapter)

        await _dispatch(
            adapter,
            _event(
                "message",
                **{**_MESSAGE, "text": "!invite-agent builder now"},
                thread_root_id="root-3",
            ),
        )

        assert heard.messages == []
        (command,) = heard.commands
        assert command.command == "invite-agent"
        assert command.args == "builder now"
        assert command.root_id == "root-3"
        assert command.message_ref == "evt-1"

    @pytest.mark.parametrize("text", ["!!!", "! space", "wow !not-first", "!"])
    async def test_text_that_only_looks_like_a_command_is_a_message(
        self, adapter: WebhookAdapter, text: str
    ) -> None:
        heard = await _started(adapter)
        await _dispatch(adapter, _event("message", **{**_MESSAGE, "text": text}))
        assert [m.content for m in heard.messages] == [text]
        assert heard.commands == []

    async def test_an_explicit_command_event_is_a_command(
        self, adapter: WebhookAdapter
    ) -> None:
        heard = await _started(adapter)
        fields = {k: v for k, v in _MESSAGE.items() if k != "text"}

        await _dispatch(
            adapter, _event("command", command="interrupt", args=" now ", **fields)
        )

        (command,) = heard.commands
        assert (command.command, command.args) == ("interrupt", "now")

    async def test_an_interaction_carries_the_control_that_was_pressed(
        self, adapter: WebhookAdapter
    ) -> None:
        heard = await _started(adapter)

        await _dispatch(
            adapter,
            _event(
                "interaction",
                channel_id=CHANNEL,
                sender_id="u-1",
                sender_name="ada",
                action_id="switch:request-option:2",
                value="tok-1",
                message_id="m-2",
                thread_root_id="root-3",
            ),
        )

        (interaction,) = heard.interactions
        assert interaction.action_id == "switch:request-option:2"
        assert interaction.value == "tok-1"
        assert interaction.message_ref == "m-2"
        assert interaction.thread_ref == "root-3"
        assert interaction.sender_id == "u-1"

    async def test_joins_reach_their_callbacks(self, adapter: WebhookAdapter) -> None:
        heard = await _started(adapter)

        await _dispatch(
            adapter,
            _event("channel.joined", channel_id=CHANNEL, channel_name="Ops"),
        )
        await _dispatch(
            adapter, _event("agent.joined", channel_id=CHANNEL, agent_name="builder")
        )
        await _dispatch(
            adapter,
            _event("user.joined", channel_id=CHANNEL, user_id="u-1", user_name="ada"),
        )

        assert heard.app_joins[0].channel_name == "Ops"
        assert heard.agent_joins[0].agent_name == "builder"
        assert heard.user_joins[0].external_user_id == "u-1"
        assert heard.user_joins[0].external_username == "ada"

    async def test_an_event_before_start_is_a_loud_failure(
        self, adapter: WebhookAdapter
    ) -> None:
        with pytest.raises(BridgeOperationError, match="before this bridge"):
            await _dispatch(adapter, _event("message", **_MESSAGE))


class TestInboundAttachments:
    @staticmethod
    def _message(*attachments: dict[str, Any]) -> bytes:
        return _event(
            "message", **{**_MESSAGE, "text": ""}, attachments=list(attachments)
        )

    async def test_base64_data_is_decoded(self, adapter: WebhookAdapter) -> None:
        heard = await _started(adapter)

        await _dispatch(
            adapter,
            self._message(
                {
                    "filename": "a.txt",
                    "mimetype": "text/plain; charset=utf-8",
                    "data_base64": base64.b64encode(b"alpha").decode(),
                }
            ),
        )

        (attachment,) = heard.messages[0].attachments
        assert (attachment.filename, attachment.mimetype) == ("a.txt", "text/plain")
        assert attachment.data == b"alpha"
        assert heard.messages[0].attachment_failures == []

    async def test_an_oversize_file_is_refused_visibly(
        self, adapter: WebhookAdapter
    ) -> None:
        heard = await _started(adapter)
        adapter.set_max_attachment_bytes(4)

        await _dispatch(
            adapter,
            self._message(
                {
                    "filename": "big.bin",
                    "data_base64": base64.b64encode(b"x" * 100).decode(),
                },
                {
                    "filename": "ok.bin",
                    "data_base64": base64.b64encode(b"ok").decode(),
                },
            ),
        )

        message = heard.messages[0]
        assert [a.filename for a in message.attachments] == ["ok.bin"]
        (failure,) = message.attachment_failures
        assert failure.filename == "big.bin"
        assert "4 byte limit" in failure.reason

    async def test_a_file_just_over_the_limit_after_decoding_is_refused(
        self, adapter: WebhookAdapter
    ) -> None:
        heard = await _started(adapter)
        adapter.set_max_attachment_bytes(4)

        await _dispatch(
            adapter,
            self._message(
                {
                    "filename": "five.bin",
                    "data_base64": base64.b64encode(b"12345").decode(),
                }
            ),
        )

        assert heard.messages[0].attachments == []
        assert (
            "exceeds the 4 byte limit"
            in heard.messages[0].attachment_failures[0].reason
        )

    async def test_invalid_base64_is_refused_visibly(
        self, adapter: WebhookAdapter
    ) -> None:
        heard = await _started(adapter)

        await _dispatch(
            adapter, self._message({"filename": "a.txt", "data_base64": "!!notbase64"})
        )

        assert heard.messages[0].attachments == []
        assert "not valid base64" in heard.messages[0].attachment_failures[0].reason

    async def test_a_url_is_downloaded_through_the_guarded_client(
        self, adapter: WebhookAdapter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        heard = await _started(adapter)
        adapter.set_outbound_policy(OutboundPolicy.parse(""))
        asked: list[str] = []

        def serve(request: httpx.Request) -> httpx.Response:
            asked.append(str(request.url))
            return httpx.Response(200, content=b"from-url")

        def guarded(policy: OutboundPolicy, **kwargs: Any) -> httpx.AsyncClient:
            assert policy is adapter.outbound_policy
            assert kwargs["follow_redirects"] is False
            return httpx.AsyncClient(transport=httpx.MockTransport(serve))

        monkeypatch.setattr(webhook_module, "guarded_async_client", guarded)

        await _dispatch(
            adapter,
            self._message({"filename": "a.txt", "url": "https://files.example/a.txt"}),
        )

        assert asked == ["https://files.example/a.txt"]
        assert heard.messages[0].attachments[0].data == b"from-url"

    async def test_a_url_that_fails_to_download_is_refused_visibly(
        self, adapter: WebhookAdapter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        heard = await _started(adapter)
        adapter.set_outbound_policy(OutboundPolicy.parse(""))
        monkeypatch.setattr(
            webhook_module,
            "guarded_async_client",
            lambda policy, **kwargs: httpx.AsyncClient(
                transport=httpx.MockTransport(lambda r: httpx.Response(404))
            ),
        )

        await _dispatch(
            adapter,
            self._message({"filename": "a.txt", "url": "https://files.example/a.txt"}),
        )

        assert heard.messages[0].attachments == []
        assert "download failed" in heard.messages[0].attachment_failures[0].reason

    async def test_a_url_the_outbound_policy_refuses_is_refused_visibly(
        self, adapter: WebhookAdapter
    ) -> None:
        heard = await _started(adapter)
        adapter.set_outbound_policy(OutboundPolicy.parse(""))

        await _dispatch(
            adapter,
            self._message({"filename": "a.txt", "url": "http://169.254.169.254/a"}),
        )

        assert heard.messages[0].attachments == []
        assert "download failed" in heard.messages[0].attachment_failures[0].reason

    async def test_a_url_download_over_the_limit_is_refused_visibly(
        self, adapter: WebhookAdapter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        heard = await _started(adapter)
        adapter.set_outbound_policy(OutboundPolicy.parse(""))
        adapter.set_max_attachment_bytes(4)
        monkeypatch.setattr(
            webhook_module,
            "guarded_async_client",
            lambda policy, **kwargs: httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda r: httpx.Response(200, content=b"too large")
                )
            ),
        )

        await _dispatch(
            adapter,
            self._message({"filename": "a.txt", "url": "https://files.example/a.txt"}),
        )

        assert heard.messages[0].attachments == []
        assert "4 byte limit" in heard.messages[0].attachment_failures[0].reason


class TestChannelsAndMembership:
    async def test_adding_people_is_disclosed_as_not_done(
        self, adapter: WebhookAdapter, caplog: pytest.LogCaptureFixture
    ) -> None:
        assert await adapter.add_users_to_channel(CHANNEL, ["ada"], ["u-1"]) == ["u-1"]
        assert await adapter.add_users_to_channel(CHANNEL, [], []) == []
        assert "managed by the chat app" in caplog.text

    async def test_it_knows_no_channel_membership(
        self, adapter: WebhookAdapter
    ) -> None:
        assert await adapter.get_channel_agent_names(CHANNEL) == []
        assert await adapter.get_channel_type(CHANNEL) == "channel_public"

    async def test_stop_closes_the_client(
        self, adapter: WebhookAdapter, receiver: _Receiver
    ) -> None:
        client = adapter._client
        assert client is not None
        await adapter.stop()
        assert client.is_closed
        assert adapter._client is None

    def test_inbound_text_and_outbound_markdown_pass_through(
        self, adapter: WebhookAdapter
    ) -> None:
        assert adapter.translate_inbound("a *b*") == "a *b*"
        assert adapter.translate_outbound("a *b*") == "a *b*"

    def test_mass_mentions_are_still_defused(self, adapter: WebhookAdapter) -> None:
        assert "@everyone" not in adapter.translate_outbound("ping @everyone")


# ── The real webhook route ───────────────────────────────────────────────────


class TestThroughTheWebhookRoute:
    @pytest.fixture
    async def route(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> tuple[httpx.AsyncClient, str, _Heard]:
        lifecycle = _service(session_factory)
        lifecycle.register_adapter("webhook", WebhookAdapter, WebhookConnectionConfig)
        bridge_id = await _hook_bridge(session_factory, bridge_type="webhook")
        adapter = WebhookAdapter(config=_config())
        heard = await _started(adapter)
        lifecycle._bridges[bridge_id] = _RunningBridge(adapter)  # type: ignore[assignment]
        app = FastAPI()
        app.include_router(
            create_bridge_webhook_router(
                BridgeWebhookService(
                    lifecycle=lifecycle,
                    session_factory=session_factory,
                    receipts=MessagingEventReceiptStore(),
                )
            )
        )
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
        )
        return client, bridge_id, heard

    async def test_a_message_with_the_token_reaches_the_bridge(
        self, route: tuple[httpx.AsyncClient, str, _Heard]
    ) -> None:
        client, bridge_id, heard = route

        response = await client.post(
            webhook_path(bridge_id),
            content=_event("message", **_MESSAGE),
            headers={"Authorization": f"Bearer {INBOUND_TOKEN}"},
        )

        assert response.status_code == 200
        assert [m.content for m in heard.messages] == ["hello"]

    async def test_a_signed_message_reaches_the_bridge(
        self, route: tuple[httpx.AsyncClient, str, _Heard]
    ) -> None:
        client, bridge_id, heard = route
        body = _event("message", **_MESSAGE)
        signed = _signed(body)

        response = await client.post(
            webhook_path(bridge_id), content=body, headers=dict(signed.headers)
        )

        assert response.status_code == 200
        assert len(heard.messages) == 1

    async def test_a_retried_delivery_is_handled_once(
        self, route: tuple[httpx.AsyncClient, str, _Heard]
    ) -> None:
        client, bridge_id, heard = route
        headers = {"Authorization": f"Bearer {INBOUND_TOKEN}"}
        body = _event("message", **_MESSAGE)

        for _ in range(2):
            response = await client.post(
                webhook_path(bridge_id), content=body, headers=headers
            )
            assert response.status_code == 200

        assert len(heard.messages) == 1

    async def test_a_wrong_token_is_a_401_and_nothing_is_heard(
        self, route: tuple[httpx.AsyncClient, str, _Heard]
    ) -> None:
        client, bridge_id, heard = route

        response = await client.post(
            webhook_path(bridge_id),
            content=_event("message", **_MESSAGE),
            headers={"Authorization": "Bearer wrong-token-0123456789"},
        )

        assert response.status_code == 401
        assert heard.messages == []

    async def test_a_verified_body_that_cannot_be_read_is_a_400(
        self, route: tuple[httpx.AsyncClient, str, _Heard]
    ) -> None:
        client, bridge_id, heard = route

        response = await client.post(
            webhook_path(bridge_id),
            content=_event("message", channel_id=CHANNEL),
            headers={"Authorization": f"Bearer {INBOUND_TOKEN}"},
        )

        assert response.status_code == 400
        assert heard.messages == []

    async def test_the_address_check_echoes_its_challenge(
        self, route: tuple[httpx.AsyncClient, str, _Heard]
    ) -> None:
        client, bridge_id, _ = route

        response = await client.get(
            webhook_path(bridge_id),
            params={"challenge": "abc123", "token": INBOUND_TOKEN},
        )

        assert response.status_code == 200
        assert response.text == "abc123"

    async def test_the_address_check_needs_the_token(
        self, route: tuple[httpx.AsyncClient, str, _Heard]
    ) -> None:
        client, bridge_id, _ = route

        response = await client.get(
            webhook_path(bridge_id), params={"challenge": "abc123"}
        )

        assert response.status_code == 401
