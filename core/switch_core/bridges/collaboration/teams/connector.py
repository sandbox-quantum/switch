from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from switch_core.bridges.collaboration.teams.auth import TeamsTokenProvider

logger = logging.getLogger(__name__)

ACTIVITY_SIZE_LIMIT = 64 * 1024
"""Refuse an activity larger than this, measured as UTF-16 bytes.

Microsoft asks that a bot message stay within 80 KB and describes its own
ceiling of 100 KB as approximate, counted in UTF-16. Two readings of "80 KB"
are possible — bytes, or code units — so this sits below the smaller of them
with room to spare, and the count includes everything on the wire: the card,
the mention entities, and the body text repeated in `summary` and
`fallbackText`. Going over earns a 413 the sender cannot do anything useful
with; refusing here names the size instead.
"""


class BotConnectorError(RuntimeError):
    """A Bot Connector call did not do what was asked.

    The subclass is the part that matters. What a caller may conclude about
    the platform's state differs completely between "it said no" and "it never
    answered", and a single flattened error makes those indistinguishable —
    which is how a publication that may well have happened gets retried, or a
    reservation that nothing was written for gets discarded.
    """

    def __init__(
        self, message: str, *, status: int | None, retry_after: float | None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class BotConnectorRefused(BotConnectorError):
    """Teams answered and declined. Nothing was written."""


class BotConnectorGone(BotConnectorRefused):
    """The conversation or activity addressed does not exist."""


class BotConnectorThrottled(BotConnectorRefused):
    """Rate limited. `retry_after` is Teams' own answer where it gave one."""


class BotConnectorConflict(BotConnectorRefused):
    """The activity changed under the edit, which therefore did not apply."""


class BotConnectorUnavailable(BotConnectorError):
    """Teams did not answer, or answered that it could not say.

    The outcome is unknown: the message may exist. A caller holding a
    reservation for it must keep it rather than treat this as a refusal.
    """


class BotConnectorUnaddressable(BotConnectorError):
    """Teams accepted the activity but returned no id for it.

    The message is presumed to exist and cannot be edited or deleted, so this
    is not a refusal either — the same uncertain outcome reached by a different
    route.
    """


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("Retry-After")
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        logger.warning(
            "Teams sent a Retry-After this cannot read (%r); backing off on our "
            "own schedule instead",
            raw,
        )
        return None


def _failure(operation: str, resp: httpx.Response) -> BotConnectorError:
    status = resp.status_code
    detail = f"{operation} failed ({status}): {resp.text}"
    if status == 429:
        return BotConnectorThrottled(
            detail, status=status, retry_after=_retry_after(resp)
        )
    if status == 412:
        return BotConnectorConflict(detail, status=status, retry_after=None)
    if status == 404:
        return BotConnectorGone(detail, status=status, retry_after=None)
    if status == 408:
        # A timeout reported as a status is still a timeout: Teams may have
        # done the work and given up on saying so.
        return BotConnectorUnavailable(detail, status=status, retry_after=None)
    if 400 <= status < 500:
        return BotConnectorRefused(detail, status=status, retry_after=None)
    return BotConnectorUnavailable(detail, status=status, retry_after=None)


def _payload(operation: str, body: dict[str, Any]) -> bytes:
    text = json.dumps(body, ensure_ascii=False)
    measured = len(text.encode("utf-16-le"))
    if measured > ACTIVITY_SIZE_LIMIT:
        raise BotConnectorRefused(
            f"{operation} was not attempted: the activity is {measured} bytes of "
            f"UTF-16 and Teams accepts up to about {ACTIVITY_SIZE_LIMIT}.",
            status=None,
            retry_after=None,
        )
    return text.encode()


class BotConnectorClient:
    """Thin async client over the Bot Framework Connector REST API.

    The connector is reached at the per-tenant ``serviceUrl`` carried on inbound
    activities (regional, e.g. ``https://smba.trafficmanager.net/amer/``). Every
    call is authorised with an app-only Bot Connector token from the shared
    token provider.

    Every failure leaves here as a `BotConnectorError` saying which kind it was,
    including a transport failure: an `httpx` exception escaping raw would reach
    callers that have no way to tell it from a refusal.
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

    async def _call(
        self,
        *,
        operation: str,
        method: str,
        url: str,
        body: dict[str, Any] | None,
    ) -> httpx.Response:
        headers = await self._headers()
        content: bytes | None = None
        if body is not None:
            # Serialised once, so the bytes the guard measured are the bytes
            # that go out.
            content = _payload(operation, body)
            headers["Content-Type"] = "application/json"
        try:
            resp = await self._http.request(
                method, url, content=content, headers=headers
            )
        except httpx.HTTPError as error:
            raise BotConnectorUnavailable(
                f"{operation} did not complete: {error}",
                status=None,
                retry_after=None,
            ) from error
        if resp.status_code >= 300:
            raise _failure(operation, resp)
        return resp

    @staticmethod
    def _identifier(operation: str, resp: httpx.Response, field: str) -> str:
        try:
            data = resp.json()
        except ValueError as error:
            raise BotConnectorUnaddressable(
                f"{operation} was accepted ({resp.status_code}) but the response "
                f"was not JSON, so the message it wrote cannot be addressed again.",
                status=resp.status_code,
                retry_after=None,
            ) from error
        value = data.get(field) if isinstance(data, dict) else None
        if not value:
            raise BotConnectorUnaddressable(
                f"{operation} was accepted ({resp.status_code}) but returned no "
                f"{field}, so the message it wrote cannot be edited or deleted.",
                status=resp.status_code,
                retry_after=None,
            )
        return str(value)

    async def create_channel_thread(
        self, *, service_url: str, channel_id: str, activity: dict[str, Any]
    ) -> tuple[str, str]:
        """Start a new thread in a Teams channel with ``activity``.

        Returns ``(conversation_id, activity_id)`` — the new thread's
        conversation id and the posted message's id (its thread root).
        """
        operation = f"Starting a thread in Teams channel {channel_id}"
        resp = await self._call(
            operation=operation,
            method="POST",
            url=f"{self._base(service_url)}v3/conversations",
            body={
                "isGroup": True,
                "channelData": {"channel": {"id": channel_id}},
                "activity": activity,
            },
        )
        return (
            self._identifier(operation, resp, "id"),
            self._identifier(operation, resp, "activityId"),
        )

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        """Post ``activity`` to an existing conversation; return its message id."""
        operation = f"Sending to Teams conversation {conversation_id}"
        resp = await self._call(
            operation=operation,
            method="POST",
            url=(
                f"{self._base(service_url)}v3/conversations/"
                f"{conversation_id}/activities"
            ),
            body=activity,
        )
        return self._identifier(operation, resp, "id")

    async def send_signal(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> None:
        """Post an activity nothing will ever address again, such as typing.

        Separate from `send_to_conversation` because that one treats a missing
        id as a fault, and an ephemeral activity is not required to have one.
        """
        await self._call(
            operation=f"Signalling Teams conversation {conversation_id}",
            method="POST",
            url=(
                f"{self._base(service_url)}v3/conversations/"
                f"{conversation_id}/activities"
            ),
            body=activity,
        )

    async def update_activity(
        self,
        *,
        service_url: str,
        conversation_id: str,
        activity_id: str,
        activity: dict[str, Any],
    ) -> None:
        await self._call(
            operation=f"Updating Teams activity {activity_id}",
            method="PUT",
            url=(
                f"{self._base(service_url)}v3/conversations/"
                f"{conversation_id}/activities/{activity_id}"
            ),
            body=activity,
        )

    async def delete_activity(
        self, *, service_url: str, conversation_id: str, activity_id: str
    ) -> None:
        await self._call(
            operation=f"Deleting Teams activity {activity_id}",
            method="DELETE",
            url=(
                f"{self._base(service_url)}v3/conversations/"
                f"{conversation_id}/activities/{activity_id}"
            ),
            body=None,
        )
