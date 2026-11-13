"""The operator API's own bearer (operator bearer design note v1.3, security).

The in-cluster restart and drain workers list operator actions and report their
steps on two routes (`operator_action_routes.py`). Those routes take this bearer,
`operator_token` in the hosted controller settings, and nothing else takes it:
the controller routes compare against `token`, the provisioner's against
`provisioner_token`. So no pod needs both bearers, and a leaked controller
bearer doesn't reach the operator API.

Two overlaps, each with an end Core enforces, at most 24 hours ahead (checked
when the settings load):

- **Rotation:** `operator_token_previous`, accepted until
  `operator_token_previous_until`.
- **Move-over:** the controller's `token`, accepted on these two routes only,
  until `operator_routes_accept_controller_until`.

Past its end each is refused, whether or not it's still in the file. While one
is used, Core logs at most one INFO a minute for it, so platform can see when
every pod has moved. When one lapses, a running Core logs one WARN on the next
call. No bearer is ever logged.

Refusals go through the shared refusal guard (`_refuse`) as route
`hosted_operator`. When the refused bearer is the controller's, the reason is
`controller_token`: a worker still on the old bearer. That code is in the
server log only, never in the response.
"""

from __future__ import annotations

import logging
import secrets
import threading
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import Depends, Request

from switch_core.gateway.hosted_controller import _refuse
from switch_core.gateway.hosted_machines import controller_settings
from switch_core.providers.hosted import HostedControllerSettings

logger = logging.getLogger(__name__)

ROUTE = "hosted_operator"
#: At most one INFO per overlap kind in this long, while it's in use.
KIND_LOG_EVERY = timedelta(minutes=1)

Accepted = Literal["current", "operator_previous", "controller_transition"]


def _now() -> datetime:
    """The clock the overlaps are checked against (tests replace it)."""
    return datetime.now(UTC)


def _matches(supplied: str, value: str | None) -> bool:
    if value is None:
        return False
    return secrets.compare_digest(supplied.encode(), ("Bearer " + value).encode())


class _OverlapLog:
    """Per process: when each overlap kind was last logged as used, and which
    lapses have been warned about. Only kinds and times, never a bearer."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._used_at: dict[str, datetime] = {}
        self._lapsed: set[tuple[str, datetime]] = set()

    def used(self, kind: str, now: datetime) -> None:
        with self._lock:
            last = self._used_at.get(kind)
            if last is not None and now - last < KIND_LOG_EVERY:
                return
            self._used_at[kind] = now
        logger.info("Operator API call accepted on an overlap bearer: kind=%s", kind)

    def lapsed(self, name: str, until: datetime) -> None:
        with self._lock:
            if (name, until) in self._lapsed:
                return
            self._lapsed.add((name, until))
        logger.warning(
            "Operator bearer overlap lapsed at %s and is now refused; remove %s "
            "from the hosted controller config",
            until.isoformat(),
            name,
        )

    def reset(self) -> None:
        with self._lock:
            self._used_at.clear()
            self._lapsed.clear()


overlap_log = _OverlapLog()


def check_operator_bearer(
    settings: HostedControllerSettings, supplied: str, now: datetime
) -> Accepted | None:
    """Which bearer `supplied` is, if it's one these routes accept now, else
    None. Every configured value is compared on every call, with no early
    return, so timing doesn't say which one matched."""
    if settings.operator_token is None:
        # Unset means closed, with no fallback.
        return None
    current = _matches(supplied, settings.operator_token.get_secret_value())
    previous_value = settings.operator_token_previous
    previous = _matches(
        supplied, None if previous_value is None else previous_value.get_secret_value()
    )
    controller = _matches(supplied, settings.token.get_secret_value())

    previous_until = settings.operator_token_previous_until
    previous_open = previous_until is not None and now < previous_until
    if previous_until is not None and not previous_open:
        overlap_log.lapsed("operator_token_previous_until", previous_until)
    transition_until = settings.operator_routes_accept_controller_until
    transition_open = transition_until is not None and now < transition_until
    if transition_until is not None and not transition_open:
        overlap_log.lapsed("operator_routes_accept_controller_until", transition_until)

    if current:
        return "current"
    if previous and previous_open:
        return "operator_previous"
    if controller and transition_open:
        return "controller_transition"
    return None


def require_operator_bearer(
    request: Request,
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
) -> None:
    """The operator API's credential check. No session is opened here: the
    operator actions open their own, under `no_tenant()`."""
    supplied = request.headers.get("authorization", "")
    now = _now()
    accepted = check_operator_bearer(settings, supplied, now)
    if accepted is not None:
        if accepted != "current":
            overlap_log.used(accepted, now)
        return
    # Only after the refusal is decided: name the controller's bearer, so a
    # worker left on it shows up at once. The log only, never the response.
    reason = (
        "controller_token"
        if supplied and _matches(supplied, settings.token.get_secret_value())
        else None
    )
    _refuse(request, supplied, route=ROUTE, reason=reason)
