"""A hosted box's facts from the operator, kept beside its heartbeat.

The operator's observation of a machine says which node its box runs on, and
how many times the box was pushed off a machine or restarted since the last
accepted observation. Core keeps them in one key of the machine's heartbeat
(`cloud_machines.heartbeat["box"]`), written only by the observation route:

    {"node": "ip-10-0-1-7", "day": "2026-10-29", "restarts_today": 2,
     "restart_times": [...], "eviction_times": [...]}

The hosted alerts read the two time lists (the last hour only, at most 50 each),
and the operator's Boxes tab reads `node` and `restarts_today` (counted per UTC day). Status
reports rebuild the rest of the heartbeat, and keep this key as it is.

Nothing here is text a box chose: a node name passes the Kubernetes name rule
before it gets here, and everything else is a count or a time Core made.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

BOX_KEY = "box"
MAX_TIMES = 50
KEEP_FOR = timedelta(hours=1)
MAX_COUNT = 1_000_000


def _recent(values: Any, now: datetime) -> list[str]:
    kept: list[str] = []
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, str):
            continue
        try:
            moment = datetime.fromisoformat(value)
        except ValueError:
            continue
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=UTC)
        if timedelta(0) <= now - moment <= KEEP_FOR:
            kept.append(moment.isoformat())
    return kept


def with_box_facts(
    heartbeat: Mapping[str, Any] | None,
    *,
    node: str | None,
    restarts: int | None,
    evictions: int | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The heartbeat with this observation's box facts merged in, as a new
    dict (so the JSON column sees the change). `restarts` and `evictions`
    are counts since the last accepted observation; each adds that many
    copies of `now` to its list, up to the cap."""
    moment = now or datetime.now(UTC)
    current = dict(heartbeat or {})
    facts = current.get(BOX_KEY)
    facts = dict(facts) if isinstance(facts, Mapping) else {}
    day = moment.astimezone(UTC).date().isoformat()
    today = facts.get("restarts_today") if facts.get("day") == day else 0
    today = today if isinstance(today, int) and not isinstance(today, bool) else 0
    new_restarts = max(0, min(restarts or 0, MAX_TIMES))
    new_evictions = max(0, min(evictions or 0, MAX_TIMES))
    stamp = moment.isoformat()
    restart_times = (
        _recent(facts.get("restart_times"), moment) + [stamp] * new_restarts
    )[-MAX_TIMES:]
    eviction_times = (
        _recent(facts.get("eviction_times"), moment) + [stamp] * new_evictions
    )[-MAX_TIMES:]
    current[BOX_KEY] = {
        "node": node if node is not None else facts.get("node"),
        "day": day,
        "restarts_today": min(today + max(0, restarts or 0), MAX_COUNT),
        "restart_times": restart_times,
        "eviction_times": eviction_times,
    }
    return current
