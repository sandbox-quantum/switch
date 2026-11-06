"""The Webex adapter, against a mocked Webex REST API.

Webex is mocked at the HTTP transport (`httpx.MockTransport`), never by
patching the adapter's own methods, so every test exercises the real request
the adapter builds and the real parsing of what Webex answers.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.adapter import (
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    RichContentWedged,
    ThreadUnavailable,
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
    InboundCommand,
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    position_action,
)
from switch_core.bridges.collaboration.webex import adapter as webex_module
from switch_core.bridges.collaboration.webex.adapter import (
    SIGNATURE_HEADER,
    WebexAdapter,
    WebexConnectionConfig,
    sign,
)
from switch_core.bridges.collaboration.webex.client import WebexAPIError, WebexClient
from switch_core.sessions.contract import TurnUpsert

from .session_fixtures import open_request

BOT_ID = "bot-person-id"
_NOTICE = webex_module._CARD_NOTICE
SECRET = "connection-secret"
HOOK_URL = "https://switch.example.test/messaging/bridges/b1/events"

Handler = Callable[[httpx.Request], httpx.Response]


class FakeWebex:
    """A scripted Webex: routes by method and path, and records every call."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.routes: dict[tuple[str, str], Handler] = {}
        self.route(
            "GET",
            "/v1/people/me",
            lambda r: _ok(
                {
                    "id": BOT_ID,
                    "displayName": "Switch Bot",
                    "type": "bot",
                    "emails": ["switch-bot@webex.bot"],
                }
            ),
        )
        self.route("GET", "/v1/webhooks", lambda r: _ok({"items": []}))
        self.route("POST", "/v1/webhooks", lambda r: _ok({"id": "hook"}))

    def route(self, method: str, path: str, handler: Handler) -> None:
        self.routes[(method, path)] = handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        handler = self.routes.get((request.method, request.url.path))
        if handler is None:
            return httpx.Response(
                404, json={"message": f"no route {request.method} {request.url.path}"}
            )
        if b'"attachments"' in request.content and b"<@" in request.content:
            body = json.loads(request.content)
            if body.get("attachments") and "<@" in body.get("markdown", ""):
                return _refused("Mentions not allowed to be used with attachments.")
        return handler(request)

    def sent(self, method: str, path: str) -> list[httpx.Request]:
        return [c for c in self.calls if c.method == method and c.url.path == path]


def _ok(body: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json=body)


def _refused(message: str) -> httpx.Response:
    return httpx.Response(400, json={"message": message})


@pytest.fixture
def webex(monkeypatch: pytest.MonkeyPatch) -> FakeWebex:
    fake = FakeWebex()
    monkeypatch.setattr(
        webex_module,
        "_new_client",
        lambda token: WebexClient(token, transport=httpx.MockTransport(fake)),
    )
    return fake


def _config(**overrides: Any) -> WebexConnectionConfig:
    return WebexConnectionConfig.model_validate(
        {"bot_token": "bot-token", "webhook_secret": SECRET, **overrides}
    )


class Received:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.interactions: list[InboundInteraction] = []
        self.app_joins: list[Any] = []
        self.user_joins: list[Any] = []

    async def message(self, m: InboundMessage) -> None:
        self.messages.append(m)

    async def command(self, c: InboundCommand) -> None:
        self.commands.append(c)

    async def interaction(self, i: InboundInteraction) -> None:
        self.interactions.append(i)

    async def app_join(self, j: Any) -> None:
        self.app_joins.append(j)

    async def user_join(self, j: Any) -> None:
        self.user_joins.append(j)

    async def ignore(self, _: Any) -> None:
        return None


async def _started(
    webex: FakeWebex, *, listening: bool = True, webhook_url: str | None = HOOK_URL
) -> tuple[WebexAdapter, Received]:
    adapter = WebexAdapter(config=_config())
    adapter.set_bridge_id("b1")
    adapter.set_listening(listening)
    adapter.set_webhook_url(webhook_url)
    received = Received()
    adapter.set_interaction_handler(received.interaction)
    await adapter.start(
        received.message,
        received.command,
        received.ignore,
        received.user_join,
        received.app_join,
    )
    return adapter, received


def _signed(body: dict[str, Any], secret: str = SECRET) -> WebhookRequest:
    raw = json.dumps(body).encode()
    return WebhookRequest(
        method="POST",
        headers={SIGNATURE_HEADER: sign(secret, raw)},
        query={},
        body=raw,
    )


def _message(**fields: Any) -> dict[str, Any]:
    return {
        "id": "msg-1",
        "roomId": "room-1",
        "roomType": "group",
        "personId": "person-1",
        "personEmail": "ada@example.test",
        "created": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        **fields,
    }


def _serve_message(webex: FakeWebex, message: dict[str, Any]) -> None:
    webex.route("GET", f"/v1/messages/{message['id']}", lambda r: _ok(message))
    webex.route(
        "GET",
        f"/v1/people/{message['personId']}",
        lambda r: _ok({"id": message["personId"], "displayName": "Ada Lovelace"}),
    )


# ── Connection settings ──────────────────────────────────────────────────────


class TestConfig:
    def test_a_token_is_required(self) -> None:
        with pytest.raises(ValueError, match="bot_token is required"):
            WebexConnectionConfig.model_validate({"bot_token": "  "})

    def test_a_pasted_bearer_prefix_is_refused(self) -> None:
        with pytest.raises(ValueError, match="without the word Bearer"):
            WebexConnectionConfig.model_validate({"bot_token": "Bearer abc"})

    def test_the_secret_is_not_on_the_connect_form(self) -> None:
        schema = WebexConnectionConfig.model_json_schema()
        assert "webhook_secret" not in schema["properties"]
        assert "bot_token" in schema["properties"]

    async def test_the_secret_is_minted_once(self) -> None:
        prepared = await WebexAdapter.prepare_config({"bot_token": "t"})
        assert isinstance(prepared["webhook_secret"], str)
        assert len(str(prepared["webhook_secret"])) >= 32
        again = await WebexAdapter.prepare_config(prepared)
        assert again["webhook_secret"] == prepared["webhook_secret"]


class TestVerifyCredentials:
    async def test_a_rejected_token_is_a_credential_error(
        self, webex: FakeWebex
    ) -> None:
        webex.route(
            "GET",
            "/v1/people/me",
            lambda r: httpx.Response(401, json={"message": "invalid token"}),
        )
        with pytest.raises(
            BridgeCredentialError, match="rejected the bot access token"
        ):
            await WebexAdapter.verify_credentials({"bot_token": "t"})

    async def test_a_personal_token_is_refused(self, webex: FakeWebex) -> None:
        webex.route(
            "GET", "/v1/people/me", lambda r: _ok({"id": "p", "type": "person"})
        )
        with pytest.raises(BridgeCredentialError, match="belongs to a person"):
            await WebexAdapter.verify_credentials({"bot_token": "t"})

    async def test_a_bot_token_is_accepted(self, webex: FakeWebex) -> None:
        await WebexAdapter.verify_credentials({"bot_token": "t"})
        assert (
            webex.sent("GET", "/v1/people/me")[0].headers["authorization"] == "Bearer t"
        )


class TestClassifyFailure:
    def test_refusals_are_named(self) -> None:
        assert (
            WebexAdapter.classify_failure(
                WebexAPIError(401, "x", tracking_id=None, retry_after=None)
            )
            == "auth_failed"
        )
        assert (
            WebexAdapter.classify_failure(
                WebexAPIError(403, "x", tracking_id=None, retry_after=None)
            )
            == "platform_error"
        )
        assert WebexAdapter.classify_failure(httpx.ConnectError("down")) == "network"
        assert WebexAdapter.classify_failure(ValueError("other")) is None


# ── Lifecycle ────────────────────────────────────────────────────────────────


class TestStart:
    async def test_withdrawing_outlasts_a_rate_limit(
        self, webex: FakeWebex, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "GET",
            "/v1/webhooks",
            lambda r: _ok({"items": [{"id": "mine", "name": adapter._webhook_name()}]}),
        )
        answers = iter(
            [
                httpx.Response(429, headers={"retry-after": "2"}, json={}),
                httpx.Response(204),
            ]
        )
        webex.route("DELETE", "/v1/webhooks/mine", lambda r: next(answers))

        async def sleep(seconds: float) -> None:
            return None

        monkeypatch.setattr(webex_module.asyncio, "sleep", sleep)
        await adapter.withdraw()
        assert len(webex.sent("DELETE", "/v1/webhooks/mine")) == 2

    async def test_every_webhook_is_made_when_webex_limits_the_rate(
        self, webex: FakeWebex, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        limited = httpx.Response(429, headers={"retry-after": "2"}, json={})
        answers = iter(
            [_ok({"id": "h1"}), limited, limited, _ok({"id": "h2"}), _ok({"id": "h3"})]
        )
        webex.route("POST", "/v1/webhooks", lambda r: next(answers))
        waited: list[float] = []

        async def sleep(seconds: float) -> None:
            waited.append(seconds)

        monkeypatch.setattr(webex_module.asyncio, "sleep", sleep)
        await _started(webex)

        created = [json.loads(c.content) for c in webex.sent("POST", "/v1/webhooks")]
        assert [c["resource"] for c in created] == [
            "messages",
            "attachmentActions",
            "attachmentActions",
            "attachmentActions",
            "memberships",
        ]
        assert waited == [2, 2]

    async def test_a_rate_limit_that_never_lifts_still_fails_the_start(
        self, webex: FakeWebex, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        webex.route(
            "POST",
            "/v1/webhooks",
            lambda r: httpx.Response(429, headers={"retry-after": "2"}, json={}),
        )

        async def sleep(seconds: float) -> None:
            return None

        monkeypatch.setattr(webex_module.asyncio, "sleep", sleep)
        with pytest.raises(WebexAPIError):
            await _started(webex)
        assert len(webex.sent("POST", "/v1/webhooks")) == 4

    async def test_the_holder_replaces_its_own_webhooks_and_no_others(
        self, webex: FakeWebex
    ) -> None:
        webex.route(
            "GET",
            "/v1/webhooks",
            lambda r: _ok(
                {
                    "items": [
                        {"id": "mine", "name": "Switch b1"},
                        {"id": "theirs", "name": "Someone else's"},
                    ]
                }
            ),
        )
        webex.route("DELETE", "/v1/webhooks/mine", lambda r: httpx.Response(204))
        await _started(webex)

        assert [c.url.path for c in webex.sent("DELETE", "/v1/webhooks/mine")] == [
            "/v1/webhooks/mine"
        ]
        assert not webex.sent("DELETE", "/v1/webhooks/theirs")
        created = [json.loads(c.content) for c in webex.sent("POST", "/v1/webhooks")]
        assert {(h["resource"], h["event"]) for h in created} == {
            ("messages", "created"),
            ("attachmentActions", "created"),
            ("memberships", "created"),
        }
        assert all(
            h["targetUrl"] == HOOK_URL and h["secret"] == SECRET for h in created
        )

    async def test_a_quiet_copy_registers_nothing(self, webex: FakeWebex) -> None:
        await _started(webex, listening=False)
        assert not webex.sent("POST", "/v1/webhooks")

    async def test_no_public_address_refuses_to_start(self, webex: FakeWebex) -> None:
        with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
            await _started(webex, webhook_url=None)

    async def test_withdraw_deletes_this_bridges_webhooks(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "GET",
            "/v1/webhooks",
            lambda r: _ok({"items": [{"id": "h1", "name": "Switch b1"}]}),
        )
        webex.route("DELETE", "/v1/webhooks/h1", lambda r: httpx.Response(204))
        await adapter.withdraw()
        assert webex.sent("DELETE", "/v1/webhooks/h1")


# ── Webhooks ─────────────────────────────────────────────────────────────────


class TestWebhook:
    async def test_a_correctly_signed_delivery_is_accepted(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        await adapter.verify_webhook(
            _signed({"resource": "messages", "event": "created", "data": {"id": "m"}})
        )

    async def test_a_delivery_signed_with_another_secret_is_refused(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                _signed({"data": {"id": "m"}}, secret="not-ours")
            )

    async def test_an_unsigned_delivery_is_refused(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                WebhookRequest(method="POST", headers={}, query={}, body=b"{}")
            )

    async def test_a_get_is_refused(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                WebhookRequest(method="GET", headers={}, query={}, body=b"")
            )

    async def test_a_malformed_body_is_refused(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        with pytest.raises(WebhookPayloadError):
            adapter.parse_webhook(
                WebhookRequest(method="POST", headers={}, query={}, body=b"not json")
            )
        with pytest.raises(WebhookPayloadError):
            adapter.parse_webhook(
                _signed({"resource": "messages", "event": "created", "data": {}})
            )

    async def test_a_retried_delivery_carries_the_same_event_id(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        body = {
            "id": "hook",
            "resource": "messages",
            "event": "created",
            "data": {"id": "m-9"},
        }
        first = adapter.parse_webhook(_signed(body))
        second = adapter.parse_webhook(_signed(body))
        assert (
            first.external_event_id
            == second.external_event_id
            == "messages:created:m-9"
        )
        assert first.envelope_type == "messages:created"
        assert first.answers_inline is False


# ── Inbound ──────────────────────────────────────────────────────────────────


def _delivery(resource: str, event: str, **data: Any) -> dict[str, Any]:
    return {"resource": resource, "event": event, "data": data}


def _tag(person: str, name: str, kind: str = "person") -> str:
    """A mention as the live API returns it, in `markdown` and `html` alike."""
    return (
        f'<spark-mention data-object-type="{kind}" data-object-id="{person}">'
        f"{name}</spark-mention>"
    )


class TestInbound:
    @pytest.mark.parametrize(
        ("markdown", "expected"),
        [
            (
                f"{_tag(BOT_ID, 'Switch Bot')} why did it **fail**?",
                "why did it **fail**?",
            ),
            (
                f"{_tag(BOT_ID, 'Switch Bot')} ask {_tag('person-2', 'Grace Hopper')}",
                "ask Grace Hopper",
            ),
            (
                f"{_tag(BOT_ID, 'Switch Bot')} tell {_tag('all-1', 'All', 'groupMention')}",
                "tell All",
            ),
        ],
    )
    async def test_mentions_in_markdown_arrive_as_plain_text(
        self, webex: FakeWebex, markdown: str, expected: str
    ) -> None:
        adapter, received = await _started(webex)
        _serve_message(webex, _message(markdown=markdown, html=f"<p>{markdown}</p>"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId="person-1"),
        )
        [message] = received.messages
        assert message.content == expected

    async def test_a_command_after_the_bots_mention_is_a_command(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        markdown = f"{_tag(BOT_ID, 'Switch Bot')} !invite-agent @claude"
        _serve_message(webex, _message(markdown=markdown, html=f"<p>{markdown}</p>"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId="person-1"),
        )
        [command] = received.commands
        assert command.command == "invite-agent"
        assert not received.messages

    async def test_a_message_reaches_the_room_without_the_bots_mention(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        _serve_message(
            webex,
            _message(
                text="Switch Bot @claude look at the build",
                markdown="Switch Bot @claude look at the **build**",
                html=f'<p><spark-mention data-object-type="person" data-object-id="{BOT_ID}">Switch Bot</spark-mention> @claude look at the <strong>build</strong></p>',
                parentId="root-1",
            ),
        )
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId="person-1"),
        )
        [message] = received.messages
        assert message.content == "@claude look at the **build**"
        assert message.channel_id == "room-1"
        assert message.channel_type == "channel_private"
        assert message.sender_id == "person-1"
        assert message.sender_name == "Ada Lovelace"
        assert message.message_ref == "msg-1"
        assert message.root_id == "root-1"

    async def test_a_direct_space_is_a_direct_conversation(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        _serve_message(webex, _message(roomType="direct", text="hello"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId="person-1"),
        )
        assert received.messages[0].channel_type == "direct"

    async def test_the_bots_own_messages_are_ignored(self, webex: FakeWebex) -> None:
        adapter, received = await _started(webex)
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId=BOT_ID),
        )
        assert received.messages == []
        assert not webex.sent("GET", "/v1/messages/msg-1")

    async def test_a_bang_command_is_a_command(self, webex: FakeWebex) -> None:
        adapter, received = await _started(webex)
        _serve_message(webex, _message(roomType="direct", text="!invite-agent claude"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId="person-1"),
        )
        [command] = received.commands
        assert (command.command, command.args) == ("invite-agent", "claude")
        assert command.message_ref == "msg-1"
        assert received.messages == []

    async def test_a_room_is_named_after_its_space(self, webex: FakeWebex) -> None:
        adapter, received = await _started(webex)
        webex.route("GET", "/v1/rooms/room-1", lambda r: _ok({"title": "Support Desk"}))
        _serve_message(webex, _message(text="!help"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId="person-1"),
        )
        _serve_message(webex, _message(id="msg-2", text="good morning"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-2", personId="person-1"),
        )
        assert received.commands[0].channel_name == "Support Desk"
        assert received.messages[0].channel_name == "Support Desk"
        assert len(webex.sent("GET", "/v1/rooms/room-1")) == 1

    async def test_a_space_the_bot_is_added_to_names_its_room(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        webex.route("GET", "/v1/rooms/room-1", lambda r: _ok({"title": "Support Desk"}))
        await adapter.dispatch_event(
            envelope_type="memberships:created",
            payload=_delivery(
                "memberships",
                "created",
                id="membership-1",
                roomId="room-1",
                roomType="group",
                personId=BOT_ID,
            ),
        )
        [join] = received.app_joins
        assert join.channel_name == "Support Desk"

    async def test_a_message_still_arrives_when_webex_wont_say_the_title(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        _serve_message(webex, _message(text="good morning"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId="person-1"),
        )
        assert received.messages[0].channel_name is None

    async def test_a_file_link_off_webex_never_gets_the_token(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        url = "https://files.example.test/stolen"
        _serve_message(webex, _message(roomType="direct", text="see", files=[url]))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload={"data": {"id": "msg-1", "personId": "person-1"}},
        )
        [message] = received.messages
        assert message.attachments == []
        [failure] = message.attachment_failures
        assert "files.example.test" in failure.reason
        assert not [c for c in webex.calls if c.url.host == "files.example.test"]

    async def test_a_lookalike_host_is_not_webex(self, webex: FakeWebex) -> None:
        adapter, received = await _started(webex)
        url = "https://webexapis.com.example.test/v1/contents/x"
        _serve_message(webex, _message(roomType="direct", text="see", files=[url]))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload={"data": {"id": "msg-1", "personId": "person-1"}},
        )
        assert received.messages[0].attachment_failures

    async def test_a_group_message_naming_nobody_is_for_the_rooms_agent(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        _serve_message(webex, _message(roomType="group", text="why did it fail?"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload={"data": {"id": "msg-1", "personId": "person-1"}},
        )
        assert received.messages[0].self_mention_token == "switch-bot"

    async def test_a_group_message_naming_an_agent_says_who_it_is_for(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        _serve_message(webex, _message(roomType="group", text="@claude why?"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload={"data": {"id": "msg-1", "personId": "person-1"}},
        )
        assert received.messages[0].self_mention_token is None

    async def test_a_direct_message_is_for_the_rooms_agent_too(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        _serve_message(webex, _message(roomType="direct", text="hello"))
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload={"data": {"id": "msg-1", "personId": "person-1"}},
        )
        assert received.messages[0].self_mention_token == "switch-bot"

    async def test_a_file_is_relayed(self, webex: FakeWebex) -> None:
        adapter, received = await _started(webex)
        url = "https://webexapis.com/v1/contents/file-1"
        _serve_message(webex, _message(roomType="direct", text="", files=[url]))
        headers = {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="notes.txt"',
            "content-length": "5",
        }
        webex.route(
            "HEAD",
            "/v1/contents/file-1",
            lambda r: httpx.Response(200, headers=headers),
        )
        webex.route(
            "GET",
            "/v1/contents/file-1",
            lambda r: httpx.Response(200, headers=headers, content=b"hello"),
        )
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId="person-1"),
        )
        [message] = received.messages
        [attachment] = message.attachments
        assert (attachment.filename, attachment.mimetype, attachment.data) == (
            "notes.txt",
            "text/plain",
            b"hello",
        )

    async def test_an_oversized_file_is_refused_visibly(self, webex: FakeWebex) -> None:
        adapter, received = await _started(webex)
        adapter.set_max_attachment_bytes(1024)
        url = "https://webexapis.com/v1/contents/big"
        _serve_message(
            webex, _message(roomType="direct", text="see attached", files=[url])
        )
        webex.route(
            "HEAD",
            "/v1/contents/big",
            lambda r: httpx.Response(
                200,
                headers={
                    "content-disposition": 'attachment; filename="huge.zip"',
                    "content-length": str(50 * 1024 * 1024),
                },
            ),
        )
        await adapter.dispatch_event(
            envelope_type="messages:created",
            payload=_delivery("messages", "created", id="msg-1", personId="person-1"),
        )
        [message] = received.messages
        assert message.attachments == []
        [failure] = message.attachment_failures
        assert failure.filename == "huge.zip"
        assert "limit" in failure.reason
        assert not webex.sent("GET", "/v1/contents/big")

    async def test_a_card_press_is_an_interaction_from_whoever_pressed(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        webex.route(
            "GET",
            "/v1/attachment/actions/act-1",
            lambda r: _ok(
                {
                    "id": "act-1",
                    "type": "submit",
                    "messageId": "card-msg",
                    "personId": "person-2",
                    "roomId": "room-1",
                    "inputs": {
                        "switch_action": position_action(2),
                        "switch_value": "tok-1",
                    },
                }
            ),
        )
        webex.route(
            "GET", "/v1/people/person-2", lambda r: _ok({"displayName": "Grace"})
        )
        await adapter.dispatch_event(
            envelope_type="attachmentActions:created",
            payload=_delivery("attachmentActions", "created", id="act-1"),
        )
        [press] = received.interactions
        assert (press.sender_id, press.sender_name) == ("person-2", "Grace")
        assert (press.action_id, press.value) == (position_action(2), "tok-1")
        assert press.message_ref == "card-msg"

    async def test_the_bot_joining_a_space_is_an_app_join(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        await adapter.dispatch_event(
            envelope_type="memberships:created",
            payload=_delivery(
                "memberships",
                "created",
                id="mem-1",
                roomId="room-1",
                personId=BOT_ID,
                roomType="group",
            ),
        )
        assert [j.channel_id for j in received.app_joins] == ["room-1"]

    async def test_a_person_joining_a_space_is_a_user_join(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        await adapter.dispatch_event(
            envelope_type="memberships:created",
            payload=_delivery(
                "memberships",
                "created",
                id="mem-2",
                roomId="room-1",
                personId="person-3",
                personDisplayName="Linus",
                roomType="group",
            ),
        )
        [join] = received.user_joins
        assert (join.external_user_id, join.external_username) == ("person-3", "Linus")


class TestCatchUp:
    async def test_recent_messages_are_replayed_after_a_restart(
        self, webex: FakeWebex
    ) -> None:
        adapter, received = await _started(webex)
        stale = (
            (datetime.now(UTC) - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
        )
        recent = [
            _message(id="new", text="still here"),
            _message(id="old", text="long ago", created=stale),
        ]
        webex.route("GET", "/v1/messages", lambda r: _ok({"items": recent}))
        webex.route("GET", "/v1/people/person-1", lambda r: _ok({"displayName": "Ada"}))
        await adapter.ensure_channel_subscriptions([("room-1", "channel_private")])
        assert [m.message_ref for m in received.messages] == ["new"]
        [listing] = webex.sent("GET", "/v1/messages")
        assert listing.url.params["mentionedPeople"] == "me"


# ── Outbound ─────────────────────────────────────────────────────────────────


class TestOutbound:
    async def test_a_reply_is_attributed_and_threaded(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        webex.route("POST", "/v1/messages", lambda r: _ok({"id": "out-1"}))
        ref = await adapter.send_message(
            "room-1", "claude", "Done, see **logs**", "root-1"
        )
        assert ref == "out-1"
        [post] = webex.sent("POST", "/v1/messages")
        body = json.loads(post.content)
        assert body["roomId"] == "room-1"
        assert body["parentId"] == "root-1"
        first, rest = body["markdown"].split("\n", 1)
        assert "**claude**" in first
        assert rest == "Done, see **logs**"

    async def test_a_long_reply_is_split_and_the_first_part_is_the_ref(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        ids = iter(["part-1", "part-2", "part-3"])
        webex.route("POST", "/v1/messages", lambda r: _ok({"id": next(ids)}))
        long = "\n\n".join(["paragraph " * 80] * 20)
        ref = await adapter.send_message("room-1", "claude", long)
        posts = webex.sent("POST", "/v1/messages")
        assert ref == "part-1"
        assert len(posts) > 1
        assert all(
            len(json.loads(p.content)["markdown"].encode()) <= 7439 for p in posts
        )

    async def test_an_edit_keeps_the_agents_name(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "GET",
            "/v1/messages/out-1",
            lambda r: _ok(
                {"id": "out-1", "markdown": "\U0001f535 **claude**\nold text"}
            ),
        )
        webex.route("PUT", "/v1/messages/out-1", lambda r: _ok({"id": "out-1"}))
        await adapter.update_message("room-1", "out-1", "new text")
        [edit] = webex.sent("PUT", "/v1/messages/out-1")
        assert json.loads(edit.content) == {
            "roomId": "room-1",
            "markdown": "\U0001f535 **claude**\nnew text",
        }

    async def test_deleting_a_message_already_gone_is_not_an_error(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "DELETE",
            "/v1/messages/gone",
            lambda r: httpx.Response(404, json={"message": "not found"}),
        )
        await adapter.delete_message("room-1", "gone")

    async def test_a_file_is_uploaded_with_its_caption(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        webex.route("POST", "/v1/messages", lambda r: _ok({"id": "file-msg"}))
        ref = await adapter.send_attachment(
            "room-1",
            "claude",
            "report.txt",
            "text/plain",
            b"data",
            caption="Here it is",
        )
        assert ref == "file-msg"
        [post] = webex.sent("POST", "/v1/messages")
        assert post.headers["content-type"].startswith("multipart/form-data")
        assert b'filename="report.txt"' in post.content
        assert b"Here it is" in post.content

    async def test_an_outbound_mention_of_a_known_person_notifies_them(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        adapter.prime_mention_targets({"ada": "person-1"})
        assert (
            adapter.translate_outbound("thanks @ada")
            == "thanks <@personId:person-1|ada>"
        )
        assert adapter.translate_outbound("thanks @nobody") == "thanks @nobody"


class TestThreads:
    async def test_a_reply_to_a_reply_lands_in_the_same_thread(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)

        def post(request: httpx.Request) -> httpx.Response:
            if json.loads(request.content)["parentId"] == "reply-1":
                return _refused(
                    'Unable to post message to room: "Cannot reply to a reply"'
                )
            return _ok({"id": "m2"})

        webex.route("POST", "/v1/messages", post)
        webex.route(
            "GET",
            "/v1/messages/reply-1",
            lambda r: _ok({"id": "reply-1", "parentId": "root-1"}),
        )
        assert await adapter.send_message("room-1", "claude", "hi", "reply-1") == "m2"
        last = json.loads(webex.sent("POST", "/v1/messages")[-1].content)
        assert last["parentId"] == "root-1"

    async def test_a_rate_limited_message_is_sent_after_the_wait(
        self, webex: FakeWebex, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, _ = await _started(webex)
        answers = iter(
            [
                httpx.Response(429, headers={"retry-after": "3"}, json={}),
                _ok({"id": "m1"}),
            ]
        )
        webex.route("POST", "/v1/messages", lambda r: next(answers))
        waited: list[float] = []

        async def sleep(seconds: float) -> None:
            waited.append(seconds)

        monkeypatch.setattr(webex_module.asyncio, "sleep", sleep)
        assert await adapter.send_message("room-1", "claude", "hi", None) == "m1"
        assert waited == [3]


def _settled_card() -> RequestCard:
    return RequestCard(
        open_request(),
        RequestReference(token="tok-1", handle="R7"),
        unavailable_reason="Answered in Console.",
    )


class TestCards:
    async def test_an_open_request_gets_a_button_per_option(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("POST", "/v1/messages", lambda r: _ok({"id": "card-1"}))
        request = open_request()
        card = RequestCard(request, RequestReference(token="tok-1", handle="R7"))
        ref = await adapter.post_rich("room-1", "claude", card, "root-1")
        assert ref == "card-1"
        body = json.loads(webex.sent("POST", "/v1/messages")[0].content)
        assert body["parentId"] == "root-1"
        assert "R7" in body["markdown"]
        [attachment] = body["attachments"]
        assert attachment["contentType"] == "application/vnd.microsoft.card.adaptive"
        actions = attachment["content"]["actions"]
        assert actions, "an open request offers at least one button"
        for position, action in enumerate(actions, start=1):
            assert action["type"] == "Action.Submit"
            assert action["data"] == {
                "switch_action": position_action(position),
                "switch_value": "tok-1",
            }

    async def test_a_refused_post_is_a_rich_content_failure(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "POST",
            "/v1/messages",
            lambda r: httpx.Response(400, json={"message": "bad card"}),
        )
        card = RequestCard(open_request(), RequestReference(token="tok-1", handle="R7"))
        with pytest.raises(RichContentFailed, match="bad card"):
            await adapter.post_rich("room-1", "claude", card)

    async def test_redrawing_an_open_card_keeps_its_buttons(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("PUT", "/v1/messages/card-1", lambda r: _ok({"id": "card-1"}))
        card = RequestCard(open_request(), RequestReference(token="tok-1", handle="R7"))
        await adapter.update_rich("room-1", "claude", "card-1", card, None)
        body = json.loads(webex.sent("PUT", "/v1/messages/card-1")[0].content)
        assert body["attachments"][0]["content"]["actions"]

    async def test_a_card_that_cannot_be_answered_loses_its_buttons(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("PUT", "/v1/messages/card-1", lambda r: _ok({"id": "card-1"}))
        card = RequestCard(
            open_request(),
            RequestReference(token="tok-1", handle="R7"),
            unavailable_reason="Answer this one in Console.",
        )
        await adapter.update_rich("room-1", "claude", "card-1", card, None)
        body = json.loads(webex.sent("PUT", "/v1/messages/card-1")[0].content)
        assert "attachments" not in body
        assert "Answer this one in Console." in body["markdown"]

    async def test_an_answered_card_stays_as_the_record(self) -> None:
        assert WebexAdapter.removes_answered_cards is False

    async def test_a_card_names_who_it_is_waiting_on(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        webex.route("POST", "/v1/messages", lambda r: _ok({"id": "card-1"}))
        webex.route(
            "GET", "/v1/people/person-1", lambda r: _ok({"displayName": "Ada Lovelace"})
        )
        card = RequestCard(
            open_request(),
            RequestReference(token="tok-1", handle="R7"),
            notify_external_id="person-1",
        )
        await adapter.post_rich("room-1", "claude", card)
        drawn, notice = (
            json.loads(c.content) for c in webex.sent("POST", "/v1/messages")
        )
        assert "Ada Lovelace" in drawn["markdown"]
        assert "<@" not in drawn["markdown"]
        assert "<@personId:person-1|Ada Lovelace>" in notice["markdown"]
        assert notice["parentId"] == "card-1"
        assert "attachments" not in notice

    async def test_a_redrawn_card_carries_no_mention(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        webex.route("PUT", "/v1/messages/card-1", lambda r: _ok({"id": "card-1"}))
        webex.route(
            "GET", "/v1/people/person-1", lambda r: _ok({"displayName": "Ada Lovelace"})
        )
        card = RequestCard(
            open_request(),
            RequestReference(token="tok-1", handle="R7"),
            notify_external_id="person-1",
        )
        await adapter.update_rich("room-1", "claude", "card-1", card, None)
        body = json.loads(webex.sent("PUT", "/v1/messages/card-1")[0].content)
        assert body["attachments"]
        assert "<@" not in body["markdown"]

    async def test_an_answered_cards_notice_is_taken_down_by_any_pod(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex, listening=False)
        webex.route("PUT", "/v1/messages/card-2", lambda r: _ok({"id": "card-2"}))
        webex.route("DELETE", "/v1/messages/notice-2", lambda r: httpx.Response(204))
        notice = f"@Ada {_NOTICE}"
        webex.route(
            "GET",
            "/v1/messages",
            lambda r: _ok(
                {
                    "items": [
                        {"id": "notice-2", "personId": BOT_ID, "text": notice},
                        {"id": "card-2", "personId": BOT_ID, "text": "card"},
                        {"id": "notice-1", "personId": BOT_ID, "text": notice},
                        {"id": "card-1", "personId": BOT_ID, "text": "card"},
                    ]
                }
            ),
        )
        card = _settled_card()
        await adapter.update_rich("room-1", "claude", "card-2", card, "root-1")

        [listed] = webex.sent("GET", "/v1/messages")
        assert listed.url.params["parentId"] == "root-1"
        assert len(webex.sent("DELETE", "/v1/messages/notice-2")) == 1
        assert webex.sent("DELETE", "/v1/messages/notice-1") == []

    async def test_a_person_quoting_the_notice_is_left_alone(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("PUT", "/v1/messages/card-1", lambda r: _ok({"id": "card-1"}))
        webex.route(
            "GET",
            "/v1/messages",
            lambda r: _ok(
                {"items": [{"id": "said", "personId": "person-1", "text": _NOTICE}]}
            ),
        )
        card = _settled_card()
        await adapter.update_rich("room-1", "claude", "card-1", card, None)
        assert [c for c in webex.calls if c.method == "DELETE"] == []

    async def test_a_notice_that_cannot_be_found_fails_nothing(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("PUT", "/v1/messages/card-1", lambda r: _ok({"id": "card-1"}))
        card = _settled_card()
        await adapter.update_rich("room-1", "claude", "card-1", card, None)
        assert len(webex.sent("PUT", "/v1/messages/card-1")) == 1

    async def test_a_lost_notice_does_not_fail_a_card_that_is_up(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)

        def post(request: httpx.Request) -> httpx.Response:
            if b"attachments" in request.content:
                return _ok({"id": "card-1"})
            raise httpx.ConnectError("gone")

        webex.route("POST", "/v1/messages", post)
        webex.route(
            "GET", "/v1/people/person-1", lambda r: _ok({"displayName": "Ada Lovelace"})
        )
        card = RequestCard(
            open_request(),
            RequestReference(token="tok-1", handle="R7"),
            notify_external_id="person-1",
        )
        assert await adapter.post_rich("room-1", "claude", card) == "card-1"

    async def test_a_rate_limit_is_a_wait_not_a_refusal(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "POST",
            "/v1/messages",
            lambda r: httpx.Response(429, headers={"retry-after": "12"}, json={}),
        )
        card = RequestCard(open_request(), RequestReference(token="tok-1", handle="R7"))
        with pytest.raises(RichContentThrottled) as caught:
            await adapter.post_rich("room-1", "claude", card)
        assert caught.value.retry_after == 12

    async def test_a_post_whose_outcome_is_unknown_keeps_the_reservation(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "POST",
            "/v1/messages",
            lambda r: httpx.Response(502, json={"message": "bad gateway"}),
        )
        card = RequestCard(open_request(), RequestReference(token="tok-1", handle="R7"))
        with pytest.raises(WebexAPIError):
            await adapter.post_rich("room-1", "claude", card)

    async def test_a_deleted_thread_root_is_reported_as_no_thread(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "POST",
            "/v1/messages",
            lambda r: _refused(
                'Unable to post message to room: "Parent activity has been deleted"'
            ),
        )
        card = RequestCard(open_request(), RequestReference(token="tok-1", handle="R7"))
        with pytest.raises(ThreadUnavailable):
            await adapter.post_rich("room-1", "claude", card, "gone")


def _status(state: str = "running") -> TurnActivity:
    turn = TurnUpsert.model_validate(
        {"type": "turn.upsert", "turn_id": "t1", "status": state, "command_id": None}
    )
    return TurnActivity([], turn)


class TestTurnStatus:
    @pytest.fixture
    def clock(self, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
        now = SimpleNamespace(value=1000.0)
        monkeypatch.setattr(
            webex_module,
            "time",
            SimpleNamespace(monotonic=lambda: now.value, time=time.time),
        )
        return now

    def test_the_platform_draws_session_activity(self) -> None:
        assert WebexAdapter.draws_session_activity is True
        assert WebexAdapter.redraws_for_elapsed_time is False

    async def test_a_status_is_posted_with_no_buttons(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        webex.route("POST", "/v1/messages", lambda r: _ok({"id": "status-1"}))
        assert await adapter.post_rich("room-1", "claude", _status(), "root-1") == (
            "status-1"
        )
        body = json.loads(webex.sent("POST", "/v1/messages")[0].content)
        assert body["parentId"] == "root-1"
        assert "attachments" not in body

    async def test_a_problem_is_said_with_the_person_it_needs(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("POST", "/v1/messages", lambda r: _ok({"id": "attention-1"}))
        webex.route("GET", "/v1/people/person-1", lambda r: _ok({"displayName": "Ada"}))
        activity = replace(
            _status(),
            error_summary="The agent is signed out.",
            notify_external_id="person-1",
        )
        await adapter.post_rich("room-1", "claude", activity)
        markdown = json.loads(webex.sent("POST", "/v1/messages")[0].content)["markdown"]
        assert "The agent is signed out." in markdown
        assert "<@personId:person-1|Ada>" in markdown

    async def test_a_long_turn_always_keeps_an_edit_for_its_final_state(
        self, webex: FakeWebex, clock: SimpleNamespace
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("PUT", "/v1/messages/s1", lambda r: _ok({"id": "s1"}))
        for _step in range(40):
            clock.value += 3600
            await adapter.update_rich("room-1", "claude", "s1", _status(), None)
        assert len(webex.sent("PUT", "/v1/messages/s1")) == 9
        await adapter.update_rich("room-1", "claude", "s1", _status("completed"), None)
        assert len(webex.sent("PUT", "/v1/messages/s1")) == 10

    async def test_a_busy_turn_spends_its_edits_further_and_further_apart(
        self, webex: FakeWebex, clock: SimpleNamespace
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("PUT", "/v1/messages/s1", lambda r: _ok({"id": "s1"}))
        await adapter.update_rich("room-1", "claude", "s1", _status(), None)
        await adapter.update_rich("room-1", "claude", "s1", _status(), None)
        assert len(webex.sent("PUT", "/v1/messages/s1")) == 1
        clock.value += 2
        await adapter.update_rich("room-1", "claude", "s1", _status(), None)
        assert len(webex.sent("PUT", "/v1/messages/s1")) == 2
        clock.value += 2
        await adapter.update_rich("room-1", "claude", "s1", _status(), None)
        assert len(webex.sent("PUT", "/v1/messages/s1")) == 2

    async def test_a_final_state_is_never_passed_over(
        self, webex: FakeWebex, clock: SimpleNamespace
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("PUT", "/v1/messages/s1", lambda r: _ok({"id": "s1"}))
        await adapter.update_rich("room-1", "claude", "s1", _status(), None)
        await adapter.update_rich("room-1", "claude", "s1", _status("error"), None)
        assert len(webex.sent("PUT", "/v1/messages/s1")) == 2

    async def test_a_message_out_of_edits_is_wedged_once_and_then_left_alone(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "PUT",
            "/v1/messages/s1",
            lambda r: _refused(
                'Unable to post message to room: "Max allowed number of edits per '
                'activity reached"'
            ),
        )
        with pytest.raises(RichContentWedged):
            await adapter.update_rich(
                "room-1", "claude", "s1", _status("completed"), None
            )
        await adapter.update_rich("room-1", "claude", "s1", _status("completed"), None)
        assert len(webex.sent("PUT", "/v1/messages/s1")) == 1


class TestSpaces:
    async def test_a_new_space_gets_its_topic_as_the_first_message(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route("POST", "/v1/rooms", lambda r: _ok({"id": "room-new"}))
        webex.route("POST", "/v1/messages", lambda r: _ok({"id": "m"}))
        assert (
            await adapter.create_channel("incident-42", "Payments are down")
            == "room-new"
        )
        assert json.loads(webex.sent("POST", "/v1/rooms")[0].content) == {
            "title": "incident-42"
        }
        assert (
            json.loads(webex.sent("POST", "/v1/messages")[0].content)["markdown"]
            == "Payments are down"
        )

    async def test_people_who_cannot_be_added_are_handed_back(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)

        def membership(request: httpx.Request) -> httpx.Response:
            person = json.loads(request.content)["personId"]
            if person == "p-bad":
                return httpx.Response(403, json={"message": "not allowed"})
            if person == "p-dup":
                return httpx.Response(409, json={"message": "already a member"})
            return _ok({"id": "mem"})

        webex.route("POST", "/v1/memberships", membership)
        left = await adapter.add_users_to_channel(
            "room-1", ["ok", "bad", "dup"], ["p-ok", "p-bad", "p-dup"]
        )
        assert left == ["p-bad"]


class TestDirectory:
    async def test_a_name_search_in_a_free_org_explains_itself(
        self, webex: FakeWebex
    ) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "GET",
            "/v1/people",
            lambda r: httpx.Response(
                400,
                json={
                    "message": "DisplayName lookups cannot be used in the Consumer org."
                },
            ),
        )
        with pytest.raises(NotImplementedError, match="full email address"):
            await adapter.search_directory_users("Ada")

    async def test_an_email_search_finds_the_person(self, webex: FakeWebex) -> None:
        adapter, _ = await _started(webex)
        webex.route(
            "GET",
            "/v1/people",
            lambda r: _ok(
                {
                    "items": [
                        {
                            "id": "p1",
                            "displayName": "Ada",
                            "emails": ["ada@example.test"],
                            "type": "person",
                        },
                        {"id": "b1", "displayName": "Some Bot", "type": "bot"},
                    ]
                }
            ),
        )
        [person] = await adapter.search_directory_users("ada@example.test")
        assert (person.external_user_id, person.email) == ("p1", "ada@example.test")
        assert (
            webex.sent("GET", "/v1/people")[0].url.params["email"] == "ada@example.test"
        )
