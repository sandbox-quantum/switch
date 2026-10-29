"""A thin client for the parts of Meta's Graph API the WhatsApp bridge uses.

Sending, uploading and downloading media, and reading the phone number back to
check the credentials. Nothing here knows about Switch: it turns a Graph call
into a value or a `WhatsAppGraphError`, and the adapter decides what either
means for a room.

The `httpx.AsyncClient` is handed in, so the bridge owns its lifetime and a
test can put a `MockTransport` under it.
"""

from __future__ import annotations

from typing import Any

import httpx

#: The one Graph API version every call is made against. Meta retires a
#: version two years after it ships; moving off it is changing this line.
GRAPH_API_VERSION = "v26.0"
GRAPH_API_URL = f"https://graph.facebook.com/{GRAPH_API_VERSION}"

#: The access token was rejected: expired, revoked or never valid.
TOKEN_INVALID = 190
#: The person last wrote more than 24 hours ago, so only an approved template
#: may be sent until they write again.
REENGAGEMENT_REQUIRED = 131047


class WhatsAppGraphError(Exception):
    """Meta refused a Graph API call, in its own words.

    `code` is Meta's error code, which is what Meta says to branch on; `message`
    and `details` are its explanation, carried so an operator reads what the
    platform said rather than a status line.
    """

    def __init__(
        self,
        *,
        status: int,
        code: int | None,
        error_type: str | None,
        message: str,
        details: str | None,
    ) -> None:
        super().__init__(f"{message} (code {code})" if code is not None else message)
        self.status = status
        self.code = code
        self.error_type = error_type
        self.message = message
        self.details = details


def graph_error(response: httpx.Response) -> WhatsAppGraphError:
    """The `WhatsAppGraphError` a failed Graph response describes."""
    try:
        body = response.json()
    except ValueError:
        body = None
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return WhatsAppGraphError(
            status=response.status_code,
            code=None,
            error_type=None,
            message=f"Graph API answered HTTP {response.status_code}",
            details=None,
        )
    error_data = error.get("error_data")
    details = error_data.get("details") if isinstance(error_data, dict) else None
    code = error.get("code")
    return WhatsAppGraphError(
        status=response.status_code,
        code=code if isinstance(code, int) else None,
        error_type=str(error["type"]) if error.get("type") else None,
        message=str(error.get("message") or f"HTTP {response.status_code}"),
        details=str(details) if details else None,
    )


class WhatsAppGraphClient:
    """One business phone number's calls to the Graph API."""

    def __init__(
        self, *, http: httpx.AsyncClient, access_token: str, phone_number_id: str
    ) -> None:
        self._http = http
        self._access_token = access_token
        self._phone_number_id = phone_number_id

    @property
    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token}"}

    def _json(self, response: httpx.Response) -> dict[str, Any]:
        if response.is_error:
            raise graph_error(response)
        body = response.json()
        if not isinstance(body, dict):
            raise WhatsAppGraphError(
                status=response.status_code,
                code=None,
                error_type=None,
                message="Graph API answered with something other than an object",
                details=None,
            )
        return body

    async def phone_number(self, *, appsecret_proof: str) -> dict[str, Any]:
        """The phone number's display number and verified name.

        `appsecret_proof` is the access token signed with the app secret.
        Graph refuses a call whose proof does not match, so a wrong app secret
        is caught here rather than as every webhook failing its signature.
        """
        response = await self._http.get(
            f"{GRAPH_API_URL}/{self._phone_number_id}",
            params={
                "fields": "display_phone_number,verified_name",
                "appsecret_proof": appsecret_proof,
            },
            headers=self._auth,
        )
        return self._json(response)

    async def send(self, payload: dict[str, Any]) -> str:
        """Post one message (or status) and return the `wamid` Meta gave it."""
        response = await self._http.post(
            f"{GRAPH_API_URL}/{self._phone_number_id}/messages",
            json={"messaging_product": "whatsapp", **payload},
            headers=self._auth,
        )
        body = self._json(response)
        messages = body.get("messages")
        if isinstance(messages, list) and messages and "id" in messages[0]:
            return str(messages[0]["id"])
        raise WhatsAppGraphError(
            status=response.status_code,
            code=None,
            error_type=None,
            message="Graph API accepted the message without returning its id",
            details=None,
        )

    async def mark_read(self, message_id: str, *, typing: bool) -> None:
        """Mark a received message read, and show the typing indicator with it.

        The typing indicator is tied to a received message and lasts until
        the next reply or 25 seconds, whichever is first.
        """
        payload: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id,
        }
        if typing:
            payload["typing_indicator"] = {"type": "text"}
        response = await self._http.post(
            f"{GRAPH_API_URL}/{self._phone_number_id}/messages",
            json=payload,
            headers=self._auth,
        )
        self._json(response)

    async def upload_media(self, *, filename: str, mimetype: str, data: bytes) -> str:
        """Upload a file and return the media id a message can carry."""
        response = await self._http.post(
            f"{GRAPH_API_URL}/{self._phone_number_id}/media",
            data={"messaging_product": "whatsapp", "type": mimetype},
            files={"file": (filename, data, mimetype)},
            headers=self._auth,
        )
        body = self._json(response)
        if "id" not in body:
            raise WhatsAppGraphError(
                status=response.status_code,
                code=None,
                error_type=None,
                message="Graph API accepted the upload without returning its id",
                details=None,
            )
        return str(body["id"])

    async def media_info(self, media_id: str) -> dict[str, Any]:
        """Where a received file can be downloaded from, its type and size.

        The URL it gives expires after five minutes, so it is fetched right
        before the download rather than kept.
        """
        response = await self._http.get(
            f"{GRAPH_API_URL}/{media_id}",
            params={"phone_number_id": self._phone_number_id},
            headers=self._auth,
        )
        return self._json(response)

    async def download(self, url: str, *, max_bytes: int) -> bytes:
        """The bytes at a media URL from `media_info`, refusing more than
        `max_bytes` without reading them all."""
        async with self._http.stream("GET", url, headers=self._auth) as response:
            if response.is_error:
                await response.aread()
                raise graph_error(response)
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise MediaTooLarge(len(data), max_bytes)
            return bytes(data)


class MediaTooLarge(Exception):
    """A download ran past the size it was allowed."""

    def __init__(self, size: int, limit: int) -> None:
        super().__init__(f"more than {size} bytes, over the {limit} byte limit")
        self.size = size
        self.limit = limit
