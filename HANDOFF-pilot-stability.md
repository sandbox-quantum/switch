# Handoff: Switch pilot stability (connection-lapse / pool-exhaustion bursts)

Status snapshot for whoever picks this up. This branch
(`fix/gateway-session-scope`) carries a **complete and tested** change over the
paths that matter (see §5); §6 lists what is deliberately left.

Operational how-to (reading Datadog + kube for this system) lives in the
**`switch-health` skill in the napoleon repo** — use it for any "check how the
server is doing" step below, including profiling the live process with py-spy
when the question is which *function* is responsible. Do not put infra
names/IDs/credentials in this repo (it is public); keep those in napoleon.

## 1. Symptom
On the pilot, agents drop and reconnect in **bursts** ("heartbeat lapsed"). In the
worst bursts the DB connection pool times out, auth on heartbeats fails, and it
snowballs (late beats → more lapses → more reconnects).

## 2. Root cause (evidence-backed, from live metrics + a py-spy profile + logs)
- **Not the database.** Query latency stayed flat (~44 ms p95) through a burst;
  `DBLoad` ~idle. Not CPU-throttled, not out of DB connections.
- **The bottleneck is the single asyncio worker (event loop).** During the burst
  `runtime.event_loop_lag` spiked to ~240 ms (idle ≈ 2 ms). A DB connection stays
  checked out for as long as its coroutine is *running or waiting for a turn on the
  worker* — not just while the (fast) query runs. So under a stampede, connections
  are held across scheduling waits, the pool (30 + 10 overflow = 40) fills, and
  requests time out (`db_pool_timeout` = 5 s). Timeouts landed in the exact minute
  lag peaked; as lag eased, the pool still hit 40 but drained without timing out.
- **The trigger is simultaneity, not volume.** Steady state is fine; a
  restart/lapse-cascade makes the whole fleet reconnect *at the same instant*
  (their 2 s beat timers and 5 s auth-cache entries end up synchronized), so all
  the work lands together.
- **Two feeders of pool pressure:**
  1. **Held connections** — gateway handlers hold a request-scoped DB session
     across slow Matrix/Slack calls (parked slots). → the fix on this branch (§5).
  2. **Per-request/query CPU + catch-up serialization** — py-spy (steady state)
     showed the worker's baseline CPU is dominated by **SQLAlchemy per-query
     statement compile/param-processing + TLS reads**, driven by the volume of
     beats (~3,800/min) and gateway status-polling (~100/min). Pydantic
     serialization is a **burst-only** cost (catch-up replay), not the baseline.

## 3. What each metric means / where to look
Datadog service `switch-core` (pilot). Key metrics: `agent.connections_expired`
(the lapses), `runtime.event_loop_lag`, `db.pool.in_use` (now a **peak**),
`db.pool.timeouts` (new), `db.query.duration`, `http.request.duration` by route.
Reading guide + queries: napoleon `switch-health` skill.

## 4. Already shipped
- **switch #560 — MERGED** (in image 0.28.1): `db.pool.in_use` is now a peak
  (catches sub-second spikes the old snapshot missed) + new `db.pool.timeouts`
  counter, dashboard panel, and a "pool refusing connections" monitor.
- **napoleon #407 — MERGED**: pilot exports metrics to Datadog.
- **napoleon #409 — open**: turn on OTLP **logs** for dev + pilot (pilot is
  already running with logs on as of the last deploy).
- **napoleon #411 — MERGED**: the `switch-health` skill (DD + kube runbook). A
  follow-up branch (`docs/switch-health-profiling`) adds the py-spy section it
  was missing — how to attach to the live pod, and the steady-state baseline in
  §2 to compare a new profile against.
- **The session-ownership redesign is IN 0.28.1**: switch-core no longer holds/
  fans out full transcripts — events are small ("every write is one small row").
  So payload size is *not* the remaining problem; simultaneity is.

Current deploy: **0.28.1**, metrics + logs exporting. A deploy itself causes a
reconnect stampede by design (everyone reconnects at once) — expect a burst on
every `deploy-env pilot`; it self-recovers in a few minutes.

## 5. THIS branch — session-scope fix
Goal: stop handlers from holding a pooled DB connection across external
(Matrix/Slack/adapter) calls. Rule: **scope the session to its DB work and close
it before the external call; keep co-committed writes atomic** (do NOT split a
multi-write transaction into separate sessions). Exemplar:
`core/switch_core/gateway/messaging_installs.py::disconnect_install`.

`gateway/rooms.py` gains two helpers — `_authorize_room_action` (auth on a short
session) and `_room_detail_response` (read-back on a short session after
external work). Converted:

- **`gateway/rooms.py`** — `create_room_from_yaml`, `post_room_agents`,
  `delete_room_agent`, `post_room_users`, `_set_archived` (so `archive_room`
  *and* `unarchive_room`), `delete_room`.
- **`bridges/agent/api/handlers.py`** — `_resolve_registration_user_id`, the
  dependency every registration passes through, and
  `register_known_agents_bulk_endpoint`.
- **`gateway/agents.py`** — `register_known_subagents`.

### Why the register endpoints, specifically
The room endpoints are operator traffic: someone clicking *archive*, a few an
hour. Converting them removes a tail risk. The registration path is the one
with the stampede's shape — a Console whose host becomes reachable re-registers
**every agent on it**, and each registration fans `create_agent_identity` out
across every bridge while (before this branch) holding a connection. Dozens at
once, against a pool of 40. If you only deploy part of this branch, deploy that
part.

### Things already checked, so you don't redo them
- **`create_room` does NOT need converting**, despite what earlier notes said.
  `get_current_user` commits and releases its connection before the handler
  body runs, and `create_room` issues no query until *after*
  `room_service.create_room` returns. It never holds a slot across provisioning.
  Same reasoning clears any handler with no query and no `get_tenant_is_admin`
  dependency before its external call.
- **Tenant binding survives the change.** A session opened from the factory
  inside a handler is stamped by the `after_begin` hook in `db/tenant_session.py`
  with whatever `current_tenant_id()` holds — and the tenant is bound around the
  *whole* endpoint in both entry points: `get_current_user` yields inside its
  `tenant_scope`, and `BearerAuthMiddleware` wraps the entire request for the
  agent bridge. A short session inherits exactly what the request session had.
- **`test_tenant_exemption_allowlist.py` is a real gate.** It inventories every
  module opening a raw `session_factory()` session. The three modules converted
  here are listed under "request path", with the reasoning above. A new
  conversion must add itself and argue for it — that test is the review.

### Testing
`core/tests/switch_core/gateway/test_room_handler_session_scope.py` and
`core/tests/switch_core/bridges/agent/api/test_registration_session_scope.py`
assert the property directly: each drives a handler with a stand-in service
that samples `pool.checkedout()` at the moment the external call begins, and
expects zero. **Copy this shape for any further conversion** — it is the only
thing that distinguishes "scoped" from "looks scoped".

Two notes on writing them. Call handlers **by keyword**, the way FastAPI does:
positionally, the pre-fix `unarchive_room` lined up against the new signature
by accident and passed. And the probe is worth a sanity check — a live queried
session reads as 1 — or a vacuous `== 0` will pass forever.

Run with Postgres via testcontainers: `DOCKER_HOST` at the local Docker socket
and `TESTCONTAINERS_RYUK_DISABLED=true`. `just check`, `just typecheck` and the
full `core/tests/switch_core` suite pass.

Leave pure-read endpoints alone (`list_rooms`, `GET /agents/{id}`) — the only
external call they make is a channel deeplink, which is cached or pure on every
bridge but Mattermost and Telegram.

## 6. Remaining work, prioritized
1. **Jitter / desynchronize** heartbeats and reconnects (client side: Switch
   Console + sidecar), and consider not lapsing on a single missed beat / adding
   reconnect backoff. This attacks simultaneity — the highest-leverage fix, and
   now the top of the list.
2. **Move Switch Console off status-polling** (`GET /gateway/agents/{id}`
   ~100/min) onto the push stream it already holds — removes constant pool
   pressure.
3. **Export the event-loop-lag distribution, not just its maximum.**
   `EventLoopLag` samples every 2 s (the connection sweep's own oversleep) but
   `take()` reports only the worst of ~30 samples per export window and resets.
   One 150 ms hiccup and a loop pegged at 150 ms are the same point on the
   graph, and they are completely different problems — a blocking call to hunt
   versus a worker that is simply saturated. The sampling already exists; only
   the summarising throws the distribution away. Cheap, and it is the metric
   that answers "are we near the edge yet".
4. **Serialize each event once, reuse across a connection's reads** (helps
   catch-up replay); and look at the SQLAlchemy expanding-param queries that
   re-render each call (`_process_parameters_for_postcompile` showed up hot).
5. **The rest of the session-scope sweep** — roughly twenty more handlers across
   `gateway/collaborations.py` (`update_bridge`'s adapter restart is the worst),
   `gateway/connectors.py`, the remaining `gateway/rooms.py` mutations
   (`patch_room`, `put_protection`, `put_observe`, `patch_room_agent`) and the
   two bulk endpoints, which hold one connection across a *loop* of external
   deletes. All real, all low-traffic — worth doing, but none of it is what
   fills the pool during a burst. Deliberately not in this branch: it would
   have tripled the diff for the least valuable two-thirds of it.
6. Consider a modest **pool size bump** as headroom while the above land (DB has
   ample capacity), and jitter the auth-cache TTL.

## 7. Key files
- `core/switch_core/bridges/agent/protocol/stream.py` — per-connection delivery /
  catch-up (serialization at ~L371).
- `core/switch_core/bridges/agent/protocol/event_buffer.py` — per-agent buffer.
- `core/switch_core/bridges/agent/protocol/connections.py` — heartbeat TTL (6 s),
  the sweep, `db.pool.timeouts` counter site is in `observability/http.py`.
- `core/switch_core/bridges/agent/auth.py` — per-request token resolution (the
  work heartbeats pay before their handler runs).
- `core/switch_core/observability/{pool,catalogue,http,runtime}.py` — metrics.
  `runtime.EventLoopLag` is the max-only summarising named in §6.3;
  `main._connection_sweep_loop` is what feeds it.
- `core/switch_core/gateway/*.py` and
  `core/switch_core/bridges/agent/api/handlers.py` — the handlers this branch
  fixes, and the ones §6.5 leaves.
- `core/switch_core/db/tenant_session.py` — why a factory-opened session is
  still tenant-scoped; read before converting anything else.
