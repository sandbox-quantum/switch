"""Service connectors, as the `service_*` events report them.

Which service (its catalog slug, never an account), how a person signs in to
it, and why a sign-in or a token was refused, as enumerated codes. The
messaging platforms rooms are bridged to are the `connector_*` events'.
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Literal

from switch_core.connections.loader import CATALOG, AdapterName
from switch_core.telemetry.service import TelemetryService, emit_safely

SignInStage = Literal["start", "vendor", "complete"]

AUTH_KINDS: Mapping[AdapterName, str] = {
    "github": "github_app",
    "api_key": "api_key",
    "oauth": "oauth",
}


def service_slug(service: str) -> str:
    """`service` as reported: its slug, or `unknown` for one not in the catalog."""
    return service if service in CATALOG else "unknown"


def auth_kind(adapter: AdapterName | None) -> str:
    """How a person signs in, from the catalog entry's adapter."""
    return AUTH_KINDS[adapter or "oauth"]


def refusal_failure(code: str) -> str:
    """A sign-in refused by the broker, as a sign-in failure: a key the vendor
    would not take, a vendor that did not answer, or Switch saying no."""
    if code == "validation_error":
        return "invalid_key"
    if code == "internal":
        return "vendor_unavailable"
    return "refused"


def sign_in_started(
    telemetry: TelemetryService | None, service: str, adapter: AdapterName | None
) -> None:
    emit_safely(
        telemetry,
        "service_connection_started",
        {"service": service_slug(service), "auth_kind": auth_kind(adapter)},
    )


def sign_in_failed(
    telemetry: TelemetryService | None,
    service: str,
    stage: SignInStage,
    reason: str,
) -> None:
    emit_safely(
        telemetry,
        "service_connection_failed",
        {"service": service_slug(service), "stage": stage, "reason": reason},
    )


TOKEN_REFUSAL_WINDOW_SECONDS = 3600.0
TOKEN_REFUSALS_HELD = 10_000


class TokenRefusals:
    """Which token refusals were reported in the last hour, by agent, service
    and reason: a session host asks again on its own, and one refusal an
    hour says as much as sixty. Held in this process only, so each replica
    reports its own."""

    def __init__(self, held: int) -> None:
        # Oldest first: a key reported again is moved to the end, so the
        # front is always the next to expire, and evicting from it costs
        # nothing however many are held.
        self._reported: dict[tuple[str, str, str], float] = {}
        self._held = held

    def first_in_window(self, agent_id: str, service: str, reason: str) -> bool:
        now = time.monotonic()
        key = (agent_id, service, reason)
        last = self._reported.get(key)
        if last is not None and now - last < TOKEN_REFUSAL_WINDOW_SECONDS:
            return False
        self._reported.pop(key, None)
        self._reported[key] = now
        while self._reported:
            oldest, at = next(iter(self._reported.items()))
            if (
                len(self._reported) <= self._held
                and now - at < TOKEN_REFUSAL_WINDOW_SECONDS
            ):
                break
            del self._reported[oldest]
        return True
