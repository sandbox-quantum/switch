from __future__ import annotations

from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.matrix import adapter as matrix_adapter
from switch_core.bridges.collaboration.matrix.adapter import MatrixAdapter
from switch_core.bridges.collaboration.matrix.chunking import chunk_message
from switch_core.bridges.collaboration.matrix.client import MatrixApiError
from switch_core.bridges.collaboration.matrix.config import MatrixConnectionConfig
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundCommand,
    InboundMessage,
    InboundMessageDelete,
    InboundMessageEdit,
    RetireOutcome,
)

ROOM = "!room:example.org"
BOT = "@switch:example.org"


class _FakeClient:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, dict[str, Any]]] = []
        self.joined: list[str] = []
        self.left: list[str] = []
        self.redacted: list[tuple[str, str]] = []
        self.typing_calls: list[tuple[str, str, bool]] = []
        self.invited: list[tuple[str, str]] = []
        self.uploads: list[tuple[bytes, str, str]] = []
        self.room_state_events: list[dict[str, Any]] = []
        self.members: dict[str, dict[str, Any]] = {}
        self.relations_events: list[dict[str, Any]] = []
        self.downloaded: bytes = b"file"
        self.download_error: Exception | None = None

    async def whoami(self) -> str:
        return BOT

    async def send_event(
        self,
        room_id: str,
        event_type: str,
        content: dict[str, Any],
        *,
        txn_id: str | None = None,
    ) -> str:
        self.sent.append((room_id, event_type, content))
        return f"$event{len(self.sent)}"

    async def redact(
        self,
        room_id: str,
        event_id: str,
        reason: str,
        *,
        txn_id: str | None = None,
    ) -> str:
        self.redacted.append((room_id, event_id))
        return event_id

    async def join(self, room_id: str) -> str:
        self.joined.append(room_id)
        return room_id

    async def leave(self, room_id: str) -> None:
        self.left.append(room_id)

    async def room_state(self, room_id: str) -> list[dict[str, Any]]:
        return self.room_state_events

    async def joined_members(self, room_id: str) -> dict[str, Any]:
        return self.members

    async def download_media(self, mxc_uri: str) -> bytes:
        if self.download_error is not None:
            raise self.download_error
        return self.downloaded

    async def upload_media(self, data: bytes, filename: str, content_type: str) -> str:
        self.uploads.append((data, filename, content_type))
        return "mxc://example.org/media"

    async def invite(self, room_id: str, user_id: str) -> None:
        self.invited.append((room_id, user_id))

    async def create_room(
        self,
        name: str,
        topic: str,
        *,
        public: bool,
        invite: list[str],
        is_direct: bool,
    ) -> str:
        return ROOM

    async def relations(
        self, room_id: str, event_id: str, rel_type: str, *, limit: int = 10
    ) -> list[dict[str, Any]]:
        return self.relations_events

    async def typing(
        self, room_id: str, user_id: str, *, typing: bool, timeout_ms: int = 30000
    ) -> None:
        self.typing_calls.append((room_id, user_id, typing))

    async def search_users(self, term: str, *, limit: int = 20) -> list[dict[str, Any]]:
        return []

    async def close(self) -> None:
        return None


def _adapter() -> MatrixAdapter:
    adapter = MatrixAdapter(
        MatrixConnectionConfig(
            homeserver_url="https://matrix.example.org",
            access_token="token",
        )
    )
    adapter._client = _FakeClient()  # type: ignore[assignment]
    adapter._user_id = BOT
    adapter._bot_localpart = "switch"
    adapter._room_types[ROOM] = "group"
    adapter._room_names[ROOM] = "General"
    adapter._member_names[ROOM] = {"@alice:example.org": "Alice"}
    return adapter


def _client(adapter: MatrixAdapter) -> _FakeClient:
    return adapter._client  # type: ignore[return-value]


async def _collect(sink: list[Any], value: Any) -> None:
    sink.append(value)


def test_homeserver_url_is_normalised_and_tokens_are_trimmed() -> None:
    config = MatrixConnectionConfig(
        homeserver_url="https://matrix.example.org/",
        access_token=" token ",
    )
    assert config.homeserver_url == "https://matrix.example.org"
    assert config.access_token == "token"


@pytest.mark.parametrize(
    "url",
    [
        "matrix.example.org",
        "ftp://matrix.example.org",
        "https://matrix.example.org/?x=1",
    ],
)
def test_a_homeserver_url_must_be_a_plain_http_address(url: str) -> None:
    with pytest.raises(ValidationError):
        MatrixConnectionConfig(homeserver_url=url, access_token="token")


def test_inbound_matrix_ids_become_switch_handles() -> None:
    adapter = _adapter()
    assert (
        adapter.translate_inbound("@alice:example.org and @room")
        == "@alice and @everyone"
    )


def test_a_matrix_user_called_room_is_not_a_room_wide_mention() -> None:
    adapter = _adapter()
    assert adapter.translate_inbound("@room:example.org") == "@room"
    assert adapter.translate_inbound("@room") == "@everyone"


def test_known_names_become_matrix_mentions_but_urls_are_left_alone() -> None:
    adapter = _adapter()
    adapter.prime_mention_targets({"Alice": "@alice:example.org"})

    assert (
        adapter._render_outbound("hi @Alice, see https://example.org/@Alice")
        == "hi @alice:example.org, see https://example.org/@Alice"
    )


def test_ordinary_room_text_cannot_page_everyone() -> None:
    adapter = _adapter()
    assert "@\u200broom" in adapter.translate_outbound("hello @room")
    assert "@\u200bROOM" in adapter.translate_outbound("@ROOM hello")


async def test_a_message_is_bridged_with_its_thread_root() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    await adapter._handle_message(
        ROOM,
        {
            "event_id": "$m1",
            "sender": "@alice:example.org",
            "type": "m.room.message",
            "content": {
                "msgtype": "m.text",
                "body": "hello",
                "m.relates_to": {
                    "rel_type": "m.thread",
                    "event_id": "$root",
                },
            },
        },
    )

    assert len(seen) == 1
    assert seen[0].channel_id == ROOM
    assert seen[0].channel_type == "group"
    assert seen[0].sender_id == "@alice:example.org"
    assert seen[0].sender_name == "Alice"
    assert seen[0].content == "hello"
    assert seen[0].root_id == "$root"
    assert seen[0].message_ref == "$m1"


async def test_a_matrix_edit_is_forwarded_with_both_event_ids() -> None:
    adapter = _adapter()
    edits: list[InboundMessageEdit] = []
    adapter._on_message_edited = lambda value: _collect(edits, value)

    await adapter._handle_message(
        ROOM,
        {
            "event_id": "$edit1",
            "sender": "@alice:example.org",
            "content": {
                "msgtype": "m.text",
                "body": "* updated",
                "m.relates_to": {"rel_type": "m.replace", "event_id": "$m1"},
                "m.new_content": {"msgtype": "m.text", "body": "updated"},
            },
        },
    )

    assert edits == [
        InboundMessageEdit(
            channel_id=ROOM,
            sender_id="@alice:example.org",
            sender_name="Alice",
            message_ref="$m1",
            edit_ref="$edit1",
            content="updated",
        )
    ]


async def test_a_matrix_redaction_is_forwarded_as_a_delete() -> None:
    adapter = _adapter()
    deletions: list[InboundMessageDelete] = []
    adapter._on_message_deleted = lambda value: _collect(deletions, value)

    await adapter._handle_redaction(
        ROOM,
        {
            "event_id": "$redact1",
            "sender": "@alice:example.org",
            "redacts": "$m1",
        },
    )

    assert deletions == [
        InboundMessageDelete(
            channel_id=ROOM,
            sender_id="@alice:example.org",
            sender_name="Alice",
            message_ref="$m1",
            delete_ref="$redact1",
        )
    ]


async def test_a_failed_callback_is_retried_not_marked_seen() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    calls = 0

    async def fail_once(message: InboundMessage) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("database went away")
        seen.append(message)

    adapter._on_message = fail_once
    event = {
        "event_id": "$m1",
        "sender": "@alice:example.org",
        "type": "m.room.message",
        "content": {"msgtype": "m.text", "body": "hello"},
    }

    with pytest.raises(RuntimeError):
        await adapter._handle_message(ROOM, event)
    assert "$m1" not in adapter._seen

    await adapter._handle_message(ROOM, event)
    assert len(seen) == 1


async def test_an_edit_is_not_a_new_message() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    await adapter._handle_message(
        ROOM,
        {
            "event_id": "$m1",
            "sender": "@alice:example.org",
            "type": "m.room.message",
            "content": {
                "msgtype": "m.text",
                "body": "* edited",
                "m.relates_to": {"rel_type": "m.replace", "event_id": "$m0"},
            },
        },
    )

    assert seen == []


async def test_a_command_is_parsed_from_either_prefix() -> None:
    adapter = _adapter()
    seen: list[InboundCommand] = []
    adapter._on_command = lambda c: _collect(seen, c)

    await adapter._handle_message(
        ROOM,
        {
            "event_id": "$m1",
            "sender": "@alice:example.org",
            "type": "m.room.message",
            "content": {"msgtype": "m.text", "body": "/invite_agent bob"},
        },
    )

    assert len(seen) == 1
    assert seen[0].command == "invite-agent"
    assert seen[0].args == "bob"


async def test_an_encrypted_attachment_is_disclosed_not_dropped() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    await adapter._handle_message(
        ROOM,
        {
            "event_id": "$m1",
            "sender": "@alice:example.org",
            "type": "m.room.message",
            "content": {
                "msgtype": "m.file",
                "body": "secret.pdf",
                "file": {"url": "mxc://example.org/encrypted"},
            },
        },
    )

    assert len(seen) == 1
    assert seen[0].attachments == []
    assert len(seen[0].attachment_failures) == 1
    assert "encrypted" in seen[0].attachment_failures[0].reason


async def test_an_oversize_attachment_is_not_downloaded() -> None:
    adapter = _adapter()
    adapter.set_max_attachment_bytes(10)
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    await adapter._handle_message(
        ROOM,
        {
            "event_id": "$m1",
            "sender": "@alice:example.org",
            "type": "m.room.message",
            "content": {
                "msgtype": "m.file",
                "body": "big.bin",
                "url": "mxc://example.org/big",
                "info": {"size": 11, "mimetype": "application/octet-stream"},
            },
        },
    )

    assert len(seen) == 1
    assert seen[0].attachments == []
    assert "11 bytes" in seen[0].attachment_failures[0].reason


async def test_an_encrypted_room_is_told_and_left() -> None:
    adapter = _adapter()
    client = _client(adapter)

    await adapter._handle_joined(
        ROOM,
        {
            "state": {
                "events": [
                    {
                        "type": "m.room.encryption",
                        "state_key": "",
                        "content": {"algorithm": "m.megolm.v1.aes-sha2"},
                    }
                ]
            }
        },
    )

    assert client.left == [ROOM]
    assert len(client.sent) == 1
    assert "encrypted" in client.sent[0][2]["body"]
    assert ROOM not in adapter._known_rooms


async def test_a_room_can_be_reinvited_after_an_encrypted_refusal() -> None:
    adapter = _adapter()
    client = _client(adapter)

    await adapter._handle_invite(
        ROOM,
        {
            "invite_state": {
                "events": [
                    {
                        "type": "m.room.encryption",
                        "state_key": "",
                        "content": {"algorithm": "m.megolm.v1.aes-sha2"},
                    }
                ]
            }
        },
    )
    await adapter._handle_invite(ROOM, {"invite_state": {"events": []}})

    assert client.joined == [ROOM, ROOM]
    assert ROOM in adapter._known_rooms


async def test_an_encrypted_invitation_is_joined_told_and_left() -> None:
    adapter = _adapter()
    client = _client(adapter)

    await adapter._handle_invite(
        ROOM,
        {
            "invite_state": {
                "events": [
                    {
                        "type": "m.room.encryption",
                        "state_key": "",
                        "content": {"algorithm": "m.megolm.v1.aes-sha2"},
                    }
                ]
            }
        },
    )

    assert client.joined == [ROOM]
    assert client.left == [ROOM]
    assert "encrypted" in client.sent[0][2]["body"]


async def test_only_the_first_chunk_of_a_room_wide_message_pages_everyone() -> None:
    adapter = _adapter()
    client = _client(adapter)

    await adapter._send_text(
        ROOM,
        "word " * 10000,
        None,
        room_wide_mention=True,
    )

    assert len(client.sent) > 1
    assert client.sent[0][2]["m.mentions"] == {"room": True}
    assert "m.mentions" not in client.sent[1][2]


async def test_a_media_event_does_not_repeat_its_filename_as_text() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    await adapter._handle_message(
        ROOM,
        {
            "event_id": "$m1",
            "sender": "@alice:example.org",
            "type": "m.room.message",
            "content": {
                "msgtype": "m.image",
                "body": "photo.png",
                "url": "mxc://example.org/photo",
                "info": {"mimetype": "image/png"},
            },
        },
    )

    assert len(seen) == 1
    assert seen[0].content == ""
    assert seen[0].attachments[0].filename == "photo.png"


async def test_a_room_link_opens_in_a_browser() -> None:
    adapter = _adapter()
    assert (
        await adapter.channel_deeplink(ROOM)
        == "https://matrix.to/#/%21room%3Aexample.org"
    )


async def test_retiring_a_room_that_is_already_left_counts_as_left() -> None:
    adapter = _adapter()
    client = _client(adapter)

    async def leave(room_id: str) -> None:
        raise MatrixApiError(403, "M_FORBIDDEN", "not in room")

    client.leave = leave  # type: ignore[method-assign]

    assert await adapter.retire_channel(ROOM) == RetireOutcome(outcome="left")


async def test_sending_attributes_the_agent_and_threads_the_reply() -> None:
    adapter = _adapter()
    client = _client(adapter)

    ref = await adapter.send_message(ROOM, "alice", "hello", "$root")

    assert ref == "$event1"
    room_id, event_type, content = client.sent[0]
    assert room_id == ROOM
    assert event_type == "m.room.message"
    assert content["body"] == "**alice**\nhello"
    assert content["m.relates_to"] == {
        "rel_type": "m.thread",
        "event_id": "$root",
        "m.in_reply_to": {"event_id": "$root"},
    }


async def test_an_oversized_outbound_file_is_disclosed_without_uploading() -> None:
    adapter = _adapter()
    adapter.set_max_attachment_bytes(3)
    client = _client(adapter)

    await adapter.send_attachment(
        ROOM, "alice", "big.bin", "application/octet-stream", b"four"
    )

    assert client.uploads == []
    assert "big.bin" in client.sent[0][2]["body"]
    assert "4 bytes" in client.sent[0][2]["body"]


async def test_an_edit_replaces_the_message() -> None:
    adapter = _adapter()
    client = _client(adapter)

    await adapter.update_message(ROOM, "$m1", "new text")

    content = client.sent[0][2]
    assert content["m.relates_to"] == {
        "rel_type": "m.replace",
        "event_id": "$m1",
    }
    assert content["m.new_content"]["body"] == "new text"


async def test_a_delete_redacts_the_message() -> None:
    adapter = _adapter()
    client = _client(adapter)

    await adapter.delete_message(ROOM, "$m1")

    assert client.redacted == [(ROOM, "$m1")]


async def test_a_working_mark_is_added_and_removed() -> None:
    adapter = _adapter()
    client = _client(adapter)

    await adapter.mark_activity(
        ROOM, "$m1", agent_name="alice", mark="working", on=True
    )
    assert client.sent[0][2]["m.relates_to"]["key"] == "👀"

    await adapter.mark_activity(
        ROOM, "$m1", agent_name="alice", mark="working", on=False
    )
    assert client.redacted == [(ROOM, "$event1")]


async def test_a_reaction_refusal_is_not_retried() -> None:
    adapter = _adapter()
    client = _client(adapter)

    async def refuse(*args: Any, **kwargs: Any) -> str:
        raise MatrixApiError(403, "M_FORBIDDEN", "not allowed")

    client.send_event = refuse  # type: ignore[method-assign]

    with pytest.raises(matrix_adapter.ActivityMarkRefused):
        await adapter.mark_activity(
            ROOM, "$m1", agent_name="alice", mark="working", on=True
        )


async def test_a_rejected_token_is_a_credential_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeClient()

    async def refuse() -> str:
        raise MatrixApiError(401, "M_UNKNOWN_TOKEN", "unknown token")

    client.whoami = refuse  # type: ignore[method-assign]
    monkeypatch.setattr(matrix_adapter, "MatrixClient", lambda config: client)

    with pytest.raises(BridgeCredentialError):
        await MatrixAdapter.verify_credentials(
            {
                "homeserver_url": "https://matrix.example.org",
                "access_token": "bad",
            }
        )


async def test_sync_resumes_from_and_persists_the_durable_checkpoint() -> None:
    adapter = _adapter()
    adapter.load_adapter_state({"sync_token": "saved-token"})
    checkpoints: list[dict[str, object]] = []
    adapter.set_adapter_state_persister(
        lambda state: _collect(checkpoints, dict(state))
    )
    client = _client(adapter)
    requested: list[str | None] = []

    async def sync(since: str | None) -> dict[str, Any]:
        requested.append(since)
        adapter._stopping = True
        return {"next_batch": "next-token", "rooms": {}}

    client.sync = sync  # type: ignore[attr-defined,method-assign]
    await adapter._sync_forever()

    assert requested == ["saved-token"]
    assert checkpoints == [{"sync_token": "next-token"}]
    assert adapter._sync_token == "next-token"


async def test_a_nonlease_pod_verifies_the_bot_but_does_not_start_sync() -> None:
    adapter = _adapter()
    adapter.set_listening(False)

    async def ignore(*_args: Any) -> None:
        return None

    await adapter.start(ignore, ignore, ignore, ignore, ignore)

    assert adapter._sync_task is None


async def test_retiring_a_room_leaves_it() -> None:
    adapter = _adapter()
    assert await adapter.retire_channel(ROOM) == RetireOutcome(outcome="left")
    assert _client(adapter).left == [ROOM]


def test_failures_are_classified_by_what_matrix_said() -> None:
    assert (
        MatrixAdapter.classify_failure(
            MatrixApiError(401, "M_UNKNOWN_TOKEN", "unknown token")
        )
        == "auth_failed"
    )
    assert (
        MatrixAdapter.classify_failure(MatrixApiError(500, "M_UNKNOWN", "boom"))
        == "platform_error"
    )
    assert MatrixAdapter.classify_failure(httpx.ConnectError("down")) == "network"
    assert MatrixAdapter.classify_failure(ValueError("not matrix")) is None


def test_public_invite_and_direct_rooms_have_the_right_type() -> None:
    assert (
        MatrixAdapter._channel_type(
            [{"type": "m.room.join_rules", "content": {"join_rule": "public"}}], 10
        )
        == "channel_public"
    )
    assert MatrixAdapter._channel_type([], 2) == "direct"
    assert (
        MatrixAdapter._channel_type(
            [{"type": "m.room.join_rules", "content": {"join_rule": "invite"}}], 10
        )
        == "channel_private"
    )


def test_long_messages_are_split_and_code_fences_are_reopened() -> None:
    content = "```python\n" + ("print('x')\n" * 100) + "```"
    chunks = chunk_message(content, limit=200)
    assert len(chunks) > 1
    assert chunks[0].endswith("```")
    assert chunks[1].startswith("```python")
