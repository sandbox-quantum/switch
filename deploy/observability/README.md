# Dashboards and alerts

Datadog definitions for what `switch-core` reports. They are kept here rather
than clicked together in the UI so that a change to a metric and a change to
the panel reading it land in the same review.

Nothing here contains an account, an API key, a team handle or a URL. The
monitors carry `@REPLACE-WITH-NOTIFICATION-HANDLE` where a destination belongs;
`apply.sh` fills it in from `NOTIFY` when importing. They also carry
`REPLACE-WITH-SERVICE` in their scope and `REPLACE-WITH-ENV` in their name and
tags, which `apply.sh` fills in from `SERVICE` and `ENV`: every monitor
watches one deployment only (see "`service`" below).

**Do not skip that.** Datadog does not validate notification handles: a monitor
carrying the placeholder imports cleanly, shows as healthy in the UI, triggers
normally — and notifies nobody. There is no error to notice. Replace every one
of them before you import, and test one deliberately.

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
on `service:switch-core env:pilot`: logs carry no `pod_name`, staging's pods
share pilot's name but are tagged `env:prod` only, and development reports as
`switch-core-dev`.

## Alerts

Every monitor in `monitors.json` is something a user would notice and someone
should act on now: no data, the database unreachable or refusing connections,
the pool full for 10 minutes, messages not delivered, failing or late, a
messaging app bridge down, server errors, a slow API, a stalled server,
agents dropping off together, or auto-route decisions failing, backing up or
expiring (see [Decision routing](#decision-routing)). Each says what users see and what to check, posts
when it fires, again every hour while it stays firing (`renotify_interval: 60`),
and once more when it recovers. A crashed bridge also gets an alert that names
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
`service:switch-core env:pilot`, for the reason the board's log panels do.

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
nothing is lost, P4 when only our own visibility is.

What isn't urgent stays out of them on purpose. Causes (slow queries, CPU,
garbage collection) belong on the dashboards, and a monitor that fires without
anyone needing to act teaches people to skim the channel. If one fires and the
answer is "that's fine", tune it or delete it that week.

Error alerts count failures rather than taking a percentage. At low traffic one
failure among a handful of requests reads as a high error rate, so a percentage
would page on noise. "Decisions are failing" is the one exception, and it keeps
a minimum volume for the same reason: see [Decision routing](#decision-routing).

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
needs read access to metrics, and to logs for the reason bridges fail. Its verdict, the choice of graph and the comments are tested in
`test_daily_report.py`.

## Importing

`apply.sh` creates or updates the monitors, matching by name so a second run
updates in place. It loads the Signal board too, but only for the deployment
that keeps the default service (`SERVICE=switch-core` with
`ALLOW_DEFAULT_SERVICE=1`): the board is shared, under one title, so a run
for any other deployment leaves it alone.

```bash
DD_API_KEY=... DD_APP_KEY=... NOTIFY=@slack-<workspace>-<channel> \
  SERVICE=<service> ENV=<env> ./apply.sh
DRY_RUN=1 ...   # print what would change
```

The application key needs monitor and dashboard write access. `dashboard.json`
and `multi-pod-dashboard.json` are not touched by it; import those by hand with
`POST /api/v1/dashboard` if a deployment doesn't have them yet.

## Check these before you trust the dashboard

**Histogram panels need two things, not one.** Request latency, delivery lag,
database query duration, pool hold and wait time (`switch.db.pool.hold.duration`,
`switch.db.pool.wait.duration`), platform call duration, rate-limit hold-backs,
the agent buffer's scan length and duration, garbage-collection pauses
(`switch.runtime.gc_pause`), cloud machine memory (`switch.hosted.box_memory_used`),
hosted box anonymous memory (`switch.hosted.box_anon_memory`),
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
and `delivery` for rate-limit hold-backs, `backend` for decision duration, model
time and confidence, `outcome` for decision wait), or
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

- **Per request to a backend:** decisions per second by outcome (`agent`,
  `none`, `failed`), failures by reason, the errors a backend reported behind
  it by kind, and duration beside model time by backend, so the gap between
  them shows the network and the backend's queue rather than the model.
- **Per message:** how each undecided message ended (`settled`, by outcome),
  how long the person waited (`wait`), how many are waiting now and how old the
  oldest is, and the "auto-route is unavailable" notices posted to rooms.
- **The confidence distribution,** for setting a workspace's threshold: how
  many answers land just under it.
- **The default decision service's health check** (`check:decision`). It exists
  only when the server has a default decision endpoint, and it never takes
  switch-core out of service: a down decision pod must not take core with it.

`backend` is the kind of backend that was asked, never which endpoint,
workspace or machine. Those are per tenant, and live in the decision record
switch-core logs for each message.

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
status reports, the hosted controller service's calls, and, for hosted agents
v2 boxes, the operator's observations. Laptops and SSH hosts are never
counted. No metric carries an id: every attribute is a word from a fixed set
(`core/switch_core/observability/hosted.py`), and `backend` is the kind of
machine: `vm` for a v1 machine, `box` for a hosted agents v2 box.

- The gauges come from one Core process, the one holding the hosted metrics
  advisory lock, so several processes don't each report every machine. A
  report older than 3 minutes is left out rather than reported as it was.
- Agents, stopped agents, sessions, machines expected and reporting, memory
  and disk used, provider logins and provisioning time are reported for both
  kinds, by `backend`. The rest (restarts, out-of-memory kills, waiting for
  room, the valve, the gateway, evictions, guard stops and valve parks) are
  boxes' only, with no `backend`.
- A v1 machine reports no session state, so `switch.hosted.agents` always has
  `session:none` for it: chart it by `process`.
- `switch.hosted.box_memory_used` is recorded once per machine report: a
  machine serving several workspaces sends its memory in each workspace's
  report, and only the first fresh one, by workspace id, is counted.
- `switch.hosted.guard_stops` and `switch.hosted.valve_parks` are counts of the
  rise in each box's since-start figures, so a controller restart reads as a
  reset, not a drop.
- **A silent machine** is `switch.hosted.boxes_reporting` below
  `switch.hosted.boxes_expected`. Machines stopped by their owner or for
  idleness, and boxes paused or turned off, are not expected, so they don't
  set it off.
- `switch.hosted.machine_events` counts cloud machine changes once committed,
  at the same points as the product telemetry events of the same names, so it
  counts whether or not product telemetry is on.
  An idle machine with no agents left is released with its disk kept rather
  than stopped, and counts as `event:stopped` with `reason:retained`.
- `switch.hosted.reconciler_silence` is per process, counted from the
  process's start until it first hears from the hosted controller service, so
  a reconciler that is down when Core restarts still shows as silent. Read the
  minimum over pods.
  **On a server with hosted agents v2 on**, the box workers (the scaler and
  the drain worker) poll the same machine list, so the gauge shows the
  hosted controller service as a whole, not the v1 machines' reconciler
  alone: it stays low while the box workers run, even if the v1 reconciler
  has stopped. On a v1-only server it watches the v1 reconciler alone.
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
- `switch.auth.sign_in_failures` counts password sign-ins refused for a wrong
  password or an unknown email, with no attributes at all. Its alert fires
  above 20 in 10 minutes, at low urgency.
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
  address or any part of the credential. With hosted agents v2 on it also
  counts `locked_out` (a request refused while its address is locked out) and
  `lockout_started`, and the cloud controller service's `hosted_provisioner`
  and `hosted_operator` routes.
- Credential refusals have two alerts. **The paging one** watches the bearer
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
- Two box alerts, low urgency: 3 or more memory guard stops, and 3 or more
  evictions, in 30 minutes.
- `switch.hosted.alerts_open` counts the operator alerts open now, by condition
  only. Which box, machine or service is on the operator's Alerts tab, never
  in Datadog.
