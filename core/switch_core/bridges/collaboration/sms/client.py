"""A thin client for the parts of Twilio's REST API the SMS bridge uses.

Sending a message, fetching what a person sent, and reading the account and
phone number back to check the credentials. Nothing here knows about Switch: it
turns a Twilio call into a value or a `TwilioError`, and the adapter decides
what either means for a room.

The `httpx.AsyncClient` is handed in, so the bridge owns its lifetime and a
test can put a `MockTransport` under it.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

API_HOST = "api.twilio.com"
API_URL = f"https://{API_HOST}/2010-04-01"

#: The person has opted out by texting STOP, so Twilio will not message them.
OPTED_OUT = 21610

_MAX_MEDIA_REDIRECTS = 3

_PHONE_NUMBER = re.compile(r"\+?\d[\d ().-]{5,}\d")

_ERROR_DOCS = "https://www.twilio.com/docs/api/errors"

# A delivery report carries only a code, so the common ones are spelled out here.
DELIVERY_ERRORS = {
    "30003": "the phone is unreachable",
    "30004": "the message was blocked",
    "30005": "the number is unknown or inactive",
    "30006": "a landline, or a carrier that can't be reached",
    "30007": "the carrier filtered the message",
    "30008": "the carrier gave no reason",
    "30032": "the toll-free number isn't verified",
    "30034": "the number isn't registered for A2P 10DLC",
}


def error_page(code: object) -> str:
    """The page in Twilio's docs for this error code."""
    return f"{_ERROR_DOCS}/{code}" if code else _ERROR_DOCS


class TwilioError(Exception):
    """Twilio refused a call.

    `code` is Twilio's error code, which is what its docs say to branch on.
    `message` is Twilio's own words, which can quote a phone number, so `str()`,
    and with it every log, shows them with the number masked. The link comes
    last so that nothing runs into it when a terminal makes it clickable.
    """

    def __init__(self, *, status: int, code: int | None, message: str) -> None:
        masked = _PHONE_NUMBER.sub(lambda m: f"...{m.group()[-4:]}", message)
        super().__init__(
            f"{masked} (HTTP {status}, code {code}). See {error_page(code)}"
            if code is not None
            else f"{masked} (HTTP {status})"
        )
        self.status = status
        self.code = code
        self.message = message


class MediaTooLarge(Exception):
    """A file is over the size the caller will take."""


class MediaRefused(Exception):
    """A media address is not one Twilio's credentials should be sent to, or
    it redirected too many times."""


def twilio_error(response: httpx.Response) -> TwilioError:
    """The `TwilioError` a failed response describes."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        body = {}
    code = body.get("code")
    return TwilioError(
        status=response.status_code,
        code=code if isinstance(code, int) else None,
        message=str(
            body.get("message") or f"Twilio answered HTTP {response.status_code}"
        ),
    )


class TwilioClient:
    """One account's calls to Twilio's REST API."""

    def __init__(
        self, *, http: httpx.AsyncClient, account_sid: str, auth_token: str
    ) -> None:
        self._http = http
        self._auth = httpx.BasicAuth(account_sid, auth_token)
        self._account_url = f"{API_URL}/Accounts/{account_sid}"

    def _json(self, response: httpx.Response) -> dict[str, Any]:
        if response.is_error:
            raise twilio_error(response)
        body = response.json()
        if not isinstance(body, dict):
            raise TwilioError(
                status=response.status_code,
                code=None,
                message="Twilio answered with something other than a JSON object",
            )
        return body

    async def account(self) -> dict[str, Any]:
        response = await self._http.get(f"{self._account_url}.json", auth=self._auth)
        return self._json(response)

    async def incoming_number(self, phone_number: str) -> dict[str, Any] | None:
        """The account's record of this number, or None if it doesn't own it.

        Twilio's filter also matches part of a number, so the answer is checked
        for the whole of it.
        """
        response = await self._http.get(
            f"{self._account_url}/IncomingPhoneNumbers.json",
            params={"PhoneNumber": phone_number},
            auth=self._auth,
        )
        numbers = self._json(response).get("incoming_phone_numbers") or []
        number: dict[str, Any]
        for number in numbers:
            if number.get("phone_number") == phone_number:
                return number
        return None

    async def send_message(
        self, *, from_number: str, to: str, body: str, status_callback: str
    ) -> str:
        """Send one message and return its SID. Twilio may bill it as several
        segments. `SmartEncoded` swaps curly quotes and the like for plain ones,
        which keeps a message in the cheaper GSM-7 encoding."""
        response = await self._http.post(
            f"{self._account_url}/Messages.json",
            data={
                "From": from_number,
                "To": to,
                "Body": body,
                "SmartEncoded": "true",
                "StatusCallback": status_callback,
            },
            auth=self._auth,
        )
        return str(self._json(response)["sid"])

    async def download_media(self, url: str, *, max_bytes: int) -> bytes:
        """Fetch a file a person sent.

        Twilio's credentials go only to Twilio's own API host over https. It
        may redirect to a storage host, which is followed without them.
        """
        for _ in range(_MAX_MEDIA_REDIRECTS + 1):
            parts = urlsplit(url)
            if parts.scheme != "https":
                raise MediaRefused(f"Media address is not https: {parts.scheme}")
            auth = self._auth if parts.hostname == API_HOST else None
            async with self._http.stream("GET", url, auth=auth) as response:
                if response.is_redirect:
                    url = urljoin(url, response.headers["location"])
                    continue
                if response.is_error:
                    await response.aread()
                    raise twilio_error(response)
                declared = response.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > max_bytes:
                    raise MediaTooLarge(f"{declared} bytes")
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > max_bytes:
                        raise MediaTooLarge(f"over {max_bytes} bytes")
                return bytes(content)
        raise MediaRefused("Media address redirected too many times")
