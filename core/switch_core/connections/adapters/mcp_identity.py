"""A bounded MCP identity lookup, using only a catalog-selected tool.

This is not an agent session: no discovery, server-initiated requests, prompts,
resources or tool text are executed. Only structured identity data is accepted.
The injected HTTP client retains its transport, with redirects always refused.
"""

from __future__ import annotations

import json
import re
from typing import Any

import anyio
import httpx
from mcp.shared.version import SUPPORTED_PROTOCOL_VERSIONS
from mcp.types import LATEST_PROTOCOL_VERSION, CallToolResult, InitializeResult
from pydantic import ValidationError

from switch_core.connections.adapters import (
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
)

MAX_IDENTITY_BYTES = 64 * 1024
IDENTITY_TIMEOUT = 20


async def identify(
    http: httpx.AsyncClient, *, url: str, tool: str, token: str, name: str
) -> dict[str, Any]:
    """Initialize, acknowledge, then call exactly the configured identity tool."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
    }

    async def post(message: dict[str, Any]) -> tuple[dict[str, Any], httpx.Headers]:
        def answer(data: Any) -> dict[str, Any] | None:
            if not isinstance(data, dict) or type(data.get("id")) is not int:
                return None
            if data["id"] != message["id"]:
                return None
            result = data.get("result")
            if (
                data.get("jsonrpc") != "2.0"
                or "error" in data
                or not isinstance(result, dict)
            ):
                raise ValueError("identity request failed")
            return result

        request = http.build_request("POST", url, headers=headers, json=message)
        response = await http.send(request, stream=True, follow_redirects=False)
        try:
            if response.status_code == 401:
                raise ReauthorizationRequiredError(
                    f"{name} refused the new sign-in when asked whose it is."
                )
            if response.status_code == 429 or response.status_code >= 500:
                raise ServiceUnavailableError(
                    f"{name} is unavailable. Please try again."
                )
            if response.status_code not in (200, 202):
                raise ServiceAdapterError(f"{name} refused the identity lookup.")
            if "id" not in message:
                if response.status_code != 202:
                    raise ValueError("identity notification was not accepted")
                return {}, response.headers
            if response.status_code != 200:
                raise ValueError("identity request has no result")
            content_type = (
                response.headers.get("content-type", "").split(";")[0].strip()
            )
            if content_type not in ("application/json", "text/event-stream"):
                raise ValueError("identity response is not JSON or SSE")
            raw = bytearray()
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_IDENTITY_BYTES:
                    raise ValueError("identity response is too large")
                raw.extend(chunk)
                if content_type == "text/event-stream":
                    # Consume complete SSE events before EOF: a server may keep
                    # the stream open. Never execute its notifications/requests.
                    while match := re.search(rb"\r?\n\r?\n", raw):
                        event = raw[: match.start()].decode("utf-8")
                        del raw[: match.end()]
                        data = "\n".join(
                            line[5:].removeprefix(" ")
                            for line in event.splitlines()
                            if line.startswith("data:")
                        )
                        if data and (result := answer(json.loads(data))) is not None:
                            return result, response.headers
            if content_type == "application/json":
                result = answer(json.loads(raw))
                if result is not None:
                    return result, response.headers
            raise ValueError("identity response has no matching result")
        finally:
            await response.aclose()

    try:
        with anyio.fail_after(IDENTITY_TIMEOUT):
            result, response_headers = await post(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": LATEST_PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": {"name": "Switch", "version": "1"},
                    },
                }
            )
            initialized = InitializeResult.model_validate(result)
            if initialized.protocolVersion not in SUPPORTED_PROTOCOL_VERSIONS:
                raise ValueError("unsupported MCP protocol version")
            if initialized.capabilities.tools is None:
                raise ValueError("identity server does not offer tools")
            headers["MCP-Protocol-Version"] = initialized.protocolVersion
            session_id = response_headers.get("mcp-session-id")
            if session_id is not None:
                if not re.fullmatch(r"[\x21-\x7e]{1,256}", session_id):
                    raise ValueError("invalid MCP session id")
                headers["Mcp-Session-Id"] = session_id
            await post({"jsonrpc": "2.0", "method": "notifications/initialized"})
            result, _ = await post(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": tool, "arguments": {}},
                }
            )
            called = CallToolResult.model_validate(result)
            if called.isError or called.structuredContent is None:
                raise ValueError("identity tool returned no structured result")
            return called.structuredContent
    except (httpx.HTTPError, TimeoutError):
        raise ServiceUnavailableError(
            f"{name} could not be reached. Please try again."
        ) from None
    except (ValueError, ValidationError):
        # Never include a server's text, validation errors or payload in a
        # connection failure: they may contain personal data or echoed secrets.
        raise ServiceAdapterError(
            f"{name} returned an invalid identity response."
        ) from None
