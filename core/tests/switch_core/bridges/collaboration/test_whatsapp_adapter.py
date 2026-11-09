"""The WhatsApp adapter against a stand-in for the Cloud API."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
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
    InboundCommand,
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.session.renderers import (
    Control,
    RequestReference,
    parse_answer_position,
)
from switch_core.bridges.collaboration.whatsapp import adapter as whatsapp
from switch_core.bridges.collaboration.whatsapp.adapter import (
    MAX_MESSAGE,
    SIGNATURE_HEADER,
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
    WhatsAppError,
    appsecret_proof,
    from_whatsapp,
    sign,
    to_whatsapp,
)

from .session_fixtures import _item, _turn, open_request

NUMBER_ID = "1234567890"
TOKEN = "token"
SECRET = "app-secret"
VERIFY = "a-long-verify-token"
ADA = "447700900123"
URL = "https://switch.example.test/messaging/bridges/b1/events"
GRAPH = "https://graph.facebook.com/v21.0"
CDN = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1"


class FakeGraph:
    """The Graph API calls the adapter makes: messages, media, debug_token."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.uploads: list[dict[str, Any]] = []
        self.refuse: tuple[int, int] | None = None
        self.media: dict[str, dict[str, Any]] = {}
        self.files: dict[str, bytes] = {}
        self.token_valid = True
        self.proofs: list[str | None] = []
        self.scopes = ["whatsapp_business_messaging"]

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url).split("?")[0]
        if url.startswith(GRAPH):
            self.proofs.append(request.url.params.get("appsecret_proof"))
        if request.headers.get("authorization") not in (None, f"Bearer {TOKEN}"):
            return _graph_error(
                400, 190, "Invalid OAuth access token - Cannot parse access token"
            )
        if request.method == "GET" and str(request.url) in self.files:
            assert request.headers["authorization"] == f"Bearer {TOKEN}"
            return httpx.Response(200, content=self.files[str(request.url)])
        if request.method == "GET" and url == f"{GRAPH}/debug_token":
            return httpx.Response(
                200,
                json={"data": {"is_valid": self.token_valid, "scopes": self.scopes}},
            )
        if request.method == "GET" and url == f"{GRAPH}/{NUMBER_ID}":
            if request.url.params.get("appsecret_proof") != appsecret_proof(
                TOKEN, SECRET
            ):
                return _graph_error(
                    400, 100, "Invalid appsecret_proof provided in the API argument"
                )
            return httpx.Response(200, json={"display_phone_number": "+1 555 0100"})
        if request.method == "GET" and url.startswith(f"{GRAPH}/"):
            media_id = url.rsplit("/", 1)[1]
            if media_id not in self.media:
                return _graph_error(404, 100, "Unknown media")
            return httpx.Response(200, json=self.media[media_id])
        if url == f"{GRAPH}/{NUMBER_ID}/media":
            self.uploads.append({"content": request.content})
            return httpx.Response(200, json={"id": f"media{len(self.uploads)}"})
        body = json.loads(request.content)
        self.sent.append(body)
        if self.refuse:
            status, code = self.refuse
            return _graph_error(status, code, "refused")
        return httpx.Response(
            200, json={"messages": [{"id": f"wamid.out{len(self.sent)}"}]}
        )


def _graph_error(status: int, code: int, message: str) -> httpx.Response:
    return httpx.Response(status, json={"error": {"code": code, "message": message}})


@pytest.fixture
def graph() -> FakeGraph:
    return FakeGraph()


def _config(**changes: str) -> WhatsAppConnectionConfig:
    values = {
        "phone_number_id": NUMBER_ID,
        "access_token": TOKEN,
        "app_secret": SECRET,
        "verify_token": VERIFY,
    }
    return WhatsAppConnectionConfig(**{**values, **changes})


@pytest.fixture
async def adapter(graph: FakeGraph) -> WhatsAppAdapter:
    adapter = WhatsAppAdapter(config=_config())
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(graph.handle))
    received: list[Any] = []

    async def keep(item: Any) -> None:
        received.append(item)

    adapter.set_webhook_url(URL)
    await adapter.start(keep, keep, keep, keep, keep)
    adapter.set_interaction_handler(keep)
    adapter.received = received  # type: ignore[attr-defined]
    return adapter


def _change(message: dict[str, Any], number: str = NUMBER_ID) -> bytes:
    value = {
        "metadata": {"phone_number_id": number},
        "contacts": [{"wa_id": ADA, "profile": {"name": "Ada"}}],
        "messages": [{"from": ADA, "id": "wamid.in1", **message}],
    }
    return json.dumps({"entry": [{"changes": [{"value": value}]}]}).encode()


def _statuses(*statuses: dict[str, Any]) -> bytes:
    value = {"statuses": list(statuses)}
    return json.dumps({"entry": [{"changes": [{"value": value}]}]}).encode()


def _post(body: bytes, secret: str = SECRET) -> WebhookRequest:
    return WebhookRequest(
        method="POST",
        headers={SIGNATURE_HEADER: sign(secret, body)},
        query={},
        body=body,
    )


async def _deliver(adapter: WhatsAppAdapter, body: bytes) -> None:
    hook = adapter.parse_webhook(_post(body))
    await adapter.dispatch_event(envelope_type=hook.envelope_type, payload=hook.payload)


@pytest.fixture
def meta(graph: FakeGraph, monkeypatch: pytest.MonkeyPatch) -> FakeGraph:
    """`verify_credentials` opens its own client; route it to the stand-in."""
    real = httpx.AsyncClient

    def client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        return real(transport=httpx.MockTransport(graph.handle))

    monkeypatch.setattr(whatsapp.httpx, "AsyncClient", client)
    return graph


# ── Connecting ───────────────────────────────────────────────────────────────


def test_a_config_it_cannot_use_is_refused() -> None:
    with pytest.raises(ValidationError, match="digits"):
        _config(phone_number_id="+44 7700")
    with pytest.raises(ValidationError):
        _config(verify_token="short")


async def test_good_credentials_pass(meta: FakeGraph) -> None:
    await WhatsAppAdapter.verify_credentials(_config().model_dump())


async def test_an_expired_token_is_said_plainly(meta: FakeGraph) -> None:
    meta.token_valid = False
    with pytest.raises(BridgeCredentialError, match="does not accept the access token"):
        await WhatsAppAdapter.verify_credentials(_config().model_dump())


async def test_a_token_meta_cannot_read_is_said_to_be_the_token(
    meta: FakeGraph,
) -> None:
    with pytest.raises(BridgeCredentialError, match="does not accept the access token"):
        await WhatsAppAdapter.verify_credentials(
            _config(access_token="EAAnotatoken").model_dump()
        )


async def test_a_token_without_messaging_is_refused(meta: FakeGraph) -> None:
    meta.scopes = ["whatsapp_business_management"]
    with pytest.raises(BridgeCredentialError, match="whatsapp_business_messaging"):
        await WhatsAppAdapter.verify_credentials(_config().model_dump())


async def test_another_apps_secret_is_caught_at_connect(meta: FakeGraph) -> None:
    with pytest.raises(BridgeCredentialError, match="app secret is not this app's"):
        await WhatsAppAdapter.verify_credentials(
            _config(app_secret="another-secret").model_dump()
        )


async def test_a_wrong_number_id_is_said(meta: FakeGraph) -> None:
    with pytest.raises(BridgeCredentialError, match="phone number ID"):
        await WhatsAppAdapter.verify_credentials(
            _config(phone_number_id="999999999").model_dump()
        )


# ── Webhooks ─────────────────────────────────────────────────────────────────


async def test_the_address_check_echoes_its_challenge(adapter: WhatsAppAdapter) -> None:
    query = {"hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "42"}
    request = WebhookRequest(method="GET", headers={}, query=query, body=b"")
    await adapter.verify_webhook(request)
    assert adapter.parse_webhook(request).handshake == "42"
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            WebhookRequest(
                method="GET",
                headers={},
                query={**query, "hub.verify_token": "x"},
                body=b"",
            )
        )


async def test_a_signed_event_is_taken_and_another_secret_refused(
    adapter: WhatsAppAdapter,
) -> None:
    body = _change({"type": "text", "text": {"body": "hi"}})
    await adapter.verify_webhook(_post(body))
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_post(body, "another-secret"))
    with pytest.raises(WebhookPayloadError):
        adapter.parse_webhook(_post(b"{}"))


def test_a_retried_event_carries_the_message_id(adapter: WhatsAppAdapter) -> None:
    body = _change({"type": "text", "text": {"body": "hi"}})
    assert adapter.parse_webhook(_post(body)).external_event_id == "wamid.in1"


# ── What arrives ─────────────────────────────────────────────────────────────


async def test_a_text_is_a_direct_room_and_a_quote_reply_its_thread(
    adapter: WhatsAppAdapter,
) -> None:
    await _deliver(
        adapter,
        _change(
            {
                "type": "text",
                "text": {"body": "@coder hi"},
                "context": {"id": "wamid.root"},
            }
        ),
    )
    [message] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(message, InboundMessage)
    assert (message.channel_id, message.channel_type, message.sender_name) == (
        ADA,
        "direct",
        "Ada",
    )
    assert (message.content, message.root_id) == ("@coder hi", "wamid.root")


async def test_an_event_for_another_number_is_dropped(
    adapter: WhatsAppAdapter,
) -> None:
    await _deliver(
        adapter, _change({"type": "text", "text": {"body": "hi"}}, "999999999")
    )
    assert adapter.received == []  # type: ignore[attr-defined]


async def test_a_group_message_is_not_relayed(adapter: WhatsAppAdapter) -> None:
    await _deliver(
        adapter, _change({"type": "text", "text": {"body": "hi"}, "group_id": "g1"})
    )
    assert adapter.received == []  # type: ignore[attr-defined]


async def test_a_person_known_by_username_is_their_scoped_id(
    adapter: WhatsAppAdapter,
) -> None:
    value = {
        "metadata": {"phone_number_id": NUMBER_ID},
        "contacts": [{"user_id": "US.ada", "profile": {"name": "Ada"}}],
        "messages": [
            {
                "from_user_id": "US.ada",
                "id": "wamid.in2",
                "type": "text",
                "text": {"body": "hi"},
            }
        ],
    }
    await _deliver(
        adapter, json.dumps({"entry": [{"changes": [{"value": value}]}]}).encode()
    )
    [message] = adapter.received  # type: ignore[attr-defined]
    assert (message.channel_id, message.sender_name) == ("US.ada", "Ada")


async def test_a_bang_command(adapter: WhatsAppAdapter) -> None:
    await _deliver(adapter, _change({"type": "text", "text": {"body": "!help"}}))
    [command] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(command, InboundCommand) and command.command == "help"


async def test_a_photo_arrives_with_its_caption(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    graph.media["m1"] = {"url": CDN, "mime_type": "image/jpeg", "file_size": 3}
    graph.files[CDN] = b"jpg"
    await _deliver(
        adapter,
        _change(
            {
                "type": "image",
                "image": {"id": "m1", "mime_type": "image/jpeg", "caption": "the bug"},
            }
        ),
    )
    [message] = adapter.received  # type: ignore[attr-defined]
    assert message.content == "the bug"
    [attachment] = message.attachments
    assert (attachment.mimetype, attachment.data) == ("image/jpeg", b"jpg")
    assert attachment.filename.startswith("image-") and attachment.filename.endswith(
        ".jpg"
    )
    assert message.attachment_failures == []


async def test_a_document_keeps_its_name(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    graph.media["m2"] = {"url": CDN, "mime_type": "application/pdf", "file_size": 4}
    graph.files[CDN] = b"%PDF"
    document = {"id": "m2", "mime_type": "application/pdf", "filename": "report.pdf"}
    await _deliver(adapter, _change({"type": "document", "document": document}))
    [message] = adapter.received  # type: ignore[attr-defined]
    assert [a.filename for a in message.attachments] == ["report.pdf"]


async def test_an_oversized_file_is_told_to_the_room_not_dropped(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    adapter.set_max_attachment_bytes(10)
    graph.media["m3"] = {"url": CDN, "mime_type": "video/mp4", "file_size": 50}
    await _deliver(
        adapter,
        _change({"type": "video", "video": {"id": "m3", "mime_type": "video/mp4"}}),
    )
    [message] = adapter.received  # type: ignore[attr-defined]
    assert message.attachments == []
    [failure] = message.attachment_failures
    assert "exceeds the 10 byte limit" in failure.reason


async def test_a_download_stops_at_the_limit_when_meta_names_no_size(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    adapter.set_max_attachment_bytes(10)
    graph.media["m5"] = {"url": CDN, "mime_type": "application/pdf"}
    graph.files[CDN] = b"x" * 1000
    document = {"id": "m5", "mime_type": "application/pdf", "filename": "big.pdf"}
    await _deliver(adapter, _change({"type": "document", "document": document}))
    [message] = adapter.received  # type: ignore[attr-defined]
    assert message.attachments == []
    [failure] = message.attachment_failures
    assert "attachment limit" in failure.reason


async def test_a_file_that_will_not_download_is_a_failure(
    adapter: WhatsAppAdapter,
) -> None:
    await _deliver(
        adapter,
        _change({"type": "audio", "audio": {"id": "gone", "mime_type": "audio/ogg"}}),
    )
    [message] = adapter.received  # type: ignore[attr-defined]
    [failure] = message.attachment_failures
    assert failure.reason.startswith("download failed")


async def test_media_is_fetched_only_from_meta(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    graph.media["m4"] = {
        "url": "https://internal.example.test/x",
        "mime_type": "image/png",
        "file_size": 1,
    }
    await _deliver(
        adapter,
        _change({"type": "image", "image": {"id": "m4", "mime_type": "image/png"}}),
    )
    [message] = adapter.received  # type: ignore[attr-defined]
    assert message.attachments == [] and len(message.attachment_failures) == 1


async def test_a_location_and_a_contact_are_said(adapter: WhatsAppAdapter) -> None:
    place = {"latitude": 51.5, "longitude": -0.1, "name": "Office"}
    await _deliver(adapter, _change({"type": "location", "location": place}))
    contact = {"name": {"formatted_name": "Grace"}}
    await _deliver(adapter, _change({"type": "contacts", "contacts": [contact]}))
    located, shared = adapter.received  # type: ignore[attr-defined]
    assert located.content == "_shared a location: Office (51.5, -0.1)_"
    assert shared.content == "_shared Grace_"


async def test_a_reaction_reaches_no_room(adapter: WhatsAppAdapter) -> None:
    reaction = {"message_id": "wamid.out1", "emoji": "\N{THUMBS UP SIGN}"}
    await _deliver(adapter, _change({"type": "reaction", "reaction": reaction}))
    assert adapter.received == []  # type: ignore[attr-defined]


async def test_a_button_reply_is_an_interaction(adapter: WhatsAppAdapter) -> None:
    reply = {"button_reply": {"id": "switch:answer:2|tok", "title": "2. No"}}
    await _deliver(
        adapter,
        _change(
            {
                "type": "interactive",
                "interactive": reply,
                "context": {"id": "wamid.card"},
            }
        ),
    )
    [press] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(press, InboundInteraction)
    assert (press.action_id, press.value, press.message_ref) == (
        "switch:answer:2",
        "tok",
        "wamid.card",
    )


async def test_a_list_choice_is_an_interaction(adapter: WhatsAppAdapter) -> None:
    reply = {
        "type": "list_reply",
        "list_reply": {"id": "switch:answer:5|tok", "title": "5. Later"},
    }
    await _deliver(adapter, _change({"type": "interactive", "interactive": reply}))
    [press] = adapter.received  # type: ignore[attr-defined]
    assert (press.action_id, press.value) == ("switch:answer:5", "tok")


async def test_a_delivered_status_reaches_no_room(adapter: WhatsAppAdapter) -> None:
    hook = adapter.parse_webhook(_post(_statuses({"id": "x", "status": "delivered"})))
    assert hook.external_event_id is None
    await adapter.dispatch_event(envelope_type=hook.envelope_type, payload=hook.payload)
    assert adapter.received == []  # type: ignore[attr-defined]


async def test_a_late_refusal_outside_the_window_is_logged_saying_why(
    adapter: WhatsAppAdapter, caplog: pytest.LogCaptureFixture
) -> None:
    failed = {
        "id": "wamid.out7",
        "status": "failed",
        "recipient_id": ADA,
        "errors": [{"code": 131047, "title": "Re-engagement message"}],
    }
    with caplog.at_level(logging.ERROR):
        await _deliver(adapter, _statuses(failed))
    [record] = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert "wamid.out7" in record.getMessage()
    assert "within 24 hours" in record.getMessage()


# ── What goes out ────────────────────────────────────────────────────────────


async def test_a_reply_names_the_agent_and_quotes_the_thread(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    await adapter.send_message(
        ADA, "coder", adapter.translate_outbound("**done**"), "wamid.root"
    )
    [sent] = graph.sent
    assert sent["to"] == ADA and sent["text"]["body"] == "*coder*\n*done*"
    assert sent["context"] == {"message_id": "wamid.root"}


async def test_a_long_reply_is_split_and_code_blocks_closed(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    code = "```\n" + "\n".join(f"line {n}" for n in range(1200)) + "\n```"
    await adapter.send_message(ADA, "coder", code)
    bodies = [s["text"]["body"] for s in graph.sent]
    assert len(bodies) > 1
    assert all(len(b) <= MAX_MESSAGE for b in bodies)
    assert all(b.count("```") % 2 == 0 for b in bodies)


async def test_outside_the_24_hour_window_the_refusal_says_so(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    graph.refuse = (400, 131047)
    with pytest.raises(BridgeOperationError, match="24 hours"):
        await adapter.send_message(ADA, "coder", "late")


async def test_an_expired_token_is_named_when_a_send_is_refused(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    graph.refuse = (401, 190)
    with pytest.raises(BridgeOperationError, match="does not accept the access token"):
        await adapter.send_message(ADA, "coder", "hi")


async def test_a_card_with_few_options_has_reply_buttons(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    card = RequestCard(open_request(), RequestReference(token="tok", handle="R1"))
    await adapter.post_rich(ADA, "coder", card)
    [sent] = graph.sent
    buttons = sent["interactive"]["action"]["buttons"]
    assert 0 < len(buttons) <= 3
    ids = [b["reply"]["id"].split("|") for b in buttons]
    assert all(token == "tok" for _, token in ids)
    assert [parse_answer_position(a) for a, _ in ids] == list(range(1, len(ids) + 1))
    assert all(len(b["reply"]["title"]) <= 20 for b in buttons)


async def test_a_card_with_more_options_is_a_list(
    adapter: WhatsAppAdapter, graph: FakeGraph, monkeypatch: pytest.MonkeyPatch
) -> None:
    labels = ["Yes", "No", "Ask me later", "Only this file", "Never for this project"]
    monkeypatch.setattr(
        whatsapp,
        "offered_controls",
        lambda _: [
            Control(position=n, label=label) for n, label in enumerate(labels, 1)
        ],
    )
    card = RequestCard(open_request(), RequestReference(token="tok", handle="R1"))
    await adapter.post_rich(ADA, "coder", card)
    [sent] = graph.sent
    assert sent["interactive"]["type"] == "list"
    [section] = sent["interactive"]["action"]["sections"]
    rows = section["rows"]
    assert [parse_answer_position(r["id"].split("|")[0]) for r in rows] == [
        1,
        2,
        3,
        4,
        5,
    ]
    assert all(r["id"].endswith("|tok") for r in rows)
    assert all(len(r["title"]) <= 24 and len(r["description"]) <= 72 for r in rows)


async def test_a_refused_card_falls_back_to_its_text(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    graph.refuse = (400, 100)
    card = RequestCard(open_request(), RequestReference(token="tok", handle="R1"))
    with pytest.raises(RichContentFailed):
        await adapter.post_rich(ADA, "coder", card)


def _activity(status: str, error: str | None = None) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    return TurnActivity(items, _turn(status), error_summary=error)


async def test_a_running_turn_is_recorded_but_not_sent(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    ref = await adapter.post_rich(ADA, "coder", _activity("running"))
    assert ref.startswith("turn-")
    await adapter.update_rich(ADA, "coder", ref, _activity("completed"), None)
    assert graph.sent == []


async def test_a_failed_turn_is_said_once(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    ref = await adapter.post_rich(ADA, "coder", _activity("running"))
    await adapter.update_rich(
        ADA,
        "coder",
        ref,
        _activity("error", "The agent stopped unexpectedly."),
        "wamid.root",
    )
    [sent] = graph.sent
    assert sent["text"]["body"] == "*coder*\nThe agent stopped unexpectedly."
    assert sent["context"] == {"message_id": "wamid.root"}


async def test_a_photo_goes_out_inline_with_the_agents_name(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    ref = await adapter.send_attachment(
        ADA,
        "coder",
        "shot.png",
        "image/png",
        b"png",
        caption="**here**",
        thread_root_id="wamid.root",
    )
    assert ref == "wamid.out1"
    assert len(graph.uploads) == 1 and b"shot.png" in graph.uploads[0]["content"]
    [sent] = graph.sent
    assert sent["type"] == "image"
    assert sent["image"] == {"id": "media1", "caption": "*coder*\n*here*"}
    assert sent["context"] == {"message_id": "wamid.root"}


async def test_any_other_file_goes_out_as_a_named_document(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    await adapter.send_attachment(ADA, "coder", "notes.zip", "application/zip", b"zip")
    [sent] = graph.sent
    assert sent["type"] == "document"
    assert sent["document"]["filename"] == "notes.zip"


async def test_an_oversized_file_is_refused_visibly(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    big = b"x" * (5 * 1024 * 1024 + 1)
    await adapter.send_attachment(ADA, "coder", "huge.jpg", "image/jpeg", big)
    assert graph.uploads == []
    [sent] = graph.sent
    assert sent["type"] == "text"
    assert "huge.jpg could not be sent on WhatsApp" in sent["text"]["body"]
    assert "5 MB limit for image files" in sent["text"]["body"]


async def test_the_working_reaction_goes_on_and_comes_off(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    await adapter.mark_activity(
        ADA, "wamid.in1", agent_name="coder", mark="working", on=True
    )
    await adapter.mark_activity(
        ADA, "wamid.in1", agent_name="coder", mark="working", on=False
    )
    on, typing, off = graph.sent
    assert on["type"] == "reaction"
    assert on["reaction"] == {"message_id": "wamid.in1", "emoji": "\N{EYES}"}
    assert typing == {
        "messaging_product": "whatsapp",
        "status": "read",
        "message_id": "wamid.in1",
        "typing_indicator": {"type": "text"},
    }
    assert off["reaction"] == {"message_id": "wamid.in1", "emoji": ""}


async def test_every_graph_call_carries_the_app_secret_proof(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    await adapter.send_message(ADA, "coder", "hi")
    await adapter.send_attachment(ADA, "coder", "a.png", "image/png", b"png")
    assert graph.proofs and set(graph.proofs) == {appsecret_proof(TOKEN, SECRET)}


async def test_a_refused_reaction_is_raised_as_refused(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    graph.refuse = (400, 131047)
    with pytest.raises(ActivityMarkRefused):
        await adapter.mark_activity(
            ADA, "wamid.in1", agent_name="coder", mark="working", on=True
        )


async def test_there_is_no_group_to_create(adapter: WhatsAppAdapter) -> None:
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("room", "topic")


def test_what_whatsapp_cannot_do_is_declared() -> None:
    assert WhatsAppAdapter.supports_channel_creation is False
    assert WhatsAppAdapter.supports_directory_search is False
    assert WhatsAppAdapter.supports_activity_reactions is True
    assert WhatsAppAdapter.draws_session_activity is True
    assert WhatsAppAdapter.supports_queue_reaction is False
    assert WhatsAppAdapter.outbound_urls(_config().model_dump()) == []


def test_whatsapps_marks_back_into_markdown() -> None:
    assert (
        from_whatsapp("*bold* _it_ ~old~ `*code*` 2*3*4 @support")
        == "**bold** _it_ ~~old~~ `*code*` 2*3*4 @support"
    )


def test_markdown_in_whatsapps_marks() -> None:
    assert (
        to_whatsapp("# Plan\n**bold** ~~old~~ [docs](https://x.test)")
        == "*Plan*\n*bold* ~old~ docs (https://x.test)"
    )


def test_failures_are_classified() -> None:
    assert (
        WhatsAppAdapter.classify_failure(WhatsAppError(401, 190, "no")) == "auth_failed"
    )
    assert (
        WhatsAppAdapter.classify_failure(WhatsAppError(400, 100, "no"))
        == "platform_error"
    )
    assert WhatsAppAdapter.classify_failure(httpx.ConnectError("down")) == "network"
    assert (
        WhatsAppAdapter.claimed_workspace({"phone_number_id": NUMBER_ID})
        == f"whatsapp {NUMBER_ID}"
    )
