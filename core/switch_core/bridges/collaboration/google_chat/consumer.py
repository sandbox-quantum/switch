from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from switch_core.bridges.collaboration.google_chat.cards import (
    render_settled_approval_card,
)
from switch_core.bridges.collaboration.google_chat.client import GoogleChatClient
from switch_core.bridges.collaboration.google_chat.formatting import (
    strip_bot_mention,
)
from switch_core.bridges.collaboration.google_chat.subscriptions import (
    WorkspaceEventsManager,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

# Deduplication cache expiration: 10 minutes
DEDUPE_TTL_SECONDS = 600
# Periodic ack deadline extension interval: 20 seconds
ACK_EXTENSION_INTERVAL = 20
# Deadline extension amount: 60 seconds
ACK_DEADLINE_EXTENSION_SECONDS = 60


class InboundConsumer:
    """Consumes and dispatches Google Chat interaction events and Workspace CloudEvents from Pub/Sub."""

    def __init__(
        self,
        project_id: str,
        subscription_id: str,
        client: GoogleChatClient,
        workspace_events_mgr: WorkspaceEventsManager,
        *,
        slash_command_map: dict[str, str] | None = None,
        max_attachment_bytes: int = 20 * 1024 * 1024,
    ) -> None:
        self.project_id = project_id
        self.subscription_id = subscription_id
        self.client = client
        self.workspace_events_mgr = workspace_events_mgr
        self.slash_command_map = slash_command_map or {}
        self.max_attachment_bytes = max_attachment_bytes

        # Callbacks registered by adapter
        self.on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self.on_command: Callable[[InboundCommand], Awaitable[None]] | None = None
        self.on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]] | None = (
            None
        )
        self.on_user_joined: Callable[[InboundUserJoin], Awaitable[None]] | None = None
        self.on_app_joined: Callable[[InboundAppJoin], Awaitable[None]] | None = None
        self.on_interaction: Callable[[InboundInteraction], Awaitable[None]] | None = (
            None
        )

        self._running = False
        self._pull_task: asyncio.Task[None] | None = None
        self._extender_task: asyncio.Task[None] | None = None
        self._inflight_ack_ids: set[str] = set()

        # Deduplication cache: key -> timestamp (used as fallback when no session_factory)
        self._seen_events: dict[str, float] = {}
        # Single-winner / resolved interaction tokens
        self._resolved_tokens: set[str] = set()
        self._lock = asyncio.Lock()

        # Database event receipt store for horizontal multi-pod deduplication
        self.receipt_store = MessagingEventReceiptStore()
        self.session_factory: async_sessionmaker[AsyncSession] | None = None
        self.tenant_id: str | None = None
        self.bridge_id: str | None = None

    def set_callbacks(
        self,
        *,
        on_message: Callable[[InboundMessage], Awaitable[None]] | None = None,
        on_command: Callable[[InboundCommand], Awaitable[None]] | None = None,
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]] | None = None,
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]] | None = None,
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]] | None = None,
        on_interaction: Callable[[InboundInteraction], Awaitable[None]] | None = None,
    ) -> None:
        self.on_message = on_message
        self.on_command = on_command
        self.on_agent_joined = on_agent_joined
        self.on_user_joined = on_user_joined
        self.on_app_joined = on_app_joined
        self.on_interaction = on_interaction

    def start(self) -> None:
        """Start the background pull loop and ack extension."""
        self._running = True
        self._pull_task = asyncio.create_task(
            self._pull_loop(), name="google-chat-pubsub-pull"
        )
        self._extender_task = asyncio.create_task(
            self._ack_extender_loop(),
            name="google-chat-pubsub-ack-extender",
        )

    async def stop(self) -> None:
        """Stop consumer loop. In-flight uncommitted deliveries are left unacked."""
        self._running = False
        if self._pull_task:
            self._pull_task.cancel()
            try:
                await self._pull_task
            except asyncio.CancelledError:
                pass
            self._pull_task = None

        if self._extender_task:
            self._extender_task.cancel()
            try:
                await self._extender_task
            except asyncio.CancelledError:
                pass
            self._extender_task = None

        self._inflight_ack_ids.clear()

    def _is_duplicate_and_mark(self, dedupe_key: str) -> bool:
        """Check if dedupe_key was already processed; mark it if new."""
        now = time.time()
        # Clean expired entries periodically
        if len(self._seen_events) > 5000:
            expired = [
                k
                for k, ts in self._seen_events.items()
                if now - ts > DEDUPE_TTL_SECONDS
            ]
            for k in expired:
                self._seen_events.pop(k, None)

        if dedupe_key in self._seen_events:
            if now - self._seen_events[dedupe_key] <= DEDUPE_TTL_SECONDS:
                return True

        self._seen_events[dedupe_key] = now
        return False

    async def _claim_event(self, dedupe_key: str) -> tuple[bool, str | None]:
        """Claim an event for processing via MessagingEventReceiptStore or in-memory fallback.

        Returns (claimed, receipt_id). If claimed is False, another pod/worker has already taken
        the event, and the caller should ack and drop it immediately.
        """
        if self.session_factory and self.tenant_id:
            try:
                async with tenant_session(
                    self.session_factory, self.tenant_id
                ) as session:
                    receipt = await self.receipt_store.claim(
                        session,
                        platform="google_chat",
                        external_event_id=dedupe_key,
                    )
                    if receipt is None:
                        return False, None
                    receipt_id = receipt.id
                    # Commit immediately to release the unique index lock
                    await session.commit()
                    return True, receipt_id
            except Exception as exc:
                logger.warning(
                    "Error claiming event %s via receipt store: %s",
                    dedupe_key,
                    exc,
                )
                return not self._is_duplicate_and_mark(dedupe_key), None

        return not self._is_duplicate_and_mark(dedupe_key), None

    async def _mark_handled(self, receipt_id: str | None) -> None:
        """Mark claimed event handled in the database and prune expired receipts."""
        if receipt_id and self.session_factory and self.tenant_id:
            try:
                async with tenant_session(
                    self.session_factory, self.tenant_id
                ) as session:
                    await self.receipt_store.mark_handled(
                        session, receipt_id=receipt_id
                    )
                    await self.receipt_store.prune(session)
                    await session.commit()
            except Exception as exc:
                logger.warning("Failed to mark receipt %s handled: %s", receipt_id, exc)

    async def _ack_extender_loop(self) -> None:
        """Periodically extend ack deadline for in-flight slow turn messages."""
        while self._running:
            try:
                await asyncio.sleep(ACK_EXTENSION_INTERVAL)
                ack_ids = list(self._inflight_ack_ids)
                if ack_ids:
                    await self.client.modify_ack_deadline(
                        self.project_id,
                        self.subscription_id,
                        ack_ids,
                        ack_deadline_seconds=ACK_DEADLINE_EXTENSION_SECONDS,
                    )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("Error extending Pub/Sub ack deadlines: %s", exc)

    async def _pull_loop(self) -> None:
        """Background pull loop."""
        while self._running:
            try:
                messages = await self.client.pull_pubsub_messages(
                    self.project_id,
                    self.subscription_id,
                    max_messages=10,
                )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("Error pulling messages from Pub/Sub: %s", exc)
                try:
                    await asyncio.sleep(5.0)
                except asyncio.CancelledError:
                    break
                continue

            if not messages:
                try:
                    await asyncio.sleep(1.0)
                except asyncio.CancelledError:
                    break
                continue

            for msg_item in messages:
                ack_id = msg_item.get("ackId")
                if not ack_id:
                    continue
                # Process message with ack-after-write
                self._inflight_ack_ids.add(ack_id)
                try:
                    await self._process_single_pubsub_message(
                        ack_id, msg_item.get("message", {})
                    )
                except asyncio.CancelledError:
                    # Inflight uncommitted deliveries remain unacked on shutdown/lease loss
                    raise
                except Exception as exc:
                    logger.error(
                        "Failed processing Pub/Sub message %s: %s", ack_id, exc
                    )
                finally:
                    self._inflight_ack_ids.discard(ack_id)

    async def _process_single_pubsub_message(
        self, ack_id: str, message_data: dict[str, Any]
    ) -> None:
        """Process a single Pub/Sub envelope and ack ONLY AFTER successful write."""
        raw_b64 = message_data.get("data", "")
        attributes = message_data.get("attributes", {})
        message_id = message_data.get("messageId", "")

        try:
            raw_bytes = base64.b64decode(raw_b64)
            payload = json.loads(raw_bytes.decode("utf-8"))
        except Exception as exc:
            logger.warning(
                "Pub/Sub message data is not valid JSON (%s): %s", message_id, exc
            )
            # Malformed data cannot be processed, ack it so it does not block the queue
            await self.client.acknowledge_pubsub_messages(
                self.project_id, self.subscription_id, [ack_id]
            )
            return

        # Determine if this is a CloudEvent or a Chat App Interaction Event
        is_cloud_event = (
            "ce-type" in attributes
            or payload.get("specversion") == "1.0"
            or str(payload.get("type", "")).startswith("google.workspace.")
        )

        success = False
        try:
            if is_cloud_event:
                success = await self._handle_cloud_event(
                    payload, attributes, message_id
                )
            else:
                success = await self._handle_interaction_event(payload, message_id)
        except Exception as exc:
            logger.error("Error dispatching Pub/Sub event: %s", exc, exc_info=True)
            success = False

        # Ack-after-write: Ack ONLY if the durable room/transport write succeeded
        if success:
            await self.client.acknowledge_pubsub_messages(
                self.project_id, self.subscription_id, [ack_id]
            )

    # ── Chat App Interaction Events ──────────────────────────────────────────────

    async def _handle_interaction_event(
        self, payload: dict[str, Any], event_id: str
    ) -> bool:
        event_type = payload.get("type")
        space = payload.get("space", {})
        space_name = space.get("name", "")
        if not space_name:
            return True

        channel_type: ChannelType = (
            "direct"
            if space.get("type") == "DM" or space.get("singleUserBotDm")
            else "channel_public"
        )
        space_display_name = space.get("displayName")

        if event_type == "ADDED_TO_SPACE":
            logger.info(
                "Chat app added to space: %s (%s)", space_name, space_display_name
            )
            # Ensure workspace events subscription exists for unaddressed messages
            await self.workspace_events_mgr.ensure_space_subscription(space_name)
            if self.on_app_joined:
                await self.on_app_joined(
                    InboundAppJoin(
                        channel_id=space_name,
                        channel_type=channel_type,
                        channel_name=space_display_name,
                    )
                )
            return True

        if event_type == "REMOVED_FROM_SPACE":
            logger.info("Chat app removed from space: %s", space_name)
            return True

        if event_type == "CARD_CLICKED":
            return await self._handle_card_clicked(payload, space_name)

        if event_type == "MESSAGE":
            return await self._handle_chat_message_event(
                payload,
                space_name,
                channel_type,
                space_display_name,
                event_id,
            )

        # Legacy or numeric slash command interaction
        if event_type == "SLASH_COMMAND" or "appCommandPayload" in payload:
            return await self._handle_slash_command(
                payload, space_name, channel_type, space_display_name
            )

        logger.debug("Unhandled interaction event type: %s", event_type)
        return True

    async def _handle_card_clicked(
        self, payload: dict[str, Any], space_name: str
    ) -> bool:
        action = payload.get("action", {})
        params = {p.get("key"): p.get("value") for p in action.get("parameters", [])}

        token = params.get("token") or ""
        action_id = params.get("action_id") or ""
        message_name = payload.get("message", {}).get("name")
        user = payload.get("user", {})
        sender_id = user.get("name", "")
        sender_name = user.get("displayName", "User")

        if not action_id or not token:
            logger.warning("CARD_CLICKED event missing action_id or token: %r", params)
            return True

        # Replay protection / single-winner semantics across pods
        claimed, receipt_id = await self._claim_event(f"card:{token}")
        if not claimed or token in self._resolved_tokens:
            logger.info(
                "Card action for token %s already resolved; ignoring duplicate click.",
                token,
            )
            return True

        if self.on_interaction:
            await self.on_interaction(
                InboundInteraction(
                    channel_id=space_name,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    action_id=action_id,
                    value=token,
                    message_ref=message_name,
                )
            )

        # Mark token as resolved
        self._resolved_tokens.add(token)

        # Patch the card to reflect the decision and disable buttons
        if message_name:
            try:
                settled_cards = render_settled_approval_card(
                    payload.get("message", {}).get("cardsV2"),
                    decision_label="Decision Recorded",
                    actor_name=sender_name,
                )
                await self.client.patch_message(
                    message_name,
                    cards_v2=settled_cards,
                    update_mask="cards_v2",
                )
            except Exception as exc:
                logger.warning(
                    "Could not patch settled card on %s: %s", message_name, exc
                )

        await self._mark_handled(receipt_id)
        return True

    async def _handle_slash_command(
        self,
        payload: dict[str, Any],
        space_name: str,
        channel_type: ChannelType,
        channel_name: str | None,
    ) -> bool:
        user = payload.get("user", {})
        message = payload.get("message", {})
        cmd_meta = payload.get("appCommandPayload", {}).get("appCommandMetadata", {})
        cmd_id = str(cmd_meta.get("appCommandId") or "")

        cmd_name = self.slash_command_map.get(cmd_id) or f"command_{cmd_id}"
        args = strip_bot_mention(message.get("text", ""), message.get("argumentText"))

        if self.on_command:
            await self.on_command(
                InboundCommand(
                    channel_id=space_name,
                    channel_type=channel_type,
                    sender_id=user.get("name", ""),
                    sender_name=user.get("displayName", "User"),
                    command=cmd_name.lstrip("/"),
                    args=args,
                    message_ref=message.get("name"),
                    root_id=message.get("thread", {}).get("name"),
                    channel_name=channel_name,
                )
            )
        return True

    async def _handle_chat_message_event(
        self,
        payload: dict[str, Any],
        space_name: str,
        channel_type: ChannelType,
        space_display_name: str | None,
        event_id: str,
    ) -> bool:
        message = payload.get("message", {})
        message_name = message.get("name", "")
        if not message_name:
            return True

        # Deduplicate across @mention interaction events and Workspace message.v1.created CloudEvents
        # Claim Pub/Sub messages through MessagingEventReceiptStore, keyed by message name.
        claimed, receipt_id = await self._claim_event(message_name)
        if not claimed:
            logger.debug("Duplicate message event %s dropped.", message_name)
            return True

        sender = message.get("sender", {})
        if sender.get("type") == "BOT" or "app" in sender.get("name", ""):
            # Ignore messages posted by our bot
            await self._mark_handled(receipt_id)
            return True

        raw_text = message.get("text", "")
        argument_text = message.get("argumentText")
        annotations = message.get("annotations", [])
        thread_name = message.get("thread", {}).get("name")

        # Determine self-mention
        self_mentioned = False
        for ann in annotations:
            if ann.get("type") == "USER_MENTION":
                mention_user = ann.get("userMention", {}).get("user", {})
                if mention_user.get("type") == "BOT" or "app" in mention_user.get(
                    "name", ""
                ):
                    self_mentioned = True
                    break

        clean_text = strip_bot_mention(raw_text, argument_text, annotations)

        # Parse !command
        if clean_text.startswith("!"):
            parts = clean_text[1:].split(maxsplit=1)
            cmd = parts[0]
            cmd_args = parts[1] if len(parts) > 1 else ""
            if self.on_command:
                await self.on_command(
                    InboundCommand(
                        channel_id=space_name,
                        channel_type=channel_type,
                        sender_id=sender.get("name", ""),
                        sender_name=sender.get("displayName", "User"),
                        command=cmd,
                        args=cmd_args,
                        message_ref=message_name,
                        root_id=thread_name,
                        channel_name=space_display_name,
                    )
                )
            await self._mark_handled(receipt_id)
            return True

        # Handle attachments
        inbound_attachments: list[Attachment] = []
        attachment_failures: list[AttachmentFailure] = []

        for att in message.get("attachment", []):
            content_name = att.get("contentName", "attachment")
            content_type = att.get("contentType", "application/octet-stream")

            data_ref = att.get("attachmentDataRef", {})
            drive_ref = att.get("driveDataRef", {})

            if data_ref.get("resourceName"):
                try:
                    file_bytes = await self.client.download_media(
                        data_ref["resourceName"],
                        max_bytes=self.max_attachment_bytes,
                    )
                    inbound_attachments.append(
                        Attachment(
                            filename=content_name,
                            mimetype=content_type,
                            data=file_bytes,
                        )
                    )
                except ValueError as val_err:
                    attachment_failures.append(
                        AttachmentFailure(filename=content_name, reason=str(val_err))
                    )
                except Exception as exc:
                    attachment_failures.append(
                        AttachmentFailure(
                            filename=content_name,
                            reason=f"Download failed: {exc}",
                        )
                    )
            elif drive_ref.get("driveFileId"):
                # Drive-linked file fallback
                drive_id = drive_ref["driveFileId"]
                drive_link = f"https://drive.google.com/open?id={drive_id}"
                clean_text += (
                    f"\n[Google Drive attachment: {content_name} (<{drive_link}>)]"
                )

        if self.on_message:
            await self.on_message(
                InboundMessage(
                    channel_id=space_name,
                    channel_type=channel_type,
                    sender_id=sender.get("name", ""),
                    sender_name=sender.get("displayName", "User"),
                    content=clean_text,
                    message_ref=message_name,
                    root_id=thread_name,
                    channel_name=space_display_name,
                    attachments=inbound_attachments,
                    attachment_failures=attachment_failures,
                    self_mention_token="bot" if self_mentioned else None,
                )
            )

        await self._mark_handled(receipt_id)
        return True

    # ── Google Workspace Events (CloudEvents) ────────────────────────────────────

    async def _handle_cloud_event(
        self,
        payload: dict[str, Any],
        attributes: dict[str, str],
        event_id: str,
    ) -> bool:
        ce_type = attributes.get("ce-type") or payload.get("type", "")
        ce_id = attributes.get("ce-id") or payload.get("id") or event_id

        # Deduplicate non-message CloudEvents on CloudEvent ID
        ce_receipt_id: str | None = None
        if ce_type != "google.workspace.chat.message.v1.created" and ce_id:
            claimed, ce_receipt_id = await self._claim_event(f"ce:{ce_id}")
            if not claimed:
                logger.debug("Duplicate CloudEvent %s dropped.", ce_id)
                return True

        data = payload.get("data", {})
        if not data and "message" in payload:
            data = payload

        if ce_type == "google.workspace.chat.message.v1.created":
            return await self._handle_workspace_message_created(data, ce_id)

        if ce_type in (
            "google.workspace.chat.message.v1.updated",
            "google.workspace.chat.message.v1.deleted",
        ):
            # Inbound edits/deletes are unsupported per maintainer instructions (Issue #804 has not landed)
            logger.debug(
                "Inbound edit/delete CloudEvent (%s) ignored: core #804 not landed.",
                ce_type,
            )
            await self._mark_handled(ce_receipt_id)
            return True

        if ce_type == "google.workspace.chat.membership.v1.created":
            res = await self._handle_workspace_membership_created(data)
            await self._mark_handled(ce_receipt_id)
            return res

        logger.debug("Unhandled Workspace CloudEvent: %s", ce_type)
        await self._mark_handled(ce_receipt_id)
        return True

    async def _handle_workspace_message_created(
        self, data: dict[str, Any], event_id: str
    ) -> bool:
        message = data.get("message", {})
        message_name = message.get("name", "")

        # If resource payload was not included (resource-name-only notification), fetch message
        if not message.get("text") and message_name:
            try:
                message = await self.client.get_message(message_name)
            except Exception as exc:
                logger.warning(
                    "Failed to fetch message for CloudEvent (%s): %s", message_name, exc
                )
                return True

        if not message_name:
            message_name = message.get("name", "")
        if not message_name:
            return True

        # Check deduplication on message resource name
        # Claim Pub/Sub messages through MessagingEventReceiptStore, keyed by message name.
        claimed, receipt_id = await self._claim_event(message_name)
        if not claimed:
            logger.debug("Duplicate message resource %s dropped.", message_name)
            return True

        space_name = data.get("space", {}).get("name") or message.get("space", {}).get(
            "name"
        )
        if not space_name and "/" in message_name:
            # Extract space from message name: spaces/{space}/messages/{msg}
            space_name = "/".join(message_name.split("/")[:2])

        if not space_name:
            await self._mark_handled(receipt_id)
            return True

        sender = message.get("sender", {})
        if sender.get("type") == "BOT" or "app" in sender.get("name", ""):
            await self._mark_handled(receipt_id)
            return True

        raw_text = message.get("text", "")
        clean_text = strip_bot_mention(raw_text, message.get("argumentText"))
        thread_name = message.get("thread", {}).get("name")

        if self.on_message:
            await self.on_message(
                InboundMessage(
                    channel_id=space_name,
                    channel_type="channel_public",
                    sender_id=sender.get("name", ""),
                    sender_name=sender.get("displayName", "User"),
                    content=clean_text,
                    message_ref=message_name,
                    root_id=thread_name,
                )
            )

        await self._mark_handled(receipt_id)
        return True

    async def _handle_workspace_membership_created(self, data: dict[str, Any]) -> bool:
        membership = data.get("membership", {})
        member = membership.get("member", {})
        space_name = data.get("space", {}).get("name", "")

        if not space_name:
            return True

        if member.get("type") == "BOT" and "app" in member.get("name", ""):
            if self.on_app_joined:
                await self.on_app_joined(
                    InboundAppJoin(
                        channel_id=space_name,
                        channel_type="channel_public",
                    )
                )
        else:
            if self.on_user_joined:
                await self.on_user_joined(
                    InboundUserJoin(
                        channel_id=space_name,
                        channel_type="channel_public",
                        external_user_id=member.get("name", ""),
                        external_username=member.get("displayName", "User"),
                    )
                )

        return True
