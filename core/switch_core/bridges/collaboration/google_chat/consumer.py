from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from switch_core.bridges.collaboration.google_chat.client import GoogleChatClient
from switch_core.bridges.collaboration.google_chat.formatting import (
    bot_mention_annotations,
    is_app_user,
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

# How long the in-memory dedupe (used only without a database) remembers a key.
DEDUPE_TTL_SECONDS = 600
# Every pulled message has its deadline pushed out to this as soon as the batch
# arrives, and again every ACK_EXTENSION_INTERVAL while it waits or is handled,
# so the subscription's own ack deadline (10s by default) never decides it.
ACK_DEADLINE_EXTENSION_SECONDS = 60
ACK_EXTENSION_INTERVAL = 20


def channel_type_of_space(space: dict[str, Any]) -> ChannelType | None:
    """The bridge's channel type for a Chat API space, or None when the payload
    does not say what kind of space it is."""
    if space.get("singleUserBotDm"):
        return "direct"
    kind = space.get("spaceType") or space.get("type")
    if kind is None:
        return None
    if kind in ("DIRECT_MESSAGE", "DM"):
        return "direct"
    return "channel_public"


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
        """Claim an event for processing, returning (claimed, receipt_id).

        The receipt key carries the bridge id: the receipts' unique index is per
        tenant and platform, and two Google Chat bridges in one tenant can both
        see the same message. Without a database (unit tests) an in-memory set
        stands in. A database error propagates, so the Pub/Sub message is left
        unacked and redelivered.
        """
        if self.session_factory is None or self.tenant_id is None:
            return not self._is_duplicate_and_mark(dedupe_key), None
        if self.bridge_id is None:
            raise RuntimeError(
                "Google Chat consumer has a database but no bridge id to scope its receipts."
            )
        async with tenant_session(self.session_factory, self.tenant_id) as session:
            receipt = await self.receipt_store.claim(
                session,
                platform="google_chat",
                external_event_id=f"{self.bridge_id}:{dedupe_key}",
            )
            if receipt is None:
                return False, None
            receipt_id = receipt.id
            await session.commit()
            return True, receipt_id

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

    async def _handle_claimed(
        self, dedupe_key: str, work: Callable[[], Awaitable[None]]
    ) -> bool:
        """Claim `dedupe_key`, then run `work` once.

        A claim is final (receipts are at-most-once): a redelivery after a
        failed handler would find the claim taken and be dropped anyway. So a
        handler failure is logged as an error and the message acked, and its
        receipt stays unhandled, which is how a lost event shows up in the
        receipts table. Failures before the claim leave the message unacked
        so Pub/Sub redelivers it.
        """
        claimed, receipt_id = await self._claim_event(dedupe_key)
        if not claimed:
            logger.debug("Duplicate Google Chat event %s dropped.", dedupe_key)
            return True
        try:
            await work()
        except Exception:
            logger.error(
                "Google Chat event %s failed after it was claimed; it will not be "
                "retried.",
                dedupe_key,
                exc_info=True,
            )
            return True
        await self._mark_handled(receipt_id)
        return True

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
                logger.warning("Error extending Pub/Sub ack deadlines: %s", exc)

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

            batch = [m for m in messages if m.get("ackId")]
            batch_ack_ids = [m["ackId"] for m in batch]
            self._inflight_ack_ids.update(batch_ack_ids)
            try:
                await self.client.modify_ack_deadline(
                    self.project_id,
                    self.subscription_id,
                    batch_ack_ids,
                    ack_deadline_seconds=ACK_DEADLINE_EXTENSION_SECONDS,
                )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning(
                    "Could not extend the ack deadline of a pulled batch; some "
                    "messages may be redelivered: %s",
                    exc,
                )

            for msg_item in batch:
                ack_id = msg_item["ackId"]
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
        """Process one Pub/Sub envelope; ack it unless it should be redelivered."""
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

        channel_type = channel_type_of_space(space) or "channel_public"
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
            return await self._handle_card_clicked(payload, space_name, event_id)

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
        self, payload: dict[str, Any], space_name: str, event_id: str
    ) -> bool:
        """Hand a button press to core.

        Core decides what the press means and whether it counts, and redraws
        the card through `update_rich` when it does. Nothing is settled here:
        a refused press, or the turn's Stop button, must leave the card as it
        is. The claim is on the Pub/Sub message, so only a redelivery of the
        same press is dropped.
        """
        action = payload.get("action", {})
        params = {p.get("key"): p.get("value") for p in action.get("parameters", [])}

        token = params.get("token") or ""
        action_id = params.get("action_id") or ""
        user = payload.get("user", {})

        if not action_id or not token:
            logger.warning("CARD_CLICKED event missing action_id or token: %r", params)
            return True
        if self.on_interaction is None:
            logger.warning(
                "A press on a Switch card in %s has nowhere to go: this bridge "
                "handles no interactions.",
                space_name,
            )
            return True
        on_interaction = self.on_interaction
        display_name = user.get("displayName", "User")
        interaction = InboundInteraction(
            channel_id=space_name,
            sender_id=user.get("name", ""),
            sender_name=display_name,
            sender_display_name=display_name,
            action_id=action_id,
            value=token,
            message_ref=payload.get("message", {}).get("name"),
        )
        return await self._handle_claimed(
            f"click:{event_id}", lambda: on_interaction(interaction)
        )

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
        args = strip_bot_mention(
            message.get("text", ""),
            message.get("argumentText"),
            message.get("annotations"),
        )

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
        # Keyed by message name, shared with `message.v1.created`: an @mention
        # arrives both ways, and whichever is claimed first is the one handled.
        return await self._handle_claimed(
            message_name,
            lambda: self._dispatch_message(
                message, space_name, channel_type, space_display_name
            ),
        )

    async def _dispatch_message(
        self,
        message: dict[str, Any],
        space_name: str,
        channel_type: ChannelType,
        space_display_name: str | None,
    ) -> None:
        """Turn a Chat API message into a command or an inbound message.

        Both the interaction path and the Workspace Events path come through
        here, so a message is read the same way whichever delivery wins.
        """
        message_name = message.get("name", "")
        sender = message.get("sender", {})
        if is_app_user(sender):
            return

        raw_text = message.get("text", "")
        annotations = message.get("annotations", [])
        thread_name = message.get("thread", {}).get("name")
        self_mentioned = bool(bot_mention_annotations(annotations))
        clean_text = strip_bot_mention(
            raw_text, message.get("argumentText"), annotations
        )

        if clean_text.startswith("!"):
            parts = clean_text[1:].split(maxsplit=1)
            if self.on_command and parts:
                await self.on_command(
                    InboundCommand(
                        channel_id=space_name,
                        channel_type=channel_type,
                        sender_id=sender.get("name", ""),
                        sender_name=sender.get("displayName", "User"),
                        command=parts[0],
                        args=parts[1] if len(parts) > 1 else "",
                        message_ref=message_name,
                        root_id=thread_name,
                        channel_name=space_display_name,
                    )
                )
            return

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

    # ── Google Workspace Events (CloudEvents) ────────────────────────────────────

    async def _handle_cloud_event(
        self,
        payload: dict[str, Any],
        attributes: dict[str, str],
        event_id: str,
    ) -> bool:
        ce_type = attributes.get("ce-type") or payload.get("type", "")
        ce_id = attributes.get("ce-id") or payload.get("id") or event_id

        data = payload.get("data", {})
        if not data and "message" in payload:
            data = payload

        if ce_type == "google.workspace.chat.message.v1.created":
            return await self._handle_workspace_message_created(data)

        if ce_type in (
            "google.workspace.chat.message.v1.updated",
            "google.workspace.chat.message.v1.deleted",
        ):
            logger.debug("Inbound edit/delete CloudEvent (%s) ignored.", ce_type)
            return True

        if ce_type == "google.workspace.chat.membership.v1.created":
            return await self._handle_claimed(
                f"ce:{ce_id}",
                lambda: self._handle_workspace_membership_created(data),
            )

        logger.debug("Unhandled Workspace CloudEvent: %s", ce_type)
        return True

    async def _handle_workspace_message_created(self, data: dict[str, Any]) -> bool:
        message = data.get("message", {})
        message_name = message.get("name", "")

        # A resource-name-only notification carries no message body.
        if not message.get("text") and message_name:
            try:
                message = await self.client.get_message(message_name)
            except Exception as exc:
                logger.warning(
                    "Failed to fetch message for CloudEvent (%s), leaving it for "
                    "redelivery: %s",
                    message_name,
                    exc,
                )
                return False

        if not message_name:
            message_name = message.get("name", "")
        if not message_name:
            return True

        space = data.get("space") or message.get("space") or {}
        space_name = space.get("name")
        if not space_name and "/" in message_name:
            space_name = "/".join(message_name.split("/")[:2])
        if not space_name:
            return True

        channel_type = channel_type_of_space(space)
        if channel_type is None:
            space = await self.client.get_space(space_name)
            channel_type = channel_type_of_space(space) or "channel_public"
        resolved_type: ChannelType = channel_type
        space_display_name = space.get("displayName")

        return await self._handle_claimed(
            message_name,
            lambda: self._dispatch_message(
                message, space_name, resolved_type, space_display_name
            ),
        )

    async def _handle_workspace_membership_created(self, data: dict[str, Any]) -> None:
        membership = data.get("membership", {})
        member = membership.get("member", {})
        space_name = data.get("space", {}).get("name", "")
        if not space_name:
            return

        if member.get("name") == "users/app":
            if self.on_app_joined:
                await self.on_app_joined(
                    InboundAppJoin(
                        channel_id=space_name,
                        channel_type="channel_public",
                    )
                )
        elif self.on_user_joined:
            await self.on_user_joined(
                InboundUserJoin(
                    channel_id=space_name,
                    channel_type="channel_public",
                    external_user_id=member.get("name", ""),
                    external_username=member.get("displayName", "User"),
                )
            )
