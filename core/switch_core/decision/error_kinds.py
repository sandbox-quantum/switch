"""What went wrong behind a decision backend, as Switch counts it
(`switch.decision.backend_errors`).

A decision service says so in a failed answer's `error_kind`; a machine's
controller in its result's error code. Only these values are taken from
either: anything else, or none, is `unknown`.
"""

from __future__ import annotations

from typing import Literal

BackendErrorKind = Literal[
    "model_server_unreachable",
    "model_server_timeout",
    "model_server_error",
    "model_unavailable",
    "credentials_missing",
    "backend_refused",
    "unknown",
]

KNOWN_BACKEND_ERROR_KINDS: frozenset[str] = frozenset(
    {
        "model_server_unreachable",
        "model_server_timeout",
        "model_server_error",
        "model_unavailable",
        "credentials_missing",
        "backend_refused",
    }
)
