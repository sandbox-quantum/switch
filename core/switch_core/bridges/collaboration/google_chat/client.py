from __future__ import annotations

import logging
from typing import Any, cast

import httpx

from switch_core.bridges.collaboration.google_chat.auth import GoogleAuthManager
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)

logger = logging.getLogger(__name__)

CHAT_API_BASE = "https://chat.googleapis.com/v1"
PUBSUB_API_BASE = "https://pubsub.googleapis.com/v1"
WORKSPACE_EVENTS_API_BASE = "https://workspaceevents.googleapis.com/v1"


def _format_google_error(resp: httpx.Response) -> str:
    """Format Google API error details into an actionable error message."""
    try:
        data = resp.json()
        err = data.get("error")
        if isinstance(err, dict):
            code = err.get("code", resp.status_code)
            status = err.get("status", "")
            message = err.get("message", "")
            return f"{status} (HTTP {code}): {message}".strip()
        if isinstance(err, str):
            return err
    except Exception:
        pass
    return f"HTTP {resp.status_code}: {resp.text[:300]}"


class GoogleChatClient:
    """Client for Google Chat, Cloud Pub/Sub, and Workspace Events APIs."""

    def __init__(
        self,
        auth_manager: GoogleAuthManager,
        *,
        http_client: httpx.AsyncClient | None = None,
        chat_api_base: str = CHAT_API_BASE,
        pubsub_api_base: str = PUBSUB_API_BASE,
        workspace_events_api_base: str = WORKSPACE_EVENTS_API_BASE,
    ) -> None:
        self.auth_manager = auth_manager
        self._http_client = http_client or httpx.AsyncClient(timeout=30.0)
        self._owns_http_client = http_client is None
        self.chat_api_base = chat_api_base.rstrip("/")
        self.pubsub_api_base = pubsub_api_base.rstrip("/")
        self.workspace_events_api_base = workspace_events_api_base.rstrip("/")

    async def aclose(self) -> None:
        if self._owns_http_client:
            await self._http_client.aclose()

    async def _request(
        self,
        method: str,
        url: str,
        *,
        use_user_oauth: bool = False,
        params: dict[str, Any] | None = None,
        json_data: Any = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        req_headers = dict(headers or {})
        if use_user_oauth:
            token = await self.auth_manager.get_user_token()
            if not token:
                # Fall back to service account token if user oauth is not available
                token = await self.auth_manager.get_service_account_token()
        else:
            token = await self.auth_manager.get_service_account_token()

        req_headers["Authorization"] = f"Bearer {token}"

        try:
            resp = await self._http_client.request(
                method,
                url,
                params=params,
                json=json_data,
                headers=req_headers,
            )
        except Exception as exc:
            raise BridgeOperationError(
                f"Network error calling Google API ({url}): {exc}"
            ) from exc

        if resp.status_code == 401:
            err_msg = _format_google_error(resp)
            raise BridgeCredentialError(f"Google API authentication failed: {err_msg}")

        return resp

    # ── Cloud Pub/Sub API ────────────────────────────────────────────────────────

    def _normalize_subscription_path(
        self, project_id: str, subscription_id: str
    ) -> str:
        if "/" in subscription_id:
            return subscription_id
        return f"projects/{project_id}/subscriptions/{subscription_id}"

    async def get_subscription(
        self, project_id: str, subscription_id: str
    ) -> dict[str, Any]:
        """Fetch subscription metadata to verify existence and access."""
        sub_path = self._normalize_subscription_path(project_id, subscription_id)
        url = f"{self.pubsub_api_base}/{sub_path}"
        resp = await self._request("GET", url)
        if resp.status_code != 200:
            err = _format_google_error(resp)
            if resp.status_code in (403, 404):
                raise BridgeCredentialError(
                    f"Pub/Sub subscription '{sub_path}' is inaccessible or does not exist: {err}"
                )
            raise BridgeOperationError(
                f"Failed to inspect Pub/Sub subscription '{sub_path}': {err}"
            )
        return cast(dict[str, Any], resp.json())

    async def pull_pubsub_messages(
        self,
        project_id: str,
        subscription_id: str,
        max_messages: int = 10,
    ) -> list[dict[str, Any]]:
        """Pull messages from Cloud Pub/Sub subscription."""
        sub_path = self._normalize_subscription_path(project_id, subscription_id)
        url = f"{self.pubsub_api_base}/{sub_path}:pull"
        data = {"maxMessages": max_messages}
        resp = await self._request("POST", url, json_data=data)
        if resp.status_code != 200:
            err = _format_google_error(resp)
            raise BridgeOperationError(
                f"Failed to pull messages from Pub/Sub ({sub_path}): {err}"
            )
        data = cast(dict[str, Any], resp.json())
        return cast(list[dict[str, Any]], data.get("receivedMessages", []))

    async def acknowledge_pubsub_messages(
        self,
        project_id: str,
        subscription_id: str,
        ack_ids: list[str],
    ) -> None:
        """Acknowledge processed Pub/Sub messages."""
        if not ack_ids:
            return
        sub_path = self._normalize_subscription_path(project_id, subscription_id)
        url = f"{self.pubsub_api_base}/{sub_path}:acknowledge"
        resp = await self._request("POST", url, json_data={"ackIds": ack_ids})
        if resp.status_code != 200:
            err = _format_google_error(resp)
            logger.warning(
                "Failed to acknowledge Pub/Sub messages on %s: %s", sub_path, err
            )

    async def modify_ack_deadline(
        self,
        project_id: str,
        subscription_id: str,
        ack_ids: list[str],
        ack_deadline_seconds: int = 60,
    ) -> None:
        """Extend ack deadline for in-flight slow messages."""
        if not ack_ids:
            return
        sub_path = self._normalize_subscription_path(project_id, subscription_id)
        url = f"{self.pubsub_api_base}/{sub_path}:modifyAckDeadline"
        data = {
            "ackIds": ack_ids,
            "ackDeadlineSeconds": ack_deadline_seconds,
        }
        resp = await self._request("POST", url, json_data=data)
        if resp.status_code != 200:
            err = _format_google_error(resp)
            logger.debug("Failed to modify ack deadline on %s: %s", sub_path, err)

    # ── Google Chat API ──────────────────────────────────────────────────────────

    def _normalize_space_name(self, space_id: str) -> str:
        if space_id.startswith("spaces/"):
            return space_id
        return f"spaces/{space_id}"

    async def create_message(
        self,
        space_id: str,
        *,
        text: str | None = None,
        cards_v2: list[dict[str, Any]] | None = None,
        thread_name: str | None = None,
        message_reply_option: str = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    ) -> dict[str, Any]:
        """Post a message or card to a Google Chat space."""
        space_name = self._normalize_space_name(space_id)
        url = f"{self.chat_api_base}/{space_name}/messages"
        params: dict[str, Any] = {}
        if thread_name:
            params["messageReplyOption"] = message_reply_option

        body: dict[str, Any] = {}
        if text:
            body["text"] = text
        if cards_v2:
            body["cardsV2"] = cards_v2
        if thread_name:
            # thread name must be in format spaces/{space}/threads/{thread}
            body["thread"] = {"name": thread_name}

        resp = await self._request("POST", url, params=params, json_data=body)
        if resp.status_code not in (200, 201):
            err = _format_google_error(resp)
            raise BridgeOperationError(
                f"Google Chat refused create_message in {space_name}: {err}"
            )
        return cast(dict[str, Any], resp.json())

    async def get_message(self, message_name: str) -> dict[str, Any]:
        """Get a message resource by name (spaces/{space}/messages/{msg})."""
        url = f"{self.chat_api_base}/{message_name}"
        resp = await self._request("GET", url)
        if resp.status_code != 200:
            err = _format_google_error(resp)
            raise BridgeOperationError(
                f"Google Chat could not fetch message {message_name}: {err}"
            )
        return cast(dict[str, Any], resp.json())

    async def patch_message(
        self,
        message_name: str,
        *,
        text: str | None = None,
        cards_v2: list[dict[str, Any]] | None = None,
        update_mask: str | None = None,
    ) -> dict[str, Any]:
        """Update an existing message or card in Google Chat."""
        url = f"{self.chat_api_base}/{message_name}"
        masks: list[str] = []
        body: dict[str, Any] = {}
        if text is not None:
            body["text"] = text
            masks.append("text")
        if cards_v2 is not None:
            body["cardsV2"] = cards_v2
            masks.append("cards_v2")

        if not update_mask:
            update_mask = ",".join(masks)

        resp = await self._request(
            "PATCH",
            url,
            params={"updateMask": update_mask},
            json_data=body,
        )
        if resp.status_code != 200:
            err = _format_google_error(resp)
            raise BridgeOperationError(
                f"Google Chat refused patch_message for {message_name}: {err}"
            )
        return cast(dict[str, Any], resp.json())

    async def delete_message(self, message_name: str) -> None:
        """Delete a message posted by the bot in Google Chat."""
        url = f"{self.chat_api_base}/{message_name}"
        resp = await self._request("DELETE", url)
        if resp.status_code not in (200, 204):
            err = _format_google_error(resp)
            raise BridgeOperationError(
                f"Google Chat refused delete_message for {message_name}: {err}"
            )

    async def download_media(
        self,
        resource_name: str,
        max_bytes: int = 20 * 1024 * 1024,
    ) -> bytes:
        """Download native Google Chat media attachment while enforcing byte ceiling."""
        url = f"{self.chat_api_base}/media/{resource_name}?alt=media"
        token = await self.auth_manager.get_service_account_token()
        headers = {"Authorization": f"Bearer {token}"}

        chunks: list[bytes] = []
        total_bytes = 0

        try:
            async with self._http_client.stream("GET", url, headers=headers) as resp:
                if resp.status_code != 200:
                    err = _format_google_error(resp)
                    raise BridgeOperationError(
                        f"Failed to download Chat media {resource_name}: {err}"
                    )
                async for chunk in resp.aiter_bytes():
                    total_bytes += len(chunk)
                    if total_bytes > max_bytes:
                        raise ValueError(
                            f"Attachment exceeds maximum allowed size ({max_bytes} bytes)."
                        )
                    chunks.append(chunk)
        except ValueError:
            raise
        except Exception as exc:
            raise BridgeOperationError(
                f"Error while downloading Chat media {resource_name}: {exc}"
            ) from exc

        return b"".join(chunks)

    async def get_space(self, space_id: str) -> dict[str, Any]:
        """Fetch space details."""
        space_name = self._normalize_space_name(space_id)
        url = f"{self.chat_api_base}/{space_name}"
        resp = await self._request("GET", url)
        if resp.status_code != 200:
            err = _format_google_error(resp)
            raise BridgeOperationError(
                f"Google Chat could not fetch space {space_name}: {err}"
            )
        return cast(dict[str, Any], resp.json())

    async def list_spaces(self) -> list[dict[str, Any]]:
        """List spaces the bot is a member of."""
        url = f"{self.chat_api_base}/spaces"
        resp = await self._request("GET", url)
        if resp.status_code != 200:
            err = _format_google_error(resp)
            raise BridgeOperationError(f"Google Chat could not list spaces: {err}")
        data = cast(dict[str, Any], resp.json())
        return cast(list[dict[str, Any]], data.get("spaces", []))

    async def delete_membership(
        self, space_id: str, member_name: str = "users/app"
    ) -> None:
        """Remove membership (leave a space)."""
        space_name = self._normalize_space_name(space_id)
        url = f"{self.chat_api_base}/{space_name}/members/{member_name}"
        resp = await self._request("DELETE", url)
        if resp.status_code not in (200, 204):
            err = _format_google_error(resp)
            logger.warning(
                "Could not delete membership %s in %s: %s", member_name, space_name, err
            )

    # ── Google Workspace Events API ──────────────────────────────────────────────

    async def create_workspace_events_subscription(
        self,
        space_id: str,
        pubsub_topic: str,
        *,
        include_resource: bool = True,
    ) -> dict[str, Any]:
        """Create a Google Workspace Events space subscription for chat events."""
        space_name = self._normalize_space_name(space_id)
        target_resource = f"//chat.googleapis.com/{space_name}"
        url = f"{self.workspace_events_api_base}/subscriptions"
        event_types = [
            "google.workspace.chat.message.v1.created",
            "google.workspace.chat.membership.v1.created",
        ]
        body: dict[str, Any] = {
            "targetResource": target_resource,
            "eventTypes": event_types,
            "notificationEndpoint": {
                "pubsubTopic": pubsub_topic,
            },
            "payloadOptions": {
                "includeResource": include_resource,
            },
        }
        resp = await self._request("POST", url, use_user_oauth=True, json_data=body)
        if resp.status_code not in (200, 201):
            err = _format_google_error(resp)
            raise BridgeOperationError(
                f"Failed to create Workspace Events subscription for {space_name}: {err}"
            )
        return cast(dict[str, Any], resp.json())

    async def patch_workspace_events_subscription_ttl(
        self,
        subscription_name: str,
        ttl_seconds: int = 14400,
    ) -> dict[str, Any]:
        """Renew a Google Workspace Events subscription TTL before expiration."""
        url = f"{self.workspace_events_api_base}/{subscription_name}"
        body = {"ttl": f"{ttl_seconds}s"}
        resp = await self._request(
            "PATCH",
            url,
            use_user_oauth=True,
            params={"updateMask": "ttl"},
            json_data=body,
        )
        if resp.status_code != 200:
            err = _format_google_error(resp)
            raise BridgeOperationError(
                f"Failed to renew Workspace Events subscription {subscription_name}: {err}"
            )
        return cast(dict[str, Any], resp.json())

    async def delete_workspace_events_subscription(
        self, subscription_name: str
    ) -> None:
        """Delete a Workspace Events subscription."""
        url = f"{self.workspace_events_api_base}/{subscription_name}"
        resp = await self._request("DELETE", url, use_user_oauth=True)
        if resp.status_code not in (200, 204):
            err = _format_google_error(resp)
            logger.warning(
                "Failed to delete Workspace Events subscription %s: %s",
                subscription_name,
                err,
            )
