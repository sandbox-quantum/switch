from __future__ import annotations

from typing import Any

import httpx


class WebexApiError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class WebexClient:
    API = "https://webexapis.com/v1"

    def __init__(self, *, token: str, http: httpx.AsyncClient | None = None) -> None:
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(
            headers={"Authorization": f"Bearer {token}"}, timeout=20, trust_env=False
        )

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = await self._http.request(
            method, f"{self.API}{path}", params=params, json=body
        )
        if response.is_error:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            raise WebexApiError(
                response.status_code,
                str(
                    payload.get("message")
                    or f"Webex returned HTTP {response.status_code}"
                ),
            )
        if response.status_code == 204:
            return {}
        payload = response.json()
        if not isinstance(payload, dict):
            raise WebexApiError(502, "Webex returned an invalid response")
        return payload

    async def me(self) -> dict[str, Any]:
        return await self.request("GET", "/people/me")

    async def message(self, message_id: str) -> dict[str, Any]:
        return await self.request("GET", f"/messages/{message_id}")

    async def send(self, room_id: str, markdown: str, parent_id: str | None) -> str:
        body: dict[str, Any] = {"roomId": room_id, "markdown": markdown}
        if parent_id:
            body["parentId"] = parent_id
        payload = await self.request("POST", "/messages", body=body)
        message_id = payload.get("id")
        if not isinstance(message_id, str) or not message_id:
            raise WebexApiError(502, "Webex returned no message id")
        return message_id

    async def update(self, message_id: str, room_id: str, markdown: str) -> None:
        await self.request(
            "PUT",
            f"/messages/{message_id}",
            body={"roomId": room_id, "markdown": markdown},
        )

    async def delete(self, message_id: str) -> None:
        await self.request("DELETE", f"/messages/{message_id}")

    async def list_webhooks(self) -> list[dict[str, Any]]:
        payload = await self.request("GET", "/webhooks")
        items = payload.get("items")
        return (
            [item for item in items if isinstance(item, dict)]
            if isinstance(items, list)
            else []
        )

    async def ensure_webhook(self, target_url: str, secret: str) -> None:
        hooks = await self.list_webhooks()
        if any(
            hook.get("targetUrl") == target_url
            and hook.get("resource") == "messages"
            and hook.get("event") == "created"
            and hook.get("status", "active") == "active"
            for hook in hooks
        ):
            return
        await self.request(
            "POST",
            "/webhooks",
            body={
                "name": "Switch messages",
                "targetUrl": target_url,
                "resource": "messages",
                "event": "created",
                "secret": secret,
            },
        )

    async def create_room(self, title: str) -> str:
        payload = await self.request("POST", "/rooms", body={"title": title})
        room_id = payload.get("id")
        if not isinstance(room_id, str) or not room_id:
            raise WebexApiError(502, "Webex returned no room id")
        return room_id

    async def room(self, room_id: str) -> dict[str, Any]:
        return await self.request("GET", f"/rooms/{room_id}")

    async def add_member(self, room_id: str, person: str) -> None:
        key = "personEmail" if "@" in person else "personId"
        await self.request(
            "POST", "/memberships", body={"roomId": room_id, key: person}
        )

    async def download(self, url: str) -> tuple[bytes, str]:
        response = await self._http.get(url)
        if response.is_error:
            raise WebexApiError(response.status_code, "Webex file download failed")
        return response.content, response.headers.get(
            "content-type", "application/octet-stream"
        )
