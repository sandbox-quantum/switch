from __future__ import annotations

import base64
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
    _failure_reason,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.webhook import adapter as adapter_module
from switch_core.bridges.collaboration.webhook import schema
from switch_core.bridges.collaboration.webhook.adapter import (
    WebhookAdapter,
    WebhookConnectionConfig,
)
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.gateway.collaborations import list_bridge_types
from switch_core.outbound import OutboundPolicy

from .test_lifecycle_tenant_binding import _service
from .test_platform_self_contained import _hook_bridge, _RunningBridge

SIGNING_SECRET = "signing-secret-" + "a" * 20
INBOUND_TOKEN = "inbound-token-" + "b" * 20
APP_URL = "https://chat.example/switch"


def _config(**overrides: str) -> WebhookConnectionConfig:
    values = {
        "outbound_url": APP_URL,
        "signing_secret": SIGNING_SECRET,
        "inbound_token": INBOUND_TOKEN,
    }
    return WebhookConnectionConfig(**{**values, **overrides})


def _request(
    body: dict[str, Any] | bytes,
    *,
    method: str = "POST",
    token: str | None = INBOUND_TOKEN,
) -> WebhookRequest:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    headers = {"authorization": f"Bearer {token}"} if token else {}
    return WebhookRequest(method=method, headers=headers, query={}, body=raw)


def _message_event(event_id: str = "evt-1", **message: Any) -> dict[str, Any]:
    return {
        "version": 1,
        "id": event_id,
        "type": "message",
        "channel": {"id": "c-1", "name": "Support", "type": "channel"},
        "sender": {"id": "u-1", "name": "Ada"},
        "message": {"text": "hello", **message},
    }


class _App:
    """The custom chat app on the other end of Switch's outbound requests."""

    def __init__(self, *statuses: int) -> None:
        self.statuses = list(statuses) or [200]
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return httpx.Response(status)

    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(r.content) for r in self.requests]


def _running(app: Callable[[httpx.Request], httpx.Response]) -> WebhookAdapter:
    adapter = WebhookAdapter(config=_config())
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(app))
    return adapter


async def _started(
    heard: list[Any] | None = None,
) -> WebhookAdapter:
    adapter = WebhookAdapter(config=_config())
    adapter.webhook_url = "https://switch.example/messaging/bridges/b-1/events"
    adapter.set_outbound_policy(OutboundPolicy.parse(""))
    sink = heard if heard is not None else []

    async def keep(item: Any) -> None:
        sink.append(item)

    await adapter.start(keep, keep, keep, keep, keep)
    return adapter


class TestConnectionConfig:
    def test_a_complete_config_is_accepted(self) -> None:
        assert _config().outbound_url == APP_URL

    @pytest.mark.parametrize("field", ["signing_secret", "inbound_token"])
    def test_a_short_secret_is_refused(self, field: str) -> None:
        with pytest.raises(ValueError, match="at least 24 characters"):
            _config(**{field: "too-short"})

    def test_the_two_secrets_must_differ(self) -> None:
        with pytest.raises(ValueError, match="must be different"):
            _config(inbound_token=SIGNING_SECRET)

    @pytest.mark.parametrize("url", ["chat.example", "ftp://chat.example", "https://"])
    def test_a_url_that_is_not_http_is_refused(self, url: str) -> None:
        with pytest.raises(ValueError, match="http"):
            _config(outbound_url=url)

    def test_plain_http_is_only_for_localhost(self) -> None:
        assert _config(outbound_url="http://localhost:9000/hook")
        with pytest.raises(ValueError, match="https"):
            _config(outbound_url="http://chat.example/hook")

    def test_the_outbound_url_is_declared_for_the_outbound_policy(self) -> None:
        assert WebhookAdapter.outbound_urls({"outbound_url": APP_URL}) == [APP_URL]


class TestInboundAuthentication:
    async def test_the_right_token_passes(self) -> None:
        await WebhookAdapter(config=_config()).verify_webhook(
            _request(_message_event())
        )

    @pytest.mark.parametrize("token", [None, "wrong-token-" + "c" * 20, ""])
    async def test_a_missing_or_wrong_token_is_refused(self, token: str | None) -> None:
        with pytest.raises(WebhookAuthenticityError):
            await WebhookAdapter(config=_config()).verify_webhook(
                _request(_message_event(), token=token)
            )

    async def test_the_signing_secret_is_not_accepted_as_a_token(self) -> None:
        with pytest.raises(WebhookAuthenticityError):
            await WebhookAdapter(config=_config()).verify_webhook(
                _request(_message_event(), token=SIGNING_SECRET)
            )

    async def test_another_auth_scheme_is_refused(self) -> None:
        request = WebhookRequest(
            method="POST",
            headers={"authorization": f"Basic {INBOUND_TOKEN}"},
            query={},
            body=b"{}",
        )
        with pytest.raises(WebhookAuthenticityError):
            await WebhookAdapter(config=_config()).verify_webhook(request)


class TestParsingAnEvent:
    def test_a_message_becomes_an_event_keyed_by_its_id(self) -> None:
        parsed = WebhookAdapter(config=_config()).parse_webhook(
            _request(_message_event("evt-42"))
        )

        assert parsed.envelope_type == "message"
        assert parsed.external_event_id == "evt-42"
        assert parsed.handshake is None
        assert parsed.answers_inline is False

    def test_a_retry_carries_the_same_event_id(self) -> None:
        adapter = WebhookAdapter(config=_config())
        first = adapter.parse_webhook(_request(_message_event("evt-7")))
        again = adapter.parse_webhook(_request(_message_event("evt-7")))
        assert first.external_event_id == again.external_event_id == "evt-7"

    @pytest.mark.parametrize(
        "body",
        [
            b"not json",
            b"[]",
            json.dumps({**_message_event(), "version": 2}).encode(),
            json.dumps({**_message_event(), "type": "reaction"}).encode(),
            json.dumps({**_message_event(), "id": ""}).encode(),
            json.dumps({**_message_event(), "message": None}).encode(),
            json.dumps({**_message_event(), "sender": None}).encode(),
        ],
    )
    def test_an_unreadable_event_is_refused(self, body: bytes) -> None:
        with pytest.raises(WebhookPayloadError):
            WebhookAdapter(config=_config()).parse_webhook(_request(body))

    def test_only_post_carries_events(self) -> None:
        with pytest.raises(WebhookPayloadError, match="POST"):
            WebhookAdapter(config=_config()).parse_webhook(
                _request(_message_event(), method="GET")
            )

    def test_the_refusal_names_the_field_without_echoing_the_body(self) -> None:
        event = _message_event()
        event["channel"] = {"id": "", "type": "channel"}
        with pytest.raises(WebhookPayloadError) as raised:
            WebhookAdapter(config=_config()).parse_webhook(_request(event))
        assert "channel.id" in str(raised.value)
        assert INBOUND_TOKEN not in str(raised.value)


class TestDispatchingAnEvent:
    async def _dispatch(self, event: dict[str, Any]) -> list[Any]:
        heard: list[Any] = []
        adapter = await _started(heard)
        parsed = adapter.parse_webhook(_request(event))
        await adapter.dispatch_event(
            envelope_type=parsed.envelope_type, payload=parsed.payload
        )
        return heard

    async def test_a_message_reaches_the_room_with_its_sender_and_channel(
        self,
    ) -> None:
        [message] = await self._dispatch(_message_event("evt-1"))

        assert isinstance(message, InboundMessage)
        assert message.content == "hello"
        assert message.channel_id == "c-1"
        assert message.channel_name == "Support"
        assert message.channel_type == "channel_public"
        assert (message.sender_id, message.sender_name) == ("u-1", "Ada")
        assert message.message_ref == "evt-1"
        assert message.root_id is None

    async def test_the_apps_own_message_id_is_the_reference_when_given(self) -> None:
        [message] = await self._dispatch(_message_event("evt-1", id="m-9"))
        assert message.message_ref == "m-9"

    async def test_a_reply_stays_in_its_thread(self) -> None:
        [message] = await self._dispatch(_message_event(thread_id="m-1"))
        assert message.root_id == "m-1"

    @pytest.mark.parametrize(
        ("kind", "expected"),
        [
            ("channel", "channel_public"),
            ("private", "channel_private"),
            ("group", "group"),
            ("direct", "direct"),
        ],
    )
    async def test_the_channel_kind_is_carried(self, kind: str, expected: str) -> None:
        event = _message_event()
        event["channel"]["type"] = kind
        [message] = await self._dispatch(event)
        assert message.channel_type == expected

    async def test_a_post_from_another_app_is_marked(self) -> None:
        event = _message_event()
        event["sender"]["is_app"] = True
        [message] = await self._dispatch(event)
        assert message.sender_is_app is True

    async def test_a_bang_command_is_a_command_not_a_message(self) -> None:
        event = _message_event()
        event["message"]["text"] = "!invite-agent triager"
        [command] = await self._dispatch(event)

        assert isinstance(command, InboundCommand)
        assert (command.command, command.args) == ("invite-agent", "triager")
        assert command.channel_id == "c-1"

    async def test_the_app_joining_a_channel_adopts_it(self) -> None:
        event = {
            "version": 1,
            "id": "evt-join",
            "type": "channel.joined",
            "channel": {"id": "c-2", "name": "Ops", "type": "private"},
        }
        [join] = await self._dispatch(event)

        assert isinstance(join, InboundAppJoin)
        assert (join.channel_id, join.channel_name) == ("c-2", "Ops")
        assert join.channel_type == "channel_private"

    async def test_a_file_arrives_as_an_attachment(self) -> None:
        data = base64.b64encode(b"%PDF-1.4").decode()
        [message] = await self._dispatch(
            _message_event(
                files=[
                    {"filename": "a.pdf", "mimetype": "application/pdf", "data": data}
                ]
            )
        )

        [attachment] = message.attachments
        assert (attachment.filename, attachment.mimetype) == (
            "a.pdf",
            "application/pdf",
        )
        assert attachment.data == b"%PDF-1.4"
        assert message.attachment_failures == []

    async def test_a_file_that_is_not_base64_is_disclosed_not_dropped(self) -> None:
        [message] = await self._dispatch(
            _message_event(files=[{"filename": "bad.bin", "data": "***"}])
        )

        assert message.attachments == []
        [failure] = message.attachment_failures
        assert failure.filename == "bad.bin"
        assert "base64" in failure.reason

    async def test_an_oversized_file_is_refused_visibly(self) -> None:
        heard: list[Any] = []
        adapter = await _started(heard)
        adapter.set_max_attachment_bytes(4)
        event = _message_event(
            files=[{"filename": "big.bin", "data": base64.b64encode(b"12345").decode()}]
        )
        parsed = adapter.parse_webhook(_request(event))
        await adapter.dispatch_event(
            envelope_type=parsed.envelope_type, payload=parsed.payload
        )

        [message] = heard
        assert message.attachments == []
        assert message.attachment_failures[0].filename == "big.bin"
        assert "limit" in message.attachment_failures[0].reason


class TestSendingToTheApp:
    async def test_a_message_is_posted_signed_under_the_agents_name(self) -> None:
        app = _App()
        message_id = await _running(app).send_message("c-1", "triager", "On it.")

        [request] = app.requests
        [body] = app.bodies()
        assert str(request.url) == APP_URL
        assert request.headers["x-switch-event"] == "message.created"
        assert body["version"] == 1
        assert body["type"] == "message.created"
        assert body["channel_id"] == "c-1"
        assert body["sender"]["name"] == "triager"
        assert body["text"] == "On it."
        assert body["message_id"] == message_id
        assert message_id.startswith("msg_")
        assert "thread_id" not in body

    async def test_the_signature_verifies_with_the_signing_secret(self) -> None:
        app = _App()
        await _running(app).send_message("c-1", "triager", "On it.")

        [request] = app.requests
        stamp = request.headers["x-switch-timestamp"]
        assert request.headers["x-switch-signature"] == schema.sign(
            SIGNING_SECRET, stamp, request.content
        )
        assert request.headers["x-switch-signature"] != schema.sign(
            "another-secret-" + "z" * 20, stamp, request.content
        )

    async def test_a_reply_goes_into_its_thread(self) -> None:
        app = _App()
        await _running(app).send_message("c-1", "triager", "Done.", "m-1")
        assert app.bodies()[0]["thread_id"] == "m-1"

    async def test_every_message_gets_its_own_id(self) -> None:
        adapter = _running(_App())
        first = await adapter.send_message("c-1", "triager", "one")
        second = await adapter.send_message("c-1", "triager", "two")
        assert first != second

    async def test_an_edit_names_the_message_it_changes(self) -> None:
        app = _App()
        await _running(app).update_message("c-1", "msg_1", "better")

        [body] = app.bodies()
        assert (body["type"], body["message_id"], body["text"]) == (
            "message.updated",
            "msg_1",
            "better",
        )

    async def test_a_delete_names_the_message_it_removes(self) -> None:
        app = _App()
        await _running(app).delete_message("c-1", "msg_1")

        [body] = app.bodies()
        assert (body["type"], body["message_id"]) == ("message.deleted", "msg_1")
        assert "text" not in body

    async def test_typing_is_reported_and_its_failure_is_not_fatal(self) -> None:
        app = _App()
        await _running(app).send_typing("c-1", "triager", True)
        assert app.bodies()[0]["is_typing"] is True

        down = _App(404)
        await _running(down).send_typing("c-1", "triager", False)

    async def test_files_travel_in_one_post(self) -> None:
        app = _App()
        files = [
            OutboundAttachment(filename="a.txt", mimetype="text/plain", data=b"alpha"),
            OutboundAttachment(filename="b.txt", mimetype="text/plain", data=b"beta"),
        ]
        await _running(app).send_attachments("c-1", "triager", files, caption="two")

        [body] = app.bodies()
        assert body["text"] == "two"
        assert [f["filename"] for f in body["files"]] == ["a.txt", "b.txt"]
        assert base64.b64decode(body["files"][0]["data"]) == b"alpha"
        assert body["files"][0]["size"] == 5

    async def test_an_oversized_file_is_refused_visibly(self) -> None:
        app = _App()
        adapter = _running(app)
        adapter.set_max_attachment_bytes(4)
        await adapter.send_attachment("c-1", "triager", "big.bin", "x/y", b"12345")

        [body] = app.bodies()
        assert body["files"] == []
        assert "not sent, too large: big.bin" in body["text"]


class TestWhenTheAppMisbehaves:
    @pytest.fixture(autouse=True)
    def _no_waiting(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(adapter_module, "_BACKOFF_SECONDS", (0, 0))

    async def test_a_server_error_is_retried_until_it_works(self) -> None:
        app = _App(503, 502, 200)
        await _running(app).send_message("c-1", "triager", "hi")
        assert len(app.requests) == 3

    async def test_a_retry_resends_the_same_message(self) -> None:
        app = _App(500, 200)
        await _running(app).send_message("c-1", "triager", "hi")
        first, second = app.bodies()
        assert first["message_id"] == second["message_id"]

    async def test_giving_up_says_the_app_could_not_be_reached(self) -> None:
        adapter = _running(_App(503))
        with pytest.raises(BridgeOperationError, match="503"):
            await adapter.send_message("c-1", "triager", "hi")
        assert "cannot deliver" in (await adapter.attention() or "")

    async def test_a_client_error_is_not_retried(self) -> None:
        app = _App(400)
        with pytest.raises(BridgeOperationError, match="400"):
            await _running(app).send_message("c-1", "triager", "hi")
        assert len(app.requests) == 1

    @pytest.mark.parametrize("status", [401, 403])
    async def test_a_rejected_signature_is_a_credential_problem(
        self, status: int
    ) -> None:
        adapter = _running(_App(status))
        with pytest.raises(BridgeCredentialError, match="signing secret"):
            await adapter.send_message("c-1", "triager", "hi")
        assert "signing secret" in (await adapter.attention() or "")

    async def test_attention_clears_once_the_app_accepts_again(self) -> None:
        app = _App(401, 200)
        adapter = _running(app)
        with pytest.raises(BridgeCredentialError):
            await adapter.send_message("c-1", "triager", "one")
        await adapter.send_message("c-1", "triager", "two")
        assert await adapter.attention() is None

    async def test_an_unreachable_app_is_a_network_failure(self) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        with pytest.raises(BridgeOperationError, match="Could not reach") as raised:
            await _running(refuse).send_message("c-1", "triager", "hi")
        assert _failure_reason(raised.value, WebhookAdapter) == "network"

    async def test_sending_before_the_bridge_starts_is_refused(self) -> None:
        with pytest.raises(BridgeOperationError, match="not running"):
            await WebhookAdapter(config=_config()).send_message("c-1", "x", "hi")


class TestCheckingTheConnection:
    @pytest.fixture
    def app(self, monkeypatch: pytest.MonkeyPatch) -> Callable[[_App], None]:
        def install(app: _App) -> None:
            monkeypatch.setattr(
                adapter_module,
                "_plain_client",
                lambda: httpx.AsyncClient(transport=httpx.MockTransport(app)),
            )

        return install

    @staticmethod
    def _stored() -> dict[str, object]:
        return _config().model_dump(mode="json")

    async def test_a_ping_the_app_accepts_passes(
        self, app: Callable[[_App], None]
    ) -> None:
        receiver = _App()
        app(receiver)
        await WebhookAdapter.verify_credentials(self._stored())

        [body] = receiver.bodies()
        assert body["type"] == "ping"
        request = receiver.requests[0]
        assert request.headers["x-switch-signature"] == schema.sign(
            SIGNING_SECRET, request.headers["x-switch-timestamp"], request.content
        )

    async def test_an_app_that_rejects_the_signature_is_named_as_such(
        self, app: Callable[[_App], None]
    ) -> None:
        app(_App(401))
        with pytest.raises(BridgeCredentialError, match="same signing secret"):
            await WebhookAdapter.verify_credentials(self._stored())

    async def test_an_app_that_answers_with_an_error_is_reported(
        self, app: Callable[[_App], None]
    ) -> None:
        app(_App(500))
        with pytest.raises(BridgeCredentialError, match="HTTP 500"):
            await WebhookAdapter.verify_credentials(self._stored())

    async def test_an_unreachable_app_is_reported(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        monkeypatch.setattr(
            adapter_module,
            "_plain_client",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(refuse)),
        )
        with pytest.raises(BridgeCredentialError, match="Could not reach"):
            await WebhookAdapter.verify_credentials(self._stored())


class TestTheBridgeLifecycle:
    async def test_starting_without_a_public_address_is_refused(self) -> None:
        adapter = WebhookAdapter(config=_config())
        adapter.set_outbound_policy(OutboundPolicy.parse(""))

        async def ignore(_: Any) -> None:
            return None

        with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
            await adapter.start(ignore, ignore, ignore, ignore, ignore)

    async def test_stopping_closes_the_connection(self) -> None:
        adapter = await _started()
        assert adapter._http is not None
        await adapter.stop()
        assert adapter._http is None

    async def test_it_opens_no_long_lived_connection_so_any_pod_can_serve_it(
        self,
    ) -> None:
        assert WebhookAdapter.receives_webhooks is True
        assert WebhookAdapter.keeps_quiet_unless_listening is False

    async def test_channels_cannot_be_created_and_the_reason_says_what_to_do(
        self,
    ) -> None:
        with pytest.raises(ChannelCreationUnsupported, match="channel.joined"):
            await WebhookAdapter(config=_config()).create_channel("ops", "")

    async def test_nobody_is_added_to_a_channel_the_app_owns(self) -> None:
        adapter = WebhookAdapter(config=_config())
        assert await adapter.add_users_to_channel("c-1", ["Ada"], ["u-1"]) == ["u-1"]


class TestThePlatformIsListed:
    @pytest.fixture
    def lifecycle(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> CollaborationBridgeLifecycleService:
        service = _service(session_factory)
        service._config.messaging_public_url = "https://switch.example"
        from switch_core.bridges.collaboration.platforms import register_platforms

        register_platforms(service)
        return service

    async def test_the_gateway_lists_it_with_what_it_can_and_cannot_do(
        self, lifecycle: CollaborationBridgeLifecycleService
    ) -> None:
        from unittest.mock import MagicMock

        types = {t.key: t for t in await list_bridge_types(lifecycle, MagicMock())}

        webhook = types["webhook"]
        assert webhook.display_name == "Custom app (webhook)"
        assert webhook.receives_webhooks is True
        assert webhook.channel_creation_supported is False
        assert webhook.directory_search_supported is False
        assert webhook.icon_svg is not None and webhook.icon_svg.startswith("<svg")
        assert webhook.config_schema["required"] == [
            "outbound_url",
            "signing_secret",
            "inbound_token",
        ]


class TestAnEventTravelsTheWholeRoute:
    @pytest.fixture
    async def route(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        lifecycle: CollaborationBridgeLifecycleService,
    ) -> tuple[httpx.AsyncClient, str, list[Any]]:
        bridge_id = await _hook_bridge(session_factory, bridge_type="webhook")
        heard: list[Any] = []
        adapter = await _started(heard)
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

    @pytest.fixture
    def lifecycle(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> CollaborationBridgeLifecycleService:
        service = _service(session_factory)
        service._config.messaging_public_url = "https://switch.example"
        service.register_adapter("webhook", WebhookAdapter, WebhookConnectionConfig)
        return service

    @staticmethod
    def _auth(token: str = INBOUND_TOKEN) -> dict[str, str]:
        return {"authorization": f"Bearer {token}"}

    async def test_an_authenticated_message_reaches_the_bridge(
        self, route: tuple[httpx.AsyncClient, str, list[Any]]
    ) -> None:
        client, bridge_id, heard = route

        response = await client.post(
            webhook_path(bridge_id), json=_message_event("evt-1"), headers=self._auth()
        )

        assert response.status_code == 200
        assert [m.content for m in heard] == ["hello"]

    async def test_the_wrong_token_is_a_401_and_nothing_is_delivered(
        self, route: tuple[httpx.AsyncClient, str, list[Any]]
    ) -> None:
        client, bridge_id, heard = route

        response = await client.post(
            webhook_path(bridge_id),
            json=_message_event(),
            headers=self._auth("wrong-token-" + "c" * 20),
        )

        assert response.status_code == 401
        assert heard == []

    async def test_a_retried_event_is_handled_once(
        self, route: tuple[httpx.AsyncClient, str, list[Any]]
    ) -> None:
        client, bridge_id, heard = route

        async def send() -> httpx.Response:
            return await client.post(
                webhook_path(bridge_id),
                json=_message_event("evt-9"),
                headers=self._auth(),
            )

        first, again = await send(), await send()

        assert (first.status_code, again.status_code) == (200, 200)
        assert len(heard) == 1

    async def test_an_unreadable_body_is_a_400(
        self, route: tuple[httpx.AsyncClient, str, list[Any]]
    ) -> None:
        client, bridge_id, _heard = route

        response = await client.post(
            webhook_path(bridge_id), content=b"nonsense", headers=self._auth()
        )

        assert response.status_code == 400

    async def test_the_operator_is_shown_the_address_for_the_app(
        self,
        route: tuple[httpx.AsyncClient, str, list[Any]],
        lifecycle: CollaborationBridgeLifecycleService,
    ) -> None:
        _client, bridge_id, _heard = route
        assert lifecycle.webhook_url(bridge_id, "webhook") == (
            f"https://switch.example/messaging/bridges/{bridge_id}/events"
        )


class TestThePublishedSchema:
    def test_the_docs_schema_matches_the_models(self) -> None:
        from pathlib import Path

        published = (
            Path(__file__).parents[5]
            / "docs"
            / "messaging-platforms"
            / "webhook.schema.json"
        )
        assert json.loads(published.read_text()) == schema.json_schema()
