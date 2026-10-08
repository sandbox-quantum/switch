"""Controller state, and whether an agent may be placed on a controller.

A controller's state is read from its connection's recorded transitions
(`connection_ledger.py`) and the lease of the switch-core process holding it
(`process_lease.py`), so every process answers alike and a restart changes
nothing:

- `revoked`: its credential is gone.
- `online`: its socket is attached, and the process holding it is alive
  (its lease renewed within `LEASE_TTL`, and not stopped).
- `offline`: it has connected before, and its socket went (closed, its
  heartbeat lapsed, taken over and not replaced, the server shut down), or
  the process holding it stopped or died without saying so.
- `unknown`: no connection has ever been recorded for it: enrolled but never
  run, or connected only to a server that did not record connections.

Its status report is not what makes it online; the report carries the
details (providers, disk, agents).

Placement needs the controller online and its last status report fresh,
within three status intervals (the interval being what each controller is
told as `report_within_s`), since that report is what the provider checks
read. It refuses, with a contract reason code, when either is not so, when
the definition's provider is not installed there, or when its login is
missing or expired. A provider whose login is `unknown` passes: the
controller could not tell, and refusing would block every provider whose CLI
has no probe.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Literal

from switch_core.db.models import AgentController
from switch_core.management import reason_codes
from switch_core.management.errors import ManagementError
from switch_core.management.process_lease import ProcessLeases

ControllerState = Literal["online", "offline", "unknown", "revoked"]

STALE_AFTER_INTERVALS = 3

PROVIDER_AUTH_STATES = frozenset({"ok", "expired", "missing", "unknown"})


def is_revoked(controller: AgentController) -> bool:
    return controller.revoked_at is not None or controller.api_key_id is None


def controller_state(
    controller: AgentController, leases: ProcessLeases
) -> ControllerState:
    if is_revoked(controller):
        return "revoked"
    if controller.connected_at is None:
        return "unknown"
    if controller.disconnected_at is not None:
        return "offline"
    if not leases.holds(controller.connection_process_id):
        return "offline"
    return "online"


def status_is_fresh(
    controller: AgentController, *, now: datetime, interval_seconds: int
) -> bool:
    """Whether the controller has reported status within three intervals."""
    if controller.status is None or controller.last_seen_at is None:
        return False
    stale_after = timedelta(seconds=STALE_AFTER_INTERVALS * interval_seconds)
    return now - controller.last_seen_at <= stale_after


def provider_auth(entry: dict[str, Any]) -> str:
    """The entry's `auth`, with any value this server does not know read as unknown."""
    auth = entry.get("auth")
    return auth if auth in PROVIDER_AUTH_STATES else "unknown"


def placement_refusal(
    controller: AgentController,
    provider: str,
    *,
    leases: ProcessLeases,
    now: datetime,
    interval_seconds: int,
) -> tuple[str, str] | None:
    """The reason code and message refusing this placement, or None to allow it."""
    state = controller_state(controller, leases)
    if state == "revoked":
        return reason_codes.CONTROLLER_REVOKED, "the controller has been revoked"
    if state == "unknown":
        return (
            reason_codes.CONTROLLER_OFFLINE,
            "the controller has never connected to Switch",
        )
    if state == "offline":
        return (
            reason_codes.CONTROLLER_OFFLINE,
            "the controller is not connected to Switch",
        )
    if not status_is_fresh(controller, now=now, interval_seconds=interval_seconds):
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


def require_placement(
    controller: AgentController,
    provider: str,
    *,
    leases: ProcessLeases,
    now: datetime,
    interval_seconds: int,
) -> None:
    refusal = placement_refusal(
        controller,
        provider,
        leases=leases,
        now=now,
        interval_seconds=interval_seconds,
    )
    if refusal is not None:
        code, message = refusal
        raise ManagementError(409, code, f"Cannot place the agent: {message}.")
