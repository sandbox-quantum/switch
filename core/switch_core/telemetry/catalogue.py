"""Every event the server may report, and every property each one carries.

This is the privacy boundary, enforced rather than documented: an event or a
property not declared here cannot be sent, and no path forwards an arbitrary
string. :func:`validate` holds two rules — the property set is exact (a
property that does not apply carries an explicit ``none``, so a missing key is
always a bug) and values are closed.

``docs/old/telemetry-events.md`` says why each event exists; this says what is
allowed on the wire.
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

# All four connection models in `bridges/agent/protocol/types.py`. Missing one
# drops the registration event for every agent that uses it.
AGENT_TYPE = one_of(
    "always_on", "session_addressable", "session_passive", "auto_session"
)

# The runtime behind an agent, from `known_agent_type` in its metadata.
# `other` covers a runtime Switch has no special knowledge of; `none` covers an
# agent registered without declaring one at all.
KNOWN_AGENT_TYPE = one_of("claude-code", "codex", "opencode", "other", "none")

ACTOR_KIND = one_of("user", "agent", "system")

OUTCOME = one_of("success", "failure")

# The four built-in types. A user-defined type's slug is free text, so it
# reports as `other` rather than going on the wire.
REFERENCE_TYPE = one_of("google_drive", "confluence", "github", "jira", "other")

# Where a document lives. A room document is scoped to one room and never in
# the library; a library one can be attached to many.
DOCUMENT_SCOPE = one_of("library", "room")

# What a key is for. `agent` authenticates a registered agent, `registration`
# mints new ones, `bootstrap` is the deployment-wide key, `other` is anything
# a later type introduces.
API_KEY_TYPE = one_of("agent", "registration", "bootstrap", "other")

VISIBILITY = one_of("private", "public")

# What a template provisions. Free text in the schema; these are the three the
# product itself uses, and anything an operator invents reports as `other`.
TEMPLATE_KIND = one_of("room", "group", "agent", "other")

# Shared by the connect and disconnect events: one classifier feeds both, so a
# value only one of them declares fails validation when a bridge drops.
BRIDGE_FAILURE_REASON = one_of(
    "none", "auth_failed", "network", "platform_error", "config_invalid", "unknown"
)


# ── The catalogue ────────────────────────────────────────────────────────────

_SNAPSHOT_COUNTS = (
    "tenant_count",
    "user_count",
    "user_active_1d",
    "user_active_7d",
    # `room_count` is the headline: rooms a *person* made. The other two keep
    # agent scratch rooms and adopted channels out of it.
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
    # Connections, not distinct agents: an agent may hold several. No
    # "sessions started today" — nothing durable records one, so it could only
    # be an in-process tally a restart resets. `agent_session_started` covers it.
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
    # A turn is a message classified by who sent the one before it. A
    # sender-only count reports an agent answering a person and two agents
    # talking to each other identically.
    "turn_human_to_agent_1d",
    "turn_agent_to_human_1d",
    "turn_agent_to_agent_1d",
    "attachment_count_1d",
    # Stock rather than flow. The `*_attached_count` figures sit beside the
    # totals because the gap between made and used is the signal.
    "reference_count",
    "reference_attached_count",
    "document_count",
    "document_attached_count",
    "package_count",
    "room_group_count",
    "api_key_count",
)

# Every milestone answers "how long after install did this first happen", so
# they share a property and differ only in what else they carry.
_SINCE_INSTALL: Mapping[str, PropertyType] = {"seconds_since_install": NUMBER}


CATALOGUE: Mapping[str, Mapping[str, PropertyType]] = {
    # ── The daily snapshot ───────────────────────────────────────────────────
    # Counted locally, where the ids are known; only totals are reported.
    "usage_snapshot": {name: NUMBER for name in _SNAPSHOT_COUNTS},
    # ── Milestones ───────────────────────────────────────────────────────────
    # At most once per deployment, and only for one installed after this
    # shipped. Together they are the activation funnel.
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
    # The version is a resource attribute, so this is the upgrade curve.
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
    # Counts fall for several reasons and only these say which. Each carries
    # the lifespan: deleted after an hour and after a year mean opposite things.
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
        # Removed having never connected is a failed setup; removed after
        # months is a decision.
        "was_ever_connected": BOOLEAN,
        "room_count": NUMBER,
    },
    "agent_registered": {
        "agent_type": AGENT_TYPE,
        "known_agent_type": KNOWN_AGENT_TYPE,
        # `gateway` is Console *and* the browser dashboard: they authenticate
        # identically, so the server cannot tell them apart.
        "registration_path": one_of("bootstrap", "personal_key", "gateway", "other"),
        "has_parent": BOOLEAN,
    },
    # No "start source": the server sees an authenticated connection whether a
    # person launched the session or Console spawned it.
    "agent_session_started": {"known_agent_type": KNOWN_AGENT_TYPE},
    # No runtime: the connection registry is the only thing that knows a
    # session ended and it holds none. Starts carry it.
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
    # ── Resources, keys and groups ───────────────────────────────────────────
    # Creating is intent, attaching is use, and the gap between them is the
    # signal — hence both.
    "reference_created": {
        "reference_type": REFERENCE_TYPE,
        "read_visibility": VISIBILITY,
        "created_by_kind": ACTOR_KIND,
    },
    "reference_attached_to_room": {"reference_type": REFERENCE_TYPE},
    "reference_deleted": {"reference_type": REFERENCE_TYPE, "age_days": NUMBER},
    "document_created": {
        "scope": DOCUMENT_SCOPE,
        "created_by_kind": ACTOR_KIND,
        "has_instructions": BOOLEAN,
    },
    "document_attached_to_room": {},
    "document_deleted": {"scope": DOCUMENT_SCOPE, "age_days": NUMBER},
    "package_created": {"created_by_kind": ACTOR_KIND},
    "package_attached_to_room": {"reference_count": NUMBER, "document_count": NUMBER},
    "package_deleted": {"age_days": NUMBER},
    "api_key_created": {"key_type": API_KEY_TYPE},
    "api_key_revoked": {"key_type": API_KEY_TYPE, "age_days": NUMBER},
    "room_group_created": {"has_parent": BOOLEAN},
    "room_group_deleted": {"room_count": NUMBER, "age_days": NUMBER},
    # The schema, not an instance: registering one extends what Switch can
    # point at.
    "reference_type_created": {},
    "reference_type_deleted": {"age_days": NUMBER},
    "template_created": {"template_kind": TEMPLATE_KIND},
    "template_deleted": {"template_kind": TEMPLATE_KIND, "age_days": NUMBER},
    "room_link_created": {},
    "room_link_removed": {},
    "room_role_defined": {"exclusive": BOOLEAN},
    "room_role_deleted": {},
    "room_users_added": {"user_count": NUMBER},
    # The inverse of the attaches: tried and dropped, as against never used.
    "reference_detached_from_room": {"reference_type": REFERENCE_TYPE},
    "document_detached_from_room": {},
    "package_detached_from_room": {},
    # Switch reaching out to an agent host, rather than one connecting in.
    "server_connector_registered": {"connector_kind": one_of("opencode", "other")},
    "server_connector_removed": {"connector_kind": one_of("opencode", "other")},
    # Configured, not connected. Many of these and few `bridge_connected` is a
    # deployment whose setup is failing.
    "connector_configured": {"bridge_platform": BRIDGE_PLATFORM},
    "invitation_sent": {},
    "invitation_accepted": {"age_hours": NUMBER},
    "bridge_disconnected": {
        "bridge_platform": BRIDGE_PLATFORM,
        # Shutdown reasons plus every failure `bridge_connected` can carry.
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
