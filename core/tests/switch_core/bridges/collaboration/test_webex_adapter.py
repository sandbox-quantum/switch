from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import (
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
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
)
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    position_action,
)
from switch_core.bridges.collaboration.webex import adapter as module
from switch_core.bridges.collaboration.webex.adapter import (
    MESSAGE_BYTES,
    SUBSCRIPTIONS,
    WebexAdapter,
    WebexConnectionConfig,
    split_message,
)
from switch_core.sessions.contract import (
    Question,
    QuestionOption,
    QuestionsContent,
    TurnUpsert,
)

from .session_fixtures import open_request


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    state: dict[str, Any] = {
        "calls": [],
        "hooks": [],
        "sent": [],
        "message": {
            "id": "incoming",
            "personId": "person",
            "roomId": "space",
            "roomType": "group",
            "text": "@reviewer hello",
            "parentId": "root",
        },
        "person": {"id": "person", "type": "person", "displayName": "Member"},
        "me": {"id": "bot", "type": "bot", "displayName": "Switch bot"},
        "action": {
            "id": "press",
            "personId": "person",
            "roomId": "space",
            "messageId": "card",
            "inputs": {"switch_token": secrets.token_urlsafe(), "switch_position": 1},
        },
    }

    def respond(request: httpx.Request) -> httpx.Response:
        state["calls"].append(request)
        if hook := state.get("respond"):
            result = hook(request)
            if result is not None:
                return result
        path = request.url.path
        if path == "/v1/people/me":
            return httpx.Response(200, json=state["me"])
        if path.startswith("/v1/people/"):
            return httpx.Response(200, json=state["person"])
        if path.startswith("/v1/attachment/actions/"):
            return httpx.Response(200, json=state["action"])
        if path == "/v1/memberships/member":
            return httpx.Response(
                200, json={"id": "member", "personId": "bot", "roomId": "space"}
            )
        if path.startswith("/v1/memberships"):
            return httpx.Response(200, json={"id": "member"})
        if path.startswith("/v1/rooms"):
            return httpx.Response(200, json={"id": "space", "type": "group"})
        if path == "/v1/webhooks":
            if request.method == "GET":
                return httpx.Response(200, json={"items": state["hooks"]})
            body = json.loads(request.content)
            state["hooks"].append(
                {**body, "status": "active", "id": f"hook-{len(state['hooks'])}"}
            )
            return httpx.Response(200, json=state["hooks"][-1])
        if path.startswith("/v1/webhooks/"):
            return httpx.Response(204)
        if path == "/v1/messages" and request.method == "POST":
            if "application/json" in request.headers.get("content-type", ""):
                state["sent"].append(json.loads(request.content))
            return httpx.Response(200, json={"id": f"out-{len(state['sent'])}"})
        if path == "/v1/messages" and request.method == "GET":
            return httpx.Response(200, json={"items": state.get("history", [])})
        if path.startswith("/v1/messages/"):
            return httpx.Response(200, json=state["message"])
        raise AssertionError(f"Unexpected Webex call: {request.method} {request.url}")

    def http(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(respond))

    monkeypatch.setattr(module, "guarded_async_client", http)
    return state


def config() -> WebexConnectionConfig:
    return WebexConnectionConfig(
        bot_token=secrets.token_urlsafe(),
        webhook_secret=secrets.token_urlsafe(),
        bot_id="bot",
    )


async def start(
    api: dict[str, Any],
    *,
    listening: bool = True,
    connection: WebexConnectionConfig | None = None,
) -> WebexAdapter:
    adapter = WebexAdapter(config=connection or config())
    adapter.set_webhook_url(
        "https://switch.example/messaging/bridges/connection/events"
    )
    adapter.set_listening(listening)
    adapter.set_outbound_policy(module.OutboundPolicy.parse(""))
    await adapter.start(*(AsyncMock() for _ in range(5)))
    return adapter


def delivery(adapter: WebexAdapter, **changes: Any) -> WebhookRequest:
    body = json.dumps(
        {
            "id": "registration-id",
            "resource": "messages",
            "event": "created",
            "data": {"id": "incoming"},
            **changes,
        }
    ).encode()
    signature = hmac.new(
        adapter.config.webhook_secret.encode(), body, hashlib.sha1
    ).hexdigest()
    return WebhookRequest(
        method="POST", headers={"x-spark-signature": signature}, query={}, body=body
    )


async def test_prepare_checks_bot_and_persists_secret(api: dict[str, Any]) -> None:
    prepared = await WebexAdapter.prepare_config({"bot_token": secrets.token_urlsafe()})
    assert prepared["bot_id"] == "bot"
    assert len(str(prepared["webhook_secret"])) >= 32
    assert WebexAdapter.claimed_workspace(prepared) == "bot"
    assert (
        "webhook_secret" not in WebexConnectionConfig.model_json_schema()["properties"]
    )


@pytest.mark.parametrize("person_type", ["person", None])
async def test_refuses_personal_token(
    api: dict[str, Any], person_type: str | None
) -> None:
    api["me"]["type"] = person_type
    with pytest.raises(BridgeCredentialError, match="bot access token"):
        await WebexAdapter.verify_credentials({"bot_token": secrets.token_urlsafe()})


@pytest.mark.parametrize(
    "status,exception",
    [
        (401, BridgeCredentialError),
        (403, BridgeOperationError),
        (429, BridgeOperationError),
        (503, BridgeOperationError),
    ],
)
async def test_api_failures_are_visible(
    api: dict[str, Any], status: int, exception: type[Exception]
) -> None:
    api["respond"] = lambda _: httpx.Response(
        status, json={"message": "do not expose vendor response content"}
    )
    with pytest.raises(exception):
        await WebexAdapter.verify_credentials({"bot_token": secrets.token_urlsafe()})


def test_empty_token_is_refused() -> None:
    with pytest.raises(ValidationError):
        WebexConnectionConfig(bot_token="")


async def test_only_owner_registers_and_restart_reuses_hooks(
    api: dict[str, Any],
) -> None:
    owner = await start(api)
    assert len(api["hooks"]) == len(SUBSCRIPTIONS)
    other = await start(api, listening=False)
    assert len([r for r in api["calls"] if r.url.path == "/v1/webhooks"]) == 4
    await owner.stop()
    assert not any(r.method == "DELETE" for r in api["calls"])
    successor = await start(api, connection=owner.config)
    assert len(api["hooks"]) == len(SUBSCRIPTIONS)
    assert not [r for r in api["calls"] if r.method == "PUT"]
    await other.stop()
    await successor.stop()


async def test_registration_rotation_and_withdraw_are_scoped(
    api: dict[str, Any],
) -> None:
    adapter = await start(api)
    api["hooks"].append({"id": "unrelated", "name": "Another app"})
    adapter.set_webhook_url(
        "https://new-switch.example/messaging/bridges/connection/events"
    )
    await adapter._subscribe()
    updates = [json.loads(r.content) for r in api["calls"] if r.method == "PUT"]
    assert all(
        x["targetUrl"].startswith("https://new-switch.example/")
        and x["status"] == "active"
        for x in updates
    )
    await adapter.withdraw()
    deleted = [r.url.path for r in api["calls"] if r.method == "DELETE"]
    assert len(deleted) == len(SUBSCRIPTIONS)
    assert not any("unrelated" in x for x in deleted)
    await adapter.stop()


async def test_failed_start_closes_client(api: dict[str, Any]) -> None:
    adapter = WebexAdapter(config=config())
    adapter.set_webhook_url("https://switch.example/events")
    api["me"]["type"] = "person"
    adapter.set_outbound_policy(module.OutboundPolicy.parse(""))
    with pytest.raises(BridgeCredentialError):
        await adapter.start(*(AsyncMock() for _ in range(5)))
    assert adapter._http is None


async def test_missing_public_url_is_clear(api: dict[str, Any]) -> None:
    with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
        await WebexAdapter(config=config()).start(*(AsyncMock() for _ in range(5)))


async def test_webhook_signature_and_event_identity(api: dict[str, Any]) -> None:
    adapter = await start(api, listening=False)
    first = delivery(adapter)
    await adapter.verify_webhook(first)
    one = adapter.parse_webhook(first)
    two = adapter.parse_webhook(delivery(adapter, data={"id": "different-message"}))
    assert one.external_event_id != two.external_event_id
    assert adapter.parse_webhook(first).external_event_id == one.external_event_id
    for bad in ("", "00" * 20, "non-ascii-🙂"):
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                WebhookRequest("POST", {"x-spark-signature": bad}, {}, first.body)
            )
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            WebhookRequest("POST", first.headers, {}, first.body + b" ")
        )
    await adapter.stop()


@pytest.mark.parametrize(
    "body",
    [
        b"null",
        b"[]",
        b"{",
        b"{}",
        b'{"resource":"messages","event":"created","data":null}',
        b'{"resource":"messages","event":"updated","data":{"id":"a"}}',
    ],
)
def test_bad_webhook_payloads(body: bytes) -> None:
    adapter = WebexAdapter(config=config())
    with pytest.raises(WebhookPayloadError):
        adapter.parse_webhook(WebhookRequest("POST", {}, {}, body))


async def test_inbound_message_threads_and_unaddressed_dm(api: dict[str, Any]) -> None:
    adapter = await start(api, listening=False)
    api["message"]["roomType"] = "direct"
    api["message"]["text"] = "unaddressed words"
    await adapter.dispatch_event(
        envelope_type="messages.created", payload={"data": {"id": "incoming"}}
    )
    message = adapter._on_message.call_args.args[0]
    assert (message.channel_id, message.channel_type, message.sender_name) == (
        "space",
        "direct",
        "Member",
    )
    assert message.root_id == "root"
    assert message.message_ref == "incoming"
    assert message.content == "unaddressed words"
    await adapter.stop()


async def test_commands_and_agent_mentions_survive_bot_mention(
    api: dict[str, Any],
) -> None:
    adapter = await start(api)
    api["message"].update(
        text="Switch bot !invite-agent @reviewer", mentionedPeople=["bot"]
    )
    await adapter._message("incoming")
    command = adapter._on_command.call_args.args[0]
    assert (command.command, command.args, command.root_id) == (
        "invite-agent",
        "@reviewer",
        "root",
    )
    api["message"]["text"] = "Switch bot @reviewer hello"
    await adapter._message("incoming")
    assert adapter._on_message.call_args.args[0].content == "@reviewer hello"
    await adapter.stop()


async def test_own_echo_is_ignored(api: dict[str, Any]) -> None:
    adapter = await start(api)
    api["message"]["personId"] = "bot"
    await adapter._message("incoming")
    adapter._on_message.assert_not_called()
    await adapter.stop()


async def test_bot_join_creates_room(api: dict[str, Any]) -> None:
    adapter = await start(api)
    await adapter.dispatch_event(
        envelope_type="memberships.created", payload={"data": {"id": "member"}}
    )
    assert adapter._on_app_joined.call_args.args[0].channel_id == "space"
    await adapter.stop()


async def test_messages_split_by_bytes_with_identity_and_thread(
    api: dict[str, Any],
) -> None:
    adapter = await start(api)
    content = "Unicode 🙂 words\n" * 2000
    await adapter.send_message("space", "reviewer", content, "root")
    assert len(api["sent"]) > 1
    assert all(
        len(x["markdown"].encode()) <= MESSAGE_BYTES and x["parentId"] == "root"
        for x in api["sent"]
    )
    assert "".join(x["markdown"].partition("\n")[2] for x in api["sent"]) == content
    await adapter.stop()


async def test_update_after_handover_preserves_attribution(api: dict[str, Any]) -> None:
    adapter = await start(api, listening=False)
    api["message"]["markdown"] = "**reviewer**\nOld text"
    await adapter.update_message("space", "posted", "Changed")
    update = next(r for r in reversed(api["calls"]) if r.method == "PUT")
    assert json.loads(update.content)["markdown"] == "**reviewer**\nChanged"
    await adapter.delete_message("space", "posted")
    assert api["calls"][-1].method == "DELETE"
    await adapter.stop()


async def test_upload_transfers_file_bytes_and_thread(api: dict[str, Any]) -> None:
    adapter = await start(api)
    await adapter.send_attachment(
        "space",
        "reviewer",
        "report.txt",
        "text/plain",
        b"report bytes",
        "Report",
        "root",
    )
    request = api["calls"][-1]
    assert request.headers["content-type"].startswith("multipart/form-data")
    for expected in (b"report bytes", b"report.txt", b"root", b"**reviewer**"):
        assert expected in request.content
    await adapter.stop()


async def test_oversized_upload_is_refused_visibly(api: dict[str, Any]) -> None:
    adapter = await start(api)
    adapter.set_max_attachment_bytes(2)
    await adapter.send_attachment(
        "space", "reviewer", "large.txt", "text/plain", b"123", thread_root_id="root"
    )
    assert "refused" in api["sent"][-1]["markdown"]
    assert api["sent"][-1]["parentId"] == "root"
    assert not any(
        "multipart/" in r.headers.get("content-type", "") for r in api["calls"]
    )
    await adapter.stop()


async def test_native_card_answer_on_another_pod(api: dict[str, Any]) -> None:
    owner = await start(api)
    card = RequestCard(
        open_request(), RequestReference(token=secrets.token_urlsafe(), handle="R1")
    )
    await owner.post_rich("space", "reviewer", card, "root")
    posted = api["sent"][-1]
    button = posted["attachments"][0]["content"]["actions"][0]
    assert button["type"] == "Action.Submit"
    assert posted["parentId"] == "root"
    api["action"]["inputs"] = button["data"]
    other = await start(api, listening=False)
    handler = AsyncMock()
    other.set_interaction_handler(handler)
    await other.dispatch_event(
        envelope_type="attachmentActions.created", payload={"data": {"id": "press"}}
    )
    answer = handler.call_args.args[0]
    assert (answer.sender_id, answer.value, answer.action_id) == (
        "person",
        card.reference.token,
        position_action(1),
    )
    assert answer.message_ref == "card"
    await owner.stop()
    await other.stop()


async def test_settled_card_removes_buttons(api: dict[str, Any]) -> None:
    adapter = await start(api)
    request = open_request().model_copy(update={"state": "closed"})
    await adapter.update_rich(
        "space",
        "reviewer",
        "card",
        RequestCard(
            request, RequestReference(token=secrets.token_urlsafe(), handle="R1")
        ),
        "root",
    )
    body = json.loads(api["calls"][-1].content)
    assert body["attachments"][0]["content"]["actions"] == []
    assert body["markdown"].startswith("**reviewer**")
    await adapter.stop()


async def test_confirmed_card_update_after_restart(api: dict[str, Any]) -> None:
    owner = await start(api)
    card = RequestCard(
        open_request(), RequestReference(token=secrets.token_urlsafe(), handle="R1")
    )
    reference = await owner.post_rich("space", "reviewer", card, "root")
    await owner.stop()
    successor = await start(api)
    await successor.update_rich("space", "reviewer", reference, card, "root")
    updated = json.loads(api["calls"][-1].content)
    assert (
        updated["attachments"][0]["content"]["actions"][0]["data"]["switch_token"]
        == card.reference.token
    )
    assert not successor.recovers_uncertain_posts
    assert successor.discloses_unconfirmed_posts
    await successor.stop()


@pytest.mark.parametrize("position", [None, -1, True, "1"])
async def test_bad_card_action_is_refused(api: dict[str, Any], position: Any) -> None:
    adapter = await start(api)
    api["action"]["inputs"]["switch_position"] = position
    adapter.set_interaction_handler(AsyncMock())
    with pytest.raises(WebhookPayloadError):
        await adapter._action("press")
    adapter._on_interaction.assert_not_called()
    await adapter.stop()


@pytest.mark.parametrize(
    "state,expected", [("running", "Working"), ("completed", "complete")]
)
async def test_working_and_finished_card(
    api: dict[str, Any], state: str, expected: str
) -> None:
    adapter = await start(api)
    turn = TurnUpsert(type="turn.upsert", turn_id="turn", command_id=None, status=state)
    await adapter.post_rich(
        "space",
        "reviewer",
        TurnActivity([], turn, publication_token=secrets.token_urlsafe()),
    )
    assert expected in api["sent"][-1]["markdown"]
    await adapter.stop()


async def test_room_creation_and_partial_membership(api: dict[str, Any]) -> None:
    adapter = await start(api)
    channel = await adapter.create_channel(
        "Review", "Topic", owner_external_id="person"
    )
    assert channel.id == "space"
    assert channel.name == "Review"

    def respond(request: httpx.Request) -> httpx.Response | None:
        if request.url.path == "/v1/memberships":
            body = json.loads(request.content)
            return httpx.Response(
                403 if body.get("personId") == "refused" else 200, json={"id": "member"}
            )
        return None

    api["respond"] = respond
    assert await adapter.add_users_to_channel(
        "space", ["member", "guest"], ["person", "refused"]
    ) == ["refused"]
    await adapter.stop()


def test_mention_markup_cannot_be_forged() -> None:
    adapter = WebexAdapter(config=config())
    assert "<@all>" not in adapter.translate_outbound("<@all> @everyone")
    assert adapter.classify_failure(httpx.ConnectError("offline")) == "network"


def test_split_retains_content() -> None:
    for text in ("x" * 17000, "🙂" * 7000, "line\n" * 5000, ""):
        chunks = split_message(text)
        assert "".join(chunks) == text
        assert all(len(x.encode()) <= MESSAGE_BYTES for x in chunks)


@pytest.mark.parametrize(
    "algorithm,digest", [("SHA-256", hashlib.sha256), ("SHA-512", hashlib.sha512)]
)
async def test_modern_signature_is_verified_without_legacy_downgrade(
    api, algorithm, digest
) -> None:
    adapter = await start(api)
    request = delivery(adapter)
    signature = hmac.new(
        adapter.config.webhook_secret.encode(), request.body, digest
    ).hexdigest()
    await adapter.verify_webhook(
        WebhookRequest(
            "POST", {"x-webex-signature": f"{algorithm}={signature}"}, {}, request.body
        )
    )
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            WebhookRequest(
                "POST",
                {**request.headers, "x-webex-signature": "SHA-256=bad"},
                {},
                request.body,
            )
        )
    await adapter.stop()


async def test_rate_limit_preserves_wait(api) -> None:
    adapter = await start(api)
    api["respond"] = lambda _: httpx.Response(429, headers={"retry-after": "17"})
    card = RequestCard(
        open_request(), RequestReference(token=secrets.token_urlsafe(), handle="R1")
    )
    with pytest.raises(RichContentThrottled) as error:
        await adapter.post_rich("space", "reviewer", card)
    assert error.value.retry_after == 17
    await adapter.stop()


async def test_unknown_post_outcome_keeps_uncertainty_visible(api) -> None:
    adapter = await start(api)

    def respond(request):
        if request.method == "POST":
            raise httpx.ReadTimeout("Response was lost", request=request)
        return None

    api["respond"] = respond
    card = RequestCard(
        open_request(), RequestReference(token=secrets.token_urlsafe(), handle="R1")
    )
    with pytest.raises(httpx.ReadTimeout):
        await adapter.post_rich("space", "reviewer", card)
    await adapter.stop()


async def test_changing_to_another_bot_requires_new_connection(api) -> None:
    with pytest.raises(BridgeOperationError, match="different Webex bot"):
        await WebexAdapter.verify_credentials(
            {"bot_token": secrets.token_urlsafe(), "bot_id": "another-bot"}
        )


async def test_fenced_code_stays_formatted_across_chunks(api) -> None:
    adapter = await start(api)
    await adapter.send_message(
        "space", "reviewer", "```python\n" + 'print("🙂")\n' * 2500 + "```"
    )
    assert len(api["sent"]) > 1
    for sent in api["sent"]:
        assert sent["markdown"].count("```") == 2
        assert len(sent["markdown"].encode()) <= MESSAGE_BYTES
    await adapter.stop()


async def test_html_formatting_and_mentions_are_translated(api) -> None:
    adapter = await start(api)
    api["message"].update(
        html='<p><spark-mention data-object-id="bot">Switch bot</spark-mention> @reviewer <strong>hello</strong> <a href="https://example.com">link</a></p>',
        mentionedPeople=["bot"],
    )
    await adapter._message("incoming")
    assert (
        adapter._on_message.call_args.args[0].content
        == "@reviewer **hello** [link](https://example.com)"
    )
    await adapter.stop()


async def test_download_failure_is_carried_for_visible_room_notice(api) -> None:
    adapter = await start(api)
    api["message"]["files"] = ["https://webexapis.com/v1/contents/file"]
    api["respond"] = lambda request: (
        httpx.Response(200, headers={"content-length": "1000"}, content=b"")
        if request.url.path.startswith("/v1/contents/")
        else None
    )
    adapter.set_max_attachment_bytes(8)
    await adapter._message("incoming")
    message = adapter._on_message.call_args.args[0]
    assert not message.attachments
    assert "8-byte" in message.attachment_failures[0].reason
    await adapter.stop()


async def test_bots_cannot_link_accounts_or_answer_requests(api) -> None:
    adapter = await start(api)
    api["person"]["type"] = "bot"
    assert await adapter.account_unlinkable_reason("person") is not None
    api["message"]["text"] = "!link-account code"
    await adapter._message("incoming")
    adapter._on_command.assert_not_called()
    assert adapter._on_message.call_args.args[0].sender_is_app
    with pytest.raises(WebhookPayloadError, match="Bots cannot answer"):
        await adapter._action("press")
    await adapter.stop()


async def test_large_sender_does_not_hang_chunker(api) -> None:
    adapter = await start(api)
    with pytest.raises(BridgeOperationError, match="sender name is too long"):
        await adapter.send_message("space", "x" * MESSAGE_BYTES, "hello")
    await adapter.stop()


async def test_server_error_does_not_claim_post_definitely_failed(api) -> None:
    adapter = await start(api)
    api["respond"] = lambda _: httpx.Response(503)
    card = RequestCard(
        open_request(), RequestReference(token=secrets.token_urlsafe(), handle="R1")
    )
    with pytest.raises(BridgeOperationError) as error:
        await adapter.post_rich("space", "reviewer", card)
    assert not isinstance(error.value, RichContentFailed)
    await adapter.stop()


@pytest.mark.parametrize("multi_select,expected_buttons", [(False, 2), (True, 0)])
async def test_question_buttons_and_typed_fallback(
    api, multi_select, expected_buttons
) -> None:
    adapter = await start(api)
    content = QuestionsContent(
        kind="questions",
        title="Choose target",
        questions=[
            Question(
                question_id="target",
                title="Target",
                prompt="Where should this run?",
                options=[
                    QuestionOption(option_id="test", label="Test", description=None),
                    QuestionOption(
                        option_id="staging", label="Staging", description=None
                    ),
                ],
                multi_select=multi_select,
                allow_custom_answer=False,
            )
        ],
    )
    request = open_request().model_copy(update={"content": content})
    await adapter.post_rich(
        "space",
        "reviewer",
        RequestCard(
            request, RequestReference(token=secrets.token_urlsafe(), handle="Q1")
        ),
    )
    posted = api["sent"][-1]
    assert len(posted["attachments"][0]["content"]["actions"]) == expected_buttons
    assert "Q1" in posted["markdown"]
    assert "Test" in posted["markdown"] and "Staging" in posted["markdown"]
    await adapter.stop()


def test_only_explicit_room_wide_send_can_page_everyone() -> None:
    adapter = WebexAdapter(config=config())
    assert "<@all>" not in adapter.translate_outbound("<@all> body")
    assert adapter.render_room_wide_mention("@everyone body").startswith("<@all> ")


@pytest.mark.parametrize(
    "path,method",
    [("/v1/people/me", "GET"), ("/v1/webhooks", "GET"), ("/v1/webhooks", "POST")],
)
async def test_start_waits_for_webex_rate_limit_then_recovers(
    api, monkeypatch, path, method
) -> None:
    waits = AsyncMock()
    monkeypatch.setattr(module.asyncio, "sleep", waits)
    refused = False

    def respond(request):
        nonlocal refused
        if request.url.path == path and request.method == method and not refused:
            refused = True
            return httpx.Response(429, headers={"retry-after": "23"})
        return None

    api["respond"] = respond
    adapter = await start(api)
    waits.assert_awaited_once_with(23.0)
    assert len(api["hooks"]) == len(SUBSCRIPTIONS)
    await adapter.stop()


async def test_origin_update_retries_rate_limit_without_creating_duplicate_hooks(
    api, monkeypatch
) -> None:
    adapter = await start(api)
    waits = AsyncMock()
    monkeypatch.setattr(module.asyncio, "sleep", waits)
    adapter.set_webhook_url(
        "https://new-switch.example/messaging/bridges/connection/events"
    )
    refused = False

    def respond(request):
        nonlocal refused
        if request.method == "PUT" and not refused:
            refused = True
            return httpx.Response(429, headers={"retry-after": "19"})
        return None

    api["respond"] = respond
    await adapter._subscribe()
    waits.assert_awaited_once_with(19.0)
    assert len(api["hooks"]) == len(SUBSCRIPTIONS)
    successful_updates = [r for r in api["calls"] if r.method == "PUT"][1:]
    assert len(successful_updates) == len(SUBSCRIPTIONS)
    assert all(
        json.loads(r.content)["targetUrl"].startswith("https://new-switch.example/")
        for r in successful_updates
    )
    await adapter.stop()


async def test_rate_limit_wait_is_cancelled_when_start_is_stopped(
    api, monkeypatch
) -> None:
    monkeypatch.setattr(
        module.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError)
    )
    api["respond"] = lambda _: httpx.Response(429, headers={"retry-after": "60"})
    adapter = WebexAdapter(config=config())
    adapter.set_webhook_url("https://switch.example/events")
    adapter.set_outbound_policy(module.OutboundPolicy.parse(""))
    with pytest.raises(asyncio.CancelledError):
        await adapter.start(*(AsyncMock() for _ in range(5)))
    assert adapter._http is None
