from __future__ import annotations

import asyncio
import base64
import datetime
import hashlib
import hmac
import json
import os
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding as asym_padding
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.hashes import SHA1
from cryptography.hazmat.primitives.padding import PKCS7
from cryptography.x509.oid import NameOID

from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.teams.crypto import (
    ResourceDataError,
    decrypt_resource_data,
    load_certificate_der_b64,
)


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _make_key_and_cert() -> tuple[str, str, x509.Certificate]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "switch-teams-test")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime(2020, 1, 1, tzinfo=datetime.UTC))
        .not_valid_after(datetime.datetime(2035, 1, 1, tzinfo=datetime.UTC))
        .sign(key, hashes.SHA256())
    )
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    return key_pem, cert_pem, cert


def _encrypt_like_graph(
    payload: dict[str, Any], cert: x509.Certificate
) -> dict[str, str]:
    """Encrypt a resource payload exactly as Microsoft Graph does, so the
    adapter's decryption can be verified end-to-end."""
    symmetric_key = os.urandom(32)
    raw = json.dumps(payload).encode("utf-8")

    padder = PKCS7(algorithms.AES.block_size).padder()
    padded = padder.update(raw) + padder.finalize()
    encryptor = Cipher(
        algorithms.AES(symmetric_key), modes.CBC(symmetric_key[:16])
    ).encryptor()
    data = encryptor.update(padded) + encryptor.finalize()

    data_key = cert.public_key().encrypt(  # type: ignore[union-attr]
        symmetric_key,
        asym_padding.OAEP(
            mgf=asym_padding.MGF1(algorithm=SHA1()), algorithm=SHA1(), label=None
        ),
    )
    signature = hmac.new(symmetric_key, data, hashlib.sha256).digest()
    return {
        "data": base64.b64encode(data).decode(),
        "dataKey": base64.b64encode(data_key).decode(),
        "dataSignature": base64.b64encode(signature).decode(),
    }


def _config(key_pem: str, cert_pem: str) -> TeamsConnectionConfig:
    return TeamsConnectionConfig(
        app_id="app-123",
        app_password="secret",
        tenant_id="tenant-1",
        team_id="team-1",
        public_base_url="https://switch.example",
        encryption_certificate_id="cert-1",
        encryption_public_certificate=cert_pem,
        encryption_private_key=key_pem,
        client_state="s3cr3t",
    )


# ── Crypto round-trip ────────────────────────────────────────────────────────


def test_decrypt_resource_data_round_trip() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    payload = {"id": "m1", "body": {"content": "hello world"}}

    encrypted = _encrypt_like_graph(payload, cert)
    decrypted = decrypt_resource_data(encrypted, key_pem)

    assert decrypted == payload


def test_decrypt_rejects_tampered_signature() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    encrypted = _encrypt_like_graph({"id": "x"}, cert)
    encrypted["dataSignature"] = base64.b64encode(b"not-the-signature").decode()

    try:
        decrypt_resource_data(encrypted, key_pem)
        raised = False
    except ResourceDataError:
        raised = True
    assert raised


def test_load_certificate_der_b64_round_trips_to_der() -> None:
    _, cert_pem, cert = _make_key_and_cert()
    der_b64 = load_certificate_der_b64(cert_pem)
    # It decodes back to the certificate's DER encoding.
    assert base64.b64decode(der_b64) == cert.public_bytes(serialization.Encoding.DER)


# ── Notification handling ────────────────────────────────────────────────────


class _FakeRequest:
    def __init__(
        self, *, query: dict[str, str] | None = None, body: Any = None
    ) -> None:
        self.query = query or {}
        self._body = body

    async def json(self) -> Any:
        if self._body is None:
            raise ValueError("no body")
        return self._body


def _adapter(key_pem: str, cert_pem: str) -> TeamsAdapter:
    return TeamsAdapter(config=_config(key_pem, cert_pem))


def _capture(adapter: TeamsAdapter) -> list[InboundMessage]:
    captured: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        captured.append(msg)

    adapter._on_message = on_message
    return captured


def test_validation_handshake_echoes_token() -> None:
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)

    resp = _run(
        adapter._handle_http_notifications(
            _FakeRequest(query={"validationToken": "tok-xyz"})  # type: ignore[arg-type]
        )
    )

    assert resp.status == 200
    assert resp.text == "tok-xyz"


def test_notification_decrypts_and_delivers_message() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    captured = _capture(adapter)
    adapter._channel_type["19:c@thread.tacv2"] = "channel_public"

    chat_message = {
        "id": "m100",
        "messageType": "message",
        "from": {"user": {"id": "aad-u", "displayName": "Alice"}},
        "channelIdentity": {"teamId": "t1", "channelId": "19:c@thread.tacv2"},
        "body": {"contentType": "html", "content": "<p>hello <at>Bot</at> team</p>"},
    }
    item = {
        "clientState": "s3cr3t",
        "encryptedContent": _encrypt_like_graph(chat_message, cert),
    }

    _run(adapter._dispatch_graph_notification(item))

    assert len(captured) == 1
    msg = captured[0]
    assert msg.channel_id == "19:c@thread.tacv2"
    assert msg.sender_id == "aad-u"
    assert msg.sender_name == "Alice"
    # The `<at>Bot</at>` mention is kept as an `@name` token, not deleted.
    assert msg.content == "hello @Bot team"
    assert msg.message_ref == "m100"
    assert msg.self_mention_token is None


def test_notification_sets_self_mention_token_for_bot_mention() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    captured = _capture(adapter)
    adapter._channel_type["19:c@thread.tacv2"] = "channel_public"

    chat_message = {
        "id": "m300",
        "messageType": "message",
        "from": {"user": {"id": "aad-u", "displayName": "Alice"}},
        "channelIdentity": {"teamId": "t1", "channelId": "19:c@thread.tacv2"},
        "body": {"contentType": "html", "content": '<p><at id="0">Bot</at> hi</p>'},
        "mentions": [
            {
                "id": 0,
                "mentionText": "Bot",
                "mentioned": {"application": {"id": "app-123", "displayName": "Bot"}},
            }
        ],
    }
    item = {
        "clientState": "s3cr3t",
        "encryptedContent": _encrypt_like_graph(chat_message, cert),
    }
    _run(adapter._dispatch_graph_notification(item))

    assert len(captured) == 1
    assert captured[0].content == "@Bot hi"
    assert captured[0].self_mention_token == "app-123"


def test_notification_no_self_mention_token_for_human_mention() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    captured = _capture(adapter)
    adapter._channel_type["19:c@thread.tacv2"] = "channel_public"

    chat_message = {
        "id": "m400",
        "messageType": "message",
        "from": {"user": {"id": "aad-u", "displayName": "Alice"}},
        "channelIdentity": {"teamId": "t1", "channelId": "19:c@thread.tacv2"},
        "body": {"contentType": "html", "content": '<p><at id="0">Bob</at> hi</p>'},
        "mentions": [
            {
                "id": 0,
                "mentionText": "Bob",
                "mentioned": {"user": {"id": "aad-bob", "displayName": "Bob"}},
            }
        ],
    }
    item = {
        "clientState": "s3cr3t",
        "encryptedContent": _encrypt_like_graph(chat_message, cert),
    }
    _run(adapter._dispatch_graph_notification(item))

    assert len(captured) == 1
    assert captured[0].content == "@Bob hi"
    assert captured[0].self_mention_token is None


def test_graph_message_attachment_is_disclosed() -> None:
    # A captured channel message carrying an attachment / inline image must
    # bridge its text and disclose the media rather than dropping it silently.
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    captured = _capture(adapter)
    adapter._channel_type["19:c@thread.tacv2"] = "channel_public"

    chat_message = {
        "id": "m-att",
        "messageType": "message",
        "from": {"user": {"id": "aad-u", "displayName": "Alice"}},
        "channelIdentity": {"teamId": "t1", "channelId": "19:c@thread.tacv2"},
        "body": {"contentType": "html", "content": "<p>see attached</p>"},
        "attachments": [{"contentType": "reference", "name": "report.pdf"}],
        "hostedContents": [{"id": "h1"}],
    }
    item = {
        "clientState": "s3cr3t",
        "encryptedContent": _encrypt_like_graph(chat_message, cert),
    }

    _run(adapter._dispatch_graph_notification(item))

    assert len(captured) == 1
    content = captured[0].content
    assert content.startswith("see attached")
    assert "report.pdf" in content
    assert "not relayed" in content


def test_notification_rejects_bad_client_state() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    captured = _capture(adapter)

    item = {
        "clientState": "WRONG",
        "encryptedContent": _encrypt_like_graph({"id": "m1"}, cert),
    }
    _run(adapter._dispatch_graph_notification(item))

    assert captured == []


def test_own_bot_message_is_not_delivered() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    captured = _capture(adapter)

    chat_message = {
        "id": "m200",
        "messageType": "message",
        # Authored by our own bot app → must be dropped (loop prevention).
        "from": {"application": {"id": "app-123", "displayName": "Switch"}},
        "channelIdentity": {"teamId": "t1", "channelId": "19:c@thread.tacv2"},
        "body": {"contentType": "text", "content": "echo"},
    }
    item = {
        "clientState": "s3cr3t",
        "encryptedContent": _encrypt_like_graph(chat_message, cert),
    }
    _run(adapter._dispatch_graph_notification(item))

    assert captured == []


def test_graph_capture_dedupes_with_bot_framework_path() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    captured = _capture(adapter)
    adapter._channel_type["19:c@thread.tacv2"] = "channel_public"

    chat_message = {
        "id": "dup-1",
        "messageType": "message",
        "from": {"user": {"id": "aad-u", "displayName": "Alice"}},
        "channelIdentity": {"teamId": "t1", "channelId": "19:c@thread.tacv2"},
        "body": {"contentType": "text", "content": "hi"},
    }
    item = {
        "clientState": "s3cr3t",
        "encryptedContent": _encrypt_like_graph(chat_message, cert),
    }
    _run(adapter._dispatch_graph_notification(item))
    # The same message id already seen via one path is ignored on the other.
    _run(adapter._dispatch_graph_notification(item))

    assert len(captured) == 1


def test_reply_sets_root_id_from_reply_to_id() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    captured = _capture(adapter)
    adapter._channel_type["19:c@thread.tacv2"] = "channel_public"

    chat_message = {
        "id": "reply-1",
        "messageType": "message",
        "replyToId": "root-1",
        "from": {"user": {"id": "aad-u", "displayName": "Alice"}},
        "channelIdentity": {"teamId": "t1", "channelId": "19:c@thread.tacv2"},
        "body": {"contentType": "text", "content": "a reply"},
    }
    item = {
        "clientState": "s3cr3t",
        "encryptedContent": _encrypt_like_graph(chat_message, cert),
    }
    _run(adapter._dispatch_graph_notification(item))

    assert captured[0].root_id == "root-1"


def test_system_event_message_is_ignored() -> None:
    key_pem, cert_pem, cert = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    captured = _capture(adapter)

    chat_message = {
        "id": "sys-1",
        "messageType": "systemEventMessage",
        "channelIdentity": {"teamId": "t1", "channelId": "19:c@thread.tacv2"},
        "body": {"contentType": "text", "content": ""},
    }
    item = {
        "clientState": "s3cr3t",
        "encryptedContent": _encrypt_like_graph(chat_message, cert),
    }
    _run(adapter._dispatch_graph_notification(item))

    assert captured == []


# ── Subscription lifecycle ───────────────────────────────────────────────────


class _FakeGraph:
    def __init__(self, existing: list[dict[str, Any]] | None = None) -> None:
        self.created: list[dict[str, Any]] = []
        self.renewed: list[dict[str, Any]] = []
        self.deleted: list[str] = []
        self._existing = existing or []

    async def create_subscription(self, **kwargs: Any) -> dict[str, Any]:
        self.created.append(kwargs)
        return {"id": "SUB-1"}

    async def renew_subscription(self, **kwargs: Any) -> None:
        self.renewed.append(kwargs)

    async def delete_subscription(self, *, subscription_id: str) -> None:
        self.deleted.append(subscription_id)

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        return self._existing


def test_ensure_channel_subscription_creates_with_expected_resource() -> None:
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]
    adapter._team_of_channel["19:c@thread.tacv2"] = "team-9"

    _run(adapter._ensure_channel_subscription("19:c@thread.tacv2"))

    assert len(fake.created) == 1
    assert (
        fake.created[0]["resource"]
        == "teams/team-9/channels/19:c@thread.tacv2/messages"
    )
    assert fake.created[0]["client_state"] == "s3cr3t"
    assert adapter._subscriptions["19:c@thread.tacv2"] == "SUB-1"


def test_ensure_channel_subscription_skips_without_certificate() -> None:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-1",
            team_id="team-1",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]
    adapter._team_of_channel["19:c@thread.tacv2"] = "team-9"

    _run(adapter._ensure_channel_subscription("19:c@thread.tacv2"))

    # No certificate configured → no subscription created (logged, not crashed).
    assert fake.created == []
    assert "19:c@thread.tacv2" not in adapter._subscriptions


def test_ensure_channel_subscriptions_recreates_missing_channel_subs() -> None:
    # Self-heal on startup: create subs for channels that lack one, skip
    # already-subscribed channels and non-channel (direct) conversations.
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]
    adapter._subscriptions["19:already@thread.tacv2"] = "EXISTING"

    _run(
        adapter.ensure_channel_subscriptions(
            [
                ("19:new@thread.tacv2", "channel_public"),
                ("19:priv@thread.tacv2", "channel_private"),
                ("19:already@thread.tacv2", "channel_public"),
                ("a:1dmchat", "direct"),
            ]
        )
    )

    resources = sorted(c["resource"] for c in fake.created)
    assert resources == [
        "teams/team-1/channels/19:new@thread.tacv2/messages",
        "teams/team-1/channels/19:priv@thread.tacv2/messages",
    ]


def test_adopt_existing_subscriptions_deletes_stale_and_keeps_current() -> None:
    # A rotated tunnel leaves subs pointing at a dead URL; on start we keep the
    # ones matching our current URL and delete the stale ones so they can be
    # recreated cleanly.
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    current = adapter._notification_url
    fake = _FakeGraph(
        existing=[
            {
                "id": "CUR",
                "resource": "teams/t/channels/19:keep@thread.tacv2/messages",
                "notificationUrl": current,
            },
            {
                "id": "OLD",
                "resource": "teams/t/channels/19:stale@thread.tacv2/messages",
                "notificationUrl": "https://dead.example/api/teams/notifications",
            },
            {
                "id": "OTHER",
                "resource": "users/u/messages",
                "notificationUrl": "https://x.example",
            },
        ]
    )
    adapter._graph = fake  # type: ignore[assignment]

    _run(adapter._adopt_existing_subscriptions())

    assert adapter._subscriptions == {"19:keep@thread.tacv2": "CUR"}
    assert fake.deleted == ["OLD"]


def test_channel_from_resource_parses_channel_id() -> None:
    assert (
        TeamsAdapter._channel_from_resource(
            "teams/team-9/channels/19:c@thread.tacv2/messages"
        )
        == "19:c@thread.tacv2"
    )


def test_lifecycle_reauthorization_renews_subscription() -> None:
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]

    _run(
        adapter._dispatch_graph_notification(
            {
                "lifecycleEvent": "reauthorizationRequired",
                "subscriptionId": "SUB-42",
                "clientState": "s3cr3t",
            }
        )
    )

    assert len(fake.renewed) == 1
    assert fake.renewed[0]["subscription_id"] == "SUB-42"


def test_lifecycle_event_with_bad_client_state_is_rejected() -> None:
    # A forged lifecycle notification (e.g. reauthorizationRequired) must not be
    # honoured without a valid clientState — the encryption authenticates only
    # data notifications, so lifecycle events rely entirely on clientState.
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]

    _run(
        adapter._dispatch_graph_notification(
            {
                "lifecycleEvent": "reauthorizationRequired",
                "subscriptionId": "SUB-42",
                "clientState": "WRONG",
            }
        )
    )

    assert fake.renewed == []


def test_renew_all_subscriptions_renews_each() -> None:
    key_pem, cert_pem, _ = _make_key_and_cert()
    adapter = _adapter(key_pem, cert_pem)
    fake = _FakeGraph()
    adapter._graph = fake  # type: ignore[assignment]
    adapter._subscriptions = {
        "19:c1@thread.tacv2": "S1",
        "19:c2@thread.tacv2": "S2",
    }

    _run(adapter._renew_all_subscriptions())

    assert {r["subscription_id"] for r in fake.renewed} == {"S1", "S2"}
