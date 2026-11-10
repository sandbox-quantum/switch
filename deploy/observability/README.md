# Dashboards and alerts

Datadog definitions for what `switch-core` reports. They are kept here rather
than clicked together in the UI so that a change to a metric and a change to
the panel reading it land in the same review.

Nothing here contains an account, an API key, a team handle or a URL. The
monitors carry `@REPLACE-WITH-NOTIFICATION-HANDLE` where a destination belongs;
`apply.sh` fills it in from `NOTIFY` when importing.

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

## Alerts

Every monitor in `monitors.json` is something a user would notice and someone
should act on now: no data, the database unreachable or refusing connections,
the pool full for 10 minutes, messages not delivered, failing or late, a
messaging app bridge down, server errors, a slow API, a stalled server, or
agents dropping off together. Each says what users see and what to check, posts
when it fires, again every hour while it stays firing (`renotify_interval: 60`),
and once more when it recovers. A crashed bridge also gets an alert that names
it (`switch.bridges.crashed`), and "the morning report didn't post" fires when
the 09:00 report has been silent for 25 hours, so a quiet channel can be
trusted.

Priority follows what a user loses: P1 when Switch is down or messages are
lost, P2 when some people or one platform are affected, P3 when it is slow but
nothing is lost, P4 when only our own visibility is.

What isn't urgent stays out of them on purpose. Causes (slow queries, CPU,
garbage collection) belong on the dashboards, and a monitor that fires without
anyone needing to act teaches people to skim the channel. If one fires and the
answer is "that's fine", tune it or delete it that week.

Error alerts count failures rather than taking a percentage. At low traffic one
failure among a handful of requests reads as a high error rate, so a percentage
would page on noise.

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

`apply.sh` creates or updates the monitors and the Signal board, matching by
name and title so a second run updates in place:

```bash
DD_API_KEY=... DD_APP_KEY=... NOTIFY=@slack-<workspace>-<channel> ./apply.sh
DRY_RUN=1 ...   # print what would change
```

The application key needs monitor and dashboard write access. `dashboard.json`
and `multi-pod-dashboard.json` are not touched by it; import those by hand with
`POST /api/v1/dashboard` if a deployment doesn't have them yet.

## Check these before you trust the dashboard

**Histogram panels need two things, not one.** Request latency, delivery lag,
database query duration, pool hold and wait time (`switch.db.pool.hold.duration`,
`switch.db.pool.wait.duration`), platform call duration, rate-limit hold-backs,
the agent buffer's scan length and duration, and garbage-collection pauses
(`switch.runtime.gc_pause`) are OTLP histograms, and the
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
and `delivery` for rate-limit hold-backs), or
`p95: … by {…}` returns nothing on a fresh account. Empty is the honest outcome either way; a panel is never silently
switched to a different statistic.

The two latency **monitors** depend on the same thing, and fail more quietly
than a panel does: an alert over a percentile that is not enabled evaluates
against no series and sits healthy for ever. Check them after enabling
percentiles, not before.

**`env` is a filter, not a grouping.** The dashboard's `$env` variable defaults
to `*` and works whether or not anything sets it. The monitors deliberately do
*not* group by `env`: the tag only exists when `ENVIRONMENT` is configured
(it becomes OTLP's `deployment.environment`, which Datadog reads as `env`), and
a monitor grouped by a tag no data carries returns no series and sits silently
healthy for ever. If several deployments report into one Datadog org, set
`ENVIRONMENT` on each and add `env:<name>` to the monitor scopes by hand.

**`service` is the one tag everything depends on.** Every monitor filters on
`service:switch-core`. If a deployment changes `SERVICE_NAME`, every one of
them goes silent at once.

## The odd-looking first monitor

`[Switch] switch-core has stopped reporting` queries event-loop lag with a
threshold of `< 0`, which no real reading can satisfy. That is deliberate and
is Datadog's idiom for a no-data monitor: the threshold never fires, and
`notify_no_data` does the work. Event-loop lag is the metric used because it is
emitted every interval unconditionally — a request counter would read zero on a
quiet night and a heartbeat that can legitimately be absent is not a heartbeat.

## What is deliberately not alerted on

**Latency, below a level users feel.** The two latency monitors fire only when
it is plainly bad (API p95 over 2 s, delivery p95 over 10 s, sustained). On
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
own counters show one total. Pick the deployment with `env` and `service`. It
needs a build that tags points with `pod_name`; earlier builds show one
unsplit series.

`dashboard.json` sums per-pod gauges (consumers, pool, memory) so
its totals stay totals with several pods, and the pool-saturation monitor
alerts per pod, since one pod can exhaust its pool while the others idle.
