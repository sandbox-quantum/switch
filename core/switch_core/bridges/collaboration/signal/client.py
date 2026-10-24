"""JSON-RPC 2.0 client and SSE stream reader for signal-cli HTTP daemon."""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class SignalRpcError(Exception):
    """Base error for signal-cli JSON-RPC failures."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.data = data


class UntrustedIdentityException(SignalRpcError):
    """The recipient's Signal identity/safety number has changed."""


class ProofRequiredException(SignalRpcError):
    """Signal server requires CAPTCHA / proof-of-work challenge."""


class RateLimitException(SignalRpcError):
    """Signal server or signal-cli rate limit exceeded."""


class SignalRpcClient:
    """Communicates with native signal-cli HTTP daemon via JSON-RPC 2.0 and SSE."""

    def __init__(
        self,
        endpoint_url: str,
        account: str,
        *,
        http_client: httpx.AsyncClient | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.endpoint_url = endpoint_url.rstrip("/")
        self.account = account
        self._timeout = timeout
        self._client = http_client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = http_client is None
        self._req_id = 0

    async def close(self) -> None:
        """Close underlying HTTP client if owned."""
        if self._owns_client:
            await self._client.aclose()

    async def rpc_call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Execute a JSON-RPC 2.0 request against /api/v1/rpc."""
        self._req_id += 1
        req_id = f"sw-{self._req_id}"

        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
            "id": req_id,
        }

        url = f"{self.endpoint_url}/api/v1/rpc"
        response = await self._client.post(url, json=payload)
        response.raise_for_status()

        data = response.json()
        if "error" in data:
            err = data["error"]
            code = err.get("code", -1)
            msg = err.get("message", "Unknown error")
            err_data = err.get("data")

            msg_lower = msg.lower()
            if "untrusted identity" in msg_lower or "identity" in msg_lower and "changed" in msg_lower:
                raise UntrustedIdentityException(code, msg, err_data)
            if "proof required" in msg_lower or "challenge" in msg_lower:
                raise ProofRequiredException(code, msg, err_data)
            if "rate limit" in msg_lower or code == -32000 and "rate" in msg_lower:
                raise RateLimitException(code, msg, err_data)

            raise SignalRpcError(code, msg, err_data)

        return data.get("result")

    async def check_health(self) -> bool:
        """Check daemon health endpoint and credential accessibility."""
        try:
            resp = await self._client.get(f"{self.endpoint_url}/api/v1/check")
            if resp.status_code != 200:
                return False
            # Verify credentials and account readiness
            await self.list_groups()
            return True
        except Exception as exc:
            logger.debug("Signal daemon check failed: %s", exc)
            return False

    async def send_message(
        self,
        message: str,
        *,
        recipient: str | None = None,
        group_id: str | None = None,
        quote_timestamp: int | None = None,
        quote_author: str | None = None,
        quote_message: str | None = None,
        attachments: list[str] | None = None,
        edit_timestamp: int | None = None,
    ) -> int:
        """Send a message to a direct recipient or group. Returns sent timestamp."""
        params: dict[str, Any] = {"message": message}

        if group_id is not None:
            params["groupId"] = group_id
        elif recipient is not None:
            params["recipient"] = [recipient]
        else:
            raise ValueError("Either recipient or group_id must be provided")

        if quote_timestamp is not None:
            params["quoteTimestamp"] = quote_timestamp
            if quote_author:
                params["quoteAuthor"] = quote_author
            if quote_message:
                params["quoteMessage"] = quote_message

        if attachments:
            params["attachment"] = attachments

        if edit_timestamp is not None:
            params["editTimestamp"] = edit_timestamp

        result = await self.rpc_call("send", params)
        if isinstance(result, dict) and "timestamp" in result:
            return int(result["timestamp"])
        return 0

    async def remote_delete(
        self,
        target_timestamp: int,
        *,
        recipient: str | None = None,
        group_id: str | None = None,
    ) -> None:
        """Delete a previously sent message within 24 hours."""
        params: dict[str, Any] = {"targetTimestamp": target_timestamp}
        if group_id is not None:
            params["groupId"] = group_id
        elif recipient is not None:
            params["recipient"] = [recipient]
        else:
            raise ValueError("Either recipient or group_id must be provided")

        await self.rpc_call("remoteDelete", params)

    async def send_reaction(
        self,
        emoji: str,
        target_author: str,
        target_timestamp: int,
        *,
        recipient: str | None = None,
        group_id: str | None = None,
        remove: bool = False,
    ) -> None:
        """Send or remove an emoji reaction."""
        params: dict[str, Any] = {
            "emoji": emoji,
            "targetAuthor": target_author,
            "targetTimestamp": target_timestamp,
            "remove": remove,
        }
        if group_id is not None:
            params["groupId"] = group_id
        elif recipient is not None:
            params["recipient"] = recipient
        else:
            raise ValueError("Either recipient or group_id must be provided")

        await self.rpc_call("sendReaction", params)

    async def send_typing(
        self,
        *,
        recipient: str | None = None,
        group_id: str | None = None,
        stop: bool = False,
    ) -> None:
        """Send typing indicator start or stop."""
        params: dict[str, Any] = {"stop": stop}
        if group_id is not None:
            params["groupId"] = group_id
        elif recipient is not None:
            params["recipient"] = recipient
        else:
            raise ValueError("Either recipient or group_id must be provided")

        await self.rpc_call("sendTyping", params)

    async def get_attachment(
        self,
        attachment_id: str,
        *,
        recipient: str | None = None,
        group_id: str | None = None,
    ) -> bytes:
        """Fetch attachment data as bytes via JSON-RPC getAttachment."""
        params: dict[str, Any] = {"id": attachment_id}
        if group_id is not None:
            params["groupId"] = group_id
        elif recipient is not None:
            params["recipient"] = recipient

        b64_data = await self.rpc_call("getAttachment", params)
        if not b64_data or not isinstance(b64_data, str):
            return b""
        return base64.b64decode(b64_data)

    async def list_groups(self) -> list[dict[str, Any]]:
        """List groups joined by the account."""
        result = await self.rpc_call("listGroups")
        if isinstance(result, list):
            return result
        return []

    async def stream_events(
        self, last_event_id: str | None = None
    ) -> AsyncIterator[tuple[str | None, dict[str, Any]]]:
        """Stream SSE events from /api/v1/events, yielding (event_id, payload)."""
        headers = {}
        if last_event_id:
            headers["Last-Event-ID"] = last_event_id

        url = f"{self.endpoint_url}/api/v1/events"
        async with self._client.stream("GET", url, headers=headers, timeout=None) as response:
            response.raise_for_status()

            current_id: str | None = None
            data_lines: list[str] = []

            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    # Dispatch event on empty line
                    if data_lines:
                        raw_data = "\n".join(data_lines)
                        try:
                            payload = json.loads(raw_data)
                            yield current_id, payload
                        except json.JSONDecodeError:
                            logger.warning("Malformed JSON in SSE data: %r", raw_data)
                        data_lines = []
                    current_id = None
                    continue

                if line.startswith("id:"):
                    current_id = line[3:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].strip())
                elif line.startswith(":"):
                    # SSE comment / keep-alive
                    continue
