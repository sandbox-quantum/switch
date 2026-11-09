"""Every event the server may report, and every property each one carries.

This is the privacy boundary, enforced rather than documented: an event or a
property not declared here cannot be sent, and no path forwards an arbitrary
string. :func:`validate` holds two rules — the property set is exact (a
property that does not apply carries an explicit ``none``, so a missing key is
a bug, unless the property is declared :func:`optional`) and values are
closed.

``docs/old/telemetry-events.md`` says why each event exists; this says what is
allowed on the wire.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from switch_core import messaging_platforms

# The wire prefix. One Amplitude project holds several products, so every event
# is namespaced by the one that sent it — the Console sends `switch_console.*`
# against the same relay.
EVENT_NAME_PREFIX = "switch_core"

# Added to every event by the service, not declared by any: who runs the
# deployment (`SwitchConfig.deployment_kind`), so Switch Cloud's traffic can be
# told from the servers people run themselves on any chart. Reserved, so no
# event can declare a property of its own under the name.
DEPLOYMENT_KIND_PROPERTY = "deployment_kind"


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


@dataclass(frozen=True)
class _Optional(PropertyType):
    """A property an event leaves out when its value is not known.

    For a number that has no honest stand-in: an age whose timestamp could not
    be read, a room size whose room could not be looked up. A sentinel such as
    -1 is summed and averaged like any other value unless every chart filters
    it, where an absent property is skipped by every aggregation. A caller
    passes None, and the service leaves the key out.
    """

    kind: PropertyType

    def check(self, value: object) -> str | None:
        return self.kind.check(value)


def optional(kind: PropertyType) -> _Optional:
    return _Optional(kind)


class TelemetryCatalogueError(Exception):
    """An event does not match the catalogue.

    Always a programming error rather than a runtime condition: the event name,
    the property names and the set of values a property may take are all fixed
    at author time. Raised rather than logged so it fails in the test that
    builds the event, not in production as a silently malformed record.
    """


# ── Shared value sets ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _RegisteredPlatform(PropertyType):
    """A messaging platform this build registered, or one of `extra`.

    Closed like `one_of`, but the set is read when an event is checked rather
    than written here: it is exactly the adapters registered with the
    collaboration lifecycle, so adding a platform adds its value without an
    edit to this file. Still no free text — a platform key is code, shaped by
    `messaging_platforms.PLATFORM_KEY_PATTERN`, and a value nobody registered
    is refused like any other undeclared value.
    """

    extra: frozenset[str]

    @property
    def values(self) -> frozenset[str]:
        return self.extra | frozenset(messaging_platforms.keys())

    def check(self, value: object) -> str | None:
        allowed = self.values
        if not isinstance(value, str):
            return f"expected one of {sorted(allowed)}, got {type(value).__name__}"
        if value not in allowed:
            return f"expected one of {sorted(allowed)}, got {value!r}"
        return None


# Every registered collaboration platform, plus the absence of one. `none`
# rather than omitting the property: see the module docstring on exact property
# sets. `unknown` is a third, distinct case — not "no bridge" but "there is one
# and we could not resolve it" (the lookup itself failed, or its platform is no
# longer registered) — so a transient error is never misreported as an
# internal-only room.
BRIDGE_PLATFORM = _RegisteredPlatform(frozenset({"none", "unknown"}))


def connector_count_property(platform: str) -> str:
    """The `usage_snapshot` property counting one platform's connections."""
    return f"connector_{platform}_count"


# `unknown` as for BRIDGE_PLATFORM: the room exists and the lookup that would
# have named its type failed, which is not the same as it having none.
CHANNEL_TYPE = one_of("channel_public", "channel_private", "direct", "none", "unknown")

# All four connection models in `bridges/agent/protocol/types.py`. Missing one
# drops the registration event for every agent that uses it.
AGENT_TYPE = one_of(
    "always_on", "session_addressable", "session_passive", "auto_session"
)

# The runtime behind an agent, from `known_agent_type` in its metadata.
# `other` covers a runtime Switch has no special knowledge of; `none` covers an
# agent registered without declaring one at all.
KNOWN_AGENT_TYPE = one_of("claude-code", "codex", "opencode", "other", "none")

# The runtime as `message_sent` reports it for an agent's message. That event
# looks the sending agent up after the fact, so it has a third answer:
# `unknown`, for a lookup that failed or found no agent.
LOOKED_UP_AGENT_TYPE = one_of(*KNOWN_AGENT_TYPE.values, "unknown")

ACTOR_KIND = one_of("user", "agent", "system")

# Who said a message. `user` is a person on a messaging platform and `member`
# a person in Switch Console; `bot` is an integration posting on a platform (a
# Slack app, a Discord bot or webhook, a Mattermost bot account, another
# Switch server's agent). `platform` is Switch itself speaking — a template's
# kickoff, or a request it carries on a person's behalf — and `unknown` a
# sender whose client could not be looked up.
SENDER_KIND = one_of("user", "member", "bot", "agent", "platform", "unknown")

# Who joined or left a room through Switch Console.
CONSOLE_MEMBER_KIND = one_of("person", "agent")

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
API_KEY_TYPE = one_of("agent", "registration", "bootstrap", "retired", "other")

VISIBILITY = one_of("private", "public")

# What a template provisions. Free text in the schema; these are the three the
# product itself uses, and anything an operator invents reports as `other`.
TEMPLATE_KIND = one_of("room", "group", "agent", "other")

# Shared by the connect and disconnect events: one classifier feeds both, so a
# value only one of them declares fails validation when a bridge drops.
BRIDGE_FAILURE_REASON = one_of(
    "none", "auth_failed", "network", "platform_error", "config_invalid", "unknown"
)

# A yes/no fact the server sometimes cannot establish — a failed lookup reports
# `unknown` rather than collapsing "could not tell" into `false`, a value the
# code has no evidence for. Not BOOLEAN: a property that can be unknown is a
# three-valued fact, not a boolean with a spare bit smuggled into it.
TRISTATE = one_of("true", "false", "unknown")


# Which decision backend a workspace's auto-route used: the server's own
# decision service as its default, the workspace's own endpoint, or Haiku.
DECISION_BACKEND = one_of(
    "server_default", "endpoint", "haiku_anthropic", "haiku_bedrock"
)

# The confidence the decision service gave its choice, in tenths above one
# half, where a threshold sits; `none` when it gave none.
DECISION_CONFIDENCE = one_of(
    "none", "lt_0.5", "0.5_0.6", "0.6_0.7", "0.7_0.8", "0.8_0.9", "0.9_1.0"
)

# Why a decision service gave no usable answer: no answer in time, no
# connection, an answer other than 200, an answer that was not a decision (or
# named an agent that was not a candidate), a workspace key the server can no
# longer decrypt, or a workspace endpoint the server's outbound policy refuses.
DECISION_FAILURE_REASON = one_of(
    "timeout",
    "unreachable",
    "error_status",
    "bad_answer",
    "key_unreadable",
    "endpoint_refused",
)


# ── The catalogue ────────────────────────────────────────────────────────────

_SNAPSHOT_COUNTS = (
    # How many tenants are actually behind every other number here, which is
    # not how many the deployment has: a tenant whose queries fail is stepped
    # over, and `tenant_failed_count` says how many. Without the pair a partial
    # pass is a drop in every count at once with nothing to attribute it to —
    # indistinguishable from a deployment losing its users.
    "tenant_count",
    "tenant_failed_count",
    "user_count",
    "user_internal_count",
    # Switch accounts, not chat identities — see `chat_identity_*` for those.
    # The period events' `account_active` counts these per period, and adds
    # accounts that used Switch Console chat.
    "user_active_1d",
    "user_active_7d",
    "user_internal_active_1d",
    "user_internal_active_7d",
    "chat_identity_count",
    # Counts an integration's identity as a person; the period events'
    # `person_identity_active` and `bot_identity_active` split the two.
    "chat_identity_active_1d",
    "chat_identity_active_7d",
    # `room_count` is the headline: rooms a *person* made. The other two keep
    # agent scratch rooms and adopted channels out of it.
    "room_count",
    "room_agent_created_count",
    "room_system_created_count",
    "room_active_1d",
    "room_active_7d",
    "room_archived_count",
    "room_internal_only_count",
    # Switch Console chats: 1-1 with an agent, with more than one person, and
    # used in the last week. Already in the counts above by origin.
    "room_console_chat_direct_count",
    "room_console_chat_group_count",
    "room_console_chat_active_7d",
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
    # be an in-process tally a restart resets. `session_started` covers it.
    "session_live_count",
    # Plus one `connector_<platform>_count` per registered platform; see
    # `event_spec`.
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
    # The tiers of activity, as chat identities. `chat_identity_active_*`
    # above is the most active (spoke in a room with an agent in it);
    # `chat_identity_posted_*` is anyone who said anything in any room;
    # `chat_identity_in_room_count` is everyone Switch has seen in a room: a
    # member of a live room, or anyone who posted in the last seven days. Not
    # the channels' full audience — Switch records a person only once they
    # post, are added by name, or join after the channel was adopted, so a
    # member who has only ever read is not in it.
    "chat_identity_posted_1d",
    "chat_identity_posted_7d",
    "chat_identity_in_room_count",
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

# What each period event counts (`snapshot.PeriodCounts`), read from the
# database for the whole period. `is_partial` says the period began before the
# deployment was installed or before telemetry was last switched on: it is the
# first of its length the deployment reports, dated no earlier than that.
_PERIOD_COUNTS: Mapping[str, PropertyType] = {
    "room_active": NUMBER,
    "person_identity_active": NUMBER,
    "bot_identity_active": NUMBER,
    "account_active": NUMBER,
    "agent_active": NUMBER,
    # From the message table, so it can be set against the message events
    # received to see how many were lost on the way.
    "message_count": NUMBER,
    "turn_human_to_agent": NUMBER,
    "turn_agent_to_human": NUMBER,
    "turn_agent_to_agent": NUMBER,
    # Accounts that spoke in Switch Console chat, and of those, the ones no
    # platform account of theirs spoke for in the same period.
    "console_account_active": NUMBER,
    "console_only_account_active": NUMBER,
    "is_partial": BOOLEAN,
    "tenant_failed_count": NUMBER,
}

# Every milestone answers "how long after install did this first happen", so
# they share a property and differ only in what else they carry.
_SINCE_INSTALL: Mapping[str, PropertyType] = {"seconds_since_install": NUMBER}


CATALOGUE: Mapping[str, Mapping[str, PropertyType]] = {
    # ── The daily snapshot ───────────────────────────────────────────────────
    # Counted locally, where the ids are known; only totals are reported.
    # `duration_ms` is how long the pass took to collect. It is roughly twenty
    # queries per tenant, on a schedule, against the same database serving
    # rooms — "what does this cost at scale" is an open question in
    # `docs/old/telemetry-events.md`, and this is the only place it can be
    # answered from.
    "usage_snapshot": {
        **{name: NUMBER for name in _SNAPSHOT_COUNTS},
        "duration_ms": NUMBER,
    },
    # One per finished UTC day, ISO week and calendar month, dated to its
    # middle: distinct use over exactly that period, so the events of one
    # kind add up across deployments where the snapshot's trailing `*_7d`
    # counts, summed over days, count each room up to seven times.
    "usage_day_counted": dict(_PERIOD_COUNTS),
    "usage_week_counted": dict(_PERIOD_COUNTS),
    "usage_month_counted": dict(_PERIOD_COUNTS),
    # ── Accounts, workspaces and cloud machines ─────────────────────────────
    # Switch Cloud's funnel, though any server that has them sends them:
    # `deployment_kind`, on every event, says which kind of server it was.
    "account_created": {"method": one_of("signup", "oidc", "admin")},
    "signup_refused": {
        "reason": one_of("disabled", "rate_limited", "email_taken", "country")
    },
    "workspace_created": {"new_organization": BOOLEAN},
    # One per claim that changed something, naming the first of these that
    # applies: a retained machine joined from another workspace is
    # `joined_workspace`, though the claim runs it again as well.
    "cloud_machine_requested": {
        "change": one_of("new", "joined_workspace", "unretained", "restarted"),
    },
    # `provisioning_seconds` is from the claim to the first controller report,
    # for a new machine; left out for a later start, which nothing times.
    "cloud_machine_ready": {
        "new_machine": BOOLEAN,
        "provisioning_seconds": optional(NUMBER),
    },
    "cloud_machine_failed": {
        "reason": one_of(
            "not_scheduled",
            "never_started",
            "never_connected",
            "owner_left",
            "needs_attention",
            "reported",
        ),
    },
    # A person's starts and stops apart from Switch's own, so the two can be
    # told apart by name: Switch waking a machine it put to sleep because its
    # agent was addressed or placed, and putting it to sleep when idle, are
    # not anyone using it.
    "cloud_machine_woken": {"trigger": one_of("message", "agent_placed")},
    "cloud_machine_idle_stopped": {},
    "cloud_machine_started": {"stopped_by": one_of("idle", "owner", "unknown")},
    "cloud_machine_stopped": {},
    # ── Milestones ───────────────────────────────────────────────────────────
    # At most once per deployment, and only for one installed after this
    # shipped. Together they are the activation funnel.
    "deployment_installed": dict(_SINCE_INSTALL),
    # The first connector a person added. One the setup step registered itself
    # never claims it, or the bundled Mattermost would, seconds after install.
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
    # An agent's first live connection. Released servers sent the same moment
    # as `first_session_started`, which is no longer sent; on a deployment that
    # sent it, this is claimed in its place (`SUPERSEDED_MILESTONES`).
    "first_agent_connected": {**_SINCE_INSTALL, "known_agent_type": KNOWN_AGENT_TYPE},
    # The first coding-agent session a host reported (`session_started`): an
    # agent doing work, not just coming online. A deployment that had already
    # done either before this existed claims it without reporting, so it never
    # announces a "first" months in (`settle_superseded_milestones`).
    "first_agent_session": {
        **_SINCE_INSTALL,
        "known_agent_type": KNOWN_AGENT_TYPE,
        "start_source": one_of("user", "room", "automation", "unknown"),
    },
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
        "console_chat": BOOLEAN,
    },
    "room_became_active": {
        "seconds_since_room_created": NUMBER,
        "bridge_platform": BRIDGE_PLATFORM,
        "channel_type": CHANNEL_TYPE,
        "agent_count": NUMBER,
        "created_by_kind": ACTOR_KIND,
        "console_chat": BOOLEAN,
    },
    "room_archived": {
        "bridge_platform": BRIDGE_PLATFORM,
        "age_days": optional(NUMBER),
        "was_ever_active": TRISTATE,
        "console_chat": BOOLEAN,
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
        "age_days": optional(NUMBER),
        "was_ever_active": TRISTATE,
        "agent_count": NUMBER,
        "console_chat": BOOLEAN,
    },
    "agent_deleted": {
        "known_agent_type": KNOWN_AGENT_TYPE,
        "age_days": optional(NUMBER),
        "room_count": NUMBER,
        "had_parent": BOOLEAN,
    },
    "connector_removed": {
        "bridge_platform": BRIDGE_PLATFORM,
        "age_days": optional(NUMBER),
        # Removed having never connected is a failed setup; removed after
        # months is a decision. `unknown` when the durable record itself
        # could not be read — that is not evidence either way, and reporting
        # it as `false` would misfile a lookup failure as a failed setup.
        "was_ever_connected": TRISTATE,
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
    # An agent coming online: its first live connection. No "start source": the
    # server sees an authenticated connection whether a person launched the
    # session or Console spawned it. `session_started` is the one that says.
    # Released servers sent it as `agent_session_started`.
    "agent_connected": {"known_agent_type": KNOWN_AGENT_TYPE},
    # A coding-agent session starting, as its host reports it once, when the
    # session is new. `start_source` is what the launcher stamped on it: `user`
    # a person starting one in Console, `room` the agent being addressed in a
    # room, `automation` Console's local automation API, and `unknown` a
    # launcher that said nothing — reported rather than dropped, so a launch
    # path nobody stamped shows up as a gap instead of as no sessions.
    "session_started": {
        "start_source": one_of("user", "room", "automation", "unknown"),
        "known_agent_type": KNOWN_AGENT_TYPE,
    },
    # No runtime: the connection registry is the only thing that knows a
    # session ended and it holds none. Starts carry it. Dated to the last
    # connection closing, not to the end of the grace that confirmed it.
    # Released servers sent it as `agent_session_ended`.
    "agent_disconnected": {
        "duration_seconds": NUMBER,
        "reason": one_of(
            "normal", "heartbeat_lapsed", "replaced", "room_claimed", "error"
        ),
    },
    "connector_added": {
        "bridge_platform": BRIDGE_PLATFORM,
        # Left out where the deployment has no install clock.
        "seconds_since_install": optional(NUMBER),
        "seconds_since_configured": optional(NUMBER),
        # Registered by the deployment's setup step (the bundled Mattermost)
        # rather than by a person. Filter these out to measure onboarding.
        "is_preconfigured": BOOLEAN,
        # The first connector a person added: never true for a preconfigured
        # one, and a preconfigured one already running does not make it false.
        "is_first_connector": BOOLEAN,
        "failed_attempts_before_success": NUMBER,
    },
    "bridge_connected": {
        # Which side of the bridge: always "collaboration" today; "agent" is
        # declared so the agent bridge can report the same events.
        "bridge": one_of("collaboration", "agent"),
        "bridge_platform": BRIDGE_PLATFORM,
        "outcome": OUTCOME,
        # `none` on success, so the property set stays exact either way.
        "failure_reason": BRIDGE_FAILURE_REASON,
        # How long the attempt took. Nothing else times this: connecting a
        # bridge is a background task rather than a request the server serves,
        # so it is invisible to `switch.http.request.duration`, and a connect
        # that succeeds after ninety seconds and one that succeeds in two are
        # otherwise the same row. Measured on a monotonic clock, in whole
        # milliseconds, on both outcomes — a failure's latency is the more
        # interesting of the two, because a timeout and a refusal look identical
        # in the failure code and nothing alike in the time.
        "duration_ms": optional(NUMBER),
    },
    # ── Messages ─────────────────────────────────────────────────────────────
    # One per message, unlike everything above. They carry no identifier, so
    # they answer "how much, and between whom", never "who": distinct people
    # come from the period counts and the snapshot. A multi-file post is one
    # message, not one per file.
    #
    # Everything a participant chose to say in a room, on a messaging
    # platform or in Switch Console — the population the tenant is metered
    # for. Notices Switch posts on someone's behalf are not in it.
    # `known_agent_type` is the sending agent's runtime, carried only when an
    # agent said it. The room sizes are its members right now, so averaging
    # them over these events gives the room size a typical message is said to;
    # `room_user_count` separates an agent answering people from agents
    # talking among themselves. A room that could not be read leaves its
    # sizes out.
    "message_sent": {
        "sender_kind": SENDER_KIND,
        "known_agent_type": optional(LOOKED_UP_AGENT_TYPE),
        "bridge_platform": BRIDGE_PLATFORM,
        "channel_type": CHANNEL_TYPE,
        "console_chat": TRISTATE,
        "room_user_count": optional(NUMBER),
        "room_agent_count": optional(NUMBER),
        "has_attachment": BOOLEAN,
        "in_thread": BOOLEAN,
    },
    # A message an agent was asked to act on: addressed to it and let through
    # its addressing policy and budget, whether or not the agent was there to
    # take it. One per agent addressed, so a message naming two agents is two
    # of these and one `message_sent`; a multi-file post delivered in two
    # pieces is not counted again. `agent_live` is whether the agent had a live
    # session for the room when it arrived: false for one that was offline or
    # still starting, and always for a session_passive agent, which reads its
    # messages later rather than live.
    "agent_message_received": {
        "sender_kind": SENDER_KIND,
        "known_agent_type": KNOWN_AGENT_TYPE,
        "bridge_platform": BRIDGE_PLATFORM,
        "channel_type": CHANNEL_TYPE,
        "console_chat": TRISTATE,
        "has_attachment": BOOLEAN,
        "agent_live": BOOLEAN,
    },
    # ── Switch Console chats ─────────────────────────────────────────────────
    # What people do to their chats in Switch Console, reported by the chat
    # service once committed. A chat being made is `room_created` with
    # `console_chat`. Console manages any room a person is in, not only the
    # chats it made, so the membership and list events say which.
    #
    # A direct chat turned group, for good: by a second person or a second
    # agent joining it.
    "console_chat_became_group": {
        "trigger": one_of("person_added", "agent_added"),
        "age_days": optional(NUMBER),
    },
    # Someone added to a room from Console by one of its managers; already in
    # is not an add. A person added is also a `room_users_added`, which counts
    # adds from everywhere; this one says it was Console. `channel_type` is the room's after the add, so a direct
    # chat that this made a group reads `channel_private`.
    "console_member_added": {
        "member_kind": CONSOLE_MEMBER_KIND,
        "channel_type": CHANNEL_TYPE,
        "console_chat": BOOLEAN,
    },
    # Someone taken out of a room from Console. `left` is a person taking
    # themselves out, as against a manager removing them; always false for an
    # agent.
    "console_member_removed": {
        "member_kind": CONSOLE_MEMBER_KIND,
        "left": BOOLEAN,
        "channel_type": CHANNEL_TYPE,
        "console_chat": BOOLEAN,
    },
    # A person taking a room off their own Console list, and putting it back.
    # Only a change is reported: hiding a hidden room is not, and nor is a
    # room coming back on its own because something new was said in it.
    "console_room_hidden": {
        "channel_type": CHANNEL_TYPE,
        "age_days": optional(NUMBER),
        "console_chat": BOOLEAN,
    },
    "console_room_shown": {
        "channel_type": CHANNEL_TYPE,
        "age_days": optional(NUMBER),
        "console_chat": BOOLEAN,
    },
    # ── Decision routing ─────────────────────────────────────────────────────
    # One per message auto-route asked a decision service about. Which agent,
    # room or message is never said: only whether an agent was picked, how
    # sure the service was, how long it took and which kind of backend
    # answered. `latency_ms` is measured by Switch, around the whole request.
    "decision_made": {
        "backend": DECISION_BACKEND,
        "outcome": one_of("agent", "none"),
        "confidence": DECISION_CONFIDENCE,
        "latency_ms": NUMBER,
    },
    # A decision service that gave no usable answer, so the message went to
    # nobody, or to the room's triage agent.
    "decision_failed": {
        "backend": DECISION_BACKEND,
        "reason": DECISION_FAILURE_REASON,
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
    "reference_deleted": {
        "reference_type": REFERENCE_TYPE,
        "age_days": optional(NUMBER),
    },
    "document_created": {
        "scope": DOCUMENT_SCOPE,
        "created_by_kind": ACTOR_KIND,
        "has_instructions": BOOLEAN,
    },
    "document_attached_to_room": {},
    "document_deleted": {"scope": DOCUMENT_SCOPE, "age_days": optional(NUMBER)},
    # No `created_by_kind`: only a person can make one.
    "package_created": {},
    "package_attached_to_room": {"reference_count": NUMBER, "document_count": NUMBER},
    "package_deleted": {"age_days": optional(NUMBER)},
    "api_key_created": {"key_type": API_KEY_TYPE},
    "api_key_revoked": {"key_type": API_KEY_TYPE, "age_days": optional(NUMBER)},
    "room_group_created": {"has_parent": BOOLEAN},
    "room_group_deleted": {"room_count": NUMBER, "age_days": optional(NUMBER)},
    # The schema, not an instance: registering one extends what Switch can
    # point at.
    "reference_type_created": {},
    "reference_type_deleted": {"age_days": optional(NUMBER)},
    "template_created": {"template_kind": TEMPLATE_KIND},
    "template_deleted": {"template_kind": TEMPLATE_KIND, "age_days": optional(NUMBER)},
    # An agent asked for something and was told no, on purpose. Which rule
    # people run into is what a finer rights model is designed from; who and
    # what stays in the server log (see `agent_refusals`).
    "agent_request_refused": {
        "operation": one_of(
            "list_templates",
            "get_template",
            "run_template",
            "save_template",
            "update_template",
            "delete_template",
            "create_room",
            "create_room_from_yaml",
        ),
        "reason": one_of(
            "not_found",
            "not_yours",
            "name_taken",
            "visibility_not_allowed",
            "invalid",
            "too_large",
            "has_warnings",
            "missing_agents",
            "agent_creation_console_only",
            "agents_not_created",
            "run_undone",
            "busy",
            "run_paused",
            "run_stopped",
            "repeat",
            "kickoff_ignored",
        ),
    },
    "room_link_created": {},
    "room_link_removed": {},
    "room_role_defined": {"exclusive": BOOLEAN},
    "room_role_deleted": {},
    "room_users_added": {"user_count": NUMBER},
    # People taken out of a room: by someone through Switch ("user"), or
    # because their platform said they left the channel ("platform").
    "room_users_removed": {
        "user_count": NUMBER,
        "removed_by_kind": one_of("user", "platform"),
    },
    # The inverse of the attaches: tried and dropped, as against never used.
    "reference_detached_from_room": {"reference_type": REFERENCE_TYPE},
    "document_detached_from_room": {},
    "package_detached_from_room": {},
    # Configured, not connected. Many of these and few `bridge_connected` is a
    # deployment whose setup is failing.
    "connector_configured": {
        "bridge_platform": BRIDGE_PLATFORM,
        "is_preconfigured": BOOLEAN,
    },
    "invitation_sent": {
        "delivery": one_of("sent", "not_configured", "failed", "not_requested")
    },
    "invitation_accepted": {"age_hours": optional(NUMBER)},
    "bridge_disconnected": {
        # Which side of the bridge: always "collaboration" today; "agent" is
        # declared so the agent bridge can report the same events.
        "bridge": one_of("collaboration", "agent"),
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

# What a caller hands over: None for an optional property it does not know,
# which is left off the wire.
EmittedValue = PropertyValue | None


def wire_name(event: str) -> str:
    """The prefixed name as the relay sees it."""
    return f"{EVENT_NAME_PREFIX}.{event}"


def event_spec(event: str) -> Mapping[str, PropertyType] | None:
    """What `event` declares, with the per-platform counts filled in.

    `usage_snapshot` counts connections per platform, one property each, and
    the platforms are the ones this build registered — so those keys are added
    here, when the event is checked, rather than listed in `CATALOGUE`.
    """
    spec = CATALOGUE.get(event)
    if spec is None or event != "usage_snapshot":
        return spec
    return {
        **spec,
        **{
            connector_count_property(platform): NUMBER
            for platform in messaging_platforms.keys()
        },
    }


def validate(event: str, properties: Mapping[str, EmittedValue]) -> None:
    """Raise unless `properties` is exactly what `event` declares.

    Checks the three things that would each, on their own, let something
    unintended reach the relay: an event nobody declared, a property nobody
    declared, and a value outside the set its property allows. A missing
    property is checked too — not for privacy but for the charts, since an
    event whose keys vary between emissions cannot be grouped on them. Only a
    property declared `optional` may be missing, or None.
    """
    spec = event_spec(event)
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
    required = {name for name, kind in spec.items() if not isinstance(kind, _Optional)}
    if missing := sorted(required - given):
        raise TelemetryCatalogueError(
            f"{event!r} is missing {missing}. Every event of a name carries the "
            "same keys every time — pass the explicit 'none'/0/False rather "
            "than omitting one."
        )

    for name, value in properties.items():
        kind = spec[name]
        if value is None:
            if isinstance(kind, _Optional):
                continue
            raise TelemetryCatalogueError(
                f"{event!r}.{name} is required and was None. Only a property "
                "declared optional may be left out."
            )
        if reason := kind.check(value):
            raise TelemetryCatalogueError(f"{event!r}.{name}: {reason}.")
