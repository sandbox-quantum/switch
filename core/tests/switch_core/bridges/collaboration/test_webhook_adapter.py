from __future__ import annotations

import base64
import hashlib
import hmac
import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.webhook import adapter as module
from switch_core.bridges.collaboration.webhook.adapter import (
    WebhookAdapter,
    WebhookConnectionConfig,
)
from switch_core.bridges.collaboration.webhook.protocol import (
    MAX_BODY_BYTES,
    MAX_FILE_BYTES,
    Incoming,
    Outgoing,
    parse_incoming,
    signature,
    verify_signature,
)
from switch_core.outbound import OutboundPolicy, OutboundURLRefused

CONFIG = {
    "outbound_url": "https://receiver.example/events",
    "inbound_token": "inbound-" + "a" * 40,
    "signing_secret": "signing-" + "b" * 40,
}
POLICY = OutboundPolicy.parse("")


def event(**changes):
    return {
        "version": 1,
        "type": "message.created",
        "event_id": "event-1",
        "message_id": "message-1",
        "channel_id": "channel-1",
        "sender_id": "user-1",
        "sender_name": "Ada",
        "text": "@agent hello",
        **changes,
    }


def request(payload=None, *, token=None, body=None, **headers):
    return WebhookRequest(
        method="POST",
        query={},
        headers={
            "content-type": "application/json",
            "authorization": "Bearer " + (token or CONFIG["inbound_token"]),
            **headers,
        },
        body=body if body is not None else json.dumps(payload or event()).encode(),
    )


@pytest.fixture
async def adapter(monkeypatch):
    sent = []
    statuses = []

    async def receiver(req):
        sent.append(req)
        if statuses:
            result = statuses.pop(0)
            if isinstance(result, BaseException):
                raise result
            return httpx.Response(result, stream=httpx.ByteStream(b""))
        payload = json.loads(req.content)
        proof = b""
        if payload["type"] == "connection.check":
            proof = (
                hmac.new(
                    CONFIG["signing_secret"].encode(),
                    b"switch-webhook-check-v1." + payload["challenge"].encode(),
                    hashlib.sha256,
                )
                .hexdigest()
                .encode()
            )
        return httpx.Response(200, stream=httpx.ByteStream(proof))

    def client(policy, **kwargs):
        assert policy == POLICY
        return httpx.AsyncClient(transport=httpx.MockTransport(receiver), **kwargs)

    monkeypatch.setattr(module, "guarded_async_client", client)
    instance = WebhookAdapter(config=WebhookConnectionConfig(**CONFIG))
    instance.set_outbound_policy(POLICY)
    callbacks = [AsyncMock() for _ in range(5)]
    await instance.start(*callbacks)
    yield instance, sent, statuses, callbacks
    await instance.stop()


@pytest.mark.parametrize(
    "field,value",
    [
        ("outbound_url", "http://example.com"),
        ("outbound_url", "https://user:password@example.com"),
        ("outbound_url", "https://example.com/path?token=x"),
        ("outbound_url", "https://example.com/#fragment"),
        ("outbound_url", "https://example.com:bad"),
        ("inbound_token", "short"),
        ("inbound_token", "a" * 32 + "\n"),
        ("signing_secret", CONFIG["inbound_token"]),
    ],
)
def test_config_rejects_unsafe_settings(field, value):
    with pytest.raises(ValidationError):
        WebhookConnectionConfig(**{**CONFIG, field: value})


async def test_authentication_is_per_connection_and_constant_time(adapter, monkeypatch):
    instance, _, _, _ = adapter
    original = hmac.compare_digest
    calls = []

    def compare(left, right):
        calls.append((left, right))
        return original(left, right)

    monkeypatch.setattr(hmac, "compare_digest", compare)
    await instance.verify_webhook(request())
    for bad in ("wrong-connection-" + "c" * 40, "☃", ""):
        bad_request = WebhookRequest(
            method="POST",
            body=b"not json",
            query={},
            headers={"authorization": "Bearer " + bad},
        )
        with pytest.raises(WebhookAuthenticityError):
            await instance.verify_webhook(bad_request)
    assert len(calls) == 4
    assert all(isinstance(left, bytes) for left, _ in calls)
    with pytest.raises(WebhookAuthenticityError):
        await instance.verify_webhook(
            WebhookRequest(method="GET", body=b"", headers={}, query={})
        )


@pytest.mark.parametrize(
    "payload",
    [
        b"not JSON",
        b"[]",
        b'{"version":1,"version":2}',
        b'{"version":true}',
        json.dumps(event(version=2)).encode(),
        json.dumps(event(version="1")).encode(),
        json.dumps(event(text="")).encode(),
        json.dumps(event(message_id="")).encode(),
        json.dumps(event(thread_id="message-1")).encode(),
        json.dumps(event(unexpected="field")).encode(),
        json.dumps(event(sender_id=5)).encode(),
        json.dumps(event(text="x" * 100001)).encode(),
        b"x" * (MAX_BODY_BYTES + 1),
    ],
)
async def test_invalid_envelopes_are_refused_safely(adapter, payload):
    instance, _, _, _ = adapter
    with pytest.raises(WebhookPayloadError, match="Invalid v1"):
        instance.parse_webhook(request(body=payload))


async def test_schema_content_type_and_version(adapter):
    instance, _, _, _ = adapter
    with pytest.raises(WebhookPayloadError, match="application/json"):
        instance.parse_webhook(request(**{"content-type": "text/plain"}))
    assert Incoming.model_json_schema()["properties"]["version"]["const"] == 1
    assert Outgoing.model_json_schema()["properties"]["version"]["const"] == 1


async def test_inbound_identity_threads_files_and_commands(adapter):
    instance, _, _, callbacks = adapter
    file = {
        "filename": "hello.txt",
        "mimetype": "text/plain",
        "data_base64": base64.b64encode(b"hello").decode(),
    }
    parsed = instance.parse_webhook(
        request(event(thread_id="root", attachments=[file]))
    )
    assert parsed.external_event_id == "event-1"
    await instance.dispatch_event(
        envelope_type=parsed.envelope_type, payload=parsed.payload
    )
    message = callbacks[0].call_args.args[0]
    assert (message.message_ref, message.root_id) == ("message-1", "root")
    assert message.attachments[0].data == b"hello"
    assert message.agent_name is None
    command = instance.parse_webhook(
        request(event(text="!invite-agent helper", thread_id="root"))
    )
    await instance.dispatch_event(
        envelope_type=command.envelope_type, payload=command.payload
    )
    invoked = callbacks[1].call_args.args[0]
    assert (invoked.command, invoked.args, invoked.root_id) == (
        "invite-agent",
        "helper",
        "root",
    )
    joined = instance.parse_webhook(request(event(type="channel.connected", text="")))
    await instance.dispatch_event(
        envelope_type=joined.envelope_type, payload=joined.payload
    )
    assert callbacks[4].call_args.args[0].channel_id == "channel-1"


@pytest.mark.parametrize(
    "kind,text",
    [
        ("message.updated", "corrected"),
        ("message.deleted", ""),
    ],
)
async def test_inbound_mutations_are_explicit_threaded_notices(adapter, kind, text):
    instance, _, _, callbacks = adapter
    parsed = instance.parse_webhook(request(event(type=kind, text=text)))
    await instance.dispatch_event(envelope_type=kind, payload=parsed.payload)
    message = callbacks[0].call_args.args[0]
    assert message.root_id == "message-1"
    assert message.message_ref == "event-1"
    assert ("edited" if text else "deleted") in message.content


@pytest.mark.parametrize(
    "changes",
    [
        {"filename": "../secret"},
        {"filename": ".."},
        {"filename": "bad\nname"},
        {"mimetype": "text/html; charset=utf-8"},
        {"data_base64": "not base64!"},
        {"data_base64": base64.b64encode(b"x" * (MAX_FILE_BYTES + 1)).decode()},
        {"url": "http://169.254.169.254"},
    ],
)
def test_unsafe_attachments_are_rejected(changes):
    file = {
        "filename": "hello.txt",
        "mimetype": "text/plain",
        "data_base64": "eA==",
        **changes,
    }
    with pytest.raises(ValueError):
        parse_incoming(json.dumps(event(attachments=[file])).encode())


def test_attachment_count_and_boundary():
    file = {
        "filename": "hello.txt",
        "mimetype": "text/plain",
        "data_base64": base64.b64encode(b"x" * MAX_FILE_BYTES).decode(),
    }
    assert (
        len(
            parse_incoming(json.dumps(event(attachments=[file])).encode())
            .attachments[0]
            .decoded()
        )
        == MAX_FILE_BYTES
    )
    with pytest.raises(ValueError):
        parse_incoming(json.dumps(event(attachments=[file] * 5)).encode())


def test_published_schemas_match_the_wire_models():
    from switch_core.bridges.collaboration.webhook import protocol

    folder = Path(protocol.__file__).parent
    for name, model in (("incoming", Incoming), ("outgoing", Outgoing)):
        assert (
            json.loads((folder / f"{name}.schema.json").read_text())
            == model.model_json_schema()
        )


@pytest.mark.parametrize("status", [301, 302, 307, 308, 422])
async def test_redirects_and_other_permanent_errors_are_not_retried(adapter, status):
    instance, sent, statuses, _ = adapter
    statuses.append(status)
    with pytest.raises(BridgeOperationError, match=f"HTTP {status}"):
        await instance.send_message("channel", "Agent", "permanent failure")
    assert len(sent) == 1


async def test_rate_limits_are_bounded_and_retries_keep_ids(adapter):
    instance, sent, statuses, _ = adapter
    statuses.extend([429, 429, 429])
    with pytest.raises(BridgeOperationError, match="bounded"):
        await instance.send_message("channel", "Agent", "rate limited")
    assert len(sent) == 3
    assert len({r.headers["idempotency-key"] for r in sent}) == 1


def test_signatures_detect_tampering_and_expired_timestamps():
    body = b'{"version":1}'
    timestamp = "1234567890"
    signed = signature("secret", timestamp, body)
    assert verify_signature("secret", timestamp, body, signed, now=1234567890)
    for secret, ts, data, digest, now in [
        ("other", timestamp, body, signed, 1234567890),
        ("secret", timestamp, body + b" ", signed, 1234567890),
        ("secret", "1234567891", body, signed, 1234567890),
        ("secret", timestamp, body, signed, 1234568191),
        ("secret", timestamp, body, signed, 1234567589),
        ("secret", "NaN", body, signed, 1234567890),
        ("secret", "☃", body, signed, 1234567890),
        ("secret", timestamp, body, "☃", 1234567890),
    ]:
        assert not verify_signature(secret, ts, data, digest, now=now)


async def test_receiver_credentials_verified_without_disclosing_secrets(adapter):
    _, sent, statuses, _ = adapter
    await WebhookAdapter.verify_connection(CONFIG, POLICY)
    assert json.loads(sent[0].content)["type"] == "connection.check"
    assert CONFIG["inbound_token"].encode() not in sent[0].content
    assert CONFIG["signing_secret"].encode() not in sent[0].content
    statuses.append(200)  # No proof of possession.
    with pytest.raises(BridgeCredentialError, match="prove"):
        await WebhookAdapter.verify_connection(CONFIG, POLICY)
    statuses.append(401)
    with pytest.raises(BridgeCredentialError, match="refused"):
        await WebhookAdapter.verify_connection(CONFIG, POLICY)


async def test_outbound_signatures_and_stable_identity_after_restart(adapter):
    instance, sent, _, _ = adapter
    with instance.delivery_scope("transport-event"):
        first = await instance.send_message("channel", "Agent", "same", "root")
    # A fresh instance has neither counters nor caches from the first.
    fresh = WebhookAdapter(config=WebhookConnectionConfig(**CONFIG))
    fresh.set_outbound_policy(POLICY)
    await fresh.start(*[AsyncMock() for _ in range(5)])
    try:
        with fresh.delivery_scope("transport-event"):
            second = await fresh.send_message("channel", "Agent", "same", "root")
        with fresh.delivery_scope("different-transport-event"):
            third = await fresh.send_message("channel", "Agent", "same", "root")
    finally:
        await fresh.stop()
    assert first == second != third
    assert sent[0].content == sent[1].content != sent[2].content
    assert json.loads(sent[0].content)["thread_id"] == "root"
    for req in sent:
        assert verify_signature(
            CONFIG["signing_secret"],
            req.headers["x-switch-timestamp"],
            req.content,
            req.headers["x-switch-signature"],
        )
        assert req.headers["idempotency-key"] == json.loads(req.content)["event_id"]


async def test_long_messages_reassemble_with_one_thread_identity(adapter):
    instance, sent, _, _ = adapter
    content = "```python\n" + "print('hello')\n" * 2000 + "```"
    with instance.delivery_scope("long"):
        ref = await instance.send_message("channel", "Agent", content, "root")
    payloads = [json.loads(r.content) for r in sent]
    assert "".join(p["text"] for p in payloads) == content
    assert len({p["event_id"] for p in payloads}) == len(payloads)
    assert all(p["message_id"] == ref and p["thread_id"] == "root" for p in payloads)
    assert [p["part"] for p in payloads] == list(range(1, len(payloads) + 1))


async def test_outbound_mutations_activity_and_files(adapter):
    instance, sent, _, _ = adapter
    await instance.update_message("channel", "message", "new")
    await instance.delete_message("channel", "message")
    await instance.send_typing("channel", "Agent", True)
    await instance.notify_working("channel", "Agent", "root")
    await instance.send_attachment(
        "channel", "Agent", "file.txt", "text/plain", b"hello", "caption", "root"
    )
    payloads = [json.loads(r.content) for r in sent]
    assert [p["type"] for p in payloads] == [
        "message.updated",
        "message.deleted",
        "activity",
        "activity",
        "message.created",
    ]
    assert payloads[3]["thread_id"] == "root"
    assert base64.b64decode(payloads[4]["attachments"][0]["data_base64"]) == b"hello"
    await instance.send_attachments(
        "channel",
        "Agent",
        [
            OutboundAttachment(
                filename="large",
                mimetype="text/plain",
                data=b"x" * (MAX_FILE_BYTES + 1),
            )
        ],
    )
    assert "Attachment not relayed" in json.loads(sent[-1].content)["text"]


async def test_repeated_text_in_separate_edits_is_not_a_duplicate_operation(adapter):
    instance, sent, _, _ = adapter
    for text in ("A", "B", "A"):
        await instance.update_message("channel", "message", text)
    assert len({json.loads(r.content)["event_id"] for r in sent}) == 3
    for _ in range(2):
        with instance.delivery_scope("durable-edit-source"):
            await instance.update_message("channel", "message", "scoped")
    assert sent[-1].content == sent[-2].content


async def test_retries_keep_identical_payload_and_stop_on_permanent_errors(adapter):
    instance, sent, statuses, _ = adapter
    statuses.extend([httpx.ReadTimeout("timeout"), 503, 200])
    await instance.send_message("channel", "Agent", "retry")
    assert len(sent) == 3
    assert len({r.content for r in sent}) == 1
    assert len({r.headers["idempotency-key"] for r in sent}) == 1
    statuses.extend([400, 200])
    with pytest.raises(BridgeOperationError, match="HTTP 400"):
        await instance.send_message("channel", "Agent", "bad")
    assert statuses == [200]


async def test_exhausted_timeouts_and_stopped_connection(adapter):
    instance, sent, statuses, _ = adapter
    statuses.extend([httpx.ConnectTimeout("timeout")] * 3)
    with pytest.raises(BridgeOperationError, match="bounded"):
        await instance.send_message("channel", "Agent", "unreachable")
    assert len(sent) == 3
    await instance.stop()
    with pytest.raises(BridgeOperationError, match="stopped"):
        await instance.send_message("channel", "Agent", "stopped")


async def test_destination_policy_and_capabilities():
    assert WebhookAdapter.outbound_urls(CONFIG) == [CONFIG["outbound_url"]]
    for address in ("https://127.0.0.1/events", "https://169.254.169.254/events"):
        with pytest.raises(OutboundURLRefused):
            await WebhookAdapter.verify_connection(
                {**CONFIG, "outbound_url": address}, POLICY
            )
    instance = WebhookAdapter(config=WebhookConnectionConfig(**CONFIG))
    with pytest.raises(ChannelCreationUnsupported):
        await instance.create_channel("test", "topic")
    with pytest.raises(ChannelCreationUnsupported):
        await instance.get_channel_type("unknown")
    assert not instance.supports_channel_creation
    assert not instance.supports_directory_search
