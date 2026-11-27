# Property testing: v1, a catalog of what Switch promises

Status: in progress. The catalog and its gate are built (first slice, step 1).
The explore lane (`console/tooling-e2e/src/explore/`) predates this plan and is
adopted as one of its checkers; nothing else here is built yet.

The end-to-end harness (`console/tooling-e2e/`) checks scenarios: a fixed
sequence of steps and the result each should have. That finds the bugs
someone thought to script. It does not find the ones that need an
interleaving nobody wrote down: two writers in one room, a reconnect in the
middle of a read, a lease taken over while its old holder is still running.
Those are the bugs that matter most in Switch, because its core is a
concurrent message bus on Postgres.

This note proposes keeping an explicit list of the properties Switch must
always have, written at whatever level of formality each one supports, and a
platform that checks each property at several levels in CI: against a model,
against the code, against a running system, and through the UI.

## Goals and non-goals

Goals:

- **One list of properties**, kept in the repository, readable by someone who
  has not read the code. It is the answer to "what does Switch guarantee?".
- **Every property names its checkers**, and a gate that runs nothing (like
  the scenario coverage gate) fails when a property has no checker at a level
  it says it needs, or when a checker names a property that does not exist.
- **Formal models only where they pay**: the concurrent protocols at the core
  (the bus, delivery, leases). Everything else is semi-formal and checked by
  generated inputs.
- **Failures that can be reproduced**: a seed and a shrunk counterexample,
  uploaded with the run.
- **Assertions in the code that use Antithesis's API**, so the system can run
  under Antithesis later without changing them.

Non-goals:

- Proving the implementation correct. The models are checked against
  bounded state spaces, and the code against generated inputs; neither is a
  proof.
- Replacing the scenario lanes. Scenarios remain how a feature's behaviour is
  pinned down; properties sit on top of them.
- Adopting Antithesis now. Phase 4 evaluates it.

## Terms

- A **property** is a statement that holds of every run of the system:
  *safety* (nothing bad ever happens), *liveness* (something good eventually
  happens, bounded by a time in practice), or *reachability* (a state of
  interest happens in at least some runs, which shows the checker reached it).
- A **checker** is code that tests a property at one level: a Quint invariant,
  a Hypothesis state machine, a history check over a run's database, a
  Bombadil property.
- A **level** is where the checker looks: `model`, `code`, `system`, `ui`.

## Layout

A top-level `properties/` directory. It holds what spans the codebase; the
checkers that need a code tree's own fixtures stay in that tree and point
back here by id.

| Path | What it holds |
| --- | --- |
| `properties/README.md` | How to add a property and a checker, and how to run each level |
| `properties/catalog/*.yaml` | The properties, one file per area (`bus.yaml`, `delivery.yaml`, `lease.yaml`, ...) |
| `properties/specs/*.qnt` | The Quint models |
| `properties/history/` | The history checker: reads a finished run's database and assertion log, checks properties over them |
| `properties/gate/gate.py` | The gate, and the schema every entry is validated against (a Pydantic model): reads the catalog and every checker's tags, without running anything |
| `core/tests/switch_core/properties/` | Hypothesis state machines and Schemathesis runs, on core's Postgres fixtures |
| `console/tooling-e2e/src/explore/` | Bombadil, as today |

## The catalog

One entry per property:

```yaml
- id: delivery.no-silent-loss
  title: A resuming agent misses nothing without being told
  statement: >
    A client that resumes an agent's event stream from position p receives
    every one of the agent's own events after p, in order, or the stream opens
    with a gap that names each room events were lost from.
  kind: safety              # safety | liveness | reachability
  formality: formal         # informal | semi-formal | formal
  levels: [model, code, system]
  owner: platform           # a team or role, never a person
  status: proposed          # proposed | checked | retired
  notes: >
    Retention deletes old rows (agent_event_drops) and a restarted server
    numbers from a new boot (agent_event_heads.first_seq); both must surface
    as a gap, never as silence.
  gaps: {}                  # level: reason, for a level in `levels` with no checker yet
```

- `formality: formal` means a Quint model states the property; the entry
  names it as `spec: delivery.qnt::NoSilentLoss`. `semi-formal` means the
  statement is precise enough to check mechanically (quantifiers, temporal
  words used carefully) but no model exists. `informal` is a statement worth
  writing down that no checker can yet test; it is how a property enters the
  list.
- `levels` is what the property needs, not what exists. A level with no
  checker may be listed under `gaps` with a reason, as the scenario harness's
  `surface/exemptions.json` does for routes. `status: checked` requires
  no gaps and a checker at every level; a gap at a level that has a checker is
  an error, so an excuse cannot outlive what replaced it. A `checked` formal
  property's `spec` must name a definition that exists; a proposed one may
  name a model not yet written.
- Ids are `area.kebab-name`, unique, and never reused once retired.

### How a checker names its property

The gate finds checkers statically, so it can run in PR CI in seconds:

| Level | Checker | Tag |
| --- | --- | --- |
| model | Quint invariant or temporal property | `/// @property delivery.no-silent-loss` directly above the definition |
| code | Hypothesis state machine, Schemathesis check | `@pytest.mark.property("delivery.no-silent-loss")` on the test |
| system | History check | `@checks("delivery.no-silent-loss")` on the function |
| ui | Bombadil export | `/** @property ui.no-server-errors */` above the export |

Every run also writes which properties it checked and with what result to a
JSON file, and the CI summary shows a table of property × level: passed,
failed, or not run. A property whose checker was skipped shows as not run,
never as passed (the harness's strict mode, applied to properties).

## The four levels

### Model: Quint

Quint models the protocols where interleavings are the hard part. It
translates to TLA+, model-checks with Apalache (`quint verify`), simulates
at random (`quint run`), and writes traces in the ITF format that the
trace validation below reads. It is already used and installed locally.

Candidates, in order of how much a model would find:

1. **The bus and delivery** (`db/stores/message_store.py`, `delivery/router.py`,
   `messages/notify.py`, `db/stores/delivery_cursor_store.py`): room `seq`
   handed out under `pg_advisory_xact_lock`, the router deciding in the same
   transaction which agents a row is for, own-event numbering from
   `agent_event_heads`, retention and its drop marks, wake-ups that coalesce
   and can be lost, readers that work from their own cursor.
2. **Ownership leases** (`db/stores/ownership_lease_store.py`): claims and
   takeovers by process liveness on the database clock, with fencing tokens.
   Two processes can both believe they hold a key for a while; the property
   is that the stale one's writes are all refused, which is exactly what a
   model with a clock and a TTL can check.
3. **Agent sessions**: connect, disconnect, auto-start when a person addresses
   an agent with no live session (liveness, under fairness).
4. **Tasks**: delegate, accept, update, finalise; finalised is terminal. Retired
   in phase 2: the server no longer has the task protocol.

PR CI runs each model at small bounds (seconds). The nightly run uses deeper
bounds and long random simulation.

### Code: Hypothesis and Schemathesis

- **Hypothesis stateful tests** (`RuleBasedStateMachine`) on a real Postgres
  (testcontainers, as core's store tests already use). Rules are operations
  (post, join, leave, connect, resume, expire, claim, take over); the machine
  keeps a small in-memory reference model and checks the store against it
  after every step. Concurrency is exercised with several sessions whose
  steps Hypothesis interleaves. Where a Quint model exists, the reference
  model follows its state variables, so the two are visibly the same thing.
- **Schemathesis** on the FastAPI OpenAPI document, for properties of the
  HTTP surface: no 5xx for any input, responses that match their schema, and
  (with two tenants' credentials) no id from another tenant in any response.

PR CI runs a small number of examples per test; nightly runs many, with the
Hypothesis example database kept between runs so a failure found at night is
retried first the next day. Hypothesis runs one test's examples one after another,
so under nightly each machine's search is split into four shards
(`core/tests/switch_core/properties/shards.py`), each running a quarter of the
examples from its own seed under `pytest -n auto`; what a machine should reach
is judged over its shards together once the session ends. The scheduled run
gives each test file its own runner.

### System: workload, faults, history

The approach Jepsen and Elle take, applied to Switch:

- A **workload generator** drives a throwaway stack at random through the
  scenario harness's HTTP clients: agents registering, rooms created, posts
  addressed and not, joins and leaves, connections dropping and resuming.
  Every choice comes from one seed.
- **Faults**: latency and dropped connections between switch-core and
  Postgres (a proxy such as toxiproxy), killing switch-core mid-request,
  dropping the `LISTEN` connection, and two switch-core replicas against one
  database.
- A **history checker** reads what the run left behind (`messages`,
  `agent_events`, `agent_event_heads`, `agent_event_drops`, cursors, and what
  each client received) plus the assertion log, and checks properties over
  the whole history after the run.

The history checker needs no workload of its own to be useful: run after the
existing fast lane, it checks the delivery properties over everything that
lane did. That is how it starts (first slice); the generator and faults come
later.

### UI: Bombadil

The explore lane stays as it is and becomes the `ui` level: its seven
properties are in the catalog as `ui.*` (`properties/catalog/ui.yaml`), each
tagged on its export in the spec, and it runs on the nightly schedule for 30
minutes (`e2e-scheduled.yml`; a dispatch still takes any limit). The first
nightly-length runs are where its flakes show: a locally run lane stalled when
Chromium's connection reset, and a one-minute run reported `staysSignedIn`
because the explorer clicked "Sign out of all devices", which the spec's list of
session-ending entries lacked. Later properties tie the UI to the server:
the rooms list shows what the API returns; an agent renamed in one tab reads
renamed in another.

## Assertions in code, with Antithesis's API

Antithesis's SDKs put assertions in the system under test: `always`,
`always_or_unreachable`, `sometimes`, `reachable`, `unreachable`, plus
numeric forms such as `always_greater_than`, each with a message and a
details dict. `sometimes` and `reachable` matter as much as `always`: they
show a test reached the states that make it worth anything (a reconnect
during a read, contended lease claims, a resume below a drop mark). A
`sometimes` that never fires across a nightly run is reported as a failure
of coverage.

Switch matches that API:

- **Python**: use the `antithesis` package from PyPI directly if its local
  mode works for us. Outside Antithesis, the SDK writes assertions as JSON
  lines to the file named by `ANTITHESIS_SDK_LOCAL_OUTPUT`, and does nothing
  when that is unset. If the package proves unsuitable (dependencies, import
  cost, behaviour in production), a module `switch_core/assertions.py` with
  the same function names and signatures writes the same format.
- **TypeScript** (Console, the harness): a module with the same names and the
  same output format.
- In production the variable is unset and assertions cost a branch. They
  never raise: a violated assertion is evidence for the checkers, not an
  error path in the service.
- The history checker reads the assertion log: any violated `always`, any
  `unreachable` reached, and any `sometimes` never satisfied fails the run.

Where an assertion states a catalog property, its message is the property id,
so the gate can find it.

The Python SDK (`antithesis` 0.4) was confirmed before anything depended on
it: it has no dependencies of its own, imports in about 25 ms, does nothing when
the variable is unset, never raises on a false `always`, and in local mode logs
the first call per id and outcome, not every call. So a `sometimes` shows in the
log only once it has been true, and one that is never called is absent, which is
why the history checker is given the ids it must see rather than reading them
from the log. The message is `<property id>: <what holds>`, not the bare id,
because Antithesis keys an assertion by its message and two assertions of one
property would collide. Messages are string literals: the SDK keys by message,
so one built at run time would make unbounded ids, and the gate fails on one.

## Tying models to code: trace validation

A model nobody checks against the code drifts from it. Two ways to tie them,
both later phases:

- **Trace validation**: map a run's history (rows, assertion events) to the
  model's actions and check that the history is a behaviour the model allows.
  This is what CCF ("smart casual verification") and MongoDB do with TLA+. A
  history the model rejects means the code does something the model says
  cannot happen: either a bug, or a model that is out of date.
- **Model-based testing**: generate traces from the model with `quint run`
  (ITF output) and replay them against the real system through the workload
  driver, checking that each step's result matches the model's state.

Both need a stable mapping from database rows and events to model actions.
Building the history checker first is what makes that mapping exist.

## CI

| When | What |
| --- | --- |
| Every PR | Catalog schema and gate; Quint models at small bounds; Hypothesis and Schemathesis with few examples; the history checker after the fast lane |
| Nightly | Quint at deeper bounds and long simulation; Hypothesis with many examples; Bombadil for 30 minutes; later, the workload with faults and two replicas |
| Release tags | The nightly set, on the tagged commit |

Everything that runs on a PR reads no secret, as the fast lane does today,
so it runs the same from a fork. A failure uploads its seed, the shrunk
counterexample (Hypothesis's, Quint's ITF trace, Bombadil's trace) and the
assertion log, after the existing secret scan.

## Seed properties

The list the catalog starts with. Most start `proposed`; the first slice
moves the delivery ones to `checked`.

| Id | Statement | Kind | Levels |
| --- | --- | --- | --- |
| `bus.room-seq-dense` | Within a room, `seq` is handed out one above the previous under the room's advisory lock; a reader never sees `seq` n+1 committed while n is not yet visible (apart from rows retention removed from the front) | safety | model, code, system |
| `bus.lost-wakeup-only-delays` | Every committed row is read by every consumer subscribed to its room, even if announcements are dropped or coalesced or the `LISTEN` connection reconnects | liveness | model, system |
| `delivery.decided-at-write` | Which agents a room row is for is decided by the room's state when the row is written; a later membership or addressing change never adds or removes events for earlier rows | safety | model, code, system |
| `delivery.own-seq-contiguous` | An agent's own-event `seq` is contiguous and never reused, across retention and server restarts | safety | model, code, system |
| `delivery.addressed-exactly-once` | A message addressed to an agent in a room it belongs to produces exactly one own event for it | safety | model, code, system |
| `delivery.no-silent-loss` | A resuming client receives every own event after its position, in order, or a gap naming each room that lost events | safety | model, code, system |
| `delivery.addressing-matches-reference` | For any message and room state, a row is for exactly the agents a reference model of the addressing rules says | safety | code |
| `lease.fenced-takeover` | A lease's token strictly increases per key; once a key is taken over, every write by an earlier holder is refused | safety | model, code |
| `lease.eventual-owner` | Work whose holder stopped or stopped renewing is eventually held by a live process | liveness | model, system |
| `session.addressed-reaches-controller` | Every event addressed to an agent a controller has attached reaches the controller's stream, in order, none skipped (one process; delivery across replicas is not covered) | liveness | code |
| `session.controller-starts-on-addressed` | A controller with auto-start on starts a session for an addressed agent that has none, and never two for one room | liveness | code |
| `tenancy.no-cross-tenant-ids` | No response to a principal in one tenant contains an id from another | safety | code, system |
| `api.no-5xx` | No request, however malformed, is answered with a 5xx | safety | code, system |
| `bridge.roundtrip-exactly-once` | A post from a collaboration platform appears in its room once, and an agent's reply appears on the platform once | safety | system |
| `retention.erasure-complete` | After a person is erased, no row names them | safety | code, system |
| `ui.*` | The explore lane's seven properties, as written in its specification | safety, liveness | ui |

## Phases

1. **Foundation**: the catalog, its schema and gate, the assertions module,
   the first slice below, and the explore lane on the nightly schedule.
2. **Breadth**: models and state machines for leases, sessions and tasks;
   Schemathesis with two tenants; Bombadil properties that tie the UI to the
   API.
3. **Across processes and boundaries**: several replicas, the signal bus and
   its caches, the controller, in-console chats and connectors; a thin
   two-replica lane with process and bus faults; then trace validation of the
   delivery history against the Quint model. Planned below.
4. **Antithesis evaluation**: the assertions, properties, scenarios and fault
   hooks already exist, so the question left is whether a random workload
   with interleaved faults, explored and replayed deterministically, justifies
   the cost.

## The first slice: delivery, at three levels

One property family checked by model, by code and against a run, so the whole
platform is in place before it is widened.

1. **Catalog and gate.** `properties/` with the schema, the seed properties
   above (without `ui.*`, which step 6 adds), the validation test, and the
   gate in PR CI. `just properties` checks it and `just properties table`
   prints the coverage table.
2. **Model.** `properties/specs/delivery.qnt`: writers posting to rooms under
   the advisory lock, the router writing own events in the same step,
   own-event numbering from a head, retention expiring rows and writing drop
   marks, and clients resuming from a position. Invariants for
   `bus.room-seq-dense`, `delivery.decided-at-write`,
   `delivery.own-seq-contiguous`, `delivery.addressed-exactly-once` and
   `delivery.no-silent-loss`. `quint verify` at small bounds in PR CI.
3. **Code.** A Hypothesis state machine over the message store and router on
   Postgres, with interleaved writers, joins and leaves, retention, and
   resumes, checking the same properties against a reference model that
   follows the Quint state.
4. **System.** The history checker (`properties/history/delivery.py`), run
   after each fast-lane scenario on its throwaway database and before the
   scenario's agents are deleted, checking what an end state shows of the
   same properties. It cannot show `bus.room-seq-dense` (retention and erasing
   a person leave holes) or `delivery.decided-at-write` (it needs the room's
   state when the row was written); those wait for the assertion log.
5. **Assertions.** The Antithesis Python SDK (local mode confirmed), and the
   first assertions in the event buffer: `always` that retention kept nothing
   at or below what it recorded deleting; `sometimes` a reader resumes from
   below a drop mark, and an event is not stored for an agent that left. Only
   what states something (`always*`, `unreachable`) is evidence for a property;
   a `sometimes` shows a state was reached, so its message does not carry a
   property id. The fast lane writes the log and
   `properties/history/assertions.py` fails it on a false `always`, a reached
   `unreachable`, or an expected call that never happened. The fast lane
   reaches none of the `sometimes` yet, so it requires none; the state machine
   and the explore lane are where they should be reached.
6. **Explore lane** on the nightly schedule, with its properties in the
   catalog (done: `ui.*`, 30 minutes nightly, reported with the provider lane).

The slice is done when:

- the five delivery properties are `checked`, with a checker at each of their
  levels;
- each checker has been shown to fail on a planted bug (taking `seq` without
  the advisory lock; numbering own events from the highest stored row instead
  of the head), and the PR says how;
- the PR CI time added stays under two minutes.

## Phase 2: breadth

The first slice built the platform on delivery. Phase 2 puts more of the system
on it, in this order, each checker shown to fail on a planted bug and the phase
adding under two minutes to PR CI (anything slower runs nightly).

0. **Leftovers from the first slice.**
   - The Hypothesis `nightly` profile runs on the schedule (`state-machines` in
     `properties-scheduled.yml`), with `.hypothesis` kept between runs so a
     failure found one night is replayed first the next.
   - `properties/run-machine.sh` runs the machines with the server's assertions
     logged and requires the two `sometimes` the fast lane cannot reach: a reader
     resuming below a drop mark, and an event not stored for an agent that left.
   - `retention.erasure-complete` gets a history check (no identity an erasure
     named is left, and no message from its senders was sent before it finished)
     and the `member-erasure` scenario is tagged for it.
   - The gate reads `@property` tags on the fast lane's exports, so
     `api.no-5xx` (`client-mistakes`) and `tenancy.no-cross-tenant-ids` (the
     cross-tenant probe) count as system-level checks they already were.
1. **Leases and ownership**, the main piece. `process_lease.py` and
   `ownership.py` keep each piece of run-once work in one process: rendezvous
   hashing, ownership rows whose token rises on every claim, a process stopping
   its work at half its lease by its own clock, and writes that name the token.
   - **Model** (`properties/specs/ownership.qnt`): processes with drifting local
     clocks, leases on the database clock, claim, release before claim, the
     half-lease stop, fenced writes. Invariants `lease.fenced-takeover` and a new
     `lease.no-overlap` (no two processes run one key's work at once, which is
     what the half-lease rule is for); `lease.eventual-owner` as a temporal
     property under fairness. Mutants: claim without checking the holder's
     lease, release before stopping, stop at the full lease, write without the
     token.
   - **Code**: a Hypothesis machine over `Ownership` with two or three processes
     on one Postgres. It needs a **clock seam**: the module takes a clock it can
     be given, defaulting to the real one, so the machine moves time and
     drifts one process's clock without sleeping. A small production change,
     agreed.
   - **System**: an `always` at the fenced write sites. `lease.eventual-owner`
     in a real run needs two replicas and belongs to phase 3.
2. **Tasks, dropped.** The plan was a Hypothesis machine over delegate, accept,
   update and finalise, and a history check over `tasks`. The task protocol was
   removed from the server before this phase (#952: tools, routes, events and
   instructions; the `tasks` table was left), and
   `test_task_routes_removed.py` and the tool-surface test keep it removed.
   Nothing writes a task, so there is nothing to check, and `task.lifecycle` is
   deleted from the catalog; git history keeps it if the protocol returns. The published agent-protocol
   page still lists the task events and tools, which is for the docs repository.
3. **HTTP surface.** Schemathesis against the gateway with two workspaces: no
   5xx, responses that match their schema, and no id from the other workspace.
   Nightly only, at many examples; not in PR CI. Built (`properties/http`): the
   gateway is served over HTTP as the role row-level security applies to (as the
   owner, the run reported leaks that row-level security prevents), a second
   workspace is fuzzed first so it has objects, and the first is then asked with
   its ids in path, query and body parameters, recognised from the schema's naming
   (`id`, `*_id`). No leak was found. It did find about twenty routes that answer
   500 on generated input, a NUL in a string being the commonest cause, and
   error bodies that do not match the schema; the ones found are in an accepted
   baseline, and a new one fails the run. Ids in the body are replaced too.
4. **UI tied to the API** (built: `ui.list-matches-api`, with `ui.list-checked`
   to show it was tried; the room list, as the pattern for the other lists).
   One or two Bombadil properties that read the API from
   the page: a list page that has settled shows what the API returns. The
   "renamed in one tab, renamed in another" property waits until Bombadil can
   drive two pages.
5. **Sessions.** Auto-start exists, and core never asks a controller to start a
   session: the controller reads every event of its agents off one unfiltered
   stream and decides locally. The property is split to match.
   `session.addressed-reaches-controller` is built, as a Hypothesis machine over
   the real controller stream (`controller_stream_machine.py`);
   `session.controller-starts-on-addressed` is the controller's half, built in
   TypeScript with fast-check over the real host (`agent-host.test.ts`).

Not in this phase, and why: `bus.room-seq-dense` and `delivery.decided-at-write`
at the system level (they need the commit order or the room's state at write
time), `bus.lost-wakeup-only-delays` (needs injected faults), and
`lease.eventual-owner` in a real run (two replicas, now
`replica.ownership-eventual`). These are phase 3, with the workload generator
and trace validation.

## Phase 3: across processes and boundaries

Every check so far runs against one switch-core process, so none would catch a
problem between replicas. The design rests on three rules, each stated in the
code: process leases on the database's clock (`process_lease.py`), signals that
only say "look again" and are backed by a periodic re-check (`signals.py`), and
caches held only while the bus keeps listening (`bridges/agent/held_rows.py`).
Phase 3 puts those rules, and the boundaries to the controller, chats and
connectors, in the catalog. Every property below is `proposed`.

Review of the first draft changed it in four ways. Properties that said one
thing in different words were merged: a revocation reaching every process is one
property, however many things can be revoked, and a lost wake-up on the signal
bus and on a room's wake-ups is one. Properties that need a multi-replica fault
harness say so, as a gap, instead of looking nearly done. The order follows risk,
not subsystem: security first, then the logic everything else assumes.
And the checkers that need no infrastructure move ahead of the two-replica lane.

| Property | Level | Checked by |
| --- | --- | --- |
| `tenancy.agent-surface-no-cross-tenant` | code, system | a machine over the agent operations as agents of two tenants |
| `connector.token-only-to-granted` | code, system | broker machine with a reference model of who may hold what |
| `connector.refresh-single-flight` | code | concurrent-refresh machine, fake provider |
| `chats.owned-sync-reversible` | code | grant/revoke/transfer machine against `sync_owned_rooms` |
| `chats.membership-is-read-authority` | code, system | the same machine; Schemathesis |
| `revocation.takes-effect-everywhere` | model, code, system | `signals.qnt`; one machine per resource; two-replica lane |
| `delivery.addressing-matches-reference` | code | a reference model of `addresses()` |
| `retention.erasure-complete` | code, system | a sweep of every user-id column from the schema |
| `signal.loss-only-delays` | model, system | `signals.qnt`; dropped `NOTIFY` |
| `controller.stream-complete` | code | two more steps of the controller-stream machine |
| `controller.takeover-fenced` | code, system | connection-ledger machine |
| `presence.online-iff-lease` | code, system | lease clock seam; killing a replica |
| `replica.single-owner` | system | two-replica lane, Antithesis |
| `replica.ownership-eventual` | model, system | untimed lease model; killing a replica |
| `chats.streams-close-on-sign-out` | system, ui | fast-lane scenario; Bombadil |
| `bridge.roundtrip-exactly-once` | code, system | a machine over `CollaborationCore` with a fake `PlatformAdapter` |

How they relate to what is there:

- `replica.single-owner` is the end-to-end statement of `lease.no-overlap`,
  which holds it for one key at the model and code levels; this one is about
  the consumer or bridge connection itself, in processes that die.
- `replica.ownership-eventual` supersedes `lease.eventual-owner`, now retired.
- `revocation.takes-effect-everywhere` replaces `controller.revoked-refused`,
  `connector.revoke-stops-issue`, `cache.no-stale-past-reconnect` and
  `membership.removal-reaches-every-replica`: the same mechanism (a held row,
  a short TTL when the bus was not listening, the periodic re-check) with a
  different thing revoked, so one checker parameterised by resource.
- `signal.loss-only-delays` is `bus.lost-wakeup-only-delays` as well: one rule
  on two channels, one model.
- `controller.stream-complete` is narrowed to what
  `session.addressed-reaches-controller` does not cover: agents attached or
  detached while the stream is open, and a cursor retention has passed. The
  model level is dropped, since a Quint model would only restate the cursor
  logic.
- `controller.takeover-fenced` has the shape of `lease.fenced-takeover` on a
  different mechanism (the connection ledger's `taken_over`), so it stays a
  property of its own.
- `delivery.addressing-matches-reference` replaces `delivery.unaddressed-silent`,
  which was false: a direct chat, an alias and a role address without a
  mention. Every other delivery property assumes this one.
- `session.addressed-eventually-started` was replaced by the two session
  properties in phase 2: it assumed core asks the controller to start a
  session, and it does not.

In this order, each checker shown to fail on a planted bug:

1. **Security at the code level**, which needs no new infrastructure: several
   processes in one test share Postgres, each with its own signal bus, as
   `test_connections_across_processes.py` and the ownership machine already do,
   and Hypothesis machines interleave real transactions the way the delivery
   machine does. First the agent surface as agents of two tenants
   (`tenancy.agent-surface-no-cross-tenant`: the operations are one definition
   served over HTTP and MCP, so one machine covers both); then broker grants,
   revokes and disconnects (`connector.token-only-to-granted`) and concurrent
   refresh near expiry against a fake provider that rotates tokens and refuses
   a used one (`connector.refresh-single-flight`); then chat grants, revokes
   and ownership transfers against `sync_owned_rooms`, checked after every step
   (`chats.owned-sync-reversible`, `chats.membership-is-read-authority`). An
   `always` at each grant check, so the system level comes with the lane.
2. **The addressing oracle.** A reference model of `addresses()` over generated
   free text and room state: mentions, aliases, roles, groups, who may address
   whom, direct chats; punctuation, code spans, case, one name inside another.
   With it, assert in the code machine that who a row is for never changes after
   it is written (`delivery.decided-at-write`, already in the model), and
   promote it.
3. **Erasure.** After an erase, walk every table and column that holds a user
   id, from the schema's metadata, and assert none names the person: a table
   added later is covered without anyone remembering it. It also closes the gap
   on platform people, whose messages cannot be found afterwards without the
   transport ids recorded before the erasure.
4. **The signals model** (`properties/specs/signals.qnt`): processes with a
   listening connection that drops and comes back, signals sent after commit
   and lost, the periodic re-check, resync on reconnect, and a held cache with
   its TTL and generation. Invariants for `signal.loss-only-delays` (no wrong
   answer; staleness bounded by the re-check) and the model level of
   `revocation.takes-effect-everywhere`. Mutants: a handler that acts on the
   payload, no resync on reconnect, no periodic re-check, a cache that keeps
   its hold across a reconnect. Then a machine per resource for the revocation
   property, one checker shared.
5. **The controller.** Attach and detach agents, and let retention pass a
   cursor, in the controller-stream machine from phase 2
   (`controller.stream-complete`). A machine over the connection ledger for
   `controller.takeover-fenced`, and `presence.online-iff-lease` with the lease
   clock seam from phase 2.
6. **The bridge.** A machine over `CollaborationCore` with a fake
   `PlatformAdapter`: a post appears once, an agent's reply appears once, and no
   echo loops (`bridge.roundtrip-exactly-once`), plus format round-trips (Slack
   mrkdwn and the internal form, Discord chunking) and an agent's retried write
   posting once.
7. **The two-replica lane.** Built here as a thin lane, nightly only, in three
   stages, each a pull request whose new checks are seen to fail on a planted
   bug. A random workload with interleaved faults is left to the Antithesis
   evaluation (phase 4). Exploring timing, partitions and deterministic replay
   is what Antithesis is for, and this lane's scenarios, fault hooks and
   history checks carry over to it as its workload and its checks.

   Every bound a scenario waits for is derived from the product's own timers
   (the lease's lifetime, the balance interval, the periodic re-checks), read
   from the code rather than chosen, and a failure names the bound it missed.

   1. **Two replicas, no faults.** `just e2e-fast --replicas 2` starts a second
      switch-core on its own port (`SERVER_PORT`), behind HAProxy on `:8000`:
      round robin with no stickiness, WebSocket upgrades passed through, so a
      client's requests and sockets land on either replica. Both replicas
      write the shared assertion log (the SDK appends each record in one
      write), and `SWITCH_E2E_SERVER_LOG` takes both servers' logs, comma
      separated. The replicas start one after the other, so the start-up work
      runs alone, as in a rolling deploy. Every fast-lane scenario runs
      through it, each with the history check before teardown, so what the
      lane already checks at the system level (the `delivery.*` history
      checks, `retention.erasure-complete`, `tenancy.no-cross-tenant-ids`,
      `api.no-5xx`, `chats.streams-close-on-sign-out` and the server's
      assertions) is now checked with every request free to land on either
      replica. It closes no gap by itself: the system-level gaps of
      `bus.room-seq-dense`, `delivery.decided-at-write`,
      `chats.membership-is-read-authority`,
      `tenancy.agent-surface-no-cross-tenant` and
      `connector.token-only-to-granted` are missing scenarios or a commit-order
      log, not a second replica, and each is written for this lane when it is
      added.

      Its first run found an agent left out of a new room's Mattermost
      channel: registered on one replica and put in a room on the other
      before that one had set up the agent's bot. Two replicas creating the
      same bot also logged an error each time, and a failed bot lookup was
      read as "no bot". All three are fixed.
   2. **Process faults.** A fault hook in the harness, implemented by the stack
      script: kill a replica (`SIGKILL`, or `SIGTERM` as a deploy does), pause
      and resume one (`SIGSTOP`/`SIGCONT`, which lets its lease lapse without
      its knowing), restart one, and take one out of HAProxy through its
      runtime API, which also severs its WebSockets so clients reconnect
      through the other.
      - `replica.single-owner`: kill or pause the holder of a bridge and of
        controller connections mid-traffic; an `always` assertion where owned
        work starts (no other live process holds the key), read from the
        shared log, and `ownership_leases` after the run.
      - `replica.ownership-eventual`: after a kill, the work runs on the
        survivor within the lease's lifetime and one balance.
      - `presence.online-iff-lease`: an agent whose holder died reads offline
        within the lease's lifetime, and online again once it reconnects
        through the survivor.
      - `controller.takeover-fenced` at the system level, and the case the
        eventual-ownership model found: a replica paused for less than its
        lease, a replica added meanwhile, and the key moved once it resumes.

      Built so far: the hook (`src/clients/replicas.ts`, with
      `scripts/replica.sh` starting a replica and HAProxy's runtime API on
      `127.0.0.1:9999`), and three scenarios on the Mattermost bridge
      (`src/fast/replica-faults.ts`), which hold `replica.single-owner` and
      `replica.ownership-eventual` for it: its holder crashed (`SIGKILL`),
      stopped as a deploy stops it (`SIGTERM`), and paused past its lease.
      Each reads `ownership_leases` (`properties/history/ownership.py`, which
      also reports the product's timers, so every wait is derived from them),
      checks that the survivor holds the bridge within the lease's lifetime
      and one balance (a balance after a `SIGTERM`), that an agent's message
      sent while nothing held the bridge is posted once, as the agent, and
      that both directions work once each after the hand-over and again once
      the faulted replica is back. The paused scenario also checks that the
      resumed replica logs that it stopped its work, that a message the agent
      sent during the pause is posted once, and that a person's post its
      sockets buffered is not relayed when it runs again. A scenario that
      causes an error log on purpose names it (`expectedServerErrors`); any
      other error still fails it. Each fault is undone after the scenario,
      which then waits for the bridge to settle on a live holder, so the next
      scenario does not start in a hand-over.

      They found three bugs. A process that took a bridge over after a crash
      relayed a waiting message before it had set up the agent's bot, so the
      message was posted under the admin account. A process paused past its
      lease, once resumed, wrote the posts its sockets had buffered into the
      rooms before its balance stopped the bridge: a write after its lease had
      lapsed, more than a minute late. Both are fixed: a send adopts the bot
      it lacks, and an adapter drops what its platform connection delivers
      once its process is no longer sure it holds the bridge
      (`OwnedKind.surely_holds`). The third is open (Known issues): a person's
      post made before the new holder's sockets are open is lost. The
      scenarios measure that gap rather than fail on it.

      Then two more on the bridge, and two on the connections clients hold
      (`src/fast/replica-connections.ts`, with an agent's socket and a
      controller's held open by the harness and answering pings):
      - the case the eventual-ownership model found: a process the key
        belongs to joins while its holder is paused for less than its lease.
        The bridge's rightful holder is paused past its lease, so the other
        takes it over; that one is paused for less than its lease (past half
        of it, short of the lease less one renewal interval, both from the
        timers), and the first resumed meanwhile, rejoining at once. It must
        take nothing while the paused holder's lease holds, and get the
        bridge back, under a new claim, within two balances of that holder
        running again. A first version started a replica during the pause
        instead, but a start took from 4 to 17 seconds against a pause of
        10, and where the bridge hashed was drawn with the new process's id;
      - the holder taken out of HAProxy's rotation, which keeps the bridge;
      - `presence.online-iff-lease`: an agent's socket claims a room and its
        holder is killed. The survivor must read the agent offline within the
        lease's lifetime and one lease watch, and live again once it
        reconnects with the same connection id;
      - `controller.takeover-fenced`: a controller's socket held by a paused
        replica, and the controller opening again through the other. Once
        resumed, the old holder must evict the replaced socket as
        `taken_over`, with nothing after, an attach naming the replaced
        connection must be refused, and the row must stay on the survivor.
      `properties/history/ownership.py` reports each key's rightful owner
      among the live processes, so `settled` waits for that, and who holds
      each open agent and controller connection.

      Each new check was seen to fail on a planted bug: a claim that takes a
      key from a live holder, a row read as live whatever its holder's lease
      with the lease watch off (either alone is not enough: re-reading an
      agent's rows also drops a lapsed holder's copies), and a takeover that
      leaves the replaced socket open. A lease renewed after it lapsed
      reading as sure again, the review finding fixed with `ProcessLease`'s
      lapse count, is held by a unit test: on the lane the balance usually
      runs before the renewal, so the plant passes there.

   3. **Bus faults.** One replica's listening connection is cut on its own,
      with `pg_terminate_backend`, and no proxy. Every connection names its
      process and what it is for as its `application_name`
      (`replica-1-<suffix> signals`, `... messages`, `... pool`), so a cut
      reaches one replica's signal bus or its room wake-ups and nothing
      else, and the replica goes on serving requests on its pool. A single
      cut is over in about a second, the reconnect's resync closing the gap,
      so the harness (`Replicas.deafen`, with
      `properties/history/listeners.py`) cuts just after the listener's
      heartbeat and again each time it reconnects, for a window past the
      heartbeat and the bound checked. A scenario makes its change right
      after the first cut, from the other replica, straight to its port
      (`SwitchClient.at`), so the change surely falls while the replica is
      deaf (`src/fast/replica-bus-faults.ts`):
      - `revocation.takes-effect-everywhere`: an agent taken out of a room,
        and a controller revoked. The deaf replica read the membership or the
        controller's row again after the cut; the agent's post, or the
        controller's token, through it must be refused within a held row's
        TTL (`AGENT_AUTH_CACHE_TTL_SECONDS`). Read again after the cut, so the
        refusal waits out the TTL rather than finding it over already.
      - `signal.loss-only-delays`: an agent's connection closed on the other
        replica, which the deaf one must read offline within its first
        reconnect backoff of the other doing so; and an agent's posts through
        the other replica while the bridge's holder has its wake-ups cut,
        each of which must reach Mattermost once, within the first backoff.
        The posts are spaced across more than a room re-check
        (`transport/postgres.py` wakes a client's rooms with unread rows every
        30 seconds), which would relay at most two of them in time: one post
        alone passed with the wake-up on reconnect removed when a re-check
        happened to fall within its bound.
      - Each also checks the listener is back within its first backoff once
        the cuts stop.

      Their first run found two bugs, in all four listeners
      (`messages/notify.py`, `signals.py`, and the agent-event and
      session-activity listeners), both fixed in `db/listening.py`. A
      listener noticed its connection had ended only at its next heartbeat,
      up to 20 seconds later; all that time it lost every notification, and a
      held row stayed held past its TTL under a connection that no longer
      existed, so a removed agent could still post through that replica. It
      now notices when asyncpg reports the connection closed. And the
      reconnect backoff never started again after a connection was made, so
      a process that had lost its connection a few times waited the 15-second
      cap before every reconnect.

      Each check was seen to fail on a planted bug: a held row kept across a
      reconnect (both revocations), no resync on reconnect (the closed
      connection, read live until the periodic re-check), and no wake-up of
      every room on reconnect (the post never reached the channel), as well
      as on the two bugs above before their fix.

      What is left: a connection that goes silent without ending (a half-open
      socket, dropped packets) is noticed only by the heartbeat and the
      socket's keepalive, and latency between a replica and Postgres is not
      injected at all. Both need a proxy such as toxiproxy, added if a check
      ever needs it. A connector grant and the room membership of a client
      that reads rooms are not revoked on the lane yet.

Not planned here: the controller's own rules on its side (TypeScript), such as
a handed-over session never being driven by two controllers at once in
handover and the detached runtime. They look like properties of the same kind;
whoever owns that code should say what they are first.

## Known issues

Found by the checks and not yet fixed, kept here until there is somewhere better
to track them.

- **`unlink_rooms` answers 500 for a link that does not exist.** The agent
  operation raises `LookupError`, which `refusal_status` does not map, so the
  HTTP door lets it escape. It is a "not found" and should be a 4xx. The
  agent-surface machine lists it in `KNOWN_RAISES`; remove the entry when fixed.
- **Nine routes answer 500 or 503 to fuzzed input**, accepted in
  `properties/http/baseline.json` so the nightly stays useful: `DELETE
  /messaging-apps/installs/{install_id}`, `GET /hosted-controller/machines`,
  `POST /agent-sessions/{agent_id}/{session_id}/approvals/{request_id}/answer`,
  `POST /hosted-controller/machines/{machine_id}/observation`, `POST
  /hosted-controller/machines/{machine_id}/prepare`, `POST /hosted-machines/ensure`,
  `POST /invitations/mine/accept`, `POST /provider-connections/github/flows`
  and `POST /rooms`. The baseline should shrink as each is fixed. The
  fuzz also excludes a NUL in a string, which makes many routes answer 500
  (the login among them) because Postgres cannot store one; fixing that first
  lets the exclusion go.
- **Nine routes answer in a shape their schema does not declare**
  (`response_schema_conformance`: `POST /chats`, the chat sub-routes,
  `POST /collaborations/setup/slack/check`, `POST /templates`, `PUT
  /chats/{room_id}/read`), all on the type of `detail`. They look like one
  error-shape fix, and are outside `api.no-5xx`, which only says 5xx.
- **A Mattermost post made while a bridge changes hands is lost.** The
  adapter reads each bot's socket from the moment it connects and never
  fetches what was posted before, so a person's post between the old holder
  letting go (or dying, or being paused) and the new holder's sockets
  opening reaches no agent. On a deploy that is a second or two; after a
  crash, the lease's lifetime. Closing it needs a stored position per
  channel, the last post relayed, and a fetch of what came after it when a
  socket opens, which a holder paused past its lease must not do. The
  replica fault scenarios log how many posts each hand-over lost; make them
  fail on any once this is fixed. Other adapters that listen on a socket
  (Slack in socket mode, Discord, Telegram) likely have the same gap, and
  do not yet drop what reaches them after their hold is unsure.
- **An agent's runtime state is announced only on the replica that has it.**
  `com.switch.agent.runtime_state`, Switch Console's working and idle, goes
  over an in-process bus (`transport/ephemeral.py`). Nothing reads it today:
  no consumer handles the event, a bridged channel shows a turn from the
  session-activity publication, and `!status` reads `agent_runtime_states`.
  Online status is not on this bus: it comes from the connection ledger's rows
  and the signal bus, and is `presence.online-iff-lease`. Carrying runtime
  state over the signal bus waits for a client that renders it, which is when
  it gets a property of its own.
- **The history check cannot see a platform person's messages once they are
  erased**, because the erasure deletes the identity row they are found by, and
  the fast lane erases only a member client. The erasure sweep above replaces it.
- **An agent's retried `post_message` posts twice**, in the room and on the
  platform: the operation takes no idempotency key, so an agent that retries
  after a timeout cannot say it is the same message. Step 6 listed "an agent's
  retried write posting once"; it is left out of
  `bridge.roundtrip-exactly-once` until there is a key to check, which is a
  product decision of its own.
- **A message the platform takes and then fails on shows twice.** The bridge
  lets its claim go and tries it again, since it cannot tell the post went
  out. `bridge_machine.py` expects the second copy; a platform that returns
  the post's ref with its error would let the bridge settle it instead.
- **An entity a message spells out shows decoded on Slack.** A body that
  writes `&amp;` (a message about HTML, say) shows `&`. The translation keeps
  entities because labels escaped for Slack are inlined into the bodies it
  translates; telling the two apart would let it escape every `&`.
  `bridge.slack-markup-roundtrip` leaves spelled-out entities out of its
  bodies until then.

## Open questions

- Whether a Hypothesis machine reaches the races a model finds in the
  connector and chat code the way the delivery machine does (tasks holding
  transactions open), or those need explicit scheduling points.
- What the history checker learns of what each client received: it reads the
  database, not the clients, so it checks what the database says was owed and
  kept. What a client was handed needs the harness's record or an assertion on
  the delivery path.
- Whether Schemathesis's tenant check needs the OpenAPI document to mark
  which fields are ids, or can find them from the schema's naming.
- What rules the controller's handover and detached runtime keep, from whoever
  owns them.
