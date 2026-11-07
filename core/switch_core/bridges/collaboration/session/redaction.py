"""Security redaction and bounded preview formatting for tool input and output.

Prevents sensitive operational credentials, database connection strings,
tokens, private keys, and host-passed secrets from leaking into collaboration
channels while keeping useful execution detail readable.
"""

from __future__ import annotations

import re
from collections.abc import Collection

# Common API key and secret patterns
_PRIVATE_KEY_PATTERN = re.compile(
    r"-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----[^-]+-----END [A-Z0-9 ]+PRIVATE KEY-----",
    re.DOTALL,
)

_ANTHROPIC_KEY_PATTERN = re.compile(r"sk-ant-[a-zA-Z0-9\-_]{20,}")
_OPENAI_KEY_PATTERN = re.compile(r"\bsk-[a-zA-Z0-9\-_]{20,}\b")
_GITHUB_TOKEN_PATTERN = re.compile(
    r"\b(?:ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{40,})\b"
)
_SLACK_TOKEN_PATTERN = re.compile(r"\bxox[baprs]-[a-zA-Z0-9\-]+\b")
_AWS_KEY_PATTERN = re.compile(r"\bAKIA[0-9A-Z]{16}\b")
_GOOGLE_KEY_PATTERN = re.compile(r"\bAIza[0-9A-Za-z\-_]{30,}\b")
_JWT_PATTERN = re.compile(
    r"\beyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\b"
)
_BEARER_TOKEN_PATTERN = re.compile(r"(?i)\bbearer\s+[a-zA-Z0-9\-_.~+/]+=*")

# Database URLs and connection strings: scheme://user:pass@host
_DB_URI_PASSWORD_PATTERN = re.compile(
    r"([a-zA-Z][a-zA-Z0-9+.-]*://[^:\s/@]+:)([^@\s/]+)(@[^/\s]+)"
)

# Header patterns (e.g. MCP / HTTP Authorization headers)
_AUTH_HEADER_PATTERN = re.compile(
    r"(?i)\bauthorization\s*:\s*(?:bearer\s+[^\r\n,;]+|[^\r\n,;]+)"
)

# Environment variable assignments containing secrets (e.g. API_KEY=xyz, DB_PASSWORD=xyz)
_ENV_SECRET_PATTERN = re.compile(
    r"(?i)\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|AUTH|PRIVATE)[A-Z0-9_]*\s*=\s*)(?!\[REDACTED)([^\s\r\n;,]+)"
)

# Key-value secret configurations
_KV_SECRET_PATTERN = re.compile(
    r"""(?i)\b(?:api_key|apikey|secret|password|passwd|access_token|auth_token)\s*[:=]\s*["']?([^\s"';,]+)["']?"""
)

# Sizing limits specified by maintainer review
MAX_TOTAL_DETAIL_CHARS = 2000
MAX_INPUT_DETAIL_CHARS = 500


def redact_secrets(
    text: str,
    *,
    custom_secrets: Collection[str] | None = None,
) -> str:
    """Mask known secret patterns, connection passwords, and custom tokens in text."""
    if not text:
        return ""

    result = text

    # Redact explicit custom secrets first if provided
    if custom_secrets:
        for secret in custom_secrets:
            if secret and len(secret) >= 4:
                result = result.replace(secret, "[REDACTED]")

    # Redact PEM private keys
    result = _PRIVATE_KEY_PATTERN.sub("[REDACTED: PRIVATE KEY]", result)

    # Redact Authorization headers (MCP and HTTP)
    result = _AUTH_HEADER_PATTERN.sub(
        "Authorization: [REDACTED: AUTHORIZATION]", result
    )

    # Redact Database URI passwords
    result = _DB_URI_PASSWORD_PATTERN.sub(r"\1[REDACTED: PASSWORD]\3", result)

    # Redact standard provider API keys and tokens
    result = _ANTHROPIC_KEY_PATTERN.sub("[REDACTED: ANTHROPIC KEY]", result)
    result = _OPENAI_KEY_PATTERN.sub("[REDACTED: OPENAI KEY]", result)
    result = _GITHUB_TOKEN_PATTERN.sub("[REDACTED: GITHUB TOKEN]", result)
    result = _SLACK_TOKEN_PATTERN.sub("[REDACTED: SLACK TOKEN]", result)
    result = _AWS_KEY_PATTERN.sub("[REDACTED: AWS KEY]", result)
    result = _GOOGLE_KEY_PATTERN.sub("[REDACTED: GOOGLE KEY]", result)
    result = _JWT_PATTERN.sub("[REDACTED: JWT]", result)
    result = _BEARER_TOKEN_PATTERN.sub("Bearer [REDACTED: BEARER TOKEN]", result)

    # Redact secret environment variables
    result = _ENV_SECRET_PATTERN.sub(r"\1[REDACTED: SECRET]", result)

    # Redact key-value configuration values
    def _replace_kv(m: re.Match[str]) -> str:
        full_match = m.group(0)
        val = m.group(1)
        if not val or val.startswith("[REDACTED"):
            return full_match
        return full_match.replace(val, "[REDACTED: SECRET]")

    result = _KV_SECRET_PATTERN.sub(_replace_kv, result)

    return result


def format_tool_detail(
    input_text: str | None,
    output_text: str | None,
    *,
    max_total: int = MAX_TOTAL_DETAIL_CHARS,
    max_input: int = MAX_INPUT_DETAIL_CHARS,
    custom_secrets: Collection[str] | None = None,
) -> str:
    """Format and bound tool input and output safely for channel display.

    Limits input to `max_input` characters and the entire output block
    to `max_total` characters with descriptive omission notes.
    """
    clean_input = redact_secrets(
        input_text or "", custom_secrets=custom_secrets
    ).strip()
    clean_output = redact_secrets(
        output_text or "", custom_secrets=custom_secrets
    ).strip()

    sections: list[str] = []

    if clean_input:
        if len(clean_input) > max_input:
            omitted = len(clean_input) - max_input
            clean_input = (
                clean_input[:max_input] + f"\n[input cut, {omitted} more characters]"
            )
        sections.append(f"Input:\n{clean_input}")

    if clean_output:
        # Budget available for output
        used_so_far = sum(len(s) for s in sections) + (len(sections) * 2)
        available_output = max_total - used_so_far - len("Output:\n") - 50

        if available_output <= 0:
            sections.append(
                f"Output:\n[output cut, {len(clean_output)} more characters]"
            )
        elif len(clean_output) > available_output:
            omitted = len(clean_output) - available_output
            clean_output = (
                clean_output[:available_output]
                + f"\n[output cut, {omitted} more characters]"
            )
            sections.append(f"Output:\n{clean_output}")
        else:
            sections.append(f"Output:\n{clean_output}")

    combined = "\n\n".join(sections)
    if len(combined) > max_total:
        omitted = len(combined) - max_total
        combined = combined[:max_total] + f"\n[truncated, {omitted} more characters]"

    return combined
