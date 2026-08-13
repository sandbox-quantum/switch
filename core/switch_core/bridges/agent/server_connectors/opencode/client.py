from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class OpenCodeClient:
    """HTTP client for the OpenCode server REST API."""

    def __init__(self, server_url: str, username: str, password: str) -> None:
        self._http = httpx.AsyncClient(
            base_url=server_url.rstrip("/"),
            auth=httpx.BasicAuth(username, password),
            timeout=300,
        )

    async def list_agents(self) -> list[dict[str, Any]]:
        """List available agents from the OpenCode server."""
        resp = await self._http.get("/agent")
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def create_session(self) -> str:
        """Create a new session. Returns the session ID."""
        resp = await self._http.post("/session", json={})
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return str(data["id"])

    async def send_message(self, session_id: str, content: str) -> str:
        """Send a message to a session and wait for the response.

        Returns the text content of the response.
        """
        resp = await self._http.post(
            f"/session/{session_id}/message",
            json={"parts": [{"type": "text", "text": content}]},
        )
        resp.raise_for_status()
        data = resp.json()
        return _extract_response_text(data)

    async def add_context(self, session_id: str, content: str) -> None:
        """Inject a message into the session without triggering a response."""
        resp = await self._http.post(
            f"/session/{session_id}/message",
            json={
                "parts": [{"type": "text", "text": content}],
                "noReply": True,
            },
        )
        resp.raise_for_status()

    async def prompt_async(
        self, session_id: str, content: str, agent_name: str
    ) -> None:
        """Send a message without waiting for the response."""
        resp = await self._http.post(
            f"/session/{session_id}/prompt_async",
            json={"parts": [{"type": "text", "text": content}], "agent": agent_name},
        )
        resp.raise_for_status()

    async def respond_permission(
        self, session_id: str, permission_id: str, response: str
    ) -> None:
        """Respond to a permission request raised by the OpenCode server.

        `response` is one of "once", "always", or "reject". Without a reply
        the server pauses the session indefinitely waiting for approval.
        """
        resp = await self._http.post(
            f"/session/{session_id}/permissions/{permission_id}",
            json={"response": response},
        )
        resp.raise_for_status()

    @asynccontextmanager
    async def subscribe_events(self) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        """Subscribe to the SSE event stream. Yields parsed events."""
        stream_client = httpx.AsyncClient(
            base_url=str(self._http._base_url),
            auth=self._http._auth,
            timeout=None,
        )
        try:
            async with stream_client.stream(
                "GET", "/event", headers={"Accept": "text/event-stream"}
            ) as resp:
                resp.raise_for_status()
                yield _parse_sse(resp)
        finally:
            await stream_client.aclose()

    async def close(self) -> None:
        await self._http.aclose()


def _extract_response_text(data: dict[str, Any]) -> str:
    """Extract text content from an OpenCode message response."""
    parts = data.get("parts", [])
    texts = []
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "text":
            texts.append(part.get("text", ""))
    return "\n".join(texts) if texts else ""


async def _parse_sse(resp: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    """Parse an SSE stream into typed event dicts."""
    data_buf = ""
    async for line in resp.aiter_lines():
        if line.startswith("data:"):
            data_buf += line[5:].strip()
        elif line == "" and data_buf:
            try:
                yield json.loads(data_buf)
            except json.JSONDecodeError:
                logger.debug("Skipping non-JSON SSE data: %s", data_buf[:100])
            data_buf = ""
