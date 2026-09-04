from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

import httpx

from switch_core.bridges.collaboration.teams.auth import TeamsTokenProvider

logger = logging.getLogger(__name__)


class BotConnectorError(RuntimeError):
    """A Bot Connector REST call returned a non-success status."""


class BotConnectorClient:
    """Thin async client over the Bot Framework Connector REST API.

    The connector is reached at the per-tenant ``serviceUrl`` carried on inbound
    activities (regional, e.g. ``https://smba.trafficmanager.net/amer/``). Every
    call is authorised with an app-only Bot Connector token from the shared
    token provider.
    """

    def __init__(self, *, tokens: TeamsTokenProvider, http: httpx.AsyncClient) -> None:
        self._tokens = tokens
        self._http = http

    async def _headers(self) -> dict[str, str]:
        token = await self._tokens.bot_token()
        return {"Authorization": f"Bearer {token}"}

    @staticmethod
    def _base(service_url: str) -> str:
        return service_url if service_url.endswith("/") else service_url + "/"

    async def create_channel_thread(
        self, *, service_url: str, channel_id: str, activity: dict[str, Any]
    ) -> tuple[str, str]:
        """Start a new thread in a Teams channel with ``activity``.

        Returns ``(conversation_id, activity_id)`` — the new thread's
        conversation id and the posted message's id (its thread root).
        """
        url = f"{self._base(service_url)}v3/conversations"
        body = {
            "isGroup": True,
            "channelData": {"channel": {"id": channel_id}},
            "activity": activity,
        }
        resp = await self._http.post(url, json=body, headers=await self._headers())
        if resp.status_code >= 300:
            raise BotConnectorError(
                f"create conversation in {channel_id} failed "
                f"({resp.status_code}): {resp.text}"
            )
        data = resp.json()
        conversation_id = str(data.get("id") or channel_id)
        activity_id = str(data.get("activityId") or data.get("id") or "")
        return conversation_id, activity_id

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        """Post ``activity`` to an existing conversation; return its message id."""
        url = f"{self._base(service_url)}v3/conversations/{conversation_id}/activities"
        resp = await self._http.post(url, json=activity, headers=await self._headers())
        if resp.status_code >= 300:
            raise BotConnectorError(
                f"send to conversation {conversation_id} failed "
                f"({resp.status_code}): {resp.text}"
            )
        return str(resp.json().get("id", ""))

    async def update_activity(
        self,
        *,
        service_url: str,
        conversation_id: str,
        activity_id: str,
        activity: dict[str, Any],
    ) -> None:
        url = (
            f"{self._base(service_url)}v3/conversations/"
            f"{conversation_id}/activities/{activity_id}"
        )
        resp = await self._http.put(url, json=activity, headers=await self._headers())
        if resp.status_code >= 300:
            raise BotConnectorError(
                f"update activity {activity_id} failed "
                f"({resp.status_code}): {resp.text}"
            )

    async def delete_activity(
        self, *, service_url: str, conversation_id: str, activity_id: str
    ) -> None:
        url = (
            f"{self._base(service_url)}v3/conversations/"
            f"{conversation_id}/activities/{activity_id}"
        )
        resp = await self._http.delete(url, headers=await self._headers())
        if resp.status_code >= 300:
            raise BotConnectorError(
                f"delete activity {activity_id} failed "
                f"({resp.status_code}): {resp.text}"
            )

    def _reaction_url(
        self, service_url: str, conversation_id: str, activity_id: str, reaction: str
    ) -> str:
        return (
            f"{self._base(service_url)}v3/conversations/"
            f"{conversation_id}/activities/{activity_id}/reactions/"
            f"{quote(reaction, safe='')}"
        )

    async def add_reaction(
        self,
        *,
        service_url: str,
        conversation_id: str,
        activity_id: str,
        reaction: str,
    ) -> None:
        """Put ``reaction`` on a message, as the bot.

        The reaction id is a path segment and the body is empty. Teams serves
        this off the same regional connector host and app-only token as sending
        a message, so it needs no Graph permission and no delegated user — but
        it carries no page in the Bot Connector REST reference, and a tenant
        whose Teams service has not shipped it answers 404. Callers treat a
        failure as cosmetic.
        """
        url = self._reaction_url(service_url, conversation_id, activity_id, reaction)
        resp = await self._http.put(url, headers=await self._headers())
        if resp.status_code >= 300:
            raise BotConnectorError(
                f"add reaction {reaction} to {activity_id} failed "
                f"({resp.status_code}): {resp.text}"
            )

    async def remove_reaction(
        self,
        *,
        service_url: str,
        conversation_id: str,
        activity_id: str,
        reaction: str,
    ) -> None:
        """Take the bot's own ``reaction`` back off a message."""
        url = self._reaction_url(service_url, conversation_id, activity_id, reaction)
        resp = await self._http.delete(url, headers=await self._headers())
        if resp.status_code >= 300:
            raise BotConnectorError(
                f"remove reaction {reaction} from {activity_id} failed "
                f"({resp.status_code}): {resp.text}"
            )
