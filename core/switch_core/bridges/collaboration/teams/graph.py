from __future__ import annotations

import logging
from typing import Any

import httpx

from switch_core.bridges.collaboration.models import BridgeOperationError
from switch_core.bridges.collaboration.teams.auth import TeamsTokenProvider

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class GraphError(BridgeOperationError):
    """A Microsoft Graph REST call returned a non-success status."""


def _graph_error(operation: str, resp: httpx.Response) -> GraphError:
    """A ``GraphError`` for a failed call, leading with Graph's own explanation.

    Graph answers a refusal with ``{"error": {"code", "message"}}``, and that
    message is the only part anyone can act on — it names the permission that
    was not consented, the host it could not resolve, the value it would not
    take. Passing the raw body on instead buries it in JSON, and the raw body is
    what reaches the operator once this becomes an API response.

    A body that is not that shape is passed through verbatim: better an
    unfriendly error that is true than a tidy one that guesses.
    """
    detail = resp.text
    try:
        error = resp.json()["error"]
        message = str(error["message"])
        code = str(error.get("code") or "").strip()
        detail = f"{code}: {message}" if code else message
    except (ValueError, KeyError, TypeError):
        pass
    return GraphError(f"{operation} failed ({resp.status_code}): {detail}")


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
            raise _graph_error(f"create subscription for {resource}", resp)
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
            raise _graph_error(f"renew subscription {subscription_id}", resp)

    async def delete_subscription(self, *, subscription_id: str) -> None:
        resp = await self._http.delete(
            f"{GRAPH_BASE}/subscriptions/{subscription_id}",
            headers=await self._headers(),
        )
        if resp.status_code >= 300 and resp.status_code != 404:
            raise _graph_error(f"delete subscription {subscription_id}", resp)

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        resp = await self._http.get(
            f"{GRAPH_BASE}/subscriptions", headers=await self._headers()
        )
        if resp.status_code >= 300:
            raise _graph_error("list subscriptions", resp)
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
            raise _graph_error(
                f"create channel '{display_name}' in team {team_id}", resp
            )
        result: dict[str, Any] = resp.json()
        return result

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        resp = await self._http.get(
            f"{GRAPH_BASE}/teams/{team_id}/channels/{channel_id}",
            headers=await self._headers(),
        )
        if resp.status_code >= 300:
            raise _graph_error(f"get channel {channel_id}", resp)
        result: dict[str, Any] = resp.json()
        return result

    async def search_users(self, *, query: str, top: int = 25) -> list[dict[str, Any]]:
        """Search the directory for people whose name, handle or mail matches.

        Uses `$search` over the `users` collection, which needs the
        ConsistencyLevel header. Returns the raw Graph user objects.
        """
        escaped = query.replace('"', '\\"')
        headers = await self._headers()
        headers["ConsistencyLevel"] = "eventual"
        resp = await self._http.get(
            f"{GRAPH_BASE}/users",
            params={
                "$search": f'"displayName:{escaped}" OR "mail:{escaped}"',
                "$select": "id,displayName,userPrincipalName,mail",
                "$top": str(top),
            },
            headers=headers,
        )
        if resp.status_code >= 300:
            raise _graph_error(f"user search for {query!r}", resp)
        payload: dict[str, Any] = resp.json()
        users: list[dict[str, Any]] = payload.get("value", []) or []
        return users

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
            raise _graph_error(
                f"add member {user_aad_id} to channel {channel_id}", resp
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
            raise _graph_error(f"add member {user_aad_id} to team {team_id}", resp)
