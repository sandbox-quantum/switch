"""Snowflake-specific validation for account-scoped MCP server endpoints."""

from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit

SNOWFLAKE_HOST = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"snowflakecomputing\.(?:com|cn)$"
)
MCP_PATH = (
    "api",
    "v2",
    "databases",
    None,
    "schemas",
    None,
    "mcp-servers",
    None,
)


def validate_mcp_endpoint(endpoint: str) -> str:
    """Accept only HTTPS Snowflake MCP endpoints, never arbitrary server URLs."""
    if not endpoint or endpoint != endpoint.strip() or len(endpoint) > 2048:
        raise ValueError("Enter a complete Snowflake MCP endpoint URL.")
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except ValueError:
        raise ValueError("Enter a valid Snowflake MCP endpoint URL.") from None
    hostname = parsed.hostname
    if (
        parsed.scheme != "https"
        or hostname is None
        or not SNOWFLAKE_HOST.fullmatch(hostname.lower())
        or parsed.netloc.lower() != hostname.lower()
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "The endpoint must use HTTPS on a Snowflake account host, without "
            "a port, query, or fragment."
        )
    if not parsed.path.startswith("/") or parsed.path.startswith("//"):
        raise ValueError(
            "The endpoint must name a Snowflake database, schema, and MCP server."
        )
    segments = parsed.path.lstrip("/").split("/")
    if len(segments) != len(MCP_PATH):
        raise ValueError(
            "The endpoint must name a Snowflake database, schema, and MCP server."
        )
    for actual, expected in zip(segments, MCP_PATH, strict=True):
        decoded = unquote(actual)
        if (
            not decoded
            or "/" in decoded
            or "\\" in decoded
            or "%" in decoded
            or any(ord(char) < 32 for char in decoded)
            or decoded in {".", ".."}
            or (expected is not None and decoded != expected)
        ):
            raise ValueError(
                "The endpoint must name a Snowflake database, schema, and MCP server."
            )
    return endpoint
