"""Every event the server may report, and every property each one carries.

The catalogue is the whole privacy boundary. An event is describable here or it
cannot be sent; a property is declared here or it cannot be sent. There is no
path that takes an arbitrary string and forwards it, which is what makes "the
server never reports a room name" a property of the code rather than a promise
about how carefully call sites are written.

Two rules follow from that, and both are enforced in :func:`validate`:

- **The property set is exact.** Not a subset and not a superset — an event
  carries every property its spec names, every time. A property that does not
  apply carries an explicit ``none`` rather than being left out, so a missing key
  is always a bug and never a case the reader has to guess at.
- **Values are closed.** A property is a number, a boolean, or one of a fixed
  set of strings. Nothing accepts free text, so no call site can widen the
  catalogue by passing something new; a value outside the set raises where the
  event is built.

The design note is ``docs/old/telemetry-events.md``, which explains why each
event exists and what question it answers. This file is the enforceable half of
it and the two are meant to be read together.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

# The wire prefix. One Amplitude project holds several products, so every event
# is namespaced by the one that sent it — the Console sends `switch_console.*`
# against the same relay.
EVENT_NAME_PREFIX = "switch_core"


class PropertyType:
    """Base for the three kinds of value a property may take."""

    def check(self, value: object) -> str | None:
        """Return a human-readable reason the value is unacceptable, or None."""
        raise NotImplementedError


@dataclass(frozen=True)
class _Number(PropertyType):
    def check(self, value: object) -> str | None:
        # bool is a subclass of int; a boolean where a count belongs is a
        # mistake worth naming rather than silently recording as 0 or 1.
        if isinstance(value, bool) or not isinstance(value, int | float):
            return f"expected a number, got {type(value).__name__}"
        if value != value or value in (float("inf"), float("-inf")):
            return "expected a finite number"
        return None


@dataclass(frozen=True)
class _Boolean(PropertyType):
    def check(self, value: object) -> str | None:
        if not isinstance(value, bool):
            return f"expected a boolean, got {type(value).__name__}"
        return None


@dataclass(frozen=True)
class _OneOf(PropertyType):
    values: frozenset[str]

    def check(self, value: object) -> str | None:
        if not isinstance(value, str):
            return f"expected one of {sorted(self.values)}, got {type(value).__name__}"
        if value not in self.values:
            return f"expected one of {sorted(self.values)}, got {value!r}"
        return None


NUMBER = _Number()
BOOLEAN = _Boolean()


def one_of(*values: str) -> _OneOf:
    return _OneOf(frozenset(values))


class TelemetryCatalogueError(Exception):
    """An event does not match the catalogue.

    Always a programming error rather than a runtime condition: the event name,
    the property names and the set of values a property may take are all fixed
    at author time. Raised rather than logged so it fails in the test that
    builds the event, not in production as a silently malformed record.
    """


# ── Shared value sets ────────────────────────────────────────────────────────

# The five collaboration platforms, plus the absence of one. `none` rather than
# omitting the property: see the module docstring on exact property sets.
BRIDGE_PLATFORM = one_of("slack", "mattermost", "discord", "teams", "telegram", "none")

CHANNEL_TYPE = one_of("channel_public", "channel_private", "direct", "none")

# How an agent behaves in a room, as `agents.agent_type` records it — the
# connection models in `bridges/agent/protocol/types.py`, all four of them.
# `auto_session` is the one Switch Console sets whenever a user ticks
# auto-session, so leaving it out dropped the registration event for exactly
# the population the Console exists to serve.
AGENT_TYPE = one_of(
    "always_on", "session_addressable", "session_passive", "auto_session"
)

# The runtime behind an agent, from `known_agent_type` in its metadata.
# `other` covers a runtime Switch has no special knowledge of; `none` covers an
# agent registered without declaring one at all.
KNOWN_AGENT_TYPE = one_of("claude-code", "codex", "opencode", "other", "none")

ACTOR_KIND = one_of("user", "agent", "system")

OUTCOME = one_of("success", "failure")

# Why a bridge failed, shared by the connect and disconnect events because one
# classifier (`bridges/collaboration/lifecycle_service._failure_reason`) feeds
# both. `none` belongs only to the success case and is stripped where the event
# has no success case.
BRIDGE_FAILURE_REASON = one_of(
    "none", "auth_failed", "network", "platform_error", "config_invalid", "unknown"
)


# ── The catalogue ────────────────────────────────────────────────────────────

_SNAPSHOT_COUNTS = (
    "tenant_count",
    "user_count",
    "user_active_1d",
    "user_active_7d",
    # Rooms, split three ways rather than two. `room_count` is the headline —
    # rooms a person made — and the other two exist so that folding a channel
    # Switch was merely invited to, or one an agent made for its own
    # orchestration, into that figure is not possible by accident.
    "room_count",
    "room_agent_created_count",
    "room_system_created_count",
    "room_active_1d",
    "room_active_7d",
    "room_archived_count",
    "room_internal_only_count",
    "room_membership_total",
    "room_users_mean",
    "room_users_max",
    "agent_count",
    "agent_active_7d",
    "agent_claude_code_count",
    "agent_codex_count",
    "agent_opencode_count",
    "agent_other_count",
    # Connections open right now, not distinct agents holding one: an agent
    # may hold several, and counting agents would report 1 for ten people
    # running two windows each. "Sessions started today" is deliberately
    # absent — nothing durable records a session opening, so the snapshot
    # could only report an in-process tally that a restart silently resets.
    # `agent_session_started` is emitted per occurrence instead, and counting
    # those is the analytics tool's job.
    "session_live_count",
    "connector_slack_count",
    "connector_mattermost_count",
    "connector_discord_count",
    "connector_teams_count",
    "connector_telegram_count",
    "connector_configured_count",
    "message_count_1d",
    "message_from_human_1d",
    "message_from_agent_1d",
    # Turns, not senders. A turn is one message classified by who sent the
    # message *before* it in the same room, which is the only way to tell an
    # agent answering a person from two agents talking to each other — a
    # sender-only count reports both as "from an agent" and hides the
    # difference that matters.
    "turn_human_to_agent_1d",
    "turn_agent_to_human_1d",
    "turn_agent_to_agent_1d",
    "attachment_count_1d",
)

# Every milestone answers "how long after install did this first happen", so
# they share a property and differ only in what else they carry.
_SINCE_INSTALL: Mapping[str, PropertyType] = {"seconds_since_install": NUMBER}


CATALOGUE: Mapping[str, Mapping[str, PropertyType]] = {
    # ── The daily snapshot ───────────────────────────────────────────────────
    # One per deployment per day. Counts are gathered locally, where the server
    # legitimately knows the ids, and only totals are reported — which is what
    # lets the catalogue answer "how many active rooms" without any room ever
    # being identifiable.
    "usage_snapshot": {name: NUMBER for name in _SNAPSHOT_COUNTS},
    # ── Milestones ───────────────────────────────────────────────────────────
    # At most once per deployment, ever, and only for deployments installed
    # after this shipped. Together they are the activation funnel.
    # The funnel's origin. Carries the elapsed time like every other milestone
    # — normally a few seconds, since it is claimed on the first boot after
    # install, and visibly longer for a deployment that switched reporting on
    # some time after it was set up. That difference is worth being able to
    # see rather than flatten to zero: it says the funnel's origin is not
    # where it appears to be.
    "deployment_installed": dict(_SINCE_INSTALL),
    "first_connector_added": {**_SINCE_INSTALL, "bridge_platform": BRIDGE_PLATFORM},
    "first_room_created": {
        **_SINCE_INSTALL,
        "channel_type": CHANNEL_TYPE,
        "bridge_platform": BRIDGE_PLATFORM,
    },
    "first_room_active": {
        **_SINCE_INSTALL,
        "bridge_platform": BRIDGE_PLATFORM,
        "seconds_since_room_created": NUMBER,
    },
    "first_agent_registered": {
        **_SINCE_INSTALL,
        "known_agent_type": KNOWN_AGENT_TYPE,
    },
    "first_session_started": {**_SINCE_INSTALL, "known_agent_type": KNOWN_AGENT_TYPE},
    # ── Lifecycle ────────────────────────────────────────────────────────────
    # The version is already a resource attribute, so this is the upgrade
    # curve: which versions are actually running, and how many tenants each
    # carries. Deliberately no "did this boot migrate" flag — migrations run
    # in a different event loop from the server, so the answer would have to
    # be smuggled across on a module global, and it is operational trivia
    # rather than something the product wants to know.
    "deployment_started": {"tenant_count": NUMBER},
    "room_created": {
        "channel_type": CHANNEL_TYPE,
        "bridge_platform": BRIDGE_PLATFORM,
        "agent_count": NUMBER,
        "human_count": NUMBER,
        "has_instructions": BOOLEAN,
        "created_by_kind": ACTOR_KIND,
        "from_template": BOOLEAN,
    },
    "room_became_active": {
        "seconds_since_room_created": NUMBER,
        "bridge_platform": BRIDGE_PLATFORM,
        "channel_type": CHANNEL_TYPE,
        "agent_count": NUMBER,
        "created_by_kind": ACTOR_KIND,
    },
    "room_archived": {
        "bridge_platform": BRIDGE_PLATFORM,
        "age_days": NUMBER,
        "was_ever_active": BOOLEAN,
    },
    "room_agents_added": {"agent_count": NUMBER, "added_by_kind": ACTOR_KIND},
    "room_agents_removed": {"agent_count": NUMBER, "removed_by_kind": ACTOR_KIND},
    # ── Removals ─────────────────────────────────────────────────────────────
    # Every count in the snapshot can fall, and without these nothing says
    # why. A drop in `room_count` is a customer tidying up, a bridge being
    # disconnected, or a deployment being abandoned — three very different
    # readings of the same line on a chart, and the difference is only
    # recoverable if the removal was reported when it happened.
    #
    # Each carries the lifespan of the thing removed, because "deleted after
    # an hour" and "deleted after a year" are opposite signals: the first is a
    # mistake or an experiment, the second is a deliberate clean-up.
    "room_deleted": {
        "bridge_platform": BRIDGE_PLATFORM,
        "channel_type": CHANNEL_TYPE,
        "created_by_kind": ACTOR_KIND,
        "age_days": NUMBER,
        "was_ever_active": BOOLEAN,
        "agent_count": NUMBER,
    },
    "agent_deleted": {
        "known_agent_type": KNOWN_AGENT_TYPE,
        "age_days": NUMBER,
        "room_count": NUMBER,
        "had_parent": BOOLEAN,
    },
    "connector_removed": {
        "bridge_platform": BRIDGE_PLATFORM,
        "age_days": NUMBER,
        # Whether it ever worked. A connector removed having never connected
        # is a failed setup; one removed after months of service is a
        # decision. Counting both as "removed" hides the first, which is the
        # one worth acting on.
        "was_ever_connected": BOOLEAN,
        "room_count": NUMBER,
    },
    "agent_registered": {
        "agent_type": AGENT_TYPE,
        "known_agent_type": KNOWN_AGENT_TYPE,
        # What the server can actually distinguish, which is not quite what
        # a reader might expect. `gateway` covers both Switch Console and the
        # browser dashboard: they authenticate the same session-backed way
        # against the same endpoint, so telling them apart would need the
        # client to say which it is. `console` would have been a value that
        # looked precise and was a guess.
        "registration_path": one_of("bootstrap", "personal_key", "gateway", "other"),
        "has_parent": BOOLEAN,
    },
    # Deliberately only the runtime. How a session was *started* — a person
    # launching it against one Switch Console spawned automatically — is not
    # visible from here: the server sees an authenticated connection either
    # way. A property that is the same value on every emission is a dimension
    # that cannot segment anything, which is worse than not having it, so if
    # that distinction is wanted it belongs on a Console-side event that knows
    # the answer.
    "agent_session_started": {"known_agent_type": KNOWN_AGENT_TYPE},
    # Duration and cause, and deliberately not the runtime. The connection
    # registry is the only thing that knows a session has ended, and it holds
    # no runtime — the client's self-declared `artifact` is free text, which
    # may not be sent, and looking the agent up would put a database query on
    # a path that runs from the connection sweep. Session *starts* carry the
    # runtime, so the mix is available from those; what this answers is how
    # long sessions last and why they stop.
    "agent_session_ended": {
        "duration_seconds": NUMBER,
        "reason": one_of(
            "normal", "heartbeat_lapsed", "replaced", "room_claimed", "error"
        ),
    },
    "connector_added": {
        "bridge_platform": BRIDGE_PLATFORM,
        "seconds_since_install": NUMBER,
        "seconds_since_configured": NUMBER,
        "is_first_connector": BOOLEAN,
        "failed_attempts_before_success": NUMBER,
    },
    "bridge_connected": {
        "bridge_platform": BRIDGE_PLATFORM,
        "outcome": OUTCOME,
        # `none` on success, so the property set stays exact either way.
        "failure_reason": BRIDGE_FAILURE_REASON,
    },
    "bridge_disconnected": {
        "bridge_platform": BRIDGE_PLATFORM,
        # The deliberate-shutdown reasons, plus every failure reason
        # `bridge_connected` can carry. One classifier feeds both events, so a
        # value it can produce and only one of them declares is an event that
        # fails validation at the moment a bridge drops — which is precisely
        # the event worth not losing.
        "reason": one_of(
            "shutdown",
            "restart",
            *sorted(BRIDGE_FAILURE_REASON.values - {"none"}),
        ),
    },
}


PropertyValue = str | int | float | bool


def wire_name(event: str) -> str:
    """The prefixed name as the relay sees it."""
    return f"{EVENT_NAME_PREFIX}.{event}"


def validate(event: str, properties: Mapping[str, PropertyValue]) -> None:
    """Raise unless `properties` is exactly what `event` declares.

    Checks the three things that would each, on their own, let something
    unintended reach the relay: an event nobody declared, a property nobody
    declared, and a value outside the set its property allows. A missing
    property is checked too — not for privacy but for the charts, since an
    event whose keys vary between emissions cannot be grouped on them.
    """
    spec = CATALOGUE.get(event)
    if spec is None:
        raise TelemetryCatalogueError(
            f"{event!r} is not a telemetry event. Add it to CATALOGUE in "
            "telemetry/catalogue.py (and to docs/old/telemetry-events.md) "
            "rather than sending an undeclared one."
        )

    given = set(properties)
    declared = set(spec)
    if undeclared := sorted(given - declared):
        raise TelemetryCatalogueError(
            f"{event!r} does not declare {undeclared}. Every property must be "
            "in the catalogue: this is the check that stops an identifier or a "
            "free-text value reaching the relay by accident."
        )
    if missing := sorted(declared - given):
        raise TelemetryCatalogueError(
            f"{event!r} is missing {missing}. Every event of a name carries the "
            "same keys every time — pass the explicit 'none'/0/False rather "
            "than omitting one."
        )

    for name, value in properties.items():
        if reason := spec[name].check(value):
            raise TelemetryCatalogueError(f"{event!r}.{name}: {reason}.")
