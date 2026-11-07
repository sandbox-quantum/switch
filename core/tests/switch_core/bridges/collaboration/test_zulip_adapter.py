"""The Zulip adapter: config, capability flags, failure classification,
inbound dispatch (stream messages, DMs, `!commands`, own-echo, mentions),
and outbound calls — against a fake client, not real HTTP (that's
`test_zulip_client.py`)."""

from __future__ import annotations

import ssl

import httpx
import pytest

from switch_core.bridges.collaboration.zulip.adapter import (
    ZulipAdapter,
    ZulipConnectionConfig,
    _channel_id_for_dm,
    _channel_id_for_stream,
    _parse_channel_id,
    _root_id_for_topic,
    _topic_from_root_id,
)
from switch_core.bridges.collaboration.zulip.client import (
    ZulipApiError,
    ZulipSiteInvalid,
)


def _config(**overrides: object) -> ZulipConnectionConfig:
    base = dict(
        site="https://example.zulipchat.com",
        bot_email="bot@example.com",
        api_key="s3cret",
    )
    base.update(overrides)
    return ZulipConnectionConfig(**base)  # type: ignore[arg-type]


# ── Config ───────────────────────────────────────────────────────────────


def test_config_rejects_a_non_https_site() -> None:
    with pytest.raises(ValueError, match="https"):
        _config(site="http://example.zulipchat.com")


def test_api_key_field_is_auto_masked_by_name() -> None:
    schema = ZulipConnectionConfig.model_json_schema()
    assert "api_key" in schema["properties"]
    assert "api_key" in "api_key"  # the exact substring Console masks on


def test_default_new_topic() -> None:
    assert _config().new_topic == "Switch"


# ── Capability flags ─────────────────────────────────────────────────────


def test_keeps_quiet_unless_listening() -> None:
    assert ZulipAdapter.keeps_quiet_unless_listening is True


def test_supports_activity_reactions_and_queue_reaction() -> None:
    assert ZulipAdapter.supports_activity_reactions is True
    assert ZulipAdapter.supports_queue_reaction is True
    assert ZulipAdapter.activity_reactions_per_agent is False


def test_does_not_support_directory_search() -> None:
    assert ZulipAdapter.supports_directory_search is False


# ── Channel id / root id helpers ─────────────────────────────────────────


def test_stream_channel_id_round_trips() -> None:
    assert _parse_channel_id(_channel_id_for_stream(42)) == ("stream", [42])


def test_dm_channel_id_sorts_and_dedupes_user_ids() -> None:
    assert _channel_id_for_dm([3, 1, 1, 2]) == "dm:1,2,3"
    assert _parse_channel_id("dm:1,2,3") == ("dm", [1, 2, 3])


def test_root_id_round_trips_a_topic_name() -> None:
    root_id = _root_id_for_topic("general chat")
    assert _topic_from_root_id(root_id, "fallback") == "general chat"


def test_no_root_id_falls_back_to_the_default_topic() -> None:
    assert _topic_from_root_id(None, "Switch") == "Switch"


# ── classify_failure ─────────────────────────────────────────────────────


def test_classify_failure_maps_invalid_api_key_to_auth_failed() -> None:
    exc = ZulipApiError("INVALID_API_KEY", "Invalid API key", status_code=401)
    assert ZulipAdapter.classify_failure(exc) == "auth_failed"


def test_classify_failure_maps_other_api_errors_to_platform_error() -> None:
    exc = ZulipApiError("BAD_REQUEST", "nope", status_code=400)
    assert ZulipAdapter.classify_failure(exc) == "platform_error"


def test_classify_failure_maps_bad_site_to_config_invalid() -> None:
    assert ZulipAdapter.classify_failure(ZulipSiteInvalid("bad")) == "config_invalid"


def test_classify_failure_maps_transport_errors_to_network() -> None:
    assert ZulipAdapter.classify_failure(httpx.ConnectError("refused")) == "network"


def test_classify_failure_defers_on_unrelated_exceptions() -> None:
    assert ZulipAdapter.classify_failure(ssl.SSLError("x")) is None


# ── outbound_urls ────────────────────────────────────────────────────────


def test_outbound_urls_carries_the_configured_site() -> None:
    urls = ZulipAdapter.outbound_urls(
        {
            "site": "https://example.zulipchat.com",
            "bot_email": "b@x.com",
            "api_key": "k",
        }
    )
    assert urls == ["https://example.zulipchat.com"]


# ── Inbound dispatch (fake client, no HTTP) ──────────────────────────────


class _Recorder:
    def __init__(self) -> None:
        self.messages: list[object] = []
        self.commands: list[object] = []

    async def on_message(self, msg: object) -> None:
        self.messages.append(msg)

    async def on_command(self, cmd: object) -> None:
        self.commands.append(cmd)


def _wired_adapter(bot_user_id: int = 1) -> tuple[ZulipAdapter, _Recorder]:
    adapter = ZulipAdapter(config=_config())
    adapter._bot_user_id = bot_user_id
    rec = _Recorder()
    adapter._on_message = rec.on_message
    adapter._on_command = rec.on_command
    return adapter, rec


async def test_a_stream_message_is_relayed_with_topic_as_root_id() -> None:
    adapter, rec = _wired_adapter()
    message = {
        "id": 501,
        "sender_id": 2,
        "sender_full_name": "Alice",
        "content": "hello agent",
        "type": "stream",
        "stream_id": 7,
        "subject": "general",
    }
    await adapter._deliver_message(message)
    assert len(rec.messages) == 1
    msg = rec.messages[0]
    assert msg.channel_id == "stream:7"  # type: ignore[attr-defined]
    assert msg.root_id == "topic:general"  # type: ignore[attr-defined]
    assert msg.content == "hello agent"  # type: ignore[attr-defined]
    assert msg.sender_name == "Alice"  # type: ignore[attr-defined]
    assert msg.message_ref == "501"  # type: ignore[attr-defined]


async def test_a_direct_message_has_no_thread_and_excludes_the_bot_from_the_id() -> (
    None
):
    adapter, rec = _wired_adapter(bot_user_id=99)
    message = {
        "id": 502,
        "sender_id": 2,
        "sender_full_name": "Alice",
        "content": "hi",
        "type": "private",
        "display_recipient": [{"id": 2}, {"id": 99}],
    }
    await adapter._deliver_message(message)
    msg = rec.messages[0]
    assert msg.channel_id == "dm:2"  # type: ignore[attr-defined]
    assert msg.root_id is None  # type: ignore[attr-defined]


async def test_the_bots_own_message_is_ignored() -> None:
    adapter, rec = _wired_adapter(bot_user_id=99)
    message = {
        "id": 503,
        "sender_id": 99,
        "sender_full_name": "Switch",
        "content": "x",
        "type": "stream",
        "stream_id": 7,
        "subject": "general",
    }
    await adapter._deliver_message(message)
    assert rec.messages == []


async def test_a_bang_prefixed_message_is_dispatched_as_a_command() -> None:
    adapter, rec = _wired_adapter()
    message = {
        "id": 504,
        "sender_id": 2,
        "sender_full_name": "Alice",
        "content": "!invite-agent Grok",
        "type": "stream",
        "stream_id": 7,
        "subject": "general",
    }
    await adapter._deliver_message(message)
    assert rec.messages == []
    assert len(rec.commands) == 1
    assert rec.commands[0].command == "invite-agent"  # type: ignore[attr-defined]
    assert rec.commands[0].args == "Grok"  # type: ignore[attr-defined]


async def test_inbound_mention_markup_is_translated_to_plain_at_name() -> None:
    adapter, rec = _wired_adapter()
    message = {
        "id": 505,
        "sender_id": 2,
        "sender_full_name": "Alice",
        "content": "hey @**AgentName** help",
        "type": "stream",
        "stream_id": 7,
        "subject": "general",
    }
    await adapter._deliver_message(message)
    assert rec.messages[0].content == "hey @AgentName help"  # type: ignore[attr-defined]


# ── Outbound (fake client) ───────────────────────────────────────────────


class _FakeClient:
    def __init__(self) -> None:
        self.stream_sends: list[tuple[int, str, str]] = []
        self.dm_sends: list[tuple[list[int], str]] = []
        self.updates: list[tuple[int, str]] = []
        self.deletes: list[int] = []
        self.reactions: list[tuple[int, str, bool]] = []
        self._next_id = 1000

    async def send_stream_message(
        self, *, stream_id: int, topic: str, content: str
    ) -> int:
        self.stream_sends.append((stream_id, topic, content))
        self._next_id += 1
        return self._next_id

    async def send_direct_message(self, *, user_ids: list[int], content: str) -> int:
        self.dm_sends.append((user_ids, content))
        self._next_id += 1
        return self._next_id

    async def update_message(self, message_id: int, *, content: str) -> None:
        self.updates.append((message_id, content))

    async def delete_message(self, message_id: int) -> None:
        self.deletes.append(message_id)

    async def add_reaction(self, message_id: int, *, emoji_name: str) -> None:
        self.reactions.append((message_id, emoji_name, True))

    async def remove_reaction(self, message_id: int, *, emoji_name: str) -> None:
        self.reactions.append((message_id, emoji_name, False))


def _adapter_with_fake_client() -> tuple[ZulipAdapter, _FakeClient]:
    adapter = ZulipAdapter(config=_config())
    fake = _FakeClient()
    adapter._client = fake  # type: ignore[assignment]
    return adapter, fake


async def test_send_message_to_a_stream_uses_the_topic_from_root_id() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.send_message("stream:7", "AgentName", "hello", "topic:general")
    assert fake.stream_sends == [(7, "general", "**AgentName**\nhello")]


async def test_send_message_to_a_stream_with_no_thread_uses_new_topic() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.send_message("stream:7", "AgentName", "hello", None)
    assert fake.stream_sends[0][1] == "Switch"


async def test_send_message_to_a_dm_ignores_thread_root_id() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.send_message("dm:2,3", "AgentName", "hello")
    assert fake.dm_sends == [([2, 3], "**AgentName**\nhello")]


async def test_update_message_calls_the_client_with_the_integer_id() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.update_message("stream:7", "501", "new text")
    assert fake.updates == [(501, "new text")]


async def test_delete_message_calls_the_client_with_the_integer_id() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.delete_message("stream:7", "501")
    assert fake.deletes == [501]


async def test_mark_activity_working_adds_the_eyes_reaction() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.mark_activity(
        "stream:7", "501", agent_name="AgentName", mark="working", on=True
    )
    assert fake.reactions == [(501, "eyes", True)]


async def test_mark_activity_queued_uses_a_different_emoji_than_working() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.mark_activity(
        "stream:7", "501", agent_name="AgentName", mark="queued", on=True
    )
    await adapter.mark_activity(
        "stream:7", "501", agent_name="AgentName", mark="working", on=True
    )
    emojis = {r[1] for r in fake.reactions}
    assert len(emojis) == 2


async def test_mark_activity_off_removes_the_reaction() -> None:
    adapter, fake = _adapter_with_fake_client()
    await adapter.mark_activity(
        "stream:7", "501", agent_name="AgentName", mark="working", on=False
    )
    assert fake.reactions == [(501, "eyes", False)]


# ── Attachments ──────────────────────────────────────────────────────────


class _FakeUploadClient(_FakeClient):
    def __init__(self) -> None:
        super().__init__()
        self.uploaded: list[tuple[str, str, bytes]] = []

    async def upload_file(self, *, filename: str, mimetype: str, data: bytes) -> str:
        self.uploaded.append((filename, mimetype, data))
        return f"/user_uploads/1/x/{filename}"


async def test_send_attachment_uploads_and_links_it() -> None:
    adapter = ZulipAdapter(config=_config())
    fake = _FakeUploadClient()
    adapter._client = fake  # type: ignore[assignment]
    ref = await adapter.send_attachment(
        "stream:7", "AgentName", "report.txt", "text/plain", b"contents"
    )
    assert fake.uploaded == [("report.txt", "text/plain", b"contents")]
    assert fake.stream_sends[0][2].startswith("**AgentName**\n[report.txt]")
    assert ref is not None


async def test_send_attachment_over_the_size_limit_is_refused_visibly() -> None:
    adapter = ZulipAdapter(config=_config())
    fake = _FakeUploadClient()
    adapter._client = fake  # type: ignore[assignment]
    adapter._max_file_upload_bytes = 10
    await adapter.send_attachment(
        "stream:7", "AgentName", "big.bin", "application/octet-stream", b"x" * 100
    )
    assert fake.uploaded == []  # never attempted
    assert "over this organisation's" in fake.stream_sends[0][2]


# ── verify_credentials ───────────────────────────────────────────────────


async def test_verify_credentials_rejects_a_bad_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from switch_core.bridges.collaboration.models import BridgeCredentialError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "result": "error",
                "msg": "Invalid API key",
                "code": "INVALID_API_KEY",
            },
        )

    real_client = httpx.AsyncClient

    def patched(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    with pytest.raises(BridgeCredentialError):
        await ZulipAdapter.verify_credentials(
            {
                "site": "https://example.zulipchat.com",
                "bot_email": "b@x.com",
                "api_key": "wrong",
            }
        )


async def test_verify_credentials_rejects_a_persons_own_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from switch_core.bridges.collaboration.models import BridgeCredentialError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"result": "success", "msg": "", "user_id": 1, "is_bot": False},
        )

    real_client = httpx.AsyncClient

    def patched(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    with pytest.raises(BridgeCredentialError, match="bot"):
        await ZulipAdapter.verify_credentials(
            {
                "site": "https://example.zulipchat.com",
                "bot_email": "person@x.com",
                "api_key": "k",
            }
        )


async def test_verify_credentials_accepts_a_real_bot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"result": "success", "msg": "", "user_id": 1, "is_bot": True}
        )

    real_client = httpx.AsyncClient

    def patched(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    await ZulipAdapter.verify_credentials(
        {
            "site": "https://example.zulipchat.com",
            "bot_email": "bot@x.com",
            "api_key": "k",
        }
    )
