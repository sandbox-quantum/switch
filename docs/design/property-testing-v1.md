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
4. **Tasks**: delegate, accept, update, finalise; finalised is terminal.

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
retried first the next day.

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
| `delivery.unaddressed-silent` | A message not addressed to an agent produces no notification for it | safety | code, system |
| `delivery.per-room-order` | An agent's own events from one room arrive in `room_seq` order | safety | model, system |
| `lease.fenced-takeover` | A lease's token strictly increases per key; once a key is taken over, every write by an earlier holder is refused | safety | model, code |
| `lease.eventual-owner` | Work whose holder stopped or stopped renewing is eventually held by a live process | liveness | model, system |
| `session.addressed-eventually-started` | Addressing an agent with no live session, where auto-start is configured, eventually starts one | liveness | model, system |
| `task.lifecycle` | A task moves only delegate → ongoing → finalised; finalised is terminal | safety | model, code |
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
3. **System fuzzing**: the workload generator, faults, two replicas, nightly;
   then trace validation of the delivery history against the Quint model.
4. **Antithesis evaluation**: the assertions, workload and properties already
   exist, so the question left is whether deterministic replay of the stack
   justifies the cost.

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

## Open questions

- Whether the Hypothesis state machine can interleave real concurrent
  transactions well enough, or needs explicit scheduling points (a pausable
  session wrapper) to reach the races the model finds.
- What the history checker learns of what each client received: it reads the
  database, not the clients, so it checks what the database says was owed and
  kept. What a client was handed needs the harness's record or an assertion on
  the delivery path.
- Whether Schemathesis's tenant check needs the OpenAPI document to mark
  which fields are ids, or can find them from the schema's naming.
