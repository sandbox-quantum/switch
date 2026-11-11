"""Security-sensitive redaction and size-limiting for tool input and output.

Prevents secrets (API keys, tokens, passwords, private keys, connection strings)
from leaking into collaboration platform channels (Slack, Discord, Mattermost, etc.)
and enforces size caps with clear truncation indicators to avoid message flooding.
"""

from __future__ import annotations

import re
from typing import Final

REDACTED_MASK: Final[str] = "[REDACTED]"

# Regular expressions for common high-risk secret formats
_SECRET_PATTERNS: Final[list[tuple[re.Pattern[str], str]]] = [
    # Private cryptographic keys (PEM format)
    (
        re.compile(
            r"-----BEGIN [A-Z0-9\s_-]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9\s_-]+PRIVATE KEY-----",
            re.MULTILINE,
        ),
        "[REDACTED: PRIVATE KEY]",
    ),
    # OpenAI & AI provider keys (sk-..., sk-proj-..., sk-ant-...)
    (
        re.compile(r"\b(sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{20,})\b"),
        "[REDACTED: API KEY]",
    ),
    # GitHub Personal Access Tokens and OAuth tokens
    (
        re.compile(r"\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36})\b"),
        "[REDACTED: GITHUB TOKEN]",
    ),
    (
        re.compile(r"\b(github_pat_[A-Za-z0-9_]{20,})\b"),
        "[REDACTED: GITHUB TOKEN]",
    ),
    # Slack tokens (Bot, User, App, Refresh)
    (
        re.compile(r"\b(xox[baprs]-[0-9A-Za-z\-]{20,})\b"),
        "[REDACTED: SLACK TOKEN]",
    ),
    # AWS Access Key IDs
    (
        re.compile(r"\b(AKIA[0-9A-Z]{16})\b"),
        "[REDACTED: AWS KEY]",
    ),
    # Google Cloud / Firebase API keys
    (
        re.compile(r"\b(AIza[0-9A-Za-z\-_]{35})\b"),
        "[REDACTED: GOOGLE KEY]",
    ),
    # JWT tokens (Header.Payload.Signature)
    (
        re.compile(
            r"\b(eyJ[A-Za-z0-9-_]{10,}\.eyJ[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,})\b"
        ),
        "[REDACTED: JWT]",
    ),
    # Bearer authorization tokens
    (
        re.compile(r"(?i)\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*"),
        r"\1[REDACTED: BEARER TOKEN]",
    ),
]

# Database URI passwords: postgresql://user:password@host:port/db
_URI_PASSWORD_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"(?i)\b([a-z+]+://[^:\s/@]+:)(.+)(@[a-zA-Z0-9.\-_]+(?::\d+)?(?:/[^\s]*)?)",
)

# Key-value assignment secret patterns: api_key = "...", password: "..."
_KV_SECRET_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"(?i)(['\"]?(?:api[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token|private[_-]?key)['\"]?\s*[:=]\s*['\"]?)([^'\"\s\r\n,]{8,})(['\"]?)",
)


def redact_secrets(
    text: str, custom_secrets: list[str] | set[str] | None = None
) -> str:
    """Mask credentials, tokens, keys, and connection passwords in `text`.

    Args:
        text: Raw text containing potential tool inputs, commands, or outputs.
        custom_secrets: Optional list of explicit sensitive strings to mask.

    Returns:
        Sanitized text with known secret formats replaced by safe mask placeholders.
    """
    if not text:
        return text

    sanitized = text

    # 1. Custom exact secret strings
    if custom_secrets:
        for secret in custom_secrets:
            if secret and len(secret) >= 4:
                sanitized = sanitized.replace(secret, REDACTED_MASK)

    # 2. Known token and key patterns
    for pattern, replacement in _SECRET_PATTERNS:
        sanitized = pattern.sub(replacement, sanitized)

    # 3. Connection string passwords
    sanitized = _URI_PASSWORD_PATTERN.sub(r"\1[REDACTED: PASSWORD]\3", sanitized)

    # 4. Key-value assignment patterns
    sanitized = _KV_SECRET_PATTERN.sub(r"\1[REDACTED]\3", sanitized)

    return sanitized


def format_safe_tool_detail(
    text: str,
    *,
    max_length: int = 1500,
    custom_secrets: list[str] | set[str] | None = None,
) -> str:
    """Redact secrets and cap length with a clear truncation note.

    Args:
        text: Raw tool input or output string.
        max_length: Maximum allowed character length for the rendered output.
        custom_secrets: Optional custom secret strings to redact.

    Returns:
        Safe, length-bounded string with secrets masked and clear truncation note.
    """
    if not text:
        return ""

    redacted = redact_secrets(text, custom_secrets=custom_secrets)
    if len(redacted) <= max_length:
        return redacted

    omitted = len(redacted) - max_length
    truncation_note = f"\n… [truncated: {omitted:,} characters omitted]"
    keep_budget = max(0, max_length - len(truncation_note))
    return redacted[:keep_budget] + truncation_note
