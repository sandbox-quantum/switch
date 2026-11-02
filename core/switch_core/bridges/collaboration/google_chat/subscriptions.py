from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime

from switch_core.bridges.collaboration.google_chat.client import GoogleChatClient

logger = logging.getLogger(__name__)

# Default renewal threshold: renew if expiring in less than 30 minutes (1800s)
RENEWAL_THRESHOLD_SECONDS = 1800
# Default Workspace Events subscription TTL: 4 hours (14400s)
SUBSCRIPTION_TTL_SECONDS = 14400


@dataclass
class WorkspaceEventsSubscription:
    space_name: str
    subscription_name: str
    expires_at: float


class WorkspaceEventsManager:
    """Manages Google Workspace Events subscriptions for spaces and their proactive renewal."""

    def __init__(
        self,
        client: GoogleChatClient,
        pubsub_topic: str | None,
        *,
        has_user_oauth: bool,
    ) -> None:
        self._client = client
        self._pubsub_topic = pubsub_topic
        self._has_user_oauth = has_user_oauth
        self._subscriptions: dict[str, WorkspaceEventsSubscription] = {}
        self._renewal_task: asyncio.Task[None] | None = None
        self._running = False

    @property
    def active_subscriptions(self) -> dict[str, WorkspaceEventsSubscription]:
        return dict(self._subscriptions)

    def start(self) -> None:
        """Start the proactive renewal loop on the lease-holding pod."""
        if not self._has_user_oauth or not self._pubsub_topic:
            logger.info(
                "Workspace Events subscriptions disabled: requires user OAuth credentials "
                "and pubsub_topic in connection config."
            )
            return

        self._running = True
        self._renewal_task = asyncio.create_task(
            self._renewal_loop(),
            name="google-chat-workspace-events-renewal",
        )

    async def stop(self) -> None:
        """Stop the proactive renewal loop."""
        self._running = False
        if self._renewal_task:
            self._renewal_task.cancel()
            try:
                await self._renewal_task
            except asyncio.CancelledError:
                pass
            self._renewal_task = None

    def _parse_expire_time(self, expire_str: str | None) -> float:
        if not expire_str:
            return time.time() + SUBSCRIPTION_TTL_SECONDS
        try:
            # Handles RFC3339 timestamps like 2026-11-02T15:00:00.000Z
            dt = datetime.fromisoformat(expire_str.replace("Z", "+00:00"))
            return dt.timestamp()
        except Exception:
            return time.time() + SUBSCRIPTION_TTL_SECONDS

    async def ensure_space_subscription(self, space_name: str) -> None:
        """Ensure an active Workspace Events subscription exists for `space_name`."""
        if not self._has_user_oauth or not self._pubsub_topic:
            logger.debug(
                "Skipping Workspace Events subscription for %s (no User OAuth or topic configured).",
                space_name,
            )
            return

        now = time.time()
        existing = self._subscriptions.get(space_name)
        if existing and existing.expires_at > now + RENEWAL_THRESHOLD_SECONDS:
            return

        try:
            res = await self._client.create_workspace_events_subscription(
                space_name,
                self._pubsub_topic,
                include_resource=True,
            )
            sub_name = res.get("name", "")
            expire_time_str = res.get("expireTime")
            expires_at = self._parse_expire_time(expire_time_str)

            self._subscriptions[space_name] = WorkspaceEventsSubscription(
                space_name=space_name,
                subscription_name=sub_name,
                expires_at=expires_at,
            )
            logger.info(
                "Created Workspace Events subscription for %s: %s (expires in %ds)",
                space_name,
                sub_name,
                int(expires_at - now),
            )
        except Exception as exc:
            logger.warning(
                "Failed to create Workspace Events subscription for %s: %s",
                space_name,
                exc,
            )

    async def renew_expiring_subscriptions(self) -> None:
        """Renew any active subscription nearing expiration."""
        now = time.time()
        for space_name, sub in list(self._subscriptions.items()):
            if sub.expires_at - now < RENEWAL_THRESHOLD_SECONDS:
                try:
                    res = await self._client.patch_workspace_events_subscription_ttl(
                        sub.subscription_name,
                        ttl_seconds=SUBSCRIPTION_TTL_SECONDS,
                    )
                    expire_time_str = res.get("expireTime")
                    sub.expires_at = self._parse_expire_time(expire_time_str)
                    logger.info(
                        "Proactively renewed Workspace Events subscription %s for %s",
                        sub.subscription_name,
                        space_name,
                    )
                except Exception as exc:
                    logger.warning(
                        "Failed to renew Workspace Events subscription %s: %s",
                        sub.subscription_name,
                        exc,
                    )

    async def _renewal_loop(self) -> None:
        """Periodic background renewal loop."""
        while self._running:
            try:
                await self.renew_expiring_subscriptions()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Error in Workspace Events renewal loop: %s", exc)

            try:
                # Check every 10 minutes (600 seconds)
                await asyncio.sleep(600)
            except asyncio.CancelledError:
                break
