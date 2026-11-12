from __future__ import annotations

import math
from email.message import Message
from typing import Any
from urllib.parse import quote

import httpx

from switch_core.bridges.collaboration.models import (
    Attachment,
    BridgeCredentialError,
    BridgeOperationError,
)

API_ROOT = "https://webexapis.com/v1/"


class WebexError(BridgeOperationError):
    def __init__(self, status: int, retry_after: float) -> None:
        super().__init__(f"Webex refused the operation (HTTP {status}).")
        self.status = status
        self.retry_after = retry_after


def resource_path(resource: str, identifier: str) -> str:
    return f"{resource}/{quote(identifier, safe='')}"


class WebexClient:
    def __init__(self, http: httpx.AsyncClient, token: str) -> None:
        self.http = http
        self._token = token

    @staticmethod
    def check(response: httpx.Response) -> None:
        if response.status_code == 401:
            raise BridgeCredentialError(
                "Webex rejected the bot access token. Create or regenerate a bot token in Webex for Developers."
            )
        if response.is_error:
            wait = response.headers.get("retry-after", "1")
            try:
                retry_after = max(1.0, float(wait))
            except ValueError:
                retry_after = 1.0
            if not math.isfinite(retry_after):
                retry_after = 1.0
            raise WebexError(response.status_code, retry_after)

    async def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = await self.http.request(
            method,
            API_ROOT + path,
            headers={"Authorization": f"Bearer {self._token}"},
            **kwargs,
        )
        self.check(response)
        if not response.content:
            return {}
        result = response.json()
        if not isinstance(result, dict):
            raise BridgeOperationError("Webex returned an invalid API response.")
        return result

    async def items(self, resource: str, **params: str) -> list[dict[str, Any]]:
        url = httpx.URL(API_ROOT + resource, params={**params, "max": "100"})
        result: list[dict[str, Any]] = []
        seen: set[str] = set()
        while str(url) not in seen:
            seen.add(str(url))
            response = await self.http.get(
                url, headers={"Authorization": f"Bearer {self._token}"}
            )
            self.check(response)
            result.extend(response.json().get("items", []))
            following = response.links.get("next", {}).get("url")
            if not following:
                return result
            next_url = httpx.URL(following)
            if (
                next_url.scheme != "https"
                or next_url.host != "webexapis.com"
                or next_url.port not in (None, 443)
                or not next_url.path.startswith("/v1/")
            ):
                raise BridgeOperationError(
                    "Webex returned an unexpected pagination address."
                )
            url = next_url
        raise BridgeOperationError("Webex returned a pagination loop.")

    async def me(self) -> dict[str, Any]:
        person = await self.request("GET", "people/me")
        if person.get("type") != "bot" or not person.get("id"):
            raise BridgeCredentialError(
                "Use a Webex bot access token, not a personal access token."
            )
        return person

    async def download(self, url: str, limit: int) -> Attachment:
        address = httpx.URL(url)
        if (
            address.scheme != "https"
            or address.host != "webexapis.com"
            or address.port not in (None, 443)
            or not address.path.startswith("/v1/contents/")
        ):
            raise BridgeOperationError(
                "Webex supplied an unsupported attachment address."
            )
        async with self.http.stream(
            "GET",
            address,
            headers={"Authorization": f"Bearer {self._token}"},
            follow_redirects=False,
        ) as response:
            self.check(response)
            if response.is_redirect:
                raise BridgeOperationError(
                    "Webex attachment redirected; the file was not downloaded."
                )
            disposition = Message()
            disposition["content-disposition"] = response.headers.get(
                "content-disposition", ""
            )
            filename = (
                (disposition.get_filename() or "attachment")
                .replace("\\", "/")
                .rsplit("/", 1)[-1]
            )
            length = response.headers.get("content-length", "")
            if length.isdigit() and int(length) > limit:
                raise BridgeOperationError(
                    f"Attachment exceeds the {limit}-byte Switch limit."
                )
            data = bytearray()
            async for chunk in response.aiter_bytes():
                if len(data) + len(chunk) > limit:
                    raise BridgeOperationError(
                        f"Attachment exceeds the {limit}-byte Switch limit."
                    )
                data.extend(chunk)
            return Attachment(
                filename=filename,
                mimetype=response.headers.get(
                    "content-type", "application/octet-stream"
                ),
                data=bytes(data),
            )
