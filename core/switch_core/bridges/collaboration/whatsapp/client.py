"""The few WhatsApp Cloud API calls the adapter makes, over Meta's Graph API.

Every Graph call carries the access token and `appsecret_proof`, the HMAC of
that token keyed by the app secret. A token copied out of this deployment is
then useless to anyone without the secret too, and an app set to "Require App
Secret" accepts nothing else.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import Any

import httpx

GRAPH_VERSION = "v26.0"
GRAPH_ROOT = f"https://graph.facebook.com/{GRAPH_VERSION}"

# The longest Meta may go quiet mid-response, a media download included.
_TIMEOUT = httpx.Timeout(60.0, connect=10.0)

# Where Meta serves media from. The address comes from Graph's own answer,
# and the access token is sent to it, so nothing else is fetched.
_MEDIA_HOSTS = (".fbsbx.com", ".facebook.com", ".whatsapp.net")

# Graph's codes for a token that is invalid, expired or revoked.
_CREDENTIAL_CODES = frozenset({0, 102, 190})
# "More than 24 hours have passed since the recipient last replied."
WINDOW_CLOSED_CODE = 131047


class WhatsAppApiError(Exception):
    """Meta refused a call, with its own code and explanation."""

    def __init__(
        self, *, status: int, code: int | None, subcode: int | None, message: str
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.subcode = subcode

    @property
    def credentials_rejected(self) -> bool:
        return self.code in _CREDENTIAL_CODES

    @property
    def window_closed(self) -> bool:
        return self.code == WINDOW_CLOSED_CODE


class MediaTooLarge(Exception):
    """A media download ran past the size it was allowed."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"larger than {limit} bytes")
        self.limit = limit


@dataclass(frozen=True)
class Media:
    url: str
    mimetype: str | None
    size: int | None


def new_http() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=_TIMEOUT)


def appsecret_proof(access_token: str, app_secret: str) -> str:
    return hmac.new(
        app_secret.encode(), access_token.encode(), hashlib.sha256
    ).hexdigest()


async def inspect_token(
    http: httpx.AsyncClient, *, access_token: str, app_id: str, app_secret: str
) -> dict[str, Any]:
    """What Meta knows about `access_token`, asked as the app itself.

    The app's own token (`app_id|app_secret`) is what `debug_token` takes, so
    one call proves the secret belongs to the app and says which app issued the
    access token and with which permissions.
    """
    response = await http.get(
        f"{GRAPH_ROOT}/debug_token",
        params={"input_token": access_token},
        headers={"Authorization": f"Bearer {app_id}|{app_secret}"},
    )
    data = _json_or_raise(response).get("data")
    if not isinstance(data, dict):
        raise WhatsAppApiError(
            status=response.status_code,
            code=None,
            subcode=None,
            message="Meta's token check returned no data.",
        )
    return data


class CloudApi:
    def __init__(
        self,
        *,
        http: httpx.AsyncClient,
        access_token: str,
        app_secret: str,
        phone_number_id: str,
    ) -> None:
        self._http = http
        self._auth = {"Authorization": f"Bearer {access_token}"}
        self._proof = {"appsecret_proof": appsecret_proof(access_token, app_secret)}
        self._number = f"{GRAPH_ROOT}/{phone_number_id}"

    async def aclose(self) -> None:
        await self._http.aclose()

    async def phone_number(self) -> dict[str, Any]:
        return await self._get(
            self._number, {"fields": "display_phone_number,verified_name"}
        )

    async def send(self, message: dict[str, Any]) -> str:
        """Send one message and return its `wamid`."""
        body = {"messaging_product": "whatsapp", "recipient_type": "individual"}
        response = await self._http.post(
            f"{self._number}/messages",
            params=self._proof,
            headers=self._auth,
            json={**body, **message},
        )
        sent = _json_or_raise(response).get("messages")
        first = sent[0] if isinstance(sent, list) and sent else None
        if not isinstance(first, dict) or not first.get("id"):
            raise WhatsAppApiError(
                status=response.status_code,
                code=None,
                subcode=None,
                message="WhatsApp accepted the message but returned no message id.",
            )
        return str(first["id"])

    async def mark_read(self, message_id: str, *, typing: bool) -> None:
        """Mark an inbound message read, and show typing for up to 25 seconds."""
        body: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id,
        }
        if typing:
            body["typing_indicator"] = {"type": "text"}
        response = await self._http.post(
            f"{self._number}/messages",
            params=self._proof,
            headers=self._auth,
            json=body,
        )
        _json_or_raise(response)

    async def upload_media(self, *, filename: str, mimetype: str, data: bytes) -> str:
        response = await self._http.post(
            f"{self._number}/media",
            params=self._proof,
            headers=self._auth,
            data={"messaging_product": "whatsapp", "type": mimetype},
            files={"file": (filename, data, mimetype)},
        )
        media_id = _json_or_raise(response).get("id")
        if not media_id:
            raise WhatsAppApiError(
                status=response.status_code,
                code=None,
                subcode=None,
                message=f"WhatsApp accepted {filename} but returned no media id.",
            )
        return str(media_id)

    async def media(self, media_id: str) -> Media:
        """Where an inbound file can be fetched from, for the next five minutes."""
        found = await self._get(f"{GRAPH_ROOT}/{media_id}", {})
        url = httpx.URL(str(found.get("url") or ""))
        if url.scheme != "https" or not url.host.endswith(_MEDIA_HOSTS):
            raise WhatsAppApiError(
                status=200,
                code=None,
                subcode=None,
                message=f"Meta's media lookup named no WhatsApp media address "
                f"(got {url.host or 'none'}).",
            )
        size = found.get("file_size")
        mimetype = found.get("mime_type")
        return Media(
            url=str(url),
            mimetype=str(mimetype) if mimetype else None,
            size=int(str(size)) if str(size).isdigit() else None,
        )

    async def download(self, url: str, *, limit: int) -> bytes:
        """Fetch a media URL, stopping once it runs past `limit` bytes.

        Not a Graph call, so it takes no proof. Counted as it streams rather than
        trusted from the size Meta reported, which can be missing.
        """
        async with self._http.stream("GET", url, headers=self._auth) as response:
            if response.status_code != 200:
                raise WhatsAppApiError(
                    status=response.status_code,
                    code=None,
                    subcode=None,
                    message=f"WhatsApp refused the media download "
                    f"({response.status_code}).",
                )
            data = bytearray()
            async for part in response.aiter_bytes():
                data.extend(part)
                if len(data) > limit:
                    raise MediaTooLarge(limit)
        return bytes(data)

    async def _get(self, url: str, params: dict[str, str]) -> dict[str, Any]:
        response = await self._http.get(
            url, params={**params, **self._proof}, headers=self._auth
        )
        return _json_or_raise(response)


def _json_or_raise(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        body = None
    if not response.is_error and isinstance(body, dict):
        return body
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        raise WhatsAppApiError(
            status=response.status_code,
            code=None,
            subcode=None,
            message=f"WhatsApp answered {response.status_code} with no readable error.",
        )
    code = _int_or_none(error.get("code"))
    subcode = _int_or_none(error.get("error_subcode"))
    error_data = error.get("error_data")
    details = error_data.get("details") if isinstance(error_data, dict) else None
    message = str(error.get("message") or "WhatsApp refused the request.")
    if details:
        message = f"{message}: {details}"
    reference = ", ".join(
        f"{name} {value}"
        for name, value in (("code", code), ("subcode", subcode))
        if value is not None
    )
    raise WhatsAppApiError(
        status=response.status_code,
        code=code,
        subcode=subcode,
        message=f"{message} (Meta {reference})" if reference else message,
    )


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) else None
