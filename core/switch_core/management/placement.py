"""Controller state, and whether an agent may be placed on a controller.

A controller is `revoked` once its credential is gone, `online` while its
last accepted status report is fresh, and `unknown` otherwise — including
before it has ever reported. Fresh means within three status intervals, the
interval being what each controller is told as `report_within_s`.

Placement reads the controller's last status and refuses, with a contract
reason code, when the controller is revoked or not online, when the
definition's provider is not installed there, or when its login is missing
or expired. A provider whose login is `unknown` passes: the controller could
not tell, and refusing would block every provider whose CLI has no probe.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Literal

from switch_core.db.models import AgentController
from switch_core.management import reason_codes

ControllerState = Literal["online", "unknown", "revoked"]

STALE_AFTER_INTERVALS = 3

PROVIDER_AUTH_STATES = frozenset({"ok", "expired", "missing", "unknown"})


def controller_state(
    controller: AgentController, *, now: datetime, interval_seconds: int
) -> ControllerState:
    if controller.revoked_at is not None or controller.api_key_id is None:
        return "revoked"
    if controller.status is None or controller.last_seen_at is None:
        return "unknown"
    stale_after = timedelta(seconds=STALE_AFTER_INTERVALS * interval_seconds)
    if now - controller.last_seen_at > stale_after:
        return "unknown"
    return "online"


def provider_auth(entry: dict[str, Any]) -> str:
    """The entry's `auth`, with any value this server does not know read as unknown."""
    auth = entry.get("auth")
    return auth if auth in PROVIDER_AUTH_STATES else "unknown"


def placement_refusal(
    controller: AgentController,
    provider: str,
    *,
    now: datetime,
    interval_seconds: int,
) -> tuple[str, str] | None:
    """The reason code and message refusing this placement, or None to allow it."""
    state = controller_state(controller, now=now, interval_seconds=interval_seconds)
    if state == "revoked":
        return reason_codes.CONTROLLER_REVOKED, "the controller has been revoked"
    if state != "online":
        return (
            reason_codes.CONTROLLER_OFFLINE,
            "the controller has not reported status recently",
        )
    assert controller.status is not None
    providers = controller.status.get("providers")
    entry = next(
        (
            item
            for item in (providers if isinstance(providers, list) else [])
            if isinstance(item, dict) and item.get("provider") == provider
        ),
        None,
    )
    if entry is None or entry.get("installed") is not True:
        return (
            reason_codes.PROVIDER_NOT_INSTALLED,
            f"{provider} is not installed on this controller",
        )
    auth = provider_auth(entry)
    if auth == "missing":
        return (
            reason_codes.PROVIDER_LOGIN_MISSING,
            f"{provider} is not logged in on this controller",
        )
    if auth == "expired":
        return (
            reason_codes.PROVIDER_LOGIN_EXPIRED,
            f"the {provider} login on this controller has expired",
        )
    return None
