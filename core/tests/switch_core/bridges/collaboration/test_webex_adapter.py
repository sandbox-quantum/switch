"""Webex: the API is mocked at the HTTP transport, as the guide asks."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.webex import adapter as adapter_module
from switch_core.bridges.collaboration.webex.adapter import (
    WebexAdapter,
    WebexConnectionConfig,
    handle_of,
)
from switch_core.bridges.collaboration.webex.chunking import chunk_message
from switch_core.bridges.collaboration.webex.client import WebexAPIError

TOKEN = "placeholder-bot-token-value"  # gitleaks:allow
SECRET = "placeholder-webhook-secret"  # gitleaks:allow
BOT_ID = "BOT-PERSON-ID"
ROOM = "ROOM-ID"
TARGET = "https://switch.test/messaging/bridges/b1/events"
CONFIG = {"bot_token": TOKEN, "webhook_secret": SECRET}
ME = {
    "id": BOT_ID,
    "type": "bot",
    "displayName": "Switch Bot",
    "emails": ["switchbot@webex.bot"],
}


def _json(data: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=data)


class Webex:
    """Records every request and answers from `routes`: `(method, regex)` to a
    response or a function of the request. Anything unrouted is a 404."""

    def __init__(self, routes: dict[tuple[str, str], Any] | None = None) -> None:
        self.routes: dict[tuple[str, str], Any] = {
            ("GET", r"/v1/people/me"): ME,
            ("POST", r"/v1/messages"): {"id": "MSG-SENT"},
            ("GET", r"/v1/rooms/.*"): {"id": ROOM, "title": "ops", "type": "group"},
        }
        self.routes.update(routes or {})
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for (method, pattern), answer in self.routes.items():
            if request.method == method and re.fullmatch(pattern, request.url.path):
                if callable(answer):
                    return answer(request)  # type: ignore[no-any-return]
                if isinstance(answer, httpx.Response):
                    return answer
                return _json(answer)
        return _json({"message": f"unrouted {request.method} {request.url.path}"}, 404)

    def bodies(self, method: str, path: str) -> list[dict[str, Any]]:
        return [
            json.loads(r.content)
            for r in self.requests
            if r.method == method and re.fullmatch(path, r.url.path)
        ]

    def calls(self, method: str) -> list[str]:
        return [r.url.path for r in self.requests if r.method == method]


class Inbound:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.users: list[InboundUserJoin] = []
        self.apps: list[InboundAppJoin] = []

    async def message(self, m: InboundMessage) -> None:
        self.messages.append(m)

    async def command(self, c: InboundCommand) -> None:
        self.commands.append(c)

    async def user(self, u: InboundUserJoin) -> None:
        self.users.append(u)

    async def app(self, a: InboundAppJoin) -> None:
        self.apps.append(a)

    async def agent(self, _: Any) -> None:
        return None


async def connect(
    monkeypatch: pytest.MonkeyPatch,
    server: Webex,
    *,
    listening: bool = False,
    url: str | None = TARGET,
    max_attachment_bytes: int | None = None,
) -> tuple[WebexAdapter, Inbound]:
    monkeypatch.setattr(
        adapter_module,
        "_new_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(server)),
    )
    adapter = WebexAdapter(config=WebexConnectionConfig.model_validate(CONFIG))
    adapter.set_bridge_id("b1")
    adapter.set_webhook_url(url)
    adapter.set_listening(listening)
    if max_attachment_bytes is not None:
        adapter.set_max_attachment_bytes(max_attachment_bytes)
    inbound = Inbound()
    await adapter.start(
        inbound.message, inbound.command, inbound.agent, inbound.user, inbound.app
    )
    return adapter, inbound


def message(
    message_id: str = "M1", text: str = "hello", **extra: Any
) -> dict[str, Any]:
    return {
        "id": message_id,
        "roomId": ROOM,
        "roomType": "group",
        "personId": "ALICE-ID",
        "personEmail": "alice@acme.com",
        "text": text,
        **extra,
    }


def delivery(message_id: str = "M1", person_id: str = "ALICE-ID") -> dict[str, Any]:
    return {"id": message_id, "roomId": ROOM, "personId": person_id}


def request(
    body: dict[str, Any], secret: str = SECRET, **headers: str
) -> WebhookRequest:
    raw = json.dumps(body).encode()
    signature = hmac.new(secret.encode(), raw, hashlib.sha1).hexdigest()
    return WebhookRequest(
        method="POST",
        headers={"x-spark-signature": signature, **headers},
        query={},
        body=raw,
    )


# ── Config and credentials ───────────────────────────────────────────────────


class TestConfig:
    def test_a_token_is_required_and_never_echoed(self) -> None:
        with pytest.raises(ValueError) as raised:
            WebexConnectionConfig.model_validate({"bot_token": "  "})
        assert "bot_token is required" in str(raised.value)

    def test_the_webhook_secret_is_not_on_the_form(self) -> None:
        properties = WebexConnectionConfig.model_json_schema()["properties"]
        assert "bot_token" in properties
        assert "webhook_secret" not in properties

    async def test_the_secret_is_minted_once_and_kept(self) -> None:
        prepared = await WebexAdapter.prepare_config({"bot_token": TOKEN})
        assert len(str(prepared["webhook_secret"])) >= 32
        assert (await WebexAdapter.prepare_config(prepared)) == prepared

    def test_people_are_addressed_by_the_local_part_of_their_email(self) -> None:
        assert handle_of("alice@acme.com") == "alice"
        assert handle_of("a b+c@acme.com") == "a_b_c"


class TestCredentials:
    def patch(self, monkeypatch: pytest.MonkeyPatch, server: Webex) -> None:
        monkeypatch.setattr(
            adapter_module,
            "_new_http",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(server)),
        )

    async def test_a_bots_token_passes_and_is_sent_only_as_a_header(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex()
        self.patch(monkeypatch, server)
        await WebexAdapter.verify_credentials(dict(CONFIG))
        assert server.requests[0].headers["authorization"] == f"Bearer {TOKEN}"
        assert TOKEN not in str(server.requests[0].url)

    async def test_a_refused_token_is_a_credential_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self.patch(
            monkeypatch,
            Webex({("GET", r"/v1/people/me"): _json({"message": "bad"}, 401)}),
        )
        with pytest.raises(BridgeCredentialError) as raised:
            await WebexAdapter.verify_credentials(dict(CONFIG))
        assert "rejected the bot token" in str(raised.value)
        assert TOKEN not in str(raised.value)

    async def test_a_persons_token_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self.patch(
            monkeypatch,
            Webex({("GET", r"/v1/people/me"): {"id": "P", "type": "person"}}),
        )
        with pytest.raises(BridgeCredentialError, match="not a bot"):
            await WebexAdapter.verify_credentials(dict(CONFIG))

    async def test_an_unreachable_webex_is_said_to_be_unreachable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down", request=request)

        monkeypatch.setattr(
            adapter_module,
            "_new_http",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(refuse)),
        )
        with pytest.raises(BridgeCredentialError, match="Could not reach"):
            await WebexAdapter.verify_credentials(dict(CONFIG))

    def test_failures_are_classified_by_status_and_type(self) -> None:
        assert WebexAdapter.classify_failure(WebexAPIError(401, "")) == "auth_failed"
        assert WebexAdapter.classify_failure(WebexAPIError(400, "")) == "platform_error"
        assert WebexAdapter.classify_failure(httpx.ConnectError("x")) == "network"
        assert WebexAdapter.classify_failure(ValueError("x")) is None

    async def test_the_token_never_reaches_the_log(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.DEBUG)
        server = Webex({("PUT", r"/v1/messages/.*"): _json({"message": "nope"}, 403)})
        adapter, _ = await connect(monkeypatch, server)
        await adapter.update_message(ROOM, "M1", "x")
        assert TOKEN not in caplog.text


# ── Webhooks ─────────────────────────────────────────────────────────────────


class TestWebhookAuthenticity:
    def adapter(self, secret: str | None = SECRET) -> WebexAdapter:
        config = {"bot_token": TOKEN, "webhook_secret": secret}
        return WebexAdapter(config=WebexConnectionConfig.model_validate(config))

    async def test_a_correctly_signed_request_is_accepted(self) -> None:
        body = {"resource": "messages", "event": "created", "data": delivery()}
        await self.adapter().verify_webhook(request(body))

    async def test_the_signature_header_is_case_insensitive_hex(self) -> None:
        body = {"resource": "messages", "event": "created", "data": delivery()}
        signed = request(body)
        upper = WebhookRequest(
            method="POST",
            headers={"x-spark-signature": signed.headers["x-spark-signature"].upper()},
            query={},
            body=signed.body,
        )
        await self.adapter().verify_webhook(upper)

    async def test_a_request_signed_with_another_secret_is_refused(self) -> None:
        body = {"resource": "messages", "event": "created", "data": delivery()}
        with pytest.raises(WebhookAuthenticityError):
            await self.adapter().verify_webhook(request(body, secret="another"))

    async def test_an_unsigned_request_and_a_get_are_refused(self) -> None:
        unsigned = WebhookRequest(method="POST", headers={}, query={}, body=b"{}")
        with pytest.raises(WebhookAuthenticityError):
            await self.adapter().verify_webhook(unsigned)
        get = WebhookRequest(method="GET", headers={}, query={}, body=b"")
        with pytest.raises(WebhookAuthenticityError):
            await self.adapter().verify_webhook(get)

    async def test_a_connection_without_a_secret_accepts_nothing(self) -> None:
        body = {"resource": "messages", "event": "created", "data": delivery()}
        with pytest.raises(WebhookAuthenticityError):
            await self.adapter(secret=None).verify_webhook(request(body))


class TestWebhookParsing:
    def adapter(self) -> WebexAdapter:
        return WebexAdapter(config=WebexConnectionConfig.model_validate(CONFIG))

    def test_a_retried_delivery_carries_the_same_event_id(self) -> None:
        body = {
            "id": "WEBHOOK-ID",
            "resource": "messages",
            "event": "created",
            "data": delivery("M7"),
        }
        first = self.adapter().parse_webhook(request(body))
        second = self.adapter().parse_webhook(request(body))
        assert first.external_event_id == second.external_event_id == "messages:M7"
        assert first.envelope_type == "messages.created"
        assert (first.handshake, first.answers_inline) == (None, False)

    def test_a_message_and_a_membership_with_one_id_are_different_events(self) -> None:
        message_event = {
            "resource": "messages",
            "event": "created",
            "data": {"id": "X"},
        }
        member_event = {
            "resource": "memberships",
            "event": "created",
            "data": {"id": "X"},
        }
        a = self.adapter().parse_webhook(request(message_event))
        b = self.adapter().parse_webhook(request(member_event))
        assert a.external_event_id != b.external_event_id

    @pytest.mark.parametrize(
        "raw",
        [
            b"not json",
            b"[]",
            b'{"resource":"messages","event":"created"}',
            b'{"data":{"id":"1"}}',
        ],
    )
    def test_a_body_that_is_not_a_webex_event_is_refused(self, raw: bytes) -> None:
        with pytest.raises(WebhookPayloadError):
            self.adapter().parse_webhook(
                WebhookRequest(method="POST", headers={}, query={}, body=raw)
            )


# ── Registering the webhooks ─────────────────────────────────────────────────


class TestRegistration:
    async def test_without_a_public_address_the_bridge_refuses_to_start(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
            await connect(monkeypatch, Webex(), listening=True, url=None)

    async def test_the_holder_registers_what_it_needs_with_the_secret(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex(
            {
                ("GET", r"/v1/webhooks"): {"items": []},
                ("POST", r"/v1/webhooks"): {"id": "W"},
            }
        )
        await connect(monkeypatch, server, listening=True)
        created = server.bodies("POST", r"/v1/webhooks")
        assert {(c["resource"], c["event"]) for c in created} == {
            ("messages", "created"),
            ("memberships", "created"),
        }
        assert all(
            (c["targetUrl"], c["secret"], c["name"]) == (TARGET, SECRET, "Switch b1")
            for c in created
        )

    async def test_registering_again_updates_and_reactivates_and_removes_strays(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        existing = [
            {
                "id": "W1",
                "name": "Switch b1",
                "resource": "messages",
                "event": "created",
                "status": "inactive",
            },
            {
                "id": "W2",
                "name": "Switch b1",
                "resource": "messages",
                "event": "created",
                "status": "active",
            },
            {
                "id": "W3",
                "name": "Switch b1",
                "resource": "memberships",
                "event": "created",
                "status": "active",
            },
            {
                "id": "W4",
                "name": "Switch b1",
                "resource": "rooms",
                "event": "created",
                "status": "active",
            },
            {
                "id": "OTHER",
                "name": "someone else's",
                "resource": "messages",
                "event": "created",
            },
        ]
        server = Webex(
            {
                ("GET", r"/v1/webhooks"): {"items": existing},
                ("PUT", r"/v1/webhooks/.*"): {},
                ("DELETE", r"/v1/webhooks/.*"): httpx.Response(204),
            }
        )
        await connect(monkeypatch, server, listening=True)
        assert server.calls("POST") == []
        assert sorted(server.calls("PUT")) == ["/v1/webhooks/W1", "/v1/webhooks/W3"]
        assert all(
            b["status"] == "active" for b in server.bodies("PUT", r"/v1/webhooks/.*")
        )
        assert sorted(server.calls("DELETE")) == ["/v1/webhooks/W2", "/v1/webhooks/W4"]

    async def test_a_quiet_copy_registers_nothing_but_can_post(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex()
        adapter, _ = await connect(monkeypatch, server, listening=False)
        assert not any("/webhooks" in r.url.path for r in server.requests)
        assert await adapter.send_message(ROOM, "scout", "hi") == "MSG-SENT"

    async def test_removing_the_bridge_removes_its_webhooks_only(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex(
            {
                ("GET", r"/v1/webhooks"): {
                    "items": [
                        {"id": "MINE", "name": "Switch b1"},
                        {"id": "NOT", "name": "other"},
                    ]
                },
                ("DELETE", r"/v1/webhooks/.*"): httpx.Response(204),
            }
        )
        adapter, _ = await connect(monkeypatch, server, listening=False)
        await adapter.withdraw()
        assert server.calls("DELETE") == ["/v1/webhooks/MINE"]


# ── Inbound ──────────────────────────────────────────────────────────────────


class TestInbound:
    def routes(self, text: dict[str, Any]) -> dict[tuple[str, str], Any]:
        return {("GET", r"/v1/messages/.*"): text}

    async def test_a_mention_in_a_space_is_a_message_without_the_bots_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        text = message(
            text="Switch Bot @scout please look",
            mentionedPeople=[BOT_ID],
            parentId="ROOT",
        )
        adapter, inbound = await connect(monkeypatch, Webex(self.routes(text)))
        await adapter.dispatch_event(
            envelope_type="messages.created",
            payload={"data": delivery()},
        )
        sent = inbound.messages[0]
        assert sent.content == "@scout please look"
        assert (sent.root_id, sent.message_ref, sent.channel_name) == (
            "ROOT",
            "M1",
            "ops",
        )
        assert (sent.sender_name, sent.sender_id) == ("alice", "ALICE-ID")
        assert sent.channel_type == "channel_private"
        assert sent.self_mention_token == "switchbot"

    async def test_a_message_that_mentions_no_one_still_reaches_the_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, inbound = await connect(
            monkeypatch, Webex(self.routes(message(text="no mention here")))
        )
        await adapter.dispatch_event(
            envelope_type="messages.created", payload={"data": delivery()}
        )
        assert inbound.messages[0].content == "no mention here"
        assert inbound.messages[0].self_mention_token is None
        assert inbound.messages[0].root_id is None

    async def test_a_direct_space_is_direct(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex(
            {
                **self.routes(message()),
                ("GET", r"/v1/rooms/.*"): {"id": ROOM, "title": None, "type": "direct"},
            }
        )
        adapter, inbound = await connect(monkeypatch, server)
        await adapter.dispatch_event(
            envelope_type="messages.created", payload={"data": delivery()}
        )
        assert inbound.messages[0].channel_type == "direct"

    async def test_the_bots_own_message_is_not_fetched_or_relayed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex(self.routes(message()))
        adapter, inbound = await connect(monkeypatch, server)
        await adapter.dispatch_event(
            envelope_type="messages.created",
            payload={"data": delivery(person_id=BOT_ID)},
        )
        assert inbound.messages == []
        assert not any("/messages/" in r.url.path for r in server.requests)

    async def test_a_bang_command_is_a_command_in_its_thread(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        text = message(
            text="Switch Bot !invite-agent @scout",
            mentionedPeople=[BOT_ID],
            parentId="ROOT",
        )
        adapter, inbound = await connect(monkeypatch, Webex(self.routes(text)))
        await adapter.dispatch_event(
            envelope_type="messages.created", payload={"data": delivery()}
        )
        assert inbound.messages == []
        command = inbound.commands[0]
        assert (command.command, command.args, command.root_id) == (
            "invite-agent",
            "@scout",
            "ROOT",
        )

    async def test_another_bots_message_is_marked_as_an_app(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        text = message(personEmail="build@webex.bot")
        adapter, inbound = await connect(monkeypatch, Webex(self.routes(text)))
        await adapter.dispatch_event(
            envelope_type="messages.created", payload={"data": delivery()}
        )
        assert inbound.messages[0].sender_is_app is True

    async def test_a_file_is_downloaded_with_its_name_and_type(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex(
            {
                **self.routes(
                    message(text="", files=["https://webexapis.com/v1/contents/F1"])
                ),
                ("GET", r"/v1/contents/F1"): httpx.Response(
                    200,
                    content=b"data",
                    headers={
                        "content-disposition": 'attachment; filename="note.txt"',
                        "content-type": "text/plain; charset=utf-8",
                    },
                ),
            }
        )
        adapter, inbound = await connect(monkeypatch, server)
        await adapter.dispatch_event(
            envelope_type="messages.created", payload={"data": delivery()}
        )
        attachment = inbound.messages[0].attachments[0]
        assert (attachment.filename, attachment.mimetype, attachment.data) == (
            "note.txt",
            "text/plain",
            b"data",
        )

    async def test_an_oversize_file_is_reported_by_its_stated_size_or_as_it_arrives(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        files = [
            "https://webexapis.com/v1/contents/BIG",
            "https://webexapis.com/v1/contents/LIAR",
        ]
        server = Webex(
            {
                **self.routes(message(text="", files=files)),
                ("GET", r"/v1/contents/BIG"): httpx.Response(
                    200,
                    content=b"x" * 50,
                    headers={"content-disposition": 'attachment; filename="big.bin"'},
                ),
                ("GET", r"/v1/contents/LIAR"): lambda request: httpx.Response(
                    200,
                    content=b"y" * 50,
                    headers={"content-disposition": 'attachment; filename="liar.bin"'},
                ),
            }
        )
        adapter, inbound = await connect(monkeypatch, server, max_attachment_bytes=10)
        await adapter.dispatch_event(
            envelope_type="messages.created", payload={"data": delivery()}
        )
        sent = inbound.messages[0]
        assert sent.attachments == []
        assert [f.filename for f in sent.attachment_failures] == ["big.bin", "liar.bin"]
        assert "exceeds the 10 byte limit" in sent.attachment_failures[0].reason

    async def test_the_bot_being_added_is_an_app_join_and_a_person_a_user_join(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, inbound = await connect(monkeypatch, Webex())
        await adapter.dispatch_event(
            envelope_type="memberships.created",
            payload={"data": {"id": "MB1", "roomId": ROOM, "personId": BOT_ID}},
        )
        await adapter.dispatch_event(
            envelope_type="memberships.created",
            payload={
                "data": {
                    "id": "MB2",
                    "roomId": ROOM,
                    "personId": "CAROL",
                    "personEmail": "carol@acme.com",
                }
            },
        )
        assert (inbound.apps[0].channel_id, inbound.apps[0].channel_name) == (
            ROOM,
            "ops",
        )
        assert (
            inbound.users[0].external_user_id,
            inbound.users[0].external_username,
        ) == (
            "CAROL",
            "carol",
        )


# ── Outbound ─────────────────────────────────────────────────────────────────


class TestOutbound:
    async def test_an_agent_posts_under_its_name_in_the_thread(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex()
        adapter, _ = await connect(monkeypatch, server)
        ref = await adapter.send_message(ROOM, "scout", "**done**", "ROOT")
        assert ref == "MSG-SENT"
        assert server.bodies("POST", r"/v1/messages")[0] == {
            "roomId": ROOM,
            "markdown": "**scout**: **done**",
            "parentId": "ROOT",
        }

    async def test_a_long_reply_is_several_messages_under_webexs_limit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex()
        adapter, _ = await connect(monkeypatch, server)
        await adapter.send_message(ROOM, "scout", "\n".join(["word " * 20] * 200))
        bodies = server.bodies("POST", r"/v1/messages")
        assert len(bodies) > 1
        assert all(len(b["markdown"].encode()) <= 7439 for b in bodies)

    def test_a_cut_inside_a_code_block_closes_and_reopens_it(self) -> None:
        source = (
            "intro\n```\n" + "\n".join(f"line {i}" for i in range(300)) + "\n```\nend"
        )
        pieces = chunk_message(source, 400)
        assert len(pieces) > 1
        assert all(len(p.encode()) <= 400 for p in pieces)
        assert all(p.count("```") % 2 == 0 for p in pieces)
        assert chunk_message("short") == ["short"]

    async def test_headings_become_bold_lines(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, _ = await connect(monkeypatch, Webex())
        assert adapter.translate_outbound("## Plan\ntext") == "**Plan**\ntext"

    async def test_an_edit_puts_and_a_delete_deletes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex(
            {
                ("PUT", r"/v1/messages/M1"): {"id": "M1"},
                ("DELETE", r"/v1/messages/M1"): httpx.Response(204),
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        await adapter.update_message(ROOM, "M1", "new")
        assert server.bodies("PUT", r"/v1/messages/M1") == [
            {"roomId": ROOM, "markdown": "new"}
        ]
        await adapter.delete_message(ROOM, "M1")
        assert server.calls("DELETE") == ["/v1/messages/M1"]

    async def test_deleting_what_is_already_gone_is_fine(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        adapter, _ = await connect(monkeypatch, Webex())
        caplog.set_level(logging.ERROR)
        await adapter.delete_message(ROOM, "GONE")
        assert caplog.text == ""

    async def test_a_file_goes_as_a_multipart_message_under_the_agents_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex()
        adapter, _ = await connect(monkeypatch, server)
        ref = await adapter.send_attachment(
            ROOM, "scout", "chart.png", "image/png", b"12345", "the chart", "ROOT"
        )
        assert ref == "MSG-SENT"
        sent = server.requests[-1]
        assert sent.headers["content-type"].startswith("multipart/form-data")
        for fragment in (
            b'filename="chart.png"',
            b"**scout**: the chart",
            b"ROOT",
            ROOM.encode(),
        ):
            assert fragment in sent.content

    async def test_a_file_over_webexs_limit_is_refused_in_the_space(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(adapter_module, "_MAX_UPLOAD_BYTES", 3)
        server = Webex()
        adapter, _ = await connect(monkeypatch, server)
        await adapter.send_attachment(
            ROOM, "scout", "big.bin", "application/octet-stream", b"12345"
        )
        sent = server.bodies("POST", r"/v1/messages")
        assert len(sent) == 1 and "accepts at most 3" in sent[0]["markdown"]

    async def test_a_space_is_created_and_people_are_added(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def membership(request: httpx.Request) -> httpx.Response:
            if json.loads(request.content)["personId"] == "GHOST":
                return _json({"message": "no such person"}, 404)
            return _json({"id": "MB"})

        server = Webex(
            {
                ("POST", r"/v1/rooms"): {"id": "NEW"},
                ("POST", r"/v1/memberships"): membership,
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        assert await adapter.create_channel("ops", "about ops") == "NEW"
        assert server.bodies("POST", r"/v1/rooms") == [{"title": "ops"}]
        failed = await adapter.add_users_to_channel(
            "NEW", ["alice", "ghost"], ["ALICE", "GHOST"]
        )
        assert failed == ["GHOST"]

    async def test_a_refused_space_says_what_webex_said(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex({("POST", r"/v1/rooms"): _json({"message": "not allowed"}, 403)})
        adapter, _ = await connect(monkeypatch, server)
        with pytest.raises(BridgeOperationError, match="not allowed"):
            await adapter.create_channel("ops", "")

    async def test_deleting_a_room_leaves_the_space(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex(
            {
                ("GET", r"/v1/memberships"): {"items": [{"id": "MB-BOT"}]},
                ("DELETE", r"/v1/memberships/.*"): httpx.Response(204),
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        assert (await adapter.retire_channel(ROOM)).outcome == "left"
        assert server.calls("DELETE") == ["/v1/memberships/MB-BOT"]
        member_query = next(
            r for r in server.requests if r.url.path == "/v1/memberships"
        )
        assert member_query.url.params["personId"] == BOT_ID

    async def test_a_rate_limit_is_waited_out_once_and_retried(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        waited: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            waited.append(seconds)

        monkeypatch.setattr(
            "switch_core.bridges.collaboration.webex.client.asyncio.sleep", fake_sleep
        )
        answers = iter(
            [httpx.Response(429, headers={"retry-after": "2"}), _json({"id": "OK"})]
        )
        server = Webex({("POST", r"/v1/messages"): lambda request: next(answers)})
        adapter, _ = await connect(monkeypatch, server)
        assert await adapter.send_message(ROOM, "scout", "hi") == "OK"
        assert waited == [2.0]

    def test_what_webex_cannot_do_is_declared(self) -> None:
        assert WebexAdapter.receives_webhooks is True
        assert WebexAdapter.keeps_quiet_unless_listening is True
        assert WebexAdapter.supports_directory_search is False
        assert WebexAdapter.supports_activity_reactions is False
        assert WebexAdapter.renders_custom_url_schemes is False
        assert WebexAdapter.channel_on_delete == "left"
        adapter = WebexAdapter(config=WebexConnectionConfig.model_validate(CONFIG))
        assert adapter.slash_invite_hint() is None

    async def test_typing_is_a_quiet_no_op(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Webex()
        adapter, _ = await connect(monkeypatch, server)
        count = len(server.requests)
        await adapter.send_typing(ROOM, "scout", True)
        assert len(server.requests) == count
