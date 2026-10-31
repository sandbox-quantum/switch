from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx


class TwilioApiError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class TwilioClient:
    API = "https://api.twilio.com"

    def __init__(
        self,
        *,
        account_sid: str,
        auth_token: str,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.account_sid = account_sid
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(
            auth=httpx.BasicAuth(account_sid, auth_token),
            timeout=20,
            trust_env=False,
        )

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        data: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        response = await self._http.request(
            method, f"{self.API}{path}", params=params, data=data
        )
        if response.is_error:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            raise TwilioApiError(
                response.status_code,
                str(
                    payload.get("message")
                    or f"Twilio returned HTTP {response.status_code}"
                ),
            )
        payload = response.json()
        if not isinstance(payload, dict):
            raise TwilioApiError(502, "Twilio returned an invalid response")
        return payload

    async def verify_account(self) -> None:
        await self._request(
            "GET", f"/2010-04-01/Accounts/{quote(self.account_sid, safe='')}.json"
        )

    async def phone_number_sid(self, phone_number: str) -> str:
        payload = await self._request(
            "GET",
            f"/2010-04-01/Accounts/{quote(self.account_sid, safe='')}/IncomingPhoneNumbers.json",
            params={"PhoneNumber": phone_number, "PageSize": "1"},
        )
        numbers = payload.get("incoming_phone_numbers")
        if not isinstance(numbers, list) or not numbers:
            raise TwilioApiError(404, f"{phone_number} does not belong to this account")
        sid = numbers[0].get("sid") if isinstance(numbers[0], dict) else None
        if not isinstance(sid, str) or not sid:
            raise TwilioApiError(502, "Twilio returned no phone-number SID")
        return sid

    async def set_sms_webhook(self, phone_sid: str, webhook_url: str) -> None:
        await self._request(
            "POST",
            f"/2010-04-01/Accounts/{quote(self.account_sid, safe='')}/IncomingPhoneNumbers/{quote(phone_sid, safe='')}.json",
            data={"SmsUrl": webhook_url, "SmsMethod": "POST"},
        )

    async def send_sms(self, *, sender: str, recipient: str, body: str) -> str:
        payload = await self._request(
            "POST",
            f"/2010-04-01/Accounts/{quote(self.account_sid, safe='')}/Messages.json",
            data={"From": sender, "To": recipient, "Body": body},
        )
        sid = payload.get("sid")
        if not isinstance(sid, str) or not sid:
            raise TwilioApiError(502, "Twilio returned no MessageSid")
        return sid

    async def download(self, url: str) -> tuple[bytes, str | None]:
        response = await self._http.get(url)
        if response.is_error:
            raise TwilioApiError(response.status_code, "Twilio media download failed")
        return response.content, response.headers.get("content-type")
