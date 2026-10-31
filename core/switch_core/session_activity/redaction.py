"""Masking of secrets in tool text a host reports.

The host masks before it reports; this runs again on arrival because Switch
cannot tell a host that did from one that did not, and a room reads what is
stored. Heuristic, and kept in step with `redactSecrets` in the console's
`host/redaction.ts`.
"""

from __future__ import annotations

import re

_MASK = "[REDACTED]"

_SHAPES = tuple(
    re.compile(pattern)
    for pattern in (
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)",
        r"\bsk-[A-Za-z0-9_-]{16,}",
        r"\bxox[baprs]-[A-Za-z0-9-]{10,}",
        r"\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b",
        r"\bAIza[0-9A-Za-z_-]{35}",
        r"\bglpat-[A-Za-z0-9_-]{20,}",
        r"\bhf_[A-Za-z0-9]{20,}",
        r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}",
        r"\bnpm_[A-Za-z0-9]{30,}",
        r"\bgh[pousr]_[A-Za-z0-9_]{4,}",
        r"\bgithub_pat_[A-Za-z0-9_]{4,}",
        r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    )
)
_URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^/\s:@]+:)[^@\s/]+(@)", re.I)
_BEARER = re.compile(r"(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}", re.I)
_AUTHORIZATION = re.compile(
    r"""(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+""",
    re.I,
)
_ASSIGNMENT = re.compile(
    r"""(\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|secret(?:[_-]?access)?(?:[_-]?key)?|password|passwd|token|access[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;]+""",
    re.I,
)


def redact_secrets(text: str) -> str:
    """`text` with anything shaped like a secret masked."""
    for shape in _SHAPES:
        text = shape.sub(_MASK, text)
    text = _URL_PASSWORD.sub(rf"\1{_MASK}\2", text)
    text = _AUTHORIZATION.sub(rf"\1{_MASK}", text)
    text = _BEARER.sub(rf"\1{_MASK}", text)
    return _ASSIGNMENT.sub(rf"\1{_MASK}", text)
