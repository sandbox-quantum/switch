from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx


class SignalRpcError(RuntimeError):
    """A definite JSON-RPC refusal from signal-cli."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SignalEvent:
    id: str | None
    payload: dict[str, Any]


class SignalRpcClient:
    """Small client for signal-cli 0.14.9's HTTP JSON-RPC/SSE API."""

    def __init__(
        self,
        *,
        daemon_url: str,
        account: str,
        daemon_token: str | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._url = daemon_url.rstrip("/")
        self._account = account
        self._owns_http = http is None
        headers = {"Authorization": f"Bearer {daemon_token}"} if daemon_token else None
        self._http = http or httpx.AsyncClient(
            timeout=httpx.Timeout(30, read=None),
            headers=headers,
            trust_env=False,
        )
        self._next_id = 0

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def check(self) -> None:
        response = await self._http.get(f"{self._url}/api/v1/check")
        response.raise_for_status()

    async def rpc(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        include_account: bool = True,
    ) -> Any:
        self._next_id += 1
        body: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": str(self._next_id),
            "method": method,
        }
        values = dict(params or {})
        if include_account:
            values.setdefault("account", self._account)
        if values:
            body["params"] = values
        response = await self._http.post(f"{self._url}/api/v1/rpc", json=body)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise SignalRpcError(-32603, "signal-cli returned a non-object response")
        error = payload.get("error")
        if isinstance(error, dict):
            raise SignalRpcError(
                int(error.get("code", -32603)),
                str(error.get("message") or "signal-cli rejected the request"),
            )
        return payload.get("result")

    async def list_accounts(self) -> list[dict[str, Any]]:
        result = await self.rpc("listAccounts", include_account=False)
        return [item for item in result or [] if isinstance(item, dict)]

    async def list_groups(self) -> list[dict[str, Any]]:
        result = await self.rpc("listGroups")
        return [item for item in result or [] if isinstance(item, dict)]

    async def events(self, *, last_event_id: str | None) -> AsyncIterator[SignalEvent]:
        headers = {"Accept": "text/event-stream"}
        if last_event_id:
            headers["Last-Event-ID"] = last_event_id
        async with self._http.stream(
            "GET", f"{self._url}/api/v1/events", headers=headers
        ) as response:
            response.raise_for_status()
            event_id: str | None = None
            data: list[str] = []
            async for line in response.aiter_lines():
                if not line:
                    if data:
                        parsed = json.loads("\n".join(data))
                        if isinstance(parsed, dict):
                            yield SignalEvent(id=event_id, payload=parsed)
                    event_id, data = None, []
                    continue
                if line.startswith(":"):
                    continue
                field, separator, value = line.partition(":")
                if separator and value.startswith(" "):
                    value = value[1:]
                if field == "id":
                    event_id = value
                elif field == "data":
                    data.append(value)
