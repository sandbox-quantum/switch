# Dashboards and alerts

Datadog definitions for what `switch-core` reports. They are kept here rather
than clicked together in the UI so that a change to a metric and a change to
the panel reading it land in the same review.

Nothing here contains an account, an API key, a team handle or a URL. The
monitors carry `@REPLACE-WITH-NOTIFICATION-HANDLE` where a destination belongs;
`apply.sh` fills it in from `NOTIFY`, `NOTIFY_PAGE`, `NOTIFY_SECURITY` and
`NOTIFY_SECURITY_PAGE` when importing (see [Routing](#routing)). They also carry
`REPLACE-WITH-SERVICE` in their scope and `REPLACE-WITH-ENV` in their name and
tags, which `apply.sh` fills in from `SERVICE` and `ENV`: every monitor
watches one deployment only (see "`service`" below).

**Do not skip that.** Datadog does not validate notification handles: a monitor
carrying the placeholder imports cleanly, shows as healthy in the UI, triggers
normally — and notifies nobody. There is no error to notice. `apply.sh`
therefore refuses to run without every handle, and refuses to send anything
that still carries a placeholder once filled in. Test one alert deliberately
after a first import all the same.

## What the server has to be doing first

Reporting is off until a collector is named. See `OTLP_ENDPOINT` and
`DEPLOYMENT_ID` in `.env.example`, or `switchCore.observability` in the Helm
chart. With neither set these panels are empty, and only the first monitor —
the no-data canary — has anything to say. That is a correct reading, not a
broken dashboard.

Every metric this server can emit is declared in
`core/switch_core/observability/catalogue.py`, with the attributes each may
carry. That file is the reference; this directory is one view of it.

## The Signal board

`signal-board.json` is the one screen to open first: the four golden signals
(latency, traffic, errors, saturation) plus two questions only Switch has, "are
agents connected?" and "are the messaging apps up?". Everything is grey while it
is normal. A value turns red, and a dashed red line marks the limit an alert
watches, so the exception is the only thing in colour. Tiles always show the
last hour, whatever the time picker says, so a red tile means "now"; charts
follow the time picker. The other dashboards are where you go next, for causes.

Keep it that way when you edit it: one question per tile, at most five series
per chart, a limit drawn on any chart an alert reads, and colour only for state.

Below the signals, "Digging into error logs" is where you go once something is
red and you want the why. It reads switch-core's own logs on pilot, errors and
warnings only: errors over time by the logger that wrote them, the most
frequent messages with their ids folded into one pattern (usually the fastest
way to the cause), warnings by logger, and the latest errors as they arrived.
Its note links the same view in Logs and Error Tracking. The log panels filter
on `service:switch-core` alone: development reports as `switch-core-dev`, the
only other `service:switch-core` logs are staging's product events, all at
info, and `env` can't tell deployments apart because the telemetry relay sets
it (hoot's `public_otel_proxy`).

## Alerts

Every monitor in `monitors.json` is something a user would notice and someone
should act on now: no data, the database unreachable or refusing connections,
the pool full for 10 minutes, messages not delivered, failing or late, a
messaging app bridge down, server errors, a slow API, a stalled server,
agents dropping off together, or auto-route decisions failing, backing up or
expiring (see [Decision routing](#decision-routing)). Each says what users see and what to check, posts
when it fires, again every hour while it stays firing (`renotify_interval: 60`),
and once more when it recovers. The gateway's admission control (`gateway/admission.py`) has two: requests answered 503 because a pod ran out of its share of the pool, which people see as errors, and, at low urgency, one caller answered 429 again and again, which usually means a client that should batch its requests. A crashed bridge also gets an alert that names
it (`switch.bridges.crashed`), and "the morning report didn't post" fires when
the 09:00 report has been silent for 25 hours, so a quiet channel can be
trusted.

Four more alerts read logs rather than metrics, for failures that only show
up there: a request failing with an unhandled error (`Exception in ASGI
application`), a pod losing the lease on its agents' connections without
shutting down (a pod shut down in a deploy is logged at info and does not
fire it), a bridge
failing to post for 10 minutes (more
than 10 `Could not publish` lines, so one message retrying briefly stays
quiet), and a burst of more than 25 errors in 15 minutes. Before this change the
worst 15 minutes of the first week of November held 54 errors, almost all the
Slack identity error now logged as a warning; without it the worst was 7. Log alerts filter on
`service:switch-core`, for the reason the board's log panels do.

The security detection rules are log alerts too, each watching one agent or
person for something suspicious (a burst of messages, reading many rooms,
moving many files, sign-ins failing): see
[Security detection rules](#security-detection-rules).

"Agent controllers keep reconnecting" watches `switch.controllers.connections`
with `event:opened`, for the reconnect storm seen on pilot in November (about
7,500 controller connections opened every six hours, so around 625 every 30
minutes, about 570 when this was written): more than 900 in 30 minutes fires,
so it is quiet at today's level and says when the storm gets worse. Lower it
to 450 once the reconnect loop is fixed. A rollout reconnects each controller
once or twice, which stays below either. `event:taken_over` on the
same metric is the churn's signature; the signal board shows every event.

Priority follows what a user loses: P1 when Switch is down or messages are
lost, P2 when some people or one platform are affected, P3 when it is slow but
nothing is lost, P4 when only our own visibility is. Security alerts follow
what is at risk instead: P2 for data likely leaving now, P3 for a pattern
someone should look at today, P4 for a record of something legitimate but
sensitive (see [Security detection rules](#security-detection-rules)).

What isn't urgent stays out of them on purpose. Causes (slow queries, CPU,
garbage collection) belong on the dashboards, and a monitor that fires without
anyone needing to act teaches people to skim the channel. If one fires and the
answer is "that's fine", tune it or delete it that week.

Error alerts count failures rather than taking a percentage. At low traffic one
failure among a handful of requests reads as a high error rate, so a percentage
would page on noise. "Decisions are failing" is the one exception, and it keeps
a minimum volume for the same reason: see [Decision routing](#decision-routing).

## Routing

Every monitor has a `category:` tag, and the tag decides who hears about it:

| Monitor | Notifies |
| --- | --- |
| `category:ops`, P2 to P5 | `NOTIFY` (the ops channel) |
| `category:ops`, P1 | `NOTIFY` and `NOTIFY_PAGE` (the ops pager) |
| `category:security`, P3 to P5 | `NOTIFY_SECURITY` (the security channel) |
| `category:security`, P1 or P2 | `NOTIFY_SECURITY` and `NOTIFY_SECURITY_PAGE` (the security pager) |

Each variable holds one or more Datadog handles separated by spaces, each
starting with `@` (`@slack-<workspace>-<channel>`, `@pagerduty-<service>`,
`@opsgenie-<team>`, …). All four are required on every run, even while no
security monitor is at P1 or P2, so the pager is in place before the first one
arrives. Setting `NOTIFY_SECURITY` to the same value as `NOTIFY` works, with a
warning, for a deployment that has no separate security channel.

`category:security` covers the credential refusal alerts and password
sign-in failures (see [Hosted agents](#hosted-agents)), and the
[security detection rules](#security-detection-rules) on the
`switch.event: security.*` log lines. The bearer-route credential refusals
alert and "an agent is reading many rooms" are P2 and page; the rest are P3
or P4 and reach the security channel only.

Only P1 pages for `category:ops`: Switch is down or messages are being lost
(see the priorities under [Alerts](#alerts)). That is the no-data canary, the
database being unreachable, and room messages not being delivered or failing
to send. Everything below P1 can wait for someone to read the channel. A
deployment with no pager yet sets `NOTIFY_PAGE` to its channel, and the
duplicate is sent once.

**Name the security on-call owner.** Whoever `NOTIFY_SECURITY_PAGE` reaches
is the security on-call: `<security on-call owner: to be named>`. Until a
person or rotation is named here and behind that handle, a P1 or P2 security
alert pages nobody who knows it is theirs.

**Adding a monitor:** give it `category:ops` or `category:security` (exactly
one), a `priority`, the `service:`, `env:`, `team:` and `tier:` tags, and the
handle placeholder exactly once at the end of its message. Never write a real
handle into `monitors.json`. `check_monitors.py` checks all of that, and also
that a monitor reading a security signal (`switch.controller.credential_refusals`,
`switch.auth.*`, or the security event stream's logs: `switch.event:security.*`,
alone or in a group, `switch.action`, `switch.scope`, `switch.actor_user_id`,
`switch.audit_event_id`, `security_details.*`, or the `switch_core.security`
logger) is tagged `category:security`; extend `SECURITY_SIGNALS` there when a
new one appears. A log facet's value in a message, `{{[@switch.agent_id].name}}`,
is not taken for a handle. It runs on every pull request and before every
import.

## Security detection rules

These alert on what one agent or one person is doing, not on the server as a
whole. They are log monitors over the security event stream (see "The
security event stream" in `docs/old/observability.md`), grouped by the actor,
so each agent, person, address or caller fires and recovers on its own and the
alert names it (`{{[@switch.agent_id].name}}` and the like). Every one is
`category:security`, keeps a log sample (ids only: the stream never carries
message text, file names or tokens), and ends with how to stop the actor:
suspend them with the `switch-suspend` CLI or the gateway's suspend and freeze
routes.

The fields are read as Datadog attributes: the JSON log format nests them
(`{"switch": {"agent_id": ...}, "security_details": {...}}`) and the OTLP log
export flattens them to `switch.agent_id`, and Datadog queries both as
`@switch.agent_id`.

| Rule | Reads | Grouped by | Fires above | Priority |
| --- | --- | --- | --- | --- |
| An agent is posting a burst of messages | `security.agent.message_sent` | `switch.agent_id` | 300 in 5 min (60 a minute) | P3 |
| An agent is reading many rooms | `security.agent.room_read`, distinct `switch.room_id` | `switch.agent_id` | 10 rooms in 10 min | P2 |
| One actor is adding many room members | action `room.member_added` by a person or an acting agent | `switch.actor_user_id`, `security_details.acting_agent_id` | 10 in 10 min | P3 |
| One actor is moving many files | `security.attachment.uploaded` / `.downloaded` | `switch.agent_id`, `switch.actor_user_id` | 50 in 10 min | P3 |
| An agent is asking for many service tokens | `security.service_token.issued` | `switch.agent_id` | 30 in 10 min | P3 |
| Switch Trust blocked or redacted a message | actions `trust.message_blocked` / `trust.message_redacted` (an `alerted` or `errored` verdict is the log-only `security.trust.verdict`, not alerted on) | `switch.agent_id`, `switch.actor_user_id` | any | P3 |
| An agent was given more power | actions `agent.auto_approve_enabled`, `agent.can_manage_agents_granted` | `switch.agent_id` | any | P3 |
| A platform operator acted in a workspace | action `platform.access` | `switch.actor_user_id` | any | P4 |
| An API key was revealed | action `api_key.revealed` | `switch.actor_user_id` | any | P4 |
| Sign-ins failing from one address | `security.auth.sign_in_failed` | `security_details.client_ip` | 20 in 10 min | P3 |
| Sign-ins failing for one account | `security.auth.sign_in_failed` naming a real account | `switch.actor_user_id` | 20 in 10 min | P3 |
| One caller keeps tripping the refusal breaker | `security.refusal_breaker.tripped` | `security_details.caller` | 5 in 10 min | P3 |
| An agent or person was suspended | actions `agent.suspended` / `user.suspended` | `switch.target_type`, `switch.target_id` | any | P4 |

**The thresholds are starting points.** They come from the load tests (an
agent's busiest realistic step is one message every 3 minutes) and judgement,
not from production. Revisit every one after two weeks of production
baseline: read each rule's query over those two weeks, by group, and set the
limit well above the busiest legitimate actor, or delete a rule that only
ever fired for something fine.

The suspension rule matches actions another change is still adding
(`agent.suspended`, `user.suspended`); it matches them by name and stays quiet
until the first one is written. `test_monitors.py`
checks that every other event and action a rule names is one Core writes, since
a log monitor matching nothing sits healthy for ever. Sign-ins by address are
only as good as the address: unless `FORWARDED_ALLOW_IPS`
(`switchCore.forwardedAllowIps`) names the proxy in front of switch-core,
every attempt carries the load balancer's address and that rule counts
everyone together.

`security.agent.rooms_listed` (an agent calling `list_all_rooms`) is logged
but has no rule of its own: listing reads names, not conversations, and an
agent sweeping rooms has to read them next, which the room-read rule counts.

## The morning report

`daily_report.py` posts once a day into a Switch room, as an agent in that room:
a first line that says "all good" or how many things to look at, one line per
signal for the last 24 hours, and one graph of the day. The graph comes with a
short lesson (how to read it, what to look for) and a comment on the day: what
it did, with numbers, and what that means, down to a likely cause and the
detail-board chart to open next when something is off. The graph is the one
behind the first line that needs a look; on a good day, the one that moved most
against the same day last week; on a quiet day, the next in turn, so the team
meets every signal over a week or two. It covers what can wait for the morning, the
things the monitors deliberately don't post: a pool that came close to full,
latency creeping up, agents still on the old connection, events dropped for
agents that were away.

```bash
DD_API_KEY=... DD_APP_KEY=... SWITCH_URL=... SWITCH_AGENT_ID=... \
  SWITCH_ROOM_ID=... SWITCH_TOKEN=... uv run daily_report.py
```

Without the `SWITCH_*` settings it only prints the report. The application key
needs read access to metrics, and to logs for the reason bridges fail. Its verdict, the choice of graph, the comments and the drawing are tested in
`test_daily_report.py`, with the script's own dependencies (CI runs the same):

```bash
uv run --no-project --with-requirements daily_report.py --with pytest pytest
```

## Importing

`apply.sh` creates or updates the monitors, matching by name so a second run
updates in place. It loads the Signal board too, but only for the deployment
that keeps the default service (`SERVICE=switch-core` with
`ALLOW_DEFAULT_SERVICE=1`): the board is shared, under one title, so a run
for any other deployment leaves it alone.

```bash
DD_API_KEY=... DD_APP_KEY=... \
  NOTIFY=@slack-<workspace>-<ops-channel> \
  NOTIFY_PAGE=@pagerduty-<ops-service> \
  NOTIFY_SECURITY=@slack-<workspace>-<security-channel> \
  NOTIFY_SECURITY_PAGE=@pagerduty-<security-service> \
  SERVICE=<service> ENV=<env> ./apply.sh
WORKOS_DIRECTORY=1 ...   # also the WorkOS directory monitors
```

Before it sends anything it runs `check_monitors.py`, checks every handle
variable is set and starts with `@`, fills in the placeholders, and stops with
a non-zero exit, naming the problem, if any `REPLACE-WITH-…` is left in a
monitor or in the Signal board. Nothing is half-applied by a refusal.

`DRY_RUN=1` changes nothing. It prints each filled-in monitor as one JSON
object per line on stdout, and a `route:` line per monitor on stderr saying
where it goes:

```text
route: [Switch prod] the database is unreachable [ops P1] -> @slack-example-ops @pagerduty-example-ops
route: [Switch prod] Controller credential refusals rising [security P2] -> @slack-example-security @pagerduty-example-security
```

It needs no Datadog keys; given them, it also reads Datadog to say which
monitors it would update and which it would create. `test_monitors.py` drives
it this way to check the routing and the refusals.

The monitors tagged `requires:workos-directory` are imported only with
`WORKOS_DIRECTORY=1`. They read the WorkOS mirror's metrics, which only a server
with `ORGANIZATION_DIRECTORY=workos` reports, and the first fires on no data;
on any other server it would fire for ever. A test keeps every monitor on a
`switch.workos.*` metric tagged.

The application key needs monitor and dashboard write access. `dashboard.json`
and `multi-pod-dashboard.json` are not touched by it; import those by hand with
`POST /api/v1/dashboard` if a deployment doesn't have them yet. To bring an
existing copy up to date, open it in Datadog, then the settings menu, Import
dashboard JSON, and paste the file: that replaces the copy's widgets and
variables in place and keeps its URL. Edit the file here, not the copy: a
change made only in Datadog is lost at the next import.

`dashboard.json` opens with **Releases**: every panel follows the **version**
picker (`*` for every release), and the comparison panels draw **version**
beside **baseline**. The release event panels read switch-core's usage events
from logs (`TELEMETRY_ENABLED`), filtered by service alone, like the Signal
board's log panels. Version 0.27.0 is left out of every query: it came from
instances that no longer run. The **Prod** and **Dev** saved views set
`service` to `switch-core` and `switch-core-dev`.

### Applying to a deployment

Monitors belong to a deployment, not to this repository. Each one is scoped to
one deployment's `service`, its handles are that deployment's on-call, and its
queries read signals that only the switch-core version it runs emits. So the
deployment's own tooling runs `apply.sh`, from the Switch version it deploys,
when it promotes that version, with its own Datadog keys, `SERVICE`, `ENV` and
handles. Applying from `main` here would alert on signals a deployment's pinned
version may not emit yet.

What this repository checks needs no secret. On pull requests, PR CI's
"Morning report" job runs `check_monitors.py` and `test_monitors.py`, so a
monitor that would be refused at apply time is refused at review.

`hosted-dashboard.json` is the hosted agents board for whoever is on call: the
hosted alerts, then the main dashboard's hosted charts in reading order (a test
keeps them equal). Import it in Datadog under Dashboards, New Dashboard, Import
dashboard JSON, then set `$service` and `$flint_env` to the deployment's, and
replace `REPLACE-WITH-SERVICE` in the alerts panel's query with its service.

## Check these before you trust the dashboard

**Histogram panels need two things, not one.** Request latency, delivery lag,
database query duration, pool hold and wait time (`switch.db.pool.hold.duration`,
`switch.db.pool.wait.duration`), platform call duration, rate-limit hold-backs,
the agent buffer's scan length and duration, garbage-collection pauses
(`switch.runtime.gc_pause`), cloud machine memory (`switch.hosted.box_memory_used`),
and decision duration, model time, confidence
and wait (`switch.decision.duration`, `switch.decision.model_time`,
`switch.decision.confidence`, `switch.decision.wait`) are OTLP histograms, and the
`p95:`/`p99:` queries here assume the collector exports them to Datadog as
*distributions*. Check the collector's
histogram mode — in the older `histograms` mode they arrive as separate
`.count`, `.sum`, `.min` and `.max` series and these panels stay empty.

Then check the second thing, which is easy to miss because it is on Datadog's
side rather than the collector's: **percentile aggregations are off by default
on a distribution metric and are billed separately.** Enable them per metric in
Metrics Summary, and add the tag each panel groups by to that metric's
configured tag set (`route` for requests, `operation` for database queries and
the agent buffer, `caller` for pool hold time but not wait time, `generation` for
garbage-collection pauses, `bridge` and `platform` for bridge calls, `platform`
and `delivery` for rate-limit hold-backs, `model` for decision duration, model
time and confidence, `outcome` for decision wait, and `version` for the
release scorecard and comparisons), or
`p95: … by {…}` returns nothing on a fresh account. Empty is the honest outcome either way; a panel is never silently
switched to a different statistic.

The three latency **monitors** (the API, delivery, and decisions) depend on the same thing, and fail more quietly
than a panel does: an alert over a percentile that is not enabled evaluates
against no series and sits healthy for ever. Check them after enabling
percentiles, not before.

**Monitors are scoped by `service`, never by `env`.** The `env` tag Datadog
shows on these metrics is set downstream of Core, not from the deployment's
`ENVIRONMENT`: one deployment's points have
been seen under several `env` values at once. So `env` can't separate
deployments, and a monitor scoped by it could watch the wrong ones or nothing.
`service` (the deployment's `SERVICE_NAME`, sent as OTLP's `service.name`) is
the one tag Core sets that Datadog keeps, so every query filters on
`service:REPLACE-WITH-SERVICE`, which `apply.sh` replaces with `SERVICE`.
**Give every deployment its own `SERVICE_NAME`** (for example
`switch-core-prod`, `switch-core-staging`); two deployments sharing one would
share their alerts. `apply.sh` refuses the default `switch-core` unless
`ALLOW_DEFAULT_SERVICE=1` is set, for the one deployment meant to keep it.

`ENV` still names each copy (`[Switch <env>] …`) and tags it, so each
deployment imports its own set and they never overwrite each other. Without
the scoping, any deployment reporting into the same org (a test slot,
staging, a developer's server) could fire production's alerts: an ordinary
restart of a test server reads as "switch-core has stopped reporting".

**Monitors imported before this change** are named `[Switch] …` with no
environment, so the first import with `ENV` creates new ones beside them
rather than updating them. Delete the old ones by hand after that import, or
both copies alert.

**`service` is the tag everything depends on.** Import with the `SERVICE` the
deployment really sends: a wrong one leaves every monitor silent at once,
apart from the no-data canary, which fires and says so. The dashboard's
`$flint_env` variable is a convenience filter only; pick by `$service`.

**`flint_env`** is the deployment's `ENVIRONMENT`, when it's a short plain
name (a lowercase letter or digit, then up to 31 more or `-`), and is left off
otherwise. Core puts it on the resource of every metric and log batch, and a
collector in front of Datadog keeps it as a tag. `service` still tells
deployments apart.

## The odd-looking first monitor

`[Switch <env>] switch-core has stopped reporting` queries event-loop lag with a
threshold of `< 0`, which no real reading can satisfy. That is deliberate and
is Datadog's idiom for a no-data monitor: the threshold never fires, and
`notify_no_data` does the work. Event-loop lag is the metric used because it is
emitted every interval unconditionally — a request counter would read zero on a
quiet night and a heartbeat that can legitimately be absent is not a heartbeat.

## Decision routing

With auto-route on, a person's untagged message waits while a decision backend
(the server's default decision service, a workspace's own endpoint, Haiku, or
one of the workspace's machines) picks which agent, if any, should answer it.
The "Decision routing" section at the bottom of `dashboard.json` follows that
from both ends:

- **Per request to a backend, by the model that answered:** decisions per
  second by outcome (`agent`, `none`, `failed`), failures by reason, the errors
  a backend reported behind it by kind, and duration beside model time, so the
  gap between them shows the network and the backend's queue rather than the
  model.
- **Models side by side:** decisions per second for each model with the share
  it answered `none`, and a scorecard over the whole time range (decisions,
  none and failed shares, p95 duration and model time, p50 confidence). When
  the server default moves to another model, one model's line ends where the
  next one's starts, and the scorecard compares the two.
- **Per message:** how each undecided message ended (`settled`, by outcome),
  how long the person waited (`wait`), how many are waiting now and how old the
  oldest is, and the "auto-route is unavailable" notices posted to rooms.
- **The confidence distribution,** for setting a workspace's threshold: how
  many answers land just under it. A dashed line marks 0.80, the threshold a
  decision delivers at on nonprod.
- **The decision service's own view** (optional): decisions by model from
  its `decide backend=... model=...` log lines, under `service:switch-decision`.
  The lines carry the model in their text only, so the panel needs a log
  pipeline for that service with a Grok parser that takes `model` out of the
  message (for example
  `decided decide backend=%{notSpace:backend} model=%{notSpace:model} %{data}`)
  and a `@model` facet. It is empty until both exist, and while the decision
  service ships no logs (`OTLP_LOGS_ENABLED`).
- **The default decision service's health check** (`check:decision`). It exists
  only when the server has a default decision endpoint, and it never takes
  switch-core out of service: a down decision pod must not take core with it.

`backend` is the kind of backend that was asked, never which endpoint,
workspace or machine. Those are per tenant, and live in the decision record
switch-core logs for each message.

`model` is what answered: the model name in the decision service's answer
(`gemini-decision-1`, `strands-decider-E4B`, `claude-haiku-5-5`, ...). The
server default is one backend whichever model runs behind it, so `model` is
what tells a change of model apart. A decision with no answer (a timeout, an
error status) has no model to name and is `unknown`: switch-core configures no
model itself, the decision service picks it, so failures and backend errors are
mostly `unknown`. A workspace's own endpoint is always `workspace_endpoint`,
since its owner chooses the name it sends and that name could identify the
workspace. A name that isn't plain, or past the first eight one process has
seen, is `other`, so the attribute stays bounded.

The decision monitors don't group by `model`: a failure usually has no model,
and a slow model already shows on the duration panel by model.

**Pending is read with `max`, never `sum`.** `switch.decision.pending` and
`switch.decision.pending.oldest_age` are sampled from the database, so every
pod reports the same server-wide value; summed, they would read two pods as
twice the backlog. `multi-pod-dashboard.json` shows pending per pod so you can
see that they agree. The machine-state gauge arrives with "run on my machines",
and is read with `sum`, since each pod counts only the machines connected to it.

**The monitors:**

- *Decisions are failing:* more than 20% of decisions in the last 15 minutes
  failed, counted against at least 10. It divides the 15-minute failure count
  by the 15-minute request count raised to at least 10 (`moving_rollup`, then
  `clamp_min`), so a quiet room needs three failures, not one, before it fires.
  Trigger it once on purpose after import: a query Datadog evaluates
  differently from what was meant fails silent, like an unenabled percentile.
- *The default decision service is unhealthy:* the health check above, below 1
  for 5 minutes. It points at the decision pod, not core.
- *Undecided messages are backing up:* the oldest waiting message over 60 s for
  5 minutes, half the default two-minute limit, so it fires before messages are
  dropped.
- *Decisions are expiring:* any message dropped at the limit in 15 minutes.
  Each is a question nobody answered.
- *Decisions are slow:* p95 duration over 1.5 s for 30 minutes, as a
  **warning only**. Datadog requires a critical threshold, and the number in the
  query is it; it is set to 120 s, far past the decision timeout (5 s by
  default), so the monitor never goes critical and the 1.5 s warning is the one that notifies.

**Why there is no no-data monitor for decisions.** A quiet night, or a server
where nobody has turned auto-route on, makes no decisions at all, so silence is
not a fault. A dead process is already caught by "switch-core has stopped
reporting".

**Why decisions are alerted on latency.** The rule below is not to alert on
latency short of what users feel. Decisions have an explicit target of under a
second, and a person sees nothing at all until the decision is made, so a slow
decision is felt directly. The long window and warning severity keep it a
notice rather than a page.

## The WorkOS directory

On a server whose organizations come from WorkOS, the mirror applies changes
made there (a removal, a demotion) to Switch. Four monitors watch it, and the
"WorkOS directory" section at the bottom of `dashboard.json` draws their
gauges with the limits:

- **Membership changes are not reaching Switch** (P2): no pass has read the
  events through for 5 minutes, or nothing has reported the cursor age for 15,
  meaning no process runs the mirror. People removed in WorkOS keep their
  access in Switch meanwhile.
- **An organization is stuck in the recheck** (P2): an organization has been
  rechecked in full on every pass for 15 minutes because checking it keeps
  failing.
- **The daily check hasn't finished** (P3): no full check of every linked
  organization for 26 hours, the backstop for what WorkOS sends no event for.
- **A WorkOS organization that Switch follows was deleted** (P3): the Switch
  organization keeps everything and is no longer checked; remove it if the
  customer is leaving (`docs/old/workos-directory.md`, "When a customer
  leaves").

Only the cursor-age monitor fires on no data: the other gauges come from
the same process, so a missing mirror would otherwise post three alerts for one
cause.

## What is deliberately not alerted on

**Latency, below a level users feel.** The API and delivery latency monitors
fire only when it is plainly bad (API p95 over 2 s, delivery p95 over 10 s,
sustained). Slow decisions get a warning; see
[Decision routing](#decision-routing). On
pilot in early November the API p95 stayed under 1 s even while the database
pool was full, so 2 s is a symptom, not noise. Anything slower than usual but
not yet that bad is for the dashboard.

**Bridge event volume.** It follows whatever the humans in the channels are
doing. A quiet Sunday is not an incident, and an alert that fires every
weekend is one nobody reads by the time something real happens.

**Readiness itself, from inside.** If the pod is not ready, Kubernetes already
knows and the deployment is already out of service. What is alerted on is the
dependency that caused it, which is the part that says what to go and fix.

**File descriptors.** `switch.runtime.open_fds` is on the dashboard and has no
monitor, which is a judgement rather than an oversight: a leak is a slope, not
a level, and the process cannot see the limit it is climbing towards. An
absolute threshold picked from here would be a guess. Watch the panel; an agent
reporting the container's limit would make this alertable properly.

**Garbage collection.** `switch.runtime.gc_collections` is emitted and
deliberately unpanelled — it is a curiosity for a service like this one, not a
signal. It is there for the day someone is chasing a memory question and wants
it.

## Across pods

`multi-pod-dashboard.json` shows switch-core per pod (`pod_name`), to see
whether work is shared between pods and whether anything is handled twice.
Gauges are split by pod; platform events, messages and the database server's
own counters show one total. Messages waiting for a decision are split by pod
too, but should read the same on every pod: the value is server-wide. Pick the deployment with `env` and `service`. It
needs a build that tags points with `pod_name`; earlier builds show one
unsplit series.

`dashboard.json` sums per-pod gauges (consumers, pool, memory) so
its totals stay totals with several pods, and the pool-saturation monitor
alerts per pod, since one pod can exhaust its pool while the others idle.

## Hosted agents

The `switch.hosted.*` metrics are reported only with the `hosted_agents` flag
on, and come from what cloud machines already send Core: their controllers'
status reports, and the hosted controller service's calls. Laptops and SSH
hosts are never counted. No metric carries an id: every attribute is a word
from a fixed set (`core/switch_core/observability/hosted.py`), and `backend`
is the kind of machine (`vm` for every machine this server makes today).

- The gauges come from one Core process, the one holding the hosted metrics
  advisory lock, so several processes don't each report every machine. A
  report older than 3 minutes is left out rather than reported as it was.
- A v1 machine reports no session state, so `switch.hosted.agents` always has
  `session:none` for it: chart it by `process`.
- `switch.hosted.box_memory_used` is recorded once per machine report: a
  machine serving several workspaces sends its memory in each workspace's
  report, and only the first fresh one, by workspace id, is counted.
- **A silent machine** is `switch.hosted.boxes_reporting` below
  `switch.hosted.boxes_expected`. Machines stopped by their owner or for
  idleness are not expected, so they don't set it off.
- `switch.hosted.machine_events` counts cloud machine changes once committed,
  at the points where product telemetry reports the same change, so it counts
  whether or not product telemetry is on.
  An idle machine with no agents left is released with its disk kept rather
  than stopped, and counts as `event:stopped` with `reason:retained`.
  A machine an operator holds stopped (`switch-cloud-machine stop`) counts as
  `event:stopped` with `reason:admin`.
- `switch.hosted.reconciler_silence` is per process, counted from the
  process's start until it first hears from the hosted controller service, so
  a reconciler that is down when Core restarts still shows as silent. Read the
  minimum over pods.
- `switch.hosted.machine_events` with `event:failed` says why a machine
  failed: `not_scheduled`, `never_started`, `never_connected` (a first launch),
  `wake_failed` (a wake or restart that didn't come back), `owner_left`,
  `needs_attention`, `reported`, or `stop_failed` (an error while it was
  wanted stopped). Each failure also writes one log line with the fixed field
  `switch.event: hosted.machine_failed`, its reason and the machine id.
- `switch.hosted.provider_login_problems` counts AI provider logins on cloud
  machines that are `missing` or `expired`, by provider (a fixed list, else
  `other`). The first time a machine reports one, Core writes one line with
  `switch.event: hosted.provider_login_problem`.
- `switch.hosted.provision_seconds` (from request to first report, new machines
  only) and `switch.hosted.disk_used` are histograms, like memory.
- `switch.observability.sample_failures` counts samples the hosted sampler
  couldn't take: its own warnings never reach Datadog, since the observability
  package's logs are kept out of the export.
- `switch.hosted.cloud_errors` counts cloud calls the hosted controller
  service saw fail, by `call` (`launch`, `start`, `stop`,
  `terminate`, `volume`, `describe`, `other`) and `kind` (`capacity`,
  `throttled`, `permission`, `other`), never the cloud's own code or message.
  5 or more in 15 minutes pages, capacity aside; 5 or more capacity errors is
  low urgency. The service sends its counts since it last reported with its
  next observation that Core accepts.
- `switch.hosted.controller_errors` counts the hosted controller service's own
  errors by `kind` (`cloud`, `core_api`, `state`, `other`), sent with its next
  observation that Core accepts. 10 or more in 15 minutes is low urgency.
- `switch.hosted.controller_restarts` counts agent controllers on cloud
  machines that report a new start time (`controller.started_at`, ISO-8601
  with an offset). Other controllers send it too, and Core ignores it from
  them. A dashboard panel only, no alert.
- `switch.auth.sign_in_failures` counts password sign-ins refused for a wrong
  password or an unknown email, with no attributes at all. Its alert fires
  above 20 in 10 minutes, at low urgency.
- `switch.auth.sign_in_lockouts` counts password sign-in lock-outs by `limit`
  (`email` or `client_address`), never the email or the address. Anyone who
  knows a person's email can lock their password sign-in by failing with it,
  and keep it locked by repeating that: email lock-outs arriving steadily
  with no `client_address` ones beside them look like that. A dashboard panel
  only, no alert. The operator lifts a lock with
  `DELETE /gateway/users/{user_id}/sign-in-lock`.
- `switch.runtime.unhandled_exceptions` counts exceptions nothing in Core
  handled, by `component` (`http`, `websocket` or a background `task`) and
  `type` (the nearest exception class from a fixed list, else `other`). Each
  also writes one line with `switch.event: runtime.unhandled_exception`,
  beside the full stack the server already logs. 10 or more in 10 minutes
  is low urgency: the log alert on "Exception in ASGI application" is the one
  that pages, since it carries the stack-trace sample.
- **The hosted gauges are read with `max:`, not `sum:`.** Only one Core
  process reports them (the one holding the lock), but a point can reach
  Datadog as more than one series when a collector or relay in front of
  Datadog stamps its own tags (such as `env`) on each copy. `sum:` would add
  those copies together.
- **Alert timings:** "machines expected but not reporting" fires about 10
  minutes after a machine's last report (3 minutes to count as silent, held 7);
  "hosted controller service silent" about 10 minutes after its last call
  (held 1 minute). The rest are in `monitors.json`.
- **Log fields:** fixed event names use the field `switch.event`, never
  `event.name` or `event_type`, which some pipelines treat as product events
  rather than logs.
- `switch.controller.credential_refusals` counts refused controller
  credentials by reason code and kind of route only, never the client's
  address or any part of the credential.
- Credential refusals have two alerts, both routed as security (see
  [Routing](#routing)). **The more urgent one** (P2, pages) watches the bearer
  routes only (`agent`, `controller`, `hosted_controller`) for the reasons that
  mean a token was guessed (`invalid_credential`, `missing_credential`,
  `wrong`, `missing`), at more than 50 in 10 minutes. A revoked or expired
  controller's own token is refused as `controller_revoked` or
  `token_expired`, so it doesn't count there. **A low-urgency one** watches
  token exchange and enrolment (`route:management`), at more than 30 in 10
  minutes. There, a revoked controller's exchange looks the same as a guess,
  but the standard agent controller stops after one refused exchange and its
  service isn't restarted for that (exit codes 3 and 6), so each revoked
  controller adds about one refusal: 30 is well above a normal day, and
  reached only by a large revoke or by someone trying credentials.
