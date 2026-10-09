# Product telemetry: the event catalogue

What the Switch core server reports about how it is used, where it goes, and
what may never be in it. Design note for `CHOO-2806`.

This is the **product/usage** half of telemetry. The operational half —
structured logging, the export path itself, server health, tracing and
alerting — is `CHOO-2807` and lands first. The two meet at one seam, described
under [What this needs from the export path](#what-this-needs-from-the-export-path).

This is the reference for what the server reports: the events, their exact
properties, and the rule that keeps identifiers out of them. It is enforced
rather than merely documented — `core/switch_core/telemetry/catalogue.py` is the
same catalogue in executable form, and an event that does not match it raises
where it is built. Read them together; the code is authoritative on the shape
and this is authoritative on why.

## What we are trying to learn

Two questions, and they want different shapes of data.

**How much is Switch used, and is it growing?** Counts of users, rooms, agents,
sessions and connectors, over time. These are reported as a daily snapshot.

**How quickly does a new deployment reach value, and where does it get stuck?**
How long from install to a working connector, from install to a room that is
actually being used, and whether one collaboration platform is markedly harder
to set up than another. These are reported as one-time milestone events carrying
elapsed time.

The second question is the one that changes what gets built, so it is worth
being explicit: it requires a per-deployment clock starting at install, and it
requires each milestone to be emitted exactly once, ever.

## Where it goes

The Switch Console already reports to the company OTLP relay, which fans out to
Amplitude (product analytics) and Datadog (operations). The relay holds the
vendor keys; senders carry no credential and are admitted on a client id alone.
The endpoint and the wire format are in
`console/apps/switch-console-desktop/src/main/core/telemetry/` — `config.ts` for
the endpoint, `relay-client.ts` for the payload.

The server reports to the same relay, in the same shape. There is deliberately
no second pipeline: a second one is a second thing to secure, a second consent
story, and a second place for a customer's data to leak from.

The Console's implementation is the reference for the wire format, and its
choices are load-bearing rather than incidental:

- **One OTLP log record per event**, not a metric and not a span. Amplitude
  consumes events; the relay's filter keys on the `event.name` attribute.
- **The event name is sent twice** — as the log record's own `eventName` field
  and as an `event.name` attribute. The relay filters on the attribute and the
  exporter reads the field. Sending only one is dropped silently, with a 200 at
  every hop.
- **A name prefix per product**, because one Amplitude project holds several.
  The Console sends `switch_console.<event>`; the server sends
  `switch_core.<event>`.
- **Numbers go as `doubleValue`, booleans as `boolValue`.** The relay delivers
  both typed to Amplitude and Datadog — zero and `false` included — so a count
  can be summed and a flag filtered on at the far end. A number sent as text
  arrives as a category instead. The relay's own test suite pins this end to
  end; the tests beside each encoder pin the half Switch controls.
- **Non-finite numbers are refused before sending.** JSON has no NaN or
  infinity, so neither could arrive as a number whatever the relay did with it.
- **At most 100 attributes per record.** The relay drops any record over 128
  and still answers 200. The margin is held by a test over every event, on both
  the server and the Console.
- **At most 16 KiB per event.** The relay drops an event over 32 KiB before it
  reaches Amplitude, because Amplitude refuses a request over 1 MB. It answers
  200 and counts the drop. A test over every event, at its largest possible
  values, holds the margin on both clients; the largest today is about 3 KiB.

### Which Amplitude project

The relay keeps one Amplitude project per environment and files each event
under the one its `flint_env` resource attribute names: `prod`, `staging`,
`dev` or `local`. An event naming none goes to production, and one naming
anything else is dropped and counted. So every event says where it belongs,
even `prod`:

- **The server** sends `TELEMETRY_ENVIRONMENT`, which defaults to `prod`
  because every customer's deployment is production. Flint's own development
  deployment sets `dev`; `.env.example`, which `just init-env` copies for a
  developer's machine, sets `local`. Any other value stops the server at
  startup. It is set by the Helm chart's `switchCore.telemetry.environment`,
  and forwarded by the standalone compose file.
- **Switch Console** sends one per build: `prod` from a released stable build,
  `staging` from a released canary, `dev` from a packaged build that is not a
  release (a test build, or one packaged on a laptop), and `local` when run
  from source. The release workflow stamps tagged builds `VITE_RELEASE=1`, and
  a test holds every build step to it. A server Console runs for the user is
  given Console's.

`flint_env` rides on the resource, beside the client id. It describes where
the reporting process runs, not anything inside the deployment, so it is not
an identifier in the sense of the rule above.

### Internal usage

Staff use the product too, and their usage is real but is not adoption. Three
signals tell it apart, none of them an identifier:

- **`flint_internal`** on the resource: `"true"` or `"false"` from the server,
  set by `TELEMETRY_INTERNAL` (Helm `switchCore.telemetry.internal`) on the
  company's own deployments and never on a customer's. Switch Console sends
  `"true"` when any account it is signed in to a Switch server with is on
  `sandboxaq.com` or `sandboxquantum.com`, `"false"` when only other accounts
  are, and `"unknown"` when none is; only that answer leaves the machine. A
  server Console runs for the user is given Console's answer.
- **`user_internal_count`** in the daily snapshot: accounts on those domains,
  so a deployment that serves both staff and customers can be split.
  `user_internal_active_1d` / `_7d` do the same for the active counts, so
  customer activity is `user_active_*` minus them.
- Each deployment's `flint.client_id`, for the company's own deployments by
  name.

`tenant_id` is deliberately not one of them: no identifier for anything inside
a deployment is ever sent, and a tenant is inside one.

### What the relay's 200 means

The relay answers `200` once it has accepted a payload, before it forwards
anything: it batches, and at response time it does not yet know whether
Amplitude will take the events. So a `200` means *received*, never *delivered*,
and a sender cannot learn from the response that an event was lost. That is
deliberate. An error status would be either a `400` the sender can do nothing
about or a `500` that makes it retry the same payload forever.

Making loss visible is therefore the relay's job, not the sender's: counting
what it receives, what its own checks drop, and what Amplitude and Datadog
refuse, and alerting on those counts. The relay's own repository documents the
metrics, the alerts and how they are switched on, and the gaps that remain.

What that leaves to Switch is not sending anything the relay would drop: the
event name in both places, finite numbers, the attribute and size margins, and a
valid client id.

## The rule: abstracted counts, never specifics

**No identifier for anything inside a deployment is ever sent.** Not a room,
tenant, agent, user, message or channel — not the name, not the id, and not a
hash of either.

This is the same rule the Console holds itself to (`console/AGENTS.md`), and
the Console enforces it with a test that tries to smuggle a room name into
every event and asserts it never reaches the wire. The server needs the
equivalent.

It costs less than it sounds, because every metric asked for is a count or a
duration. The server counts locally, where it legitimately knows the ids, and
reports only the total. What is given up is per-room and per-tenant breakdowns:
we can say a deployment had 40 active rooms this week, never which.

Specifically never sent, in addition to any identifier:

- message bodies, prompts, code, or any room content
- room, agent, group, reference or document **names**
- file paths, working directories, repository names or URLs
- user emails, sign-in identities or platform handles
- hostnames, IP addresses, or the external channel a room is bridged to
- error messages and stack traces — an enumerated reason code instead

Free text never reaches the wire at all: every property is a number, a boolean,
or a value from a closed set fixed in the catalogue. A property carrying an
unexpected value is a bug to be raised, not a string to be passed through.

## Deployment identity and the install clock

The relay admits a sender on a client id and nothing else, so the server needs
one. It does not have one today.

**A per-deployment id**: a random UUID generated once on first use and stored in
the database, sent as the `flint.client_id` resource attribute. It identifies
the installation, and nothing else — it is not derived from a hostname, a
licence, a tenant, an account or any customer value, and it survives restarts
and redeploys so that a deployment is one Amplitude subject over its whole life
rather than a new one each boot.

The row that holds it also holds **`installed_at`**, and that timestamp is the
clock every time-to-value metric is measured from. It is written once, when the
id is generated, and never updated.

In Amplitude, **a deployment is the user**. Every event from one installation
collapses onto it, which is what makes a funnel across the milestone events
below work natively: Amplitude computes time-to-convert between two events for
the same subject.

A deployment running several tenants reports as one subject, because the
alternative is a per-tenant identifier, which is exactly what the rule above
forbids. Tenant *count* is reported; tenant identity is not.

**Time to value is measured for new deployments only.** When the id is
generated, the server checks whether the database already holds rooms, agents or
messages. On an empty database this is a genuinely new installation:
`installed_at` is set to now and the milestone events below are armed. On a
database that already has content, the deployment predates this telemetry,
`installed_at` stays null, and **no milestone event is ever emitted for it**.

No approximation, and no backfill. An install date guessed from the oldest row
would be wrong by an unknown margin in an unknown direction, and a funnel built
on it would read as confident when it is not. A deployment that cannot answer
"how long did activation take" should say nothing rather than guess, so the
time-to-value figures describe only installations actually watched from their
first boot.

The counts in the daily snapshot are unaffected — every deployment reports
those, old or new.

## Resource attributes

On every event:

| Attribute | Value |
|---|---|
| `service.name` | `switch-core`, always |
| `service.version` | the running version, as `/version` reports it; omitted when unknown |
| `flint.client_id` | the per-deployment id |
| `flint_env` | `prod` \| `staging` \| `dev` \| `local`, from `TELEMETRY_ENVIRONMENT` |
| `flint_internal` | `true` \| `false`, from `TELEMETRY_INTERNAL` |

The rule against free text holds here too. `service.name` is a constant rather
than the `SERVICE_NAME` setting, and the `ENVIRONMENT` setting is not sent as
`deployment.environment`: both are free text an operator sets for their own log
pipeline, and either could name their company. The operational OTLP export
(`OTLP_ENDPOINT`) still carries both, because it goes to the operator's own
collector. A test sets both to a company name and checks the whole request body
the relay receives for it.

## Four kinds of event

**A daily snapshot**, one per deployment, carrying the counts that describe the
installation. This answers "how much".

**Milestone events**, emitted at most once per deployment, each carrying the
seconds elapsed since install. This answers "how fast to value".

**Lifecycle events**, one per occurrence, low volume. These carry mix and
failure: which platforms are in use, how often a bridge drops, whether one
connector fails repeatedly before it works.

**Message events**, one per message, the only high-volume kind. These carry how
much is said and between whom — people to agents, agents back, people among
themselves — and the size of the room it was said in.

The snapshot exists because of the identifier rule. Without room ids,
per-occurrence events can tell you *how much* happened but never *across how
many rooms* — counting distinct anything in Amplitude requires an identifier for
the thing being counted. Counting locally and reporting the total sidesteps it.

### Message events, and what they cannot tell you

An earlier version of this note argued against an event per message, for three
reasons. Each is now answered rather than ignored:

1. **Volume.** The relay path used to post one request per event. The relay
   sink now batches: events wait up to five seconds, or until two hundred are
   queued, and go as one request. Its buffer is bounded, so a relay that is down
   costs events, never memory.
2. **The sender must not pay for it.** The transport and the agent consumer
   hand a small record to a queue and return. One worker looks up the room and
   the sender — cached, so a busy room is read once every five minutes rather
   than once per message — and emits. That queue is bounded too, and drops with
   a warning when it falls behind.
3. **Content risk.** The events carry the same kind of property as every
   other: closed sets, booleans and counts. There is no property a message body,
   a name or an id could reach, and the catalogue test enforces it.

**They count messages, not people.** No user id is ever sent, so in Amplitude
every event from a deployment belongs to one subject — the deployment — and
Amplitude's own "active users" counts deployments. How many *people* are active
comes only from the snapshot, which counts distinct people locally and reports
the total: `chat_identity_in_room_count` (seen in a room at all),
`chat_identity_posted_*` (said anything) and `chat_identity_active_*` (said
something in a room with an agent), with `user_active_*` counting the same
last tier as Switch accounts. The message events say how much those people
said, and to whom.

## Definitions

These are the definitions the counts below are computed against. They are
written down because most of them have a plausible alternative reading, and a
metric whose definition drifts is worse than no metric.

**Interaction** — a human sent a message in a room that has at least one agent
in it, or an agent replied to one. This is the unit "active" is built on
throughout: mere membership is not activity, and two agents talking to each
other is not a human using the product.

**Active user** — a human user with at least one interaction in the window.
Counted distinctly per window, so one person in six rooms is one active user.

**Active room** — a room with at least one interaction in the window. Reported
over both one day and seven, because a weekly figure flatters a product used
intensely on Mondays and a daily one punishes it. Counted over rooms of every
origin, unlike the headline `room_count` — a bridge-adopted channel people
actually use is real usage even though it is not a room anybody created in
Switch.

**Room created by a user** — a room a human made, through the gateway or the
Console. This is the headline "Rooms" figure. Rooms an agent provisioned for
itself are counted separately and never stand in for it: an orchestration that
spins up ten scratch rooms is not ten rooms of customer value, and letting the
two share a number would make adoption look like whatever the agents happened to
be doing that week.

**Session** — an agent session as the connection registry knows it: opened when
an agent connects, closed when it disconnects or its heartbeat lapses.

**Connector** — a collaboration platform bridge (Slack, Mattermost, Discord,
Teams, Telegram). A connector is *added* when a bridge for that platform first
reaches a connected state; configuring one that never connects is not an add,
which is deliberate — the metric is about reaching value, not about saving a
form.

Agent runtimes (Claude Code, Codex, OpenCode) are counted too, under
`agent_*_count`, but they are not what "connector" means in the time-to-value
metrics below.

**Room created by the system** — a channel Switch adopted because it was invited
to it on a platform, rather than one anybody asked for. Counted separately from
both of the above, because folding these into the headline would make "rooms a
person created" read as "channels this workspace happens to have".

## The catalogue

Event names are `snake_case`, past tense, prefixed `switch_core.` on the wire.
Every event of a given name always carries exactly the same property keys —
where a property does not apply, it carries an explicit `none` rather than being
omitted, so a missing key always means a bug rather than a case.

Every event that can fail carries `outcome`, so that the failure population is
never invisible.

### `usage_snapshot` — once a day per deployment

| Property | Type | Notes |
|---|---|---|
| `tenant_count` | number | tenants this pass actually counted — see `tenant_failed_count` |
| `tenant_failed_count` | number | tenants whose queries raised and were stepped over. One tenant's failure no longer takes the whole pass down, so the pair is what makes a partial pass self-describing: without it, every count dropping at once is indistinguishable from a deployment losing its users |
| `duration_ms` | number | wall time to collect the pass, on a monotonic clock. Roughly fifteen queries per tenant against the database that is also serving rooms, and a background task is invisible to `switch.http.request.duration` — so this is the only place "what does the snapshot cost at scale" can be answered from |
| `user_count` | number | user accounts that exist |
| `user_internal_count` | number | of those, accounts on the company's own email domains — see "Internal usage" |
| `user_active_1d` | number | distinct Switch **accounts** that used a room with an agent in 24h: an account counts when a chat account it has claimed spoke. One person on two platforms is one account |
| `user_active_7d` | number | same over 7 days |
| `user_internal_active_1d` | number | of `user_active_1d`, accounts on the company's own email domains |
| `user_internal_active_7d` | number | same over 7 days |
| `chat_identity_count` | number | chat identities — Slack, Mattermost and other platform accounts — that exist, claimed by an account or not |
| `chat_identity_active_1d` | number | distinct chat identities that used a room with an agent in 24h. Most belong to no Switch account and one person may have several, which is why this runs above `user_active_1d`. Servers released before this change reported this figure as `user_active_1d` |
| `chat_identity_active_7d` | number | same over 7 days |
| `chat_identity_posted_1d` | number | distinct chat identities that said anything in any room in 24h, agent or no agent |
| `chat_identity_posted_7d` | number | same over 7 days |
| `chat_identity_in_room_count` | number | distinct chat identities Switch has seen in a room: a member of at least one unarchived room of any origin, or anyone who said anything in the last 7 days. Not a channel's whole audience — see "Tiers of activity" |
| `room_count` | number | **the headline figure** — unarchived rooms a *person* created |
| `room_agent_created_count` | number | unarchived rooms an agent created for itself |
| `room_system_created_count` | number | unarchived channels Switch adopted after being invited to them on a platform |
| `room_active_1d` | number | rooms of any origin with an interaction in 24h |
| `room_active_7d` | number | same over 7 days |
| `room_archived_count` | number | archived rooms, both kinds |
| `room_internal_only_count` | number | rooms with no external channel |
| `room_membership_total` | number | user–room memberships summed over rooms |
| `room_users_mean` | number | mean human members per room |
| `room_users_max` | number | largest human membership of any one room |
| `agent_count` | number | registered agents |
| `agent_active_7d` | number | agents that interacted in 7 days |
| `agent_claude_code_count` | number | agents by runtime |
| `agent_codex_count` | number | |
| `agent_opencode_count` | number | |
| `agent_other_count` | number | including agents with no known runtime |
| `session_live_count` | number | connections open at snapshot time |
| `connector_slack_count` | number | **configured** bridges by platform |
| `connector_mattermost_count` | number | |
| `connector_discord_count` | number | |
| `connector_teams_count` | number | |
| `connector_telegram_count` | number | |
| `connector_configured_count` | number | configured, whether or not connected |
| `message_count_1d` | number | messages in 24h |
| `message_from_human_1d` | number | of those, sent by humans |
| `message_from_agent_1d` | number | of those, sent by agents |
| `turn_human_to_agent_1d` | number | agent messages answering a person |
| `turn_agent_to_human_1d` | number | person messages answering an agent |
| `turn_agent_to_agent_1d` | number | agent messages answering another agent |
| `attachment_count_1d` | number | attachments in 24h |
| `reference_count` | number | references the tenant owns |
| `reference_attached_count` | number | of those, attached to at least one room |
| `document_count` | number | documents |
| `document_attached_count` | number | of those, attached to at least one room |
| `package_count` | number | packages |
| `room_group_count` | number | room groups |
| `api_key_count` | number | API keys |

Per-platform counts are separate properties rather than one map because the
platform set is closed and small, and because Amplitude charts a property far
more easily than it charts a nested object. They count **configured** bridges,
whether or not each is currently connected — which is up is process state, and
`bridge_connected` / `bridge_disconnected` are how that is reported.

**What counts as a message.** Every durable event is a row in the message log:
arrivals, tool- and LLM-call reports and task transitions sit beside the
conversation. The message counts, the turn counts and every "interacted" figure
above (`user_active_*`, `room_active_*`, `agent_active_7d`) read only what a
participant *said*: chat messages, and commands a person typed on a platform.
The automatic notice Switch posts under an agent's name when it cannot take a
request is excluded as well — the agent did not say it.

**Tiers of activity.** `chat_identity_in_room_count`,
`chat_identity_posted_7d` and `chat_identity_active_7d` nest: everyone Switch
has seen in a room, those who said anything, and those who said something in a
room with an agent. The nesting holds by construction — anyone who posted in
the last 7 days counts as seen, even if they have since left the room or it
was archived. `chat_identity_posted_7d - chat_identity_active_7d` is people
talking only to each other. All three count chat identities, so someone on both
Slack and Teams counts twice; only the top tier is also counted as accounts
(`user_active_*`). "In a room with an agent" stands in for "talked to an
agent": whether a message addressed one is decided per agent as it is
delivered, and is not stored where a count can read it.
`agent_message_received` is the per-message measure of that.

**What "seen in a room" cannot see.** Switch records a person in a room only
when they post, are added by name, or join the channel after Switch adopted
it. Nothing lists the members a channel already had, so someone who has only
ever read an adopted channel is in no count here, and
`chat_identity_in_room_count - chat_identity_posted_7d` is **not** the passive
audience: it is the people Switch happens to know about who stayed quiet,
usually a small fraction of the real one. Counting readers would take a
member sync on each platform, which no bridge does today.

**Turns rather than senders.** A turn is one message classified by who sent the
message *before* it in the same room. That is the only way to tell an agent
answering a person from two agents talking among themselves: a sender-only count
reports both as "from an agent" and hides the difference that matters. The
pairing reads off `seq`, which is a total order within a room with no ties;
human-to-human is not counted, and neither is a turn whose predecessor was a
bridge relay or the admin client.

**No count of sessions started.** Nothing durable records a session opening, so
the snapshot could only report an in-process tally that a restart silently
resets — a number that looks like a count and is not one.
`agent_session_started` is emitted per occurrence instead.

The three `message_*_1d` figures come from the message table, which is
deliberately a *parallel* record of the bus rather than the authoritative one: a
write that fails after a successful send leaves a gap, so that a database
problem can never make messaging less reliable. These counts are therefore
near-complete, not exact. That is fine for "how much, and is it growing", and it
should be said plainly wherever the number is presented rather than discovered
later.

### Milestone events — at most once per deployment

Each carries `seconds_since_install` (number). Together with
`deployment_installed` they form the activation funnel. Emitted only by
deployments installed after this ships — see
[Deployment identity](#deployment-identity-and-the-install-clock).

| Event | Emitted when | Extra properties |
|---|---|---|
| `deployment_installed` | the deployment id is generated on an empty database | — |
| `first_connector_added` | the first bridge a **person** added reaches connected | `bridge_platform` |
| `first_room_created` | the first **user-created** room is created | `channel_type`, `bridge_platform` |
| `first_room_active` | that room sees its first interaction | `bridge_platform`, `seconds_since_room_created` |
| `first_agent_registered` | the first agent registers | `known_agent_type` |
| `first_session_started` | the first agent session opens | `known_agent_type` |

The two room milestones track user-created rooms only, for the reason given
under [Definitions](#definitions): a room an agent made for itself is not the
moment a customer got started, and counting it would report activation that
never happened.

`first_room_active` is the one that matters most: it is "install to seeing
value" end to end, and its `seconds_since_room_created` separates the two halves
of that journey — whether the time went on getting a room set up, or on getting
anyone to use it once it existed.

Emitted once *ever*, not once per process. Each needs a persisted marker, so a
restart cannot re-emit one and a deployment that passes a milestone while
telemetry is switched off does not emit it later as though it had just happened.

### Lifecycle events

**`connector_added`** — every connector, not only the first.

| Property | Type |
|---|---|
| `bridge_platform` | platform |
| `seconds_since_install` | number |
| `seconds_since_configured` | number — configuration saved to first connect |
| `is_preconfigured` | boolean — registered by the deployment's setup step, not a person |
| `is_first_connector` | boolean — the first connector a person added |
| `failed_attempts_before_success` | number |

**Preconfigured connectors.** The standalone stack, the Helm chart and every
Console-managed local server run a setup step that registers the bundled
Mattermost seconds after install. That connector reports `is_preconfigured:
true`, is never `is_first_connector`, and never claims `first_connector_added`
— so that milestone is the first connector a person added, not the deployment
booting. Filter `connector_added` on `is_preconfigured = false` to measure
onboarding. A bundled connector registered before the flag existed is marked
on the setup step's next run; if it first connects before that, its one
`connector_added` reports `false`.

**`connector_added` fires only for a first connect that was seen.** A
connector's first connect is recorded whether telemetry is on or not, so one
that first connected while telemetry was off never reports `connector_added`:
its setup went unmeasured, and reporting it later would report its whole age.
Connectors that already existed when this tracking arrived are recorded by a
migration and never report either. Servers released before it reported an old
connector's age instead, often millions of seconds; filtering to
`seconds_since_install >= 0` drops most of those.

`seconds_since_configured` and `failed_attempts_before_success` are what answer
"is one platform too hard". Elapsed time from install mostly measures when
somebody got round to it; time from *configuring* a bridge to it actually
working, and how many failures came first, measures the platform. Teams needing
six attempts and Slack needing one is the finding worth having.

The honest limitation: much of connector setup happens in the platform's own
admin UI, which the server cannot see. These metrics cover the part that starts
when Switch is first told about the bridge.

**`room_created`**

| Property | Type |
|---|---|
| `channel_type` | `channel_public` \| `channel_private` \| `direct` \| `none` |
| `bridge_platform` | platform, or `none` for internal-only |
| `agent_count` | number |
| `human_count` | number |
| `has_instructions` | boolean |
| `created_by_kind` | `user` \| `agent` \| `system` |
| `from_template` | boolean |

**`room_became_active`** — the first interaction in a room, once per room.

| Property | Type |
|---|---|
| `seconds_since_room_created` | number |
| `bridge_platform` | platform |
| `channel_type` | channel type |
| `agent_count` | number |
| `created_by_kind` | `user` \| `agent` \| `system` |

`created_by_kind` rides along rather than agent-created rooms being dropped, so
the headline chart can filter to user-created rooms while the question "do
agent-made rooms ever get used?" stays answerable from the same event.

This is "time to create an active room" for every room, not only the first. The
distribution is the interesting part: if rooms created in week one go active in
minutes and rooms created in week six never do, that is a different problem from
a slow average.

**`room_archived`** — `bridge_platform`, `age_days` (number), `was_ever_active`
(tri-state: `true` | `false` | `unknown` — `unknown` when the activity count
itself could not be run, which is not evidence the room was never used).

**`room_agents_added`** — `agent_count` (number), `added_by_kind`.

**`room_agents_removed`** — `agent_count` (number), `removed_by_kind`.

### Removals

Every count in the snapshot can fall, and on its own a falling line says
nothing about why. A drop in `room_count` is a customer tidying up, a bridge
being disconnected, or a deployment being abandoned — three opposite readings,
and the difference is only recoverable if the removal was reported when it
happened.

Each carries the lifespan of the thing removed, because "deleted after an hour"
and "deleted after a year" are opposite signals: the first is a mistake or an
experiment, the second a deliberate clean-up.

**`room_deleted`** — `bridge_platform`, `channel_type`, `created_by_kind`,
`age_days`, `was_ever_active` (tri-state, see `room_archived` above),
`agent_count`. The activity flag is read before the delete, because the
cascade takes the room's messages with it and afterwards every room looks like
it was never used.

**`agent_deleted`** — `known_agent_type`, `age_days`, `room_count`,
`had_parent`.

**`connector_removed`** — `bridge_platform`, `age_days`, `was_ever_connected`
(tri-state: `true` | `false` | `unknown`), `room_count`. `was_ever_connected` is
the one that matters: a connector removed having never connected is a failed
setup, and one removed after months of service is a decision. Reporting both
as "removed" would hide the first, which is the one worth acting on.
`unknown` when the durable record backing it could not be read — reporting
that as `false` would misfile a lookup failure as a failed setup.

**`agent_registered`**

| Property | Type |
|---|---|
| `agent_type` | `always_on` \| `session_addressable` \| `session_passive` \| `auto_session` |
| `known_agent_type` | `claude-code` \| `codex` \| `opencode` \| `other` \| `none` |
| `registration_path` | `bootstrap` \| `personal_key` \| `gateway` \| `other` |
| `has_parent` | boolean — a subagent rather than a top-level agent |

**`agent_session_started`** — `known_agent_type`. An agent *coming online*: its
first live connection, not a session a person began. Sessions share their
agent's one connection, held by Switch Console or a remote host's sidecar, so
this fires when that connection opens and not again when a session starts on
it. Deliberately nothing about *how*: the server cannot tell, and a property
that takes the same value on every emission cannot segment anything.

**`session_started`** — `start_source` (`user` \| `room` \| `automation` \|
`unknown`), `known_agent_type`. A coding-agent session starting, reported once
by the host that runs it when the session is new — never on a resume. The
launcher stamps `start_source`: `user` is a person starting one in Switch
Console, `room` the agent being addressed in a room, `automation` Console's
local automation API. `unknown` is a launcher that said nothing, reported
rather than dropped so an unstamped launch path is a visible gap. "Sessions a
person started" is `start_source = user`. It is the launcher's claim, not proof
a person clicked, and hosts older than this report nothing.

Guarded against a caller inventing sessions: the id must be a UUID (every
launcher mints one), and an agent reporting more than 120 starts in an hour is
not counted until the rate drops, with a warning logged. The claim that makes a
retried report count once is a row in `telemetry_milestones`, pruned after 7
days by the daily snapshot pass; a report retried later than that, whose first
attempt did arrive, counts twice.

**`agent_session_ended`** — `duration_seconds` (number), `reason` (`normal` \|
`heartbeat_lapsed` \| `replaced` \| `room_claimed` \| `error`). No runtime: the
connection registry is the only thing that knows a session ended and it holds
none, the client's self-declared artifact is free text and may not be sent, and
looking the agent up would put a query on the connection sweep. Session starts
carry the runtime, so the mix is available from those.

The connection registry already records a reason on every close, which is where
these values come from; the set is closed here so a new reason string added in
the code does not silently become a new Amplitude value.

**`bridge_connected`** — `bridge` (`collaboration` \| `agent`), `bridge_platform`,
`outcome`, `failure_reason`, `duration_ms`. `bridge` is always `collaboration`
today; `agent` is declared so the agent bridge can report the same events.

Fires for every attempt, including the ones that fail before the bridge's task
is ever scheduled — an unregistered adapter type, a stored config that no
longer validates, a port another bridge already holds. Those used to emit
nothing at all, so the connect success rate was computed over a denominator
that excluded the attempts that failed hardest.

`duration_ms` is how long the attempt took, in whole milliseconds on a
monotonic clock, spanning both halves of it: the synchronous setup and the task
that actually reaches the platform. Nothing else times this — a bridge comes up
on a background task rather than inside a request the server serves — and the
failure half is the more interesting one, because a timeout and a refusal carry
the same `failure_reason` and nothing alike in the time. `-1` if no reading was
taken, following the convention below.

**`bridge_disconnected`** — `bridge` (as above), `bridge_platform`, `reason`
(`shutdown` \| `restart` \| `auth_failed` \| `network` \| `platform_error` \|
`config_invalid` \| `unknown`).

Bridge drops are worth having as events rather than only as a snapshot count:
the snapshot says two bridges are down right now, the events say one platform
has flapped forty times today. That is the difference between noticing and
diagnosing.

**`deployment_started`** — `tenant_count`. The version is already a resource
attribute, so this gives an upgrade curve across installations: which versions
are actually running. Deliberately no "did this boot apply migrations" flag:
migrations run in a different event loop from the server, so the answer would
have to be carried across on a module global, and it is operational trivia
rather than something the product wants to know.

### Message events — one per message

All three come from `telemetry/messages.py`, reported off the sender's path as
described [above](#message-events-and-what-they-cannot-tell-you). A post with
several files is one message. Room facts are cached for five minutes, so a
member count can be that far behind. A room, sender or agent whose lookup
fails is not looked up again for five seconds, and its events report it as
`unknown` meanwhile; every other room carries on. Three failures in a row,
with no lookup succeeding between them, pause every lookup for five seconds.
Either way a database incident shows in the charts as a burst of `unknown`
rather than as missing messages.

**`room_message_sent`** — everything a participant chose to say in a room: the
population the tenant is metered for, reported by the transport after the
write commits. What Switch posts on a participant's behalf — greetings, command
replies, offline and refusal notices, a template's kickoff — is not in it.
Neither is a command a person types (`!reset`, a slash command): commands are
not metered, although the snapshot's activity counts treat one as something
the person said.

| Property | Type |
|---|---|
| `sender_kind` | `user` \| `agent` — only people and agents are metered, so `platform` does not occur here |
| `bridge_platform` | platform, `none` for an internal room, `unknown` if the room could not be read |
| `channel_type` | channel type, or `unknown` if the room could not be read |
| `room_user_count` | number — human members of the room, `-1` if it could not be read |
| `room_agent_count` | number — agent members, `-1` if it could not be read |
| `has_attachment` | boolean |
| `in_thread` | boolean |

The average of `room_user_count` over these events is the room size a typical
message is said to — weighted by messages, not by rooms. **Filter out
`bridge_platform = unknown` before averaging**: those are rooms that could not
be read, and their `-1` would pull the mean down. Every property is required on
every event and the catalogue has no empty value, so `-1` is the marker. The
snapshot's `room_users_mean` is the per-room figure.

**`agent_message_received`** — a message an agent was asked to act on:
addressed to it (by name, alias, role, or a direct room) *and* let through its
addressing policy and budget, whether or not the agent was there to take it.
Reported by the agent's consumer, where that is decided, so a message naming
two agents is two of these and one `room_message_sent`. Switch's own
auto-replies are excluded; a request Switch carries on a person's behalf is
included, as `platform`. A message a hosted agent's mailbox already holds — the
same message seen again — is not counted twice, and nor is a multi-file post
whose files arrive too far apart to be delivered together: it is counted with
its first file. A typed command addressed to an agent is not counted.
`agent_live` splits being asked from being there: filter on it to count only
the requests an agent could act on as they arrived.

| Property | Type |
|---|---|
| `sender_kind` | `user` \| `agent` \| `platform` \| `unknown` |
| `known_agent_type` | the receiving agent's runtime |
| `bridge_platform` | platform |
| `channel_type` | channel type |
| `has_attachment` | boolean |
| `agent_live` | boolean — the agent had a live session for the room when the message arrived. False when it was offline, still starting, or its cloud worker refused the message (stopped, broken, or a full mailbox); always false for a `session_passive` agent, which reads its messages later rather than live |

**`agent_message_sent`** — a message an agent posted: its replies, status
updates, anything it chose to say. Every one is also a `room_message_sent` with
`sender_kind = agent`; this one carries the runtime as well. `room_user_count`
separates an agent answering people from agents talking among themselves.

| Property | Type |
|---|---|
| `known_agent_type` | the sending agent's runtime, or `unknown` if the agent could not be looked up |
| `bridge_platform` | platform |
| `channel_type` | channel type |
| `room_user_count` | number, `-1` if the room could not be read |
| `has_attachment` | boolean |
| `in_thread` | boolean |

### Resources, keys, groups and the rest

What each one is for, and how to make it fire, is under
[Every event, and how to make it fire](#every-event-and-how-to-make-it-fire).
This is what each carries.

| Event | Properties |
|---|---|
| `reference_created` | `reference_type`; `read_visibility` (`private` \| `public`); `created_by_kind` (`user` \| `agent` \| `system`) |
| `reference_attached_to_room` | `reference_type` |
| `reference_detached_from_room` | `reference_type` |
| `reference_deleted` | `reference_type`; `age_days` (number) |
| `document_created` | `scope` (`library` \| `room`); `created_by_kind` (`user` \| `agent` \| `system`); `has_instructions` (boolean) |
| `document_attached_to_room` | none |
| `document_detached_from_room` | none |
| `document_deleted` | `scope` (`library` \| `room`); `age_days` (number) |
| `package_created` | `created_by_kind` (`user` \| `agent` \| `system`) |
| `package_attached_to_room` | `reference_count` (number); `document_count` (number) |
| `package_detached_from_room` | none |
| `package_deleted` | `age_days` (number) |
| `reference_type_created` | none |
| `reference_type_deleted` | `age_days` (number) |
| `api_key_created` | `key_type` (`agent` \| `registration` \| `bootstrap` \| `other`) |
| `api_key_revoked` | `key_type` (`agent` \| `registration` \| `bootstrap` \| `other`); `age_days` (number) |
| `room_group_created` | `has_parent` (boolean) |
| `room_group_deleted` | `room_count` (number); `age_days` (number) |
| `template_created` | `template_kind` (`room` \| `group` \| `agent` \| `other`) |
| `template_deleted` | `template_kind` (`room` \| `group` \| `agent` \| `other`); `age_days` (number) |
| `agent_request_refused` | `operation` (`list_templates` \| `get_template` \| `run_template` \| `save_template` \| `update_template` \| `delete_template` \| `create_room` \| `create_room_from_yaml`); `reason` (`not_found` \| `not_yours` \| `name_taken` \| `visibility_not_allowed` \| `invalid` \| `too_large` \| `missing_agents` \| `agent_creation_console_only` \| `busy` \| `run_paused` \| `run_stopped` \| `repeat` \| `kickoff_ignored`) |
| `room_link_created` | none |
| `room_link_removed` | none |
| `room_role_defined` | `exclusive` (boolean) |
| `room_role_deleted` | none |
| `room_users_added` | `user_count` (number) |
| `server_connector_registered` | `connector_kind` (`opencode` \| `other`) |
| `server_connector_removed` | `connector_kind` (`opencode` \| `other`) |
| `connector_configured` | `bridge_platform`; `is_preconfigured` (boolean) |
| `invitation_sent` | `delivery` (`sent` \| `not_configured` \| `failed` \| `not_requested`) |
| `invitation_accepted` | `age_hours` (number) |

### Closed value sets

`bridge_platform`: `slack` | `mattermost` | `discord` | `teams` | `telegram` |
`none` | `unknown`. `none` is "no bridge" (an internal-only room); `unknown` is
"there is one and the lookup that would have named it failed" — the two are
kept apart because collapsing them would misreport a Slack-bridged room as
internal-only whenever that lookup has a transient error.

`channel_type`: `channel_public` | `channel_private` | `direct` | `none` |
`unknown`, with `unknown` meaning what it does for `bridge_platform`. Only the
message events can carry it.

`reference_type`: `google_drive` | `confluence` | `github` | `jira` | `other`. The
four built-in types; a user-defined type's slug is free text, so it reports as
`other`.

`sender_kind`: `user` | `agent` | `platform` | `unknown`. `platform` is Switch
itself speaking; `unknown` a sender whose client could not be looked up.

`outcome`: `success` | `failure`. `failure_reason` is an enumerated code per
event, `none` on success — never an exception message.

`bridge_connected.failure_reason` and `bridge_disconnected.reason` share one
set, because one classifier feeds both. A value that classifier can produce and
only one of the two declares is an event that fails validation at the moment a
bridge drops — which is precisely the event worth not losing.

**Tri-state facts**: `true` | `false` | `unknown`, for a yes/no property the
server can fail to establish (`room_archived`/`room_deleted`.`was_ever_active`,
`connector_removed`.`was_ever_connected`). Not a boolean, deliberately — a
property that can be unknown is a three-valued fact, and collapsing the failed
case into `false` reports a guess as a claim the code has no evidence for.

Where a duration or an age cannot be known — a deployment with no install
clock, a bridge whose configuration timestamp is unreadable, a row whose
`created_at` could not be read — the property carries `-1` rather than `0`, so
"we could not tell" is distinguishable from "it happened instantly" or
"created just now".

Any property whose value is not in its declared set is a bug. It should raise
where the event is built rather than be coerced, dropped, or silently widened
to a value nobody added to the catalogue. This is a different statement from
the tri-states above: `unknown` is fine *as a value the catalogue itself
declares* for the handful of properties that need it — what must never happen
is a value reaching the wire that the catalogue does not know about.

## Consent

A Switch server reporting its usage to a vendor relay is a different question
from a desktop app doing it, because the deployment may be a customer's and the
usage may be theirs.

The Console's answer is opt-in, defaulting to off, gated on an explicit choice
having been made, and re-read on every event so revoking takes effect
immediately. **The server takes the same position**: telemetry is off unless
switched on, it is one setting, and when it is off no request is made at all.

Who sets that one setting depends on who deployed the server. On a stack an
operator brought up themselves, they set `TELEMETRY_ENABLED` — in the `.env` for
the standalone compose file, or in the chart's values. On a stack **Switch
Console runs for a user**, the Console sets it from that user's "Share usage
data" answer at every start, in both directions, so the person running the
server and the person answering are the same person and answer once
(`CHOO-2890`). Because the gate is read at boot, a change to the answer reaches
a running server only when it restarts; the Console says so on the server's page
and offers the restart rather than taking it.

This interacts with the milestone events in a way worth stating: a deployment
that enables telemetry three months in has already passed most of its
activation funnel. Milestones are emitted only when they actually occur, never
retroactively, so such a deployment simply contributes nothing to time-to-value
— which is correct, and better than a backfilled figure that would read as an
instant activation.

This is a setting an operator controls, and it must be documented where they
will see it before they deploy — not only in this note. What is sent, where it
goes, and how to turn it off belongs in the deployment documentation.

## What this needs from the export path

The seam with `CHOO-2807`. The catalogue above needs the export path to provide:

1. **A send taking an event name and a flat map of properties**, emitting one
   OTLP log record with the resource attributes above, the `switch_core.` prefix,
   and the name in both required places.
2. **Non-blocking emission.** A slow or unreachable relay must never delay a
   request, a message send, or a bridge event. A failed send is logged and
   dropped; telemetry is never worth a user-visible stall.
3. **The consent gate inside the send**, so that no call site can bypass it and
   no new event can forget it.
4. **The deployment id and `installed_at`**, generated and persisted once.
5. **A closed catalogue with the property allow-list enforced at the boundary**,
   so an event carrying an undeclared property fails rather than shipping it.

Nothing on that list is specific to product events; each is equally needed for
operational ones, which is why it belongs to the shared path rather than here.

## Checking it works

Three layers, and they fail differently — a green one above does not prove the
one below it.

**What Switch would send.** Start the local stand-in for the relay and point a
development server at it:

```
python scripts/otlp_sink.py
# then, in the server's environment:
TELEMETRY_ENABLED=true
TELEMETRY_ENDPOINT=http://localhost:4318
TELEMETRY_SNAPSHOT_INTERVAL_HOURS=0.02
```

The endpoint is the **base** URL — `/v1/logs` is appended, the same convention
the operational export follows. A value carrying the signal path is refused at
startup, because posting to `/v1/logs/v1/logs` would be a 404 the relay reports
once per event into a log nobody is reading.

Product events are batched: they arrive at the sink up to five seconds after
they happen, several to a request. Whatever is buffered at shutdown is posted
on the way out, several batches at once, within a one-second shutdown budget:
the message worker's drain takes at most 0.4 seconds of it and the sink has
the rest. What cannot be posted in that time is lost, and the server log says
how many events that was.

The same sink serves the operational export, so one process shows both streams. Every event is printed as it arrives, decoded, with all of its
properties. Create a room, register an
agent, connect a bridge, send a message, and watch. The first snapshot lands
about a minute after boot, so the whole catalogue is exercisable in a few
minutes without anything leaving the machine.

**That the numbers are right.** Each snapshot pass logs a one-line summary at
`INFO` before sending — rooms, active rooms, users, agents, messages. Compare
it against the same counts taken straight from the database. If they disagree,
the snapshot's query is wrong and the relay would have accepted the wrong
answer without complaint.

**That the relay accepts it.** This is the layer that fails silently, and the
only one that cannot be checked locally. A 200 does not mean a record was
kept: OTLP reports partial success in the response body, so
`python scripts/otlp_sink.py --reject 1` is how to check Switch notices — it
should log a warning naming the event. `--fail 503` checks the other
direction, that a refused send is logged and dropped rather than raising into
whatever was happening at the time.

Against the real relay, the only proof is a staging deployment with reporting
on for one interval, and the events appearing downstream. Nothing short of
that tests the vendor's own filtering.


### Every event, and how to make it fire

Work down the list against a local sink
(`python scripts/otlp_sink.py`) and each one prints as it arrives with all of
its properties.

Two things to set up first, or a third of the list cannot fire at all:

- **Start from an empty database.** Milestones are armed only when the identity
  migration runs against one with no rooms, agents or messages. On a database
  that already has content `installed_at` is null and the six `first_*` events
  are suppressed for good — correctly, but it means an upgraded dev box can
  never be used to test them.
- **Shorten the snapshot interval.** `TELEMETRY_SNAPSHOT_INTERVAL_HOURS=0.02`.
  The first pass is 60s after boot and it polls every 5 minutes, so with the
  default of 24h you would see one snapshot and nothing else.

**At boot, with no action at all**

- `deployment_installed` — fires once, on the first boot of a fresh install.
  `main.py`, after the migration. Absent on an upgraded database, by design.
- `deployment_started` — every boot. Same place.
- `usage_snapshot` — 60s after boot, then each interval.
  `telemetry/reporter.py` → `run_once`.

**Rooms** — `room_service.py` throughout; gateway routes under `/gateway/rooms`

- `room_created` — `POST /gateway/rooms`. Check `created_by_kind` is `user`
  here, `agent` when an agent creates one through its MCP tool, and `system`
  when Switch is invited to a channel on a bridged platform. Those three paths
  are the whole point of the property; test at least the first two.
- `first_room_created` — the same call, first time only, and only for a
  user-created room.
- `room_agents_added` — `POST /gateway/rooms/{id}/agents`. Adding an agent
  already in the room correctly emits nothing.
- `room_agents_removed` — `DELETE /gateway/rooms/{id}/agents/{agent_id}`.
- `room_archived` — archiving from the gateway, and from an agent's
  `archive_room` tool. Unarchiving emits nothing.
- `room_deleted` — `DELETE /gateway/rooms/{id}`. Check `was_ever_active` is
  true when someone had spoken in it: it is read before the delete, because the
  cascade takes the messages.
- `room_became_active` — **needs two snapshot passes.** Create a room with an
  agent in it, have a human post, then wait for the pass *after* the one that
  first saw it. Derived from the message table rather than emitted at send
  time.
- `first_room_active` — the same pass, once ever, user-created rooms only.

**Agents** — `bridges/agent/protocol/service.py`

- `agent_registered` — registering a new agent. `registration_path` should be
  `gateway` from the dashboard or Console, `personal_key` from a user's own
  registration key, `bootstrap` from the deployment-wide token. Re-registering
  an existing agent correctly emits nothing.
- `first_agent_registered` — the same call, first time only.
- `agent_deleted` — `DELETE /gateway/agents/{id}`. Carries how old it was and
  how many rooms it was in, both read before the row goes.

**Sessions** — `bridges/agent/api/handlers.py`, and the connection registry

- `agent_session_started` — an agent opening its event stream. A supervisor
  reattaching to a connection it already had correctly emits nothing.
- `first_session_started` — the same, once ever.
- `agent_session_ended` — kill an agent and wait for the heartbeat sweep
  (a few seconds). Reported through a listener on the registry, so every path
  that closes a connection reports, not just the sweep.
- `session_started` — `POST /agent-sessions/{id}/started` from a session host
  (`bridges/agent/api/activity_routes.py`), with a UUID id. A repeat for the
  same agent and session emits nothing, across restarts, for 7 days.

**Messages** — `telemetry/messages.py`, fed by `transport/postgres.py` and
`clients/agent_consumer.py`

- `room_message_sent` — any person or agent posting in any room. A post with
  three files is one event. A command reply or an offline notice is none.
- `agent_message_sent` — an agent posting, through its MCP tool or the HTTP
  API. Arrives beside a `room_message_sent` for the same message.
- `agent_message_received` — tag an agent, or write in a direct room with one.
  Tag two agents and there are two. Tag an agent whose policy refuses you and
  there are none.

**Connectors** — `bridges/collaboration/lifecycle_service.py`

- `bridge_connected` — a bridge reaching its platform. Also fires with
  `outcome: failure` when it cannot; try bad credentials.
- `connector_added` — the *first* successful connect for that bridge, ever.
  Restarting a working bridge correctly emits nothing.
- `first_connector_added` — the first connector a person added on the
  deployment. The bundled Mattermost the setup step registers never claims it.
- `bridge_disconnected` — stopping a bridge (`reason: shutdown`), restarting
  one (`restart`), or a live bridge crashing.
- `connector_removed` — `DELETE /gateway/collaborations/{id}`. Check
  `was_ever_connected`: it reads the durable record, so a connector that worked
  months ago and was down at removal still reports true.

**Resources, keys and groups** — `bridges/resource/service.py`, and the
gateway routes under `/gateway`

- `reference_created` / `reference_attached_to_room` / `reference_deleted` —
  make a reference, attach it to a room, delete it. Only the four built-in
  types are named; a user-defined type reports as `other`, because its slug is
  free text somebody chose.
- `document_created` / `document_attached_to_room` / `document_deleted` —
  `scope` is `library` for one in the shared library and `room` for one an
  agent authored inside a room.
- `package_created` / `package_attached_to_room` / `package_deleted`. The
  attach carries how many references and documents came with it.
- `api_key_created` / `api_key_revoked` — mint and delete a key. The label is
  never sent, only what the key is *for*.
- `room_group_created` / `room_group_deleted` — the delete carries how many
  rooms were filed under it, read before the delete.
- `invitation_sent` / `invitation_accepted` — invite someone to a tenant and
  accept it. Accepting an invitation you already hold reports nothing, because
  nobody joined.

**Creating is intent; attaching is use.** Both are reported, and the distance
between them is the signal: a library of references nobody ever attached says
something quite different from one attached constantly. The snapshot carries
`reference_count` and `reference_attached_count` side by side for the same
reason.

**Everything else with a lifecycle**

- `reference_type_created` / `reference_type_deleted` — registering a *type*,
  which is an owner extending what Switch can point at, not making a reference.
- `template_created` / `template_deleted` — `template_kind` names the three the
  product uses and reports anything an operator invents as `other`.
- `agent_request_refused`: an agent asked for something a rule says no to:
  a template it did not save, a run that would need a new agent, a room in a
  paused or stopped run. `operation` and `reason` are fixed lists; which agent
  and which template stay in the server log.
- `room_link_created` / `room_link_removed`, `room_role_defined` /
  `room_role_deleted`, `room_users_added`.
- `reference_detached_from_room` / `document_detached_from_room` /
  `package_detached_from_room` — the inverse of the attach events, so a
  resource tried and dropped is distinguishable from one never used.
- `connector_configured` — the bridge row being written, which is not the same
  as it connecting. `is_preconfigured` separates the setup step's own
  connector from one a person added. Many of these and few `bridge_connected` is a deployment
  whose setup is failing, and only the pair shows it.
- `server_connector_registered` / `server_connector_removed`.

**Deliberately not reported**, so the boundary is stated rather than
discovered: edits that change a setting rather than create or remove
something — an agent's icon, display name or addressing policy, a room's
visibility, protection or observe config, moving a room between groups,
renaming anything. They are configuration, not adoption, and each would be an
event that fires constantly and answers nothing. Ask if one of them turns out
to matter.

**What a pass has not proved**

Every event firing locally says the call sites are wired and the payloads are
well-formed. It says nothing about whether the relay accepts them — that needs
one event watched arriving downstream, which no local check can substitute for.

## Open questions

- **Query cost at scale.** The snapshot is roughly fifteen queries per tenant,
  including two seven-day `DISTINCT` scans over `messages` and a window function
  over the message table. Nobody has run it against a production-sized dataset.
  That is the open question most worth answering before this is switched on for
  a large deployment.
- **Cost of the snapshot.** Several of its counts are distinct-count queries
  over the message table across a seven-day window. On a large deployment that
  is not free, and it should be measured before it runs daily on a live
  instance.
- **Self-hosted versus hosted.** The consent default is right for both, but a
  customer-operated deployment may warrant saying more in the docs than a
  pilot instance does.
- **Retention and deletion.** Owned by the relay rather than by Switch, but an
  operator who turns telemetry off will reasonably ask what happens to what was
  already sent. The answer should exist before someone asks.
