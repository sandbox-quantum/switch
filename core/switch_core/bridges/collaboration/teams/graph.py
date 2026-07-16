from __future__ import annotations

import logging
from typing import Any

import httpx

from switch_core.bridges.collaboration.teams.auth import TeamsTokenProvider

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class GraphError(RuntimeError):
    """A Microsoft Graph REST call returned a non-success status."""


class GraphClient:
    """Async client for the Microsoft Graph endpoints the Teams bridge needs:
    change-notification subscriptions (this phase) and, later, channel/user
    provisioning. Every call carries an app-only Graph token."""

    def __init__(self, *, tokens: TeamsTokenProvider, http: httpx.AsyncClient) -> None:
        self._tokens = tokens
        self._http = http

    async def _headers(self) -> dict[str, str]:
        token = await self._tokens.graph_token()
        return {"Authorization": f"Bearer {token}"}

    async def create_subscription(
        self,
        *,
        resource: str,
        notification_url: str,
        lifecycle_notification_url: str,
        client_state: str,
        expiration_iso: str,
        encryption_certificate: str,
        encryption_certificate_id: str,
    ) -> dict[str, Any]:
        """Create a change-notification subscription with resource data.

        Channel-message subscriptions must include an encryption certificate
        (Graph encrypts the message body) and, because their lifetime exceeds an
        hour's worth of renewals, a lifecycle notification URL.
        """
        body = {
            "changeType": "created,updated",
            "notificationUrl": notification_url,
            "lifecycleNotificationUrl": lifecycle_notification_url,
            "resource": resource,
            "includeResourceData": True,
            "encryptionCertificate": encryption_certificate,
            "encryptionCertificateId": encryption_certificate_id,
            "clientState": client_state,
            "expirationDateTime": expiration_iso,
        }
        resp = await self._http.post(
            f"{GRAPH_BASE}/subscriptions", json=body, headers=await self._headers()
        )
        if resp.status_code >= 300:
            raise GraphError(
                f"create subscription for {resource} failed "
                f"({resp.status_code}): {resp.text}"
            )
        result: dict[str, Any] = resp.json()
        return result

    async def renew_subscription(
        self, *, subscription_id: str, expiration_iso: str
    ) -> None:
        resp = await self._http.patch(
            f"{GRAPH_BASE}/subscriptions/{subscription_id}",
            json={"expirationDateTime": expiration_iso},
            headers=await self._headers(),
        )
        if resp.status_code >= 300:
            raise GraphError(
                f"renew subscription {subscription_id} failed "
                f"({resp.status_code}): {resp.text}"
            )

    async def delete_subscription(self, *, subscription_id: str) -> None:
        resp = await self._http.delete(
            f"{GRAPH_BASE}/subscriptions/{subscription_id}",
            headers=await self._headers(),
        )
        if resp.status_code >= 300 and resp.status_code != 404:
            raise GraphError(
                f"delete subscription {subscription_id} failed "
                f"({resp.status_code}): {resp.text}"
            )

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        resp = await self._http.get(
            f"{GRAPH_BASE}/subscriptions", headers=await self._headers()
        )
        if resp.status_code >= 300:
            raise GraphError(
                f"list subscriptions failed ({resp.status_code}): {resp.text}"
            )
        value: list[dict[str, Any]] = resp.json().get("value", [])
        return value

    # ── Provisioning ─────────────────────────────────────────────────────────

    async def create_channel(
        self,
        *,
        team_id: str,
        display_name: str,
        description: str,
        membership_type: str,
    ) -> dict[str, Any]:
        """Create a channel in a team. ``membership_type`` is ``standard`` or
        ``private``. Returns the created channel (with its ``id``)."""
        body = {
            "displayName": display_name,
            "description": description,
            "membershipType": membership_type,
        }
        resp = await self._http.post(
            f"{GRAPH_BASE}/teams/{team_id}/channels",
            json=body,
            headers=await self._headers(),
        )
        if resp.status_code >= 300:
            raise GraphError(
                f"create channel '{display_name}' in team {team_id} failed "
                f"({resp.status_code}): {resp.text}"
            )
        result: dict[str, Any] = resp.json()
        return result

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        resp = await self._http.get(
            f"{GRAPH_BASE}/teams/{team_id}/channels/{channel_id}",
            headers=await self._headers(),
        )
        if resp.status_code >= 300:
            raise GraphError(
                f"get channel {channel_id} failed ({resp.status_code}): {resp.text}"
            )
        result: dict[str, Any] = resp.json()
        return result

    async def add_channel_member(
        self, *, team_id: str, channel_id: str, user_aad_id: str
    ) -> None:
        """Add an AAD user to a private channel's membership."""
        body = {
            "@odata.type": "#microsoft.graph.aadUserConversationMember",
            "roles": [],
            "user@odata.bind": (f"{GRAPH_BASE}/users('{user_aad_id}')"),
        }
        resp = await self._http.post(
            f"{GRAPH_BASE}/teams/{team_id}/channels/{channel_id}/members",
            json=body,
            headers=await self._headers(),
        )
        if resp.status_code >= 300 and resp.status_code != 409:
            raise GraphError(
                f"add member {user_aad_id} to channel {channel_id} failed "
                f"({resp.status_code}): {resp.text}"
            )

    async def add_team_member(self, *, team_id: str, user_aad_id: str) -> None:
        """Add an AAD user to a team (so they can see its standard channels)."""
        body = {
            "@odata.type": "#microsoft.graph.aadUserConversationMember",
            "roles": [],
            "user@odata.bind": (f"{GRAPH_BASE}/users('{user_aad_id}')"),
        }
        resp = await self._http.post(
            f"{GRAPH_BASE}/teams/{team_id}/members",
            json=body,
            headers=await self._headers(),
        )
        if resp.status_code >= 300 and resp.status_code != 409:
            raise GraphError(
                f"add member {user_aad_id} to team {team_id} failed "
                f"({resp.status_code}): {resp.text}"
            )
