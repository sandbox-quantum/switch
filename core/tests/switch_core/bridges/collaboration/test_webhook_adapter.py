from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import RequestCard, TurnActivity
from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.webhook import adapter as module
from switch_core.bridges.collaboration.webhook.adapter import (
    WebhookAdapter,
    WebhookConnectionConfig,
)
from switch_core.bridges.collaboration.webhook.protocol import (
    MAX_FILE_BYTES,
    Acknowledgment,
    Incoming,
    Outgoing,
    signature,
    split_text,
)
from switch_core.outbound import OutboundPolicy

from .session_fixtures import _item, _turn, open_request

TOKEN = "demo-inbound-" + "a" * 32
SECRET = "demo-signing-" + "b" * 32
CONFIG = {
    "outbound_url": "https://chat.example/receive",
    "inbound_token": TOKEN,
    "signing_secret": SECRET,
}
POLICY = OutboundPolicy.parse("")


def event(**changes):
    return {
        "version": 1,
        "event_id": "event-1",
        "type": "message",
        "channel_id": "chat",
        "channel_type": "channel_public",
        "sender": {"id": "human-1", "name": "Someone"},
        "message_id": "post-1",
        "text": "@agent hello",
        **changes,
    }


def request(payload, token=TOKEN):
    return WebhookRequest(
        method="POST",
        headers={"authorization": f"Bearer {token}"},
        query={},
        body=json.dumps(payload).encode(),
    )


@pytest.fixture
async def fixture(monkeypatch):
    sent = []
    responses = []
    policies = []

    async def receiver(req):
        payload = json.loads(req.content)
        timestamp = req.headers["x-switch-timestamp"]
        assert req.headers["x-switch-signature"] == signature(
            SECRET, timestamp, req.content
        )
        assert TOKEN.encode() not in req.content
        sent.append(payload)
        if responses:
            return responses.pop(0)(payload)
        return httpx.Response(200, json={"version": 1, "event_id": payload["event_id"]})

    def client(policy, **kwargs):
        policies.append(policy)
        assert kwargs["follow_redirects"] is False
        return httpx.AsyncClient(transport=httpx.MockTransport(receiver), **kwargs)

    monkeypatch.setattr(module, "guarded_async_client", client)
    adapter = WebhookAdapter(config=WebhookConnectionConfig(**CONFIG))
    adapter.set_outbound_policy(POLICY)
    adapter.set_webhook_url("https://switch.example/messaging/bridges/one/events")
    callbacks = [AsyncMock() for _ in range(5)]
    await adapter.start(*callbacks)
    yield adapter, sent, responses, callbacks, policies
    await adapter.stop()


@pytest.mark.parametrize(
    "url",
    [
        "http://public.example",
        "https://user:pass@chat.example/hook",
        "https://chat.example/hook?token=private",
        "file:///tmp/receiver",
        "https://chat.example/#fragment",
        "https://",
    ],
)
def test_bad_receiver_urls_are_refused(url):
    with pytest.raises(ValidationError):
        WebhookConnectionConfig(outbound_url=url)


async def test_secrets_are_generated_once_hidden_from_the_form_and_independent():
    first = await WebhookAdapter.prepare_config(
        {"outbound_url": "https://chat.example/receive"}
    )
    assert first == await WebhookAdapter.prepare_config(first)
    second = await WebhookAdapter.prepare_config(
        {"outbound_url": "https://chat.example/receive"}
    )
    assert first["inbound_token"] != second["inbound_token"]
    assert first["inbound_token"] != first["signing_secret"]
    schema = WebhookConnectionConfig.model_json_schema()
    assert set(schema["properties"]) == {"outbound_url"}
    assert "inbound_token" in WebhookAdapter.setup_values(first)


async def test_receiver_is_verified_before_saving_with_the_deployments_policy(fixture):
    _, sent, _, _, policies = fixture
    await WebhookAdapter.verify_connection(CONFIG, POLICY)
    assert sent[-1]["type"] == "connection.check"
    assert all(policy is POLICY for policy in policies)


async def test_bad_receiver_credentials_are_reported_clearly_without_echoing_its_body(
    fixture,
):
    _, _, responses, _, _ = fixture
    responses.append(lambda p: httpx.Response(401, text="private receiver diagnostic"))
    with pytest.raises(BridgeCredentialError, match="signature") as caught:
        await WebhookAdapter.verify_connection(CONFIG, POLICY)
    assert "private receiver" not in str(caught.value)


async def test_inbound_authentication_precedes_parsing_and_is_connection_specific(
    fixture,
):
    adapter, _, _, _, _ = fixture
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            request({"broken": True}, token="another-connection")
        )
    await adapter.verify_webhook(request(event()))
    second = WebhookAdapter(
        config=WebhookConnectionConfig(
            **{**CONFIG, "inbound_token": "other-" + "c" * 32}
        )
    )
    with pytest.raises(WebhookAuthenticityError):
        await second.verify_webhook(request(event()))


@pytest.mark.parametrize(
    "changes",
    [
        {"version": 2},
        {"type": "message.edit"},
        {"text": "", "attachments": []},
        {"channel_id": "../chat"},
        {"sender": {"id": "person", "name": "Name\nforged"}},
        {
            "attachments": [
                {"name": "../file", "mime_type": "text/plain", "data_base64": "eA=="}
            ]
        },
        {
            "attachments": [
                {"name": "file", "mime_type": "text/plain", "data_base64": "not base64"}
            ]
        },
    ],
)
async def test_malformed_inbound_events_are_refused_without_echoing_private_content(
    fixture, changes
):
    adapter, _, _, _, _ = fixture
    with pytest.raises(WebhookPayloadError) as caught:
        adapter.parse_webhook(request(event(**changes)))
    assert "@agent hello" not in str(caught.value)


async def test_message_thread_identity_and_attachments_reach_the_callbacks(fixture):
    adapter, _, _, callbacks, _ = fixture
    inbound = event(
        thread_id="root",
        attachments=[
            {
                "name": "notes.txt",
                "mime_type": "text/plain",
                "data_base64": base64.b64encode(b"notes").decode(),
            }
        ],
    )
    parsed = adapter.parse_webhook(request(inbound))
    assert parsed.external_event_id == "event-1"
    await adapter.dispatch_event(
        envelope_type=parsed.envelope_type, payload=parsed.payload
    )
    message = callbacks[0].call_args.args[0]
    assert (
        message.channel_id,
        message.message_ref,
        message.root_id,
        message.sender_id,
        message.content,
    ) == ("chat", "post-1", "root", "human-1", "@agent hello")
    assert message.attachments[0].data == b"notes"


@pytest.mark.parametrize("event_type", ["command", "message"])
async def test_commands_joins_and_echo_suppression(fixture, event_type):
    adapter, _, _, callbacks, _ = fixture
    for payload in [
        event(type=event_type, text="!invite-agent @worker", thread_id="root"),
        event(type="channel.join"),
        event(sender={"id": "agent", "name": "worker", "kind": "switch"}),
    ]:
        parsed = adapter.parse_webhook(request(payload))
        await adapter.dispatch_event(
            envelope_type=parsed.envelope_type, payload=parsed.payload
        )
    command = callbacks[1].call_args.args[0]
    assert (command.command, command.args, command.root_id, command.message_ref) == (
        "invite-agent",
        "@worker",
        "root",
        "post-1",
    )
    callbacks[4].assert_awaited_once()
    callbacks[0].assert_not_awaited()


@pytest.mark.parametrize("text", [" !help ", "\n!invite-agent\t@worker\n"])
async def test_typed_commands_ignore_surrounding_whitespace(fixture, text):
    adapter, _, _, callbacks, _ = fixture
    await adapter.dispatch_event(envelope_type="event", payload=event(text=text))
    command = callbacks[1].call_args.args[0]
    assert command.command in {"help", "invite-agent"}
    callbacks[0].assert_not_awaited()


@pytest.mark.parametrize(
    "text", ["!", "!!help", "!123", "!" + "a" * 65, "Example: !help"]
)
async def test_non_commands_remain_messages(fixture, text):
    adapter, _, _, callbacks, _ = fixture
    await adapter.dispatch_event(envelope_type="event", payload=event(text=text))
    assert callbacks[0].call_args.args[0].content == text
    callbacks[1].assert_not_awaited()


async def test_command_like_message_with_an_attachment_keeps_its_file(fixture):
    adapter, _, _, callbacks, _ = fixture
    await adapter.dispatch_event(
        envelope_type="event",
        payload=event(
            text="!help",
            attachments=[
                {
                    "name": "note.txt",
                    "mime_type": "text/plain",
                    "data_base64": "bm90ZXM=",
                }
            ],
        ),
    )
    assert callbacks[0].call_args.args[0].attachments[0].data == b"notes"
    callbacks[1].assert_not_awaited()


async def test_lost_ack_retries_the_identical_event_and_restart_uses_the_same_source_id(
    fixture,
):
    adapter, sent, responses, _, _ = fixture
    responses.append(lambda p: httpx.Response(503))
    with adapter.outbound_delivery("durable-room-event"):
        first = await adapter.send_message("chat", "worker", "Hello")
    assert sent[0] == sent[1]
    fresh = WebhookAdapter(config=WebhookConnectionConfig(**CONFIG))
    fresh.set_outbound_policy(POLICY)
    fresh.set_webhook_url("https://switch.example/messaging/bridges/one/events")
    await fresh.start(*[AsyncMock() for _ in range(5)])
    with fresh.outbound_delivery("durable-room-event"):
        assert await fresh.send_message("chat", "worker", "Hello") == first
    assert sent[0] == sent[2]
    await fresh.stop()


async def test_distinct_messages_with_identical_text_have_distinct_identity(fixture):
    adapter, _, _, _, _ = fixture
    with adapter.outbound_delivery("first"):
        first = await adapter.send_message("chat", "worker", "Same text")
    with adapter.outbound_delivery("second"):
        second = await adapter.send_message("chat", "worker", "Same text")
    assert first != second


async def test_long_unicode_messages_split_without_loss_and_keep_a_group_anchor(
    fixture,
):
    adapter, sent, _, _, _ = fixture
    text = "**bold** 😀\n" * 1500
    with adapter.outbound_delivery("long"):
        ref = await adapter.send_message("chat", "worker", text)
    assert "".join(p["text"] for p in sent) == text
    assert all(len(p["text"]) <= 4000 for p in sent)
    assert all(p["group_id"] == ref for p in sent[1:])
    assert "".join(split_text(text)) == text


async def test_edits_deletes_typing_and_files_use_the_same_contract(fixture):
    adapter, sent, _, _, _ = fixture
    await adapter.update_message("chat", "ref", "Edited **text**")
    await adapter.delete_message("chat", "ref")
    await adapter.send_typing("chat", "worker", True)
    await adapter.send_attachment(
        "chat", "worker", "file.txt", "text/plain", b"hello", "Caption", "root"
    )
    assert [p["type"] for p in sent] == [
        "message.update",
        "message.delete",
        "typing",
        "message.create",
    ]
    assert sent[0]["message_id"] == sent[1]["message_id"] == "ref"
    assert sent[2]["is_typing"] is True
    assert sent[3]["thread_id"] == "root"
    assert base64.b64decode(sent[3]["attachments"][0]["data_base64"]) == b"hello"


async def test_an_oversized_attachment_is_disclosed_visibly(fixture):
    adapter, sent, _, _, _ = fixture
    await adapter.send_attachments(
        "chat",
        "worker",
        [
            OutboundAttachment(
                filename="large",
                mimetype="application/octet-stream",
                data=b"x" * (MAX_FILE_BYTES + 1),
            )
        ],
    )
    assert "Attachment not relayed" in sent[-1]["text"]
    assert sent[-1]["attachments"] == []


async def test_receiver_cannot_acknowledge_a_different_or_oversized_response(fixture):
    adapter, _, responses, _, _ = fixture
    responses.append(
        lambda p: httpx.Response(200, json={"version": 1, "event_id": "wrong"})
    )
    with pytest.raises(BridgeOperationError, match="different event"):
        await adapter.send_message("chat", "worker", "Hello")
    responses.append(lambda p: httpx.Response(200, content=b"x" * 5000))
    with pytest.raises(BridgeOperationError, match="4096"):
        await adapter.send_message("chat", "worker", "Hello")


async def test_publication_recovery_asks_the_receiver_instead_of_assuming_delivery(
    fixture,
):
    adapter, sent, responses, _, _ = fixture
    for found in (False, True):
        responses.append(
            lambda p, found=found: httpx.Response(
                200, json={"version": 1, "event_id": p["event_id"], "found": found}
            )
        )
        ref = await adapter.find_request_card(
            "chat", None, "marker", datetime.now(UTC), "R1"
        )
        assert (ref is not None) is found
        assert sent[-1]["type"] == "publication.lookup"


async def test_activity_is_updated_in_place_and_request_replies_remain_text(fixture):
    adapter, sent, _, _, _ = fixture
    content = TurnActivity(
        [_item(status="in-progress", title="Read file")],
        _turn("running"),
        publication_token="marker",
    )
    first = await adapter.post_rich("chat", "worker", content)
    await adapter.update_rich(
        "chat", "worker", first, TurnActivity([], _turn("completed")), None
    )
    assert sent[0]["type"] == "activity"
    assert "Working" in sent[0]["text"]
    assert sent[1]["message_id"] == first
    assert "Turn complete" in sent[1]["text"]


async def test_questions_and_approvals_are_answerable_using_the_text_handle(fixture):
    adapter, sent, _, _, _ = fixture
    ref = await adapter.post_rich(
        "chat",
        "worker",
        RequestCard(
            open_request(), RequestReference(token="opaque-marker", handle="R7")
        ),
        "root",
    )
    assert sent[-1]["type"] == "request"
    assert "R7" in sent[-1]["text"]
    assert "Reply with" in sent[-1]["text"]
    assert sent[-1]["thread_id"] == "root"
    assert ref == sent[-1]["message_id"]


def test_shipped_schemas_match_the_validators():
    root = Path(module.__file__).parent
    for model, name in [
        (Incoming, "incoming"),
        (Outgoing, "outgoing"),
        (Acknowledgment, "acknowledgment"),
    ]:
        schema = json.loads((root / f"{name}.schema.json").read_text())
        assert schema == {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            **model.model_json_schema(),
        }
