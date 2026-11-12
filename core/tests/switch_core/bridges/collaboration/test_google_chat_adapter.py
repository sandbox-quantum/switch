from __future__ import annotations

import base64
import json
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from switch_core.bridges.collaboration.adapter import (
    RequestCard,
    RequestReference,
    TurnActivity,
)
from switch_core.bridges.collaboration.google_chat.adapter import (
    GoogleChatAdapter,
    GoogleChatConnectionConfig,
)
from switch_core.bridges.collaboration.google_chat.formatting import (
    markdown_to_google_chat,
    split_message_chunks,
    strip_bot_mention,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    OutboundAttachment,
)
from switch_core.sessions.contract import (
    ApprovalContent,
    ApprovalOption,
    Question,
    QuestionsContent,
    SnapshotRequest,
    TurnUpsert,
)

# Generate a fast RSA key for testing
_TEST_RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_TEST_PEM_KEY = _TEST_RSA_KEY.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode("utf-8")

TEST_PROJECT_ID = "test-project-123"
TEST_SUBSCRIPTION_ID = "switch-chat-sub"
TEST_TOPIC_ID = "switch-chat-topic"
TEST_CLIENT_EMAIL = "switch-chat-bot@test-project-123.iam.gserviceaccount.com"

TEST_SERVICE_ACCOUNT_JSON = json.dumps(
    {
        "type": "service_account",
        "project_id": TEST_PROJECT_ID,
        "private_key_id": "key-id-abc-123",
        "private_key": _TEST_PEM_KEY,
        "client_email": TEST_CLIENT_EMAIL,
        "token_uri": "https://oauth2.googleapis.com/token",
    }
)


def _make_config(**kwargs: Any) -> GoogleChatConnectionConfig:
    data = {
        "service_account_json": TEST_SERVICE_ACCOUNT_JSON,
        "project_id": TEST_PROJECT_ID,
        "subscription_id": TEST_SUBSCRIPTION_ID,
        "topic_id": TEST_TOPIC_ID,
        "slash_command_map": {"1": "invite-agent"},
    }
    data.update(kwargs)
    return GoogleChatConnectionConfig(**data)


# ── 1. Configuration & verify_credentials ────────────────────────────────────


class TestGoogleChatConfigurationAndCredentials:
    def test_valid_config_parses_cleanly(self) -> None:
        cfg = _make_config()
        assert cfg.project_id == TEST_PROJECT_ID
        assert cfg.subscription_id == TEST_SUBSCRIPTION_ID
        assert cfg.service_account_dict["client_email"] == TEST_CLIENT_EMAIL

    def test_invalid_service_account_json_rejected(self) -> None:
        with pytest.raises(ValueError, match="service_account_json is not valid JSON"):
            _make_config(service_account_json="not-json")

        with pytest.raises(ValueError, match="missing required 'client_email'"):
            bad_sa = json.dumps({"type": "service_account", "private_key": "abc"})
            _make_config(service_account_json=bad_sa)

        with pytest.raises(ValueError, match="missing required 'private_key'"):
            bad_sa = json.dumps({"type": "service_account", "client_email": "a@b.com"})
            _make_config(service_account_json=bad_sa)

    @pytest.mark.asyncio
    async def test_verify_credentials_success(self) -> None:
        cfg = _make_config()
        with (
            patch(
                "switch_core.bridges.collaboration.google_chat.auth.GoogleAuthManager.get_service_account_token",
                new=AsyncMock(return_value="fake-token"),
            ),
            patch(
                "switch_core.bridges.collaboration.google_chat.client.GoogleChatClient.get_subscription",
                new=AsyncMock(
                    return_value={
                        "name": f"projects/{TEST_PROJECT_ID}/subscriptions/{TEST_SUBSCRIPTION_ID}"
                    }
                ),
            ),
            patch(
                "switch_core.bridges.collaboration.google_chat.client.GoogleChatClient.list_spaces",
                new=AsyncMock(return_value=[]),
            ),
        ):
            # Should succeed with no exception
            await GoogleChatAdapter.verify_credentials(cfg.model_dump())

    @pytest.mark.asyncio
    async def test_verify_credentials_fails_on_missing_subscription(self) -> None:
        cfg = _make_config()
        with (
            patch(
                "switch_core.bridges.collaboration.google_chat.auth.GoogleAuthManager.get_service_account_token",
                new=AsyncMock(return_value="fake-token"),
            ),
            patch(
                "switch_core.bridges.collaboration.google_chat.client.GoogleChatClient.get_subscription",
                new=AsyncMock(
                    side_effect=BridgeCredentialError(
                        "Pub/Sub subscription not found or inaccessible"
                    )
                ),
            ),
        ):
            with pytest.raises(
                BridgeCredentialError, match="Pub/Sub subscription not found"
            ):
                await GoogleChatAdapter.verify_credentials(cfg.model_dump())

    @pytest.mark.asyncio
    async def test_verify_credentials_fails_on_disabled_chat_api(self) -> None:
        cfg = _make_config()
        with (
            patch(
                "switch_core.bridges.collaboration.google_chat.auth.GoogleAuthManager.get_service_account_token",
                new=AsyncMock(return_value="fake-token"),
            ),
            patch(
                "switch_core.bridges.collaboration.google_chat.client.GoogleChatClient.get_subscription",
                new=AsyncMock(return_value={}),
            ),
            patch(
                "switch_core.bridges.collaboration.google_chat.client.GoogleChatClient.list_spaces",
                new=AsyncMock(
                    side_effect=BridgeOperationError(
                        "Google Chat API has not been used in project"
                    )
                ),
            ),
        ):
            with pytest.raises(
                BridgeCredentialError, match="Google Chat API check failed"
            ):
                await GoogleChatAdapter.verify_credentials(cfg.model_dump())

    def test_classify_failure(self) -> None:
        assert (
            GoogleChatAdapter.classify_failure(BridgeCredentialError("bad"))
            == "auth_failed"
        )
        assert (
            GoogleChatAdapter.classify_failure(httpx.ConnectError("refused"))
            == "network"
        )
        assert (
            GoogleChatAdapter.classify_failure(BridgeOperationError("api error"))
            == "platform_error"
        )
        assert GoogleChatAdapter.classify_failure(RuntimeError("other")) is None


# ── 2. Inbound Event Consumer (Pub/Sub + Workspace Events) ───────────────────


class TestGoogleChatInboundConsumer:
    @pytest.mark.asyncio
    async def test_added_to_space_dispatches_app_join_and_subscribes(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        app_joined_event: Any = None

        async def on_app_joined(join: Any) -> None:
            nonlocal app_joined_event
            app_joined_event = join

        adapter.consumer.set_callbacks(on_app_joined=on_app_joined)
        adapter.workspace_events_mgr.ensure_space_subscription = AsyncMock()

        payload = {
            "type": "ADDED_TO_SPACE",
            "space": {
                "name": "spaces/AAAABBBB",
                "type": "SPACE",
                "displayName": "Engineering",
            },
        }

        success = await adapter.consumer._handle_interaction_event(payload, "evt-1")
        assert success is True
        assert app_joined_event is not None
        assert app_joined_event.channel_id == "spaces/AAAABBBB"
        assert app_joined_event.channel_name == "Engineering"
        adapter.workspace_events_mgr.ensure_space_subscription.assert_called_once_with(
            "spaces/AAAABBBB"
        )

    @pytest.mark.asyncio
    async def test_mention_message_dispatches_inbound_message(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        inbound_msg: InboundMessage | None = None

        async def on_message(msg: InboundMessage) -> None:
            nonlocal inbound_msg
            inbound_msg = msg

        adapter.consumer.set_callbacks(on_message=on_message)

        payload = {
            "type": "MESSAGE",
            "space": {
                "name": "spaces/SPACE1",
                "type": "SPACE",
                "displayName": "General",
            },
            "message": {
                "name": "spaces/SPACE1/messages/MSG100",
                "text": "@SwitchBot hello assistant",
                "argumentText": " hello assistant",
                "sender": {
                    "name": "users/USER123",
                    "displayName": "Alice",
                    "type": "HUMAN",
                },
                "thread": {
                    "name": "spaces/SPACE1/threads/THREAD555",
                },
                "annotations": [
                    {
                        "type": "USER_MENTION",
                        "userMention": {
                            "user": {
                                "name": "users/app",
                                "displayName": "SwitchBot",
                                "type": "BOT",
                            }
                        },
                    }
                ],
            },
        }

        success = await adapter.consumer._handle_interaction_event(payload, "evt-2")
        assert success is True
        assert inbound_msg is not None
        assert inbound_msg.channel_id == "spaces/SPACE1"
        assert inbound_msg.content == "hello assistant"
        assert inbound_msg.sender_name == "Alice"
        assert inbound_msg.message_ref == "spaces/SPACE1/messages/MSG100"
        assert inbound_msg.root_id == "spaces/SPACE1/threads/THREAD555"
        assert inbound_msg.self_mention_token == "bot"

    @pytest.mark.asyncio
    async def test_bot_own_messages_ignored(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        called = False

        async def on_message(msg: InboundMessage) -> None:
            nonlocal called
            called = True

        adapter.consumer.set_callbacks(on_message=on_message)

        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/SPACE1"},
            "message": {
                "name": "spaces/SPACE1/messages/MSG101",
                "text": "echo from bot",
                "sender": {"name": "users/app", "type": "BOT"},
            },
        }

        success = await adapter.consumer._handle_interaction_event(payload, "evt-3")
        assert success is True
        assert called is False

    @pytest.mark.asyncio
    async def test_command_parsing_exclamation(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        cmd_event: InboundCommand | None = None

        async def on_command(cmd: InboundCommand) -> None:
            nonlocal cmd_event
            cmd_event = cmd

        adapter.consumer.set_callbacks(on_command=on_command)

        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/SPACE1"},
            "message": {
                "name": "spaces/SPACE1/messages/MSG102",
                "text": "!help me please",
                "sender": {"name": "users/U1", "displayName": "Bob", "type": "HUMAN"},
            },
        }

        await adapter.consumer._handle_chat_message_event(
            payload, "spaces/SPACE1", "channel_public", "General", "e4"
        )
        assert cmd_event is not None
        assert cmd_event.command == "help"
        assert cmd_event.args == "me please"

    @pytest.mark.asyncio
    async def test_numeric_slash_command_mapping(self) -> None:
        adapter = GoogleChatAdapter(
            _make_config(slash_command_map={"1": "invite-agent"})
        )
        cmd_event: InboundCommand | None = None

        async def on_command(cmd: InboundCommand) -> None:
            nonlocal cmd_event
            cmd_event = cmd

        adapter.consumer.set_callbacks(on_command=on_command)

        payload = {
            "type": "SLASH_COMMAND",
            "space": {"name": "spaces/SPACE1"},
            "user": {"name": "users/U1", "displayName": "Bob"},
            "message": {"text": "/invite-agent scout"},
            "appCommandPayload": {"appCommandMetadata": {"appCommandId": 1}},
        }

        await adapter.consumer._handle_slash_command(
            payload, "spaces/SPACE1", "channel_public", "General"
        )
        assert cmd_event is not None
        assert cmd_event.command == "invite-agent"
        assert cmd_event.args == "/invite-agent scout"


# ── 3. Deduplication (Interaction Event vs Workspace CloudEvent) ─────────────


class TestGoogleChatDeduplication:
    @pytest.mark.asyncio
    async def test_duplicate_message_processed_only_once(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        message_count = 0

        async def on_message(msg: InboundMessage) -> None:
            nonlocal message_count
            message_count += 1

        adapter.consumer.set_callbacks(on_message=on_message)
        adapter.client.get_space = AsyncMock(
            return_value={"name": "spaces/S1", "spaceType": "SPACE"}
        )

        # 1. Delivery via Chat App Interaction Event (@mention)
        interaction_payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1"},
            "message": {
                "name": "spaces/S1/messages/SHARED_MSG_001",
                "text": "@SwitchBot hello world",
                "argumentText": " hello world",
                "sender": {"name": "users/U1", "displayName": "Alice", "type": "HUMAN"},
            },
        }
        await adapter.consumer._handle_interaction_event(
            interaction_payload, "evt-interact-1"
        )
        assert message_count == 1

        # 2. Delivery of the SAME message via Google Workspace Events CloudEvent
        cloud_event_payload = {
            "specversion": "1.0",
            "id": "ce-unique-999",
            "type": "google.workspace.chat.message.v1.created",
            "data": {
                "space": {"name": "spaces/S1"},
                "message": {
                    "name": "spaces/S1/messages/SHARED_MSG_001",
                    "text": "@SwitchBot hello world",
                    "sender": {
                        "name": "users/U1",
                        "displayName": "Alice",
                        "type": "HUMAN",
                    },
                },
            },
        }
        await adapter.consumer._handle_cloud_event(
            cloud_event_payload, {}, "ce-unique-999"
        )

        # Second delivery should be deduplicated and dropped!
        assert message_count == 1


# ── 4. Pub/Sub Ack-After-Write, No-Ack on Failure & Lease Safety ─────────────


class TestGoogleChatPubSubAckAndLeaseSafety:
    @pytest.mark.asyncio
    async def test_ack_after_write_succeeds(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.acknowledge_pubsub_messages = AsyncMock()

        called = False

        async def on_message(msg: InboundMessage) -> None:
            nonlocal called
            called = True

        adapter.consumer.set_callbacks(on_message=on_message)

        body = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1"},
            "message": {
                "name": "spaces/S1/messages/M1",
                "text": "test",
                "sender": {"name": "users/U1", "displayName": "Alice", "type": "HUMAN"},
            },
        }
        raw_b64 = base64.b64encode(json.dumps(body).encode()).decode()
        msg_item = {"data": raw_b64, "messageId": "msg-id-1"}

        await adapter.consumer._process_single_pubsub_message("ack-123", msg_item)

        assert called is True
        adapter.client.acknowledge_pubsub_messages.assert_called_once_with(
            TEST_PROJECT_ID,
            TEST_SUBSCRIPTION_ID,
            ["ack-123"],
        )

    @pytest.mark.asyncio
    async def test_handler_failure_after_claim_is_acked_and_logged(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.acknowledge_pubsub_messages = AsyncMock()
        calls = 0

        async def on_message_fail(msg: InboundMessage) -> None:
            nonlocal calls
            calls += 1
            raise RuntimeError("Database transport down!")

        adapter.consumer.set_callbacks(on_message=on_message_fail)

        body = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1"},
            "message": {
                "name": "spaces/S1/messages/M2",
                "text": "test",
                "sender": {"name": "users/U1", "displayName": "Alice", "type": "HUMAN"},
            },
        }
        raw_b64 = base64.b64encode(json.dumps(body).encode()).decode()
        msg_item = {"data": raw_b64, "messageId": "msg-id-2"}

        await adapter.consumer._process_single_pubsub_message("ack-456", msg_item)

        # The claim is final, so a redelivery could never retry it: ack, and say so.
        assert calls == 1
        adapter.client.acknowledge_pubsub_messages.assert_called_once()
        assert any(
            r.levelname == "ERROR" and "spaces/S1/messages/M2" in r.getMessage()
            for r in caplog.records
        )

    @pytest.mark.asyncio
    async def test_failed_message_fetch_is_left_for_redelivery(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.acknowledge_pubsub_messages = AsyncMock()
        adapter.client.get_message = AsyncMock(
            side_effect=BridgeOperationError("503 backend unavailable")
        )
        on_message = AsyncMock()
        adapter.consumer.set_callbacks(on_message=on_message)

        body = {
            "specversion": "1.0",
            "id": "ce-fetch-1",
            "type": "google.workspace.chat.message.v1.created",
            "data": {"message": {"name": "spaces/S1/messages/NAME_ONLY"}},
        }
        raw_b64 = base64.b64encode(json.dumps(body).encode()).decode()
        await adapter.consumer._process_single_pubsub_message(
            "ack-fetch", {"data": raw_b64, "messageId": "msg-fetch"}
        )
        adapter.client.acknowledge_pubsub_messages.assert_not_called()
        on_message.assert_not_called()

        # The redelivery is not mistaken for a duplicate.
        adapter.client.get_message = AsyncMock(
            return_value={
                "name": "spaces/S1/messages/NAME_ONLY",
                "text": "hello",
                "space": {"name": "spaces/S1", "spaceType": "SPACE"},
                "sender": {"name": "users/U1", "displayName": "Alice", "type": "HUMAN"},
            }
        )
        await adapter.consumer._process_single_pubsub_message(
            "ack-fetch-2", {"data": raw_b64, "messageId": "msg-fetch"}
        )
        on_message.assert_called_once()
        adapter.client.acknowledge_pubsub_messages.assert_called_once()

    @pytest.mark.asyncio
    async def test_whole_batch_deadline_extended_on_pull(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        consumer = adapter.consumer
        extended: list[list[str]] = []
        seen_inflight: list[set[str]] = []

        async def pull(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
            consumer._running = False
            return [
                {"ackId": "a1", "message": {}},
                {"ackId": "a2", "message": {}},
                {"ackId": "a3", "message": {}},
            ]

        async def modify(
            project: str, sub: str, ack_ids: list[str], **kwargs: Any
        ) -> None:
            extended.append(list(ack_ids))

        async def process(ack_id: str, message: dict[str, Any]) -> None:
            seen_inflight.append(set(consumer._inflight_ack_ids))

        adapter.client.pull_pubsub_messages = AsyncMock(side_effect=pull)
        adapter.client.modify_ack_deadline = AsyncMock(side_effect=modify)
        consumer._process_single_pubsub_message = process  # type: ignore[method-assign]
        consumer._running = True
        await consumer._pull_loop()

        assert extended == [["a1", "a2", "a3"]]
        # Messages still waiting their turn stay under the extender.
        assert seen_inflight[0] == {"a1", "a2", "a3"}
        assert seen_inflight[2] == {"a3"}
        assert consumer._inflight_ack_ids == set()

    @pytest.mark.asyncio
    async def test_keeps_quiet_unless_listening_lease_safety(self) -> None:
        cfg = _make_config()
        adapter = GoogleChatAdapter(cfg)
        adapter.consumer.start = MagicMock()
        adapter.workspace_events_mgr.start = MagicMock()

        # Quiet pod (listening = False)
        adapter.set_listening(False)
        await adapter.start(
            on_message=AsyncMock(),
            on_command=AsyncMock(),
            on_agent_joined=AsyncMock(),
            on_user_joined=AsyncMock(),
            on_app_joined=AsyncMock(),
        )
        adapter.consumer.start.assert_not_called()
        adapter.workspace_events_mgr.start.assert_not_called()

        # Active pod (listening = True)
        adapter.set_listening(True)
        await adapter.start(
            on_message=AsyncMock(),
            on_command=AsyncMock(),
            on_agent_joined=AsyncMock(),
            on_user_joined=AsyncMock(),
            on_app_joined=AsyncMock(),
        )
        adapter.consumer.start.assert_called_once()
        adapter.workspace_events_mgr.start.assert_called_once()

        await adapter.stop()


# ── 5. Attachments Inbound & Outbound ─────────────────────────────────────────


class TestGoogleChatAttachments:
    @pytest.mark.asyncio
    async def test_native_inbound_attachment_download(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.download_media = AsyncMock(return_value=b"file content bytes")

        received_msg: InboundMessage | None = None

        async def on_message(msg: InboundMessage) -> None:
            nonlocal received_msg
            received_msg = msg

        adapter.consumer.set_callbacks(on_message=on_message)

        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1"},
            "message": {
                "name": "spaces/S1/messages/ATT_MSG",
                "text": "here is a file",
                "sender": {"name": "users/U1", "displayName": "Alice", "type": "HUMAN"},
                "attachment": [
                    {
                        "contentName": "report.pdf",
                        "contentType": "application/pdf",
                        "attachmentDataRef": {
                            "resourceName": "spaces/S1/messages/ATT_MSG/attachments/1"
                        },
                    }
                ],
            },
        }

        await adapter.consumer._handle_interaction_event(payload, "evt-att-1")
        assert received_msg is not None
        assert len(received_msg.attachments) == 1
        assert received_msg.attachments[0].filename == "report.pdf"
        assert received_msg.attachments[0].data == b"file content bytes"

    @pytest.mark.asyncio
    async def test_oversized_inbound_attachment_refusal(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.consumer.max_attachment_bytes = 1000
        adapter.client.download_media = AsyncMock(
            side_effect=ValueError("Attachment exceeds maximum allowed size")
        )

        received_msg: InboundMessage | None = None

        async def on_message(msg: InboundMessage) -> None:
            nonlocal received_msg
            received_msg = msg

        adapter.consumer.set_callbacks(on_message=on_message)

        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1"},
            "message": {
                "name": "spaces/S1/messages/BIG_MSG",
                "text": "huge file",
                "sender": {"name": "users/U1", "displayName": "Alice", "type": "HUMAN"},
                "attachment": [
                    {
                        "contentName": "huge.zip",
                        "contentType": "application/zip",
                        "attachmentDataRef": {
                            "resourceName": "spaces/S1/messages/BIG_MSG/attachments/1"
                        },
                    }
                ],
            },
        }

        await adapter.consumer._handle_interaction_event(payload, "evt-att-2")
        assert received_msg is not None
        assert len(received_msg.attachments) == 0
        assert len(received_msg.attachment_failures) == 1
        assert received_msg.attachment_failures[0].filename == "huge.zip"
        assert "exceeds maximum" in received_msg.attachment_failures[0].reason

    @pytest.mark.asyncio
    async def test_outbound_attachment_is_disclosed_not_dropped(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.create_message = AsyncMock(
            return_value={"name": "spaces/S1/messages/OUT_1"}
        )

        ref = await adapter.send_attachments(
            channel_id="spaces/S1",
            sender_name="Scout",
            files=[
                OutboundAttachment(
                    filename="analysis.csv", mimetype="text/csv", data=b"a,b\n1,2"
                )
            ],
            caption="Here are the results",
        )

        assert ref == "spaces/S1/messages/OUT_1"
        text_sent = adapter.client.create_message.call_args[1]["text"]
        assert "Here are the results" in text_sent
        assert "couldn't be relayed: analysis.csv" in text_sent


# ── 6. Formatting, Threading & Message Splitting ─────────────────────────────


class TestGoogleChatFormattingAndThreading:
    def test_markdown_to_google_chat(self) -> None:
        md = "This is **bold**, this is ~~strike~~, and [Google](https://google.com). Code: `inline` and ```\nblock\n```"
        converted = markdown_to_google_chat(md)
        assert "*bold*" in converted
        assert "~strike~" in converted
        assert "<https://google.com|Google>" in converted
        assert "`inline`" in converted
        assert "```\nblock\n```" in converted

    def test_split_long_messages_preserves_code_fences(self) -> None:
        long_code = "```python\n" + ("x = 1\n" * 500) + "```"
        chunks = split_message_chunks(long_code, max_bytes=1000)
        assert len(chunks) > 1
        # Each chunk should end or close code blocks appropriately
        for chunk in chunks:
            assert len(chunk.encode("utf-8")) <= 1200
            # Ensure balanced ``` fences
            assert chunk.count("```") % 2 == 0

    @pytest.mark.asyncio
    async def test_thread_reply_threading_parameters(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.create_message = AsyncMock(
            return_value={"name": "spaces/S1/messages/REPLY_1"}
        )

        await adapter.send_message(
            channel_id="spaces/S1",
            sender_name="Scout",
            content="Replying to thread",
            thread_root_id="spaces/S1/threads/T123",
        )

        adapter.client.create_message.assert_called_once_with(
            space_id="spaces/S1",
            text="*Scout*: Replying to thread",
            thread_name="spaces/S1/threads/T123",
        )

    @pytest.mark.asyncio
    async def test_channel_creation_unsupported(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        with pytest.raises(ChannelCreationUnsupported):
            await adapter.create_channel("new-space", "topic")


# ── 7. Cards v2 Approvals & Interactions ─────────────────────────────────────


class TestGoogleChatCardsV2AndInteractions:
    @pytest.mark.asyncio
    async def test_post_rich_turn_activity_and_request_card(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.create_message = AsyncMock(
            return_value={"name": "spaces/S1/messages/CARD_1"}
        )

        turn = TurnUpsert(
            type="turn.upsert", turn_id="turn-1", status="running", command_id=None
        )
        activity = TurnActivity(items=[], turn=turn, elapsed_seconds=12.5)

        ref = await adapter.post_rich("spaces/S1", "Scout", activity)
        assert ref == "spaces/S1/messages/CARD_1"
        call_kwargs = adapter.client.create_message.call_args[1]
        cards = call_kwargs["cards_v2"]
        assert len(cards) == 1
        assert cards[0]["card"]["header"]["title"] == "Agent Scout"

        # Approval Card
        req = SnapshotRequest(
            request_id="req-1",
            turn_id="turn-1",
            revision=1,
            state="open",
            content=ApprovalContent(
                kind="approval",
                title="Run shell command?",
                detail="rm -rf /tmp/test",
                options=[
                    ApprovalOption(
                        option_id="opt-allow", label="Allow", decision="accept"
                    ),
                    ApprovalOption(
                        option_id="opt-deny", label="Deny", decision="decline"
                    ),
                ],
            ),
            expires_at=None,
            result=None,
            decided_by=None,
        )
        card = RequestCard(
            request=req, reference=RequestReference(token="tok-secret", handle="a1")
        )
        ref2 = await adapter.post_rich("spaces/S1", "Scout", card)
        assert ref2 == "spaces/S1/messages/CARD_1"

    @pytest.mark.asyncio
    async def test_card_click_is_handed_to_core_without_settling(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.patch_message = AsyncMock(return_value={})

        interactions: list[InboundInteraction] = []

        async def on_interaction(inter: InboundInteraction) -> None:
            interactions.append(inter)

        adapter.consumer.set_callbacks(on_interaction=on_interaction)

        def press(action_id: str) -> dict[str, Any]:
            return {
                "type": "CARD_CLICKED",
                "space": {"name": "spaces/S1"},
                "user": {"name": "users/U1", "displayName": "Alice"},
                "message": {"name": "spaces/S1/messages/CARD_MSG"},
                "action": {
                    "parameters": [
                        {"key": "token", "value": "token-xyz-1"},
                        {"key": "action_id", "value": action_id},
                    ]
                },
            }

        payload = press("switch:request-option:1")
        assert await adapter.consumer._handle_interaction_event(payload, "evt-card-1")
        assert len(interactions) == 1
        assert interactions[0].value == "token-xyz-1"
        assert interactions[0].action_id == "switch:request-option:1"
        # Core redraws the card through update_rich when it accepts the answer.
        adapter.client.patch_message.assert_not_called()

        # A redelivery of the same Pub/Sub message is dropped.
        assert await adapter.consumer._handle_interaction_event(payload, "evt-card-1")
        assert len(interactions) == 1

        # A second press with the same token (e.g. after core refused the first)
        # still reaches core, and so does the Stop button.
        await adapter.consumer._handle_interaction_event(payload, "evt-card-2")
        await adapter.consumer._handle_interaction_event(
            press("switch:turn-interrupt"), "evt-card-3"
        )
        assert [i.action_id for i in interactions] == [
            "switch:request-option:1",
            "switch:request-option:1",
            "switch:turn-interrupt",
        ]
        adapter.client.patch_message.assert_not_called()

    @pytest.mark.asyncio
    async def test_free_text_question_fallback(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.create_message = AsyncMock(
            return_value={"name": "spaces/S1/messages/CARD_Q"}
        )

        req = SnapshotRequest(
            request_id="req-q1",
            turn_id="turn-1",
            revision=1,
            state="open",
            content=QuestionsContent(
                kind="questions",
                title="Input Needed",
                questions=[
                    Question(
                        question_id="q1",
                        title="Database Host",
                        prompt="Please provide the database host address:",
                        options=[],
                        multi_select=False,
                        allow_custom_answer=True,
                    )
                ],
            ),
            expires_at=None,
            result=None,
            decided_by=None,
        )
        card = RequestCard(
            request=req, reference=RequestReference(token="tok-q", handle="qhandle")
        )
        await adapter.post_rich("spaces/S1", "Scout", card)

        call_kwargs = adapter.client.create_message.call_args[1]
        sections = call_kwargs["cards_v2"][0]["card"]["sections"]
        widgets = sections[0]["widgets"]
        text_paragraphs = [
            w["textParagraph"]["text"] for w in widgets if "textParagraph" in w
        ]
        assert any(
            "Free-text answer: Please reply in this thread with `qhandle <your answer>`"
            in t
            for t in text_paragraphs
        )


# ── 8. Workspace Events Subscriptions Lifecycle ──────────────────────────────


class TestGoogleChatWorkspaceEventsLifecycle:
    @pytest.mark.asyncio
    async def test_subscription_creation_and_proactive_renewal(self) -> None:
        cfg = _make_config(
            user_client_id="user-cid",
            user_client_secret="user-sec",
            user_refresh_token="user-ref",
        )
        adapter = GoogleChatAdapter(cfg)
        adapter.client.create_workspace_events_subscription = AsyncMock(
            return_value={
                "name": "subscriptions/sub-12345",
                "expireTime": "2026-11-02T16:00:00Z",
            }
        )
        adapter.client.patch_workspace_events_subscription_ttl = AsyncMock(
            return_value={
                "name": "subscriptions/sub-12345",
                "expireTime": "2026-11-02T20:00:00Z",
            }
        )

        # 1. Ensure space subscription
        await adapter.workspace_events_mgr.ensure_space_subscription("spaces/SPACE_XYZ")
        assert "spaces/SPACE_XYZ" in adapter.workspace_events_mgr.active_subscriptions
        adapter.client.create_workspace_events_subscription.assert_called_once_with(
            "spaces/SPACE_XYZ",
            TEST_TOPIC_ID,
            include_resource=True,
        )

        # 2. Proactive renewal: artificially set expires_at close to now
        sub = adapter.workspace_events_mgr.active_subscriptions["spaces/SPACE_XYZ"]
        sub.expires_at = 100.0  # Expiring soon relative to current time
        await adapter.workspace_events_mgr.renew_expiring_subscriptions()
        adapter.client.patch_workspace_events_subscription_ttl.assert_called_once_with(
            "subscriptions/sub-12345",
            ttl_seconds=14400,
        )

    @pytest.mark.asyncio
    async def test_subscription_adoption_and_reconciliation_on_startup_and_handoff(
        self,
    ) -> None:
        cfg = _make_config(
            user_client_id="user-cid",
            user_client_secret="user-sec",
            user_refresh_token="user-ref",
        )
        pod_b = GoogleChatAdapter(cfg)
        pod_b.client.list_workspace_events_subscriptions = AsyncMock(
            return_value=[
                {
                    "name": "subscriptions/existing-sub-1",
                    "targetResource": "//chat.googleapis.com/spaces/SPACE_1",
                    "expireTime": "2028-11-02T22:00:00Z",
                }
            ]
        )
        pod_b.client.list_spaces = AsyncMock(
            return_value=[
                {"name": "spaces/SPACE_1"},
                {"name": "spaces/SPACE_2"},
            ]
        )
        pod_b.client.create_workspace_events_subscription = AsyncMock(
            return_value={
                "name": "subscriptions/new-sub-2",
                "expireTime": "2028-11-02T20:00:00Z",
            }
        )

        # 1. On startup / lease acquisition, reconcile existing subscriptions and joined spaces
        await pod_b.workspace_events_mgr.reconcile_subscriptions()

        # SPACE_1 was adopted from existing subscriptions, so create was NOT called for it
        assert "spaces/SPACE_1" in pod_b.workspace_events_mgr.active_subscriptions
        assert (
            pod_b.workspace_events_mgr.active_subscriptions[
                "spaces/SPACE_1"
            ].subscription_name
            == "subscriptions/existing-sub-1"
        )

        # SPACE_2 was missing a subscription, so create WAS called for it
        assert "spaces/SPACE_2" in pod_b.workspace_events_mgr.active_subscriptions
        assert (
            pod_b.workspace_events_mgr.active_subscriptions[
                "spaces/SPACE_2"
            ].subscription_name
            == "subscriptions/new-sub-2"
        )
        pod_b.client.create_workspace_events_subscription.assert_called_once_with(
            "spaces/SPACE_2",
            TEST_TOPIC_ID,
            include_resource=True,
        )

        # 2. Database channels passed via ensure_channel_subscriptions
        pod_b.set_listening(True)
        pod_b.client.create_workspace_events_subscription.reset_mock()
        pod_b.client.create_workspace_events_subscription.return_value = {
            "name": "subscriptions/new-sub-3",
            "expireTime": "2028-11-02T20:00:00Z",
        }
        await pod_b.ensure_channel_subscriptions([("spaces/SPACE_3", "channel_public")])
        assert "spaces/SPACE_3" in pod_b.workspace_events_mgr.active_subscriptions
        pod_b.client.create_workspace_events_subscription.assert_called_once_with(
            "spaces/SPACE_3",
            TEST_TOPIC_ID,
            include_resource=True,
        )


# ── 9. Multi-Pod Lease Handoff Simulation ────────────────────────────────────


class TestGoogleChatMultiPodLeaseHandoff:
    @pytest.mark.asyncio
    async def test_lease_handoff_between_pods_no_duplicates(self) -> None:
        cfg = _make_config()
        pod_a = GoogleChatAdapter(cfg)
        pod_b = GoogleChatAdapter(cfg)

        dispatched_messages: list[str] = []

        async def record_message(msg: InboundMessage) -> None:
            dispatched_messages.append(msg.message_ref)

        pod_a.consumer.set_callbacks(on_message=record_message)
        pod_b.consumer.set_callbacks(on_message=record_message)

        # Pod A holds the lease initially
        pod_a.set_listening(True)
        pod_b.set_listening(False)

        await pod_a.start(
            record_message, AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
        )
        await pod_b.start(
            record_message, AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
        )

        # Pod A receives and processes a message
        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1"},
            "message": {
                "name": "spaces/S1/messages/M_HANDOFF_1",
                "text": "first turn",
                "sender": {"name": "users/U1", "displayName": "Alice", "type": "HUMAN"},
            },
        }
        await pod_a.consumer._handle_interaction_event(payload, "evt-h1")
        assert dispatched_messages == ["spaces/S1/messages/M_HANDOFF_1"]

        # Handoff: Pod A loses lease and stops, Pod B acquires lease and starts listening
        await pod_a.stop()
        pod_b.set_listening(True)
        pod_b.consumer.start()

        # New message arrives at Pod B
        payload2 = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1"},
            "message": {
                "name": "spaces/S1/messages/M_HANDOFF_2",
                "text": "second turn",
                "sender": {"name": "users/U2", "displayName": "Bob", "type": "HUMAN"},
            },
        }
        await pod_b.consumer._handle_interaction_event(payload2, "evt-h2")
        assert dispatched_messages == [
            "spaces/S1/messages/M_HANDOFF_1",
            "spaces/S1/messages/M_HANDOFF_2",
        ]

        await pod_b.stop()

    @pytest.mark.asyncio
    async def test_lease_handoff_with_shared_receipt_store_prevents_duplicate(
        self,
    ) -> None:
        cfg = _make_config()
        pod_a = GoogleChatAdapter(cfg)
        pod_b = GoogleChatAdapter(cfg)

        # Shared MessagingEventReceiptStore between pods
        shared_claimed_receipts: set[str] = set()
        mock_receipt_store = MagicMock()

        async def fake_claim(
            session: Any, *, platform: str, external_event_id: str
        ) -> Any:
            key = f"{platform}:{external_event_id}"
            if key in shared_claimed_receipts:
                return None
            shared_claimed_receipts.add(key)
            receipt = MagicMock()
            receipt.id = f"rcpt-{uuid.uuid4().hex[:8]}"
            return receipt

        mock_receipt_store.claim = AsyncMock(side_effect=fake_claim)
        mock_receipt_store.mark_handled = AsyncMock()
        mock_receipt_store.prune = AsyncMock()

        pod_a.consumer.receipt_store = mock_receipt_store
        pod_b.consumer.receipt_store = mock_receipt_store

        fake_session_factory = MagicMock()
        fake_session = AsyncMock()
        fake_session_factory.return_value.__aenter__.return_value = fake_session

        pod_a.set_tenant_id("tenant-1")
        pod_a.set_bridge_id("bridge-1")
        pod_a.set_session_factory(fake_session_factory)
        pod_b.set_tenant_id("tenant-1")
        pod_b.set_bridge_id("bridge-1")
        pod_b.set_session_factory(fake_session_factory)
        pod_b.client.get_space = AsyncMock(
            return_value={"name": "spaces/S1", "spaceType": "SPACE"}
        )

        dispatched_messages: list[str] = []

        async def record_message(msg: InboundMessage) -> None:
            dispatched_messages.append(msg.message_ref)

        pod_a.consumer.set_callbacks(on_message=record_message)
        pod_b.consumer.set_callbacks(on_message=record_message)

        pod_a.set_listening(True)
        pod_b.set_listening(False)

        # 1. Pod A processes message M1
        payload1 = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1"},
            "message": {
                "name": "spaces/S1/messages/M_HANDOFF_1",
                "text": "first turn",
                "sender": {"name": "users/U1", "displayName": "Alice", "type": "HUMAN"},
            },
        }
        await pod_a.consumer._handle_interaction_event(payload1, "evt-1")
        assert dispatched_messages == ["spaces/S1/messages/M_HANDOFF_1"]
        mock_receipt_store.mark_handled.assert_called_once()

        # 2. Handover from Pod A to Pod B
        await pod_a.stop()
        pod_b.set_listening(True)
        pod_b.consumer.start()

        # 3. Pub/Sub redelivers M1 to Pod B after failover
        await pod_b.consumer._handle_interaction_event(payload1, "evt-1-retry")
        # Pod B claimed through shared receipt store, saw it was already taken, and dropped it!
        assert dispatched_messages == ["spaces/S1/messages/M_HANDOFF_1"]

        # 4. Workspace Events CloudEvent for M1 arrives at Pod B
        ce_payload = {
            "specversion": "1.0",
            "id": "ce-msg-1",
            "type": "google.workspace.chat.message.v1.created",
            "data": {
                "space": {"name": "spaces/S1"},
                "message": {
                    "name": "spaces/S1/messages/M_HANDOFF_1",
                    "text": "first turn",
                    "sender": {
                        "name": "users/U1",
                        "displayName": "Alice",
                        "type": "HUMAN",
                    },
                },
            },
        }
        await pod_b.consumer._handle_cloud_event(ce_payload, {}, "ce-msg-1")
        # Still not dispatched again!
        assert dispatched_messages == ["spaces/S1/messages/M_HANDOFF_1"]

        # 5. Brand new message M2 arrives at Pod B
        payload2 = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1"},
            "message": {
                "name": "spaces/S1/messages/M_HANDOFF_2",
                "text": "second turn",
                "sender": {"name": "users/U2", "displayName": "Bob", "type": "HUMAN"},
            },
        }
        await pod_b.consumer._handle_interaction_event(payload2, "evt-2")
        assert dispatched_messages == [
            "spaces/S1/messages/M_HANDOFF_1",
            "spaces/S1/messages/M_HANDOFF_2",
        ]
        assert all(
            c.kwargs["external_event_id"].startswith("bridge-1:")
            for c in mock_receipt_store.claim.call_args_list
        )
        await pod_b.stop()


# ── Review follow-ups ────────────────────────────────────────────────────────

_BOT_MENTION = {
    "type": "USER_MENTION",
    "startIndex": 0,
    "length": 10,
    "userMention": {
        "user": {"name": "users/app", "displayName": "SwitchBot", "type": "BOT"},
        "type": "MENTION",
    },
}


class TestGoogleChatReviewFollowUps:
    def test_strip_bot_mention_leaves_other_mentions(self) -> None:
        text = "@SwitchBot @reviewer-agent please check"
        assert (
            strip_bot_mention(text, None, [_BOT_MENTION])
            == "@reviewer-agent please check"
        )
        # Without an annotation for the app, nothing is cut.
        assert (
            strip_bot_mention("@reviewer-agent please check", None, [])
            == "@reviewer-agent please check"
        )
        # A mention mid-sentence leaves one space behind, not two.
        mid = dict(_BOT_MENTION, startIndex=3)
        assert strip_bot_mention("hi @SwitchBot there", None, [mid]) == "hi there"

    @pytest.mark.asyncio
    async def test_workspace_event_builds_the_same_message_as_interaction(
        self,
    ) -> None:
        adapter = GoogleChatAdapter(_make_config())
        received: list[InboundMessage] = []
        commands: list[InboundCommand] = []

        async def on_message(msg: InboundMessage) -> None:
            received.append(msg)

        async def on_command(cmd: InboundCommand) -> None:
            commands.append(cmd)

        adapter.consumer.set_callbacks(on_message=on_message, on_command=on_command)

        def event(name: str, text: str) -> dict[str, Any]:
            return {
                "specversion": "1.0",
                "id": f"ce-{name}",
                "type": "google.workspace.chat.message.v1.created",
                "data": {
                    "message": {
                        "name": f"spaces/DM1/messages/{name}",
                        "text": text,
                        "annotations": [_BOT_MENTION],
                        "space": {
                            "name": "spaces/DM1",
                            "spaceType": "DIRECT_MESSAGE",
                            "displayName": "Alice",
                        },
                        "sender": {
                            "name": "users/U1",
                            "displayName": "Alice",
                            "type": "HUMAN",
                        },
                    }
                },
            }

        await adapter.consumer._handle_cloud_event(
            event("M1", "@SwitchBot hello there"), {}, "ce-M1"
        )
        msg = received[0]
        assert msg.channel_type == "direct"
        assert msg.content == "hello there"
        assert msg.self_mention_token == "bot"
        assert msg.channel_name == "Alice"

        await adapter.consumer._handle_cloud_event(
            event("M2", "@SwitchBot !status now"), {}, "ce-M2"
        )
        assert commands[0].command == "status"
        assert commands[0].args == "now"
        assert commands[0].channel_type == "direct"

    @pytest.mark.asyncio
    async def test_retire_channel_leaves_as_app_and_fails_loud(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        calls: list[tuple[str, str]] = []

        async def ok(method: str, url: str, **kwargs: Any) -> httpx.Response:
            calls.append((method, url))
            return httpx.Response(200, json={})

        adapter.client._request = AsyncMock(side_effect=ok)  # type: ignore[method-assign]
        outcome = await adapter.retire_channel("spaces/S1")
        assert outcome.outcome == "left"
        assert calls == [
            ("DELETE", f"{adapter.client.chat_api_base}/spaces/S1/members/app")
        ]

        adapter.client._request = AsyncMock(  # type: ignore[method-assign]
            return_value=httpx.Response(
                403,
                json={"error": {"message": "forbidden", "status": "PERMISSION_DENIED"}},
            )
        )
        outcome = await adapter.retire_channel("spaces/S1")
        assert outcome.outcome != "left"

    @pytest.mark.asyncio
    async def test_get_channel_type_does_not_hide_failures(self) -> None:
        adapter = GoogleChatAdapter(_make_config())
        adapter.client.get_space = AsyncMock(
            return_value={"name": "spaces/D", "spaceType": "DIRECT_MESSAGE"}
        )
        assert await adapter.get_channel_type("spaces/D") == "direct"

        adapter.client.get_space = AsyncMock(
            side_effect=BridgeOperationError("403 forbidden")
        )
        with pytest.raises(BridgeOperationError):
            await adapter.get_channel_type("spaces/D")

    @pytest.mark.asyncio
    async def test_receipts_are_scoped_to_the_bridge(self) -> None:
        claimed: set[str] = set()
        store = MagicMock()

        async def fake_claim(
            session: Any, *, platform: str, external_event_id: str
        ) -> Any:
            if external_event_id in claimed:
                return None
            claimed.add(external_event_id)
            receipt = MagicMock()
            receipt.id = external_event_id
            return receipt

        store.claim = AsyncMock(side_effect=fake_claim)
        store.mark_handled = AsyncMock()
        store.prune = AsyncMock()
        session_factory = MagicMock()
        session_factory.return_value.__aenter__.return_value = AsyncMock()

        received: list[str] = []

        async def on_message(msg: InboundMessage) -> None:
            received.append(msg.message_ref or "")

        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/S1", "spaceType": "SPACE"},
            "message": {
                "name": "spaces/S1/messages/SHARED",
                "text": "hi",
                "sender": {"name": "users/U1", "displayName": "Alice", "type": "HUMAN"},
            },
        }
        for bridge_id in ("bridge-a", "bridge-b"):
            adapter = GoogleChatAdapter(_make_config())
            adapter.consumer.receipt_store = store
            adapter.set_tenant_id("tenant-1")
            adapter.set_bridge_id(bridge_id)
            adapter.set_session_factory(session_factory)
            adapter.consumer.set_callbacks(on_message=on_message)
            await adapter.consumer._handle_interaction_event(payload, "evt")

        assert received == ["spaces/S1/messages/SHARED"] * 2
