---
name: testing
description: How to test a change in Switch. Covers choosing between a property, an end-to-end scenario and a unit test; writing Hypothesis state machines, pure properties, Quint models and fast-lane scenarios; running them; and proving a checker by planting the bug it is meant to catch. Use when adding or changing tests, when fixing a bug that needs a regression check, or when a property, machine or model fails.
---

# Testing a change in Switch

Prefer tests that check what Switch promises over tests that check how one
function does it. The bugs that reach users here are orderings and
interleavings: a post delivered twice, a lease taken over mid-write, a re-read
that finishes after a newer change, a row read from another tenant. A
hand-written case rarely thinks of them. A generator, a state machine or a
model checker does.

This is a preference, not a rule. A one-line fix with an obvious unit test does
not need a state machine. But a fix for a race, a lost or duplicated message, a
cross-tenant read or a stale cache should come with a check that would have
found it.

The design behind all of this is `docs/design/property-testing-v1.md`. The
catalog and how to add to it are in `properties/README.md`.

## 1. Choose the level

| The claim is about | Check it with | Example to copy |
| --- | --- | --- |
| A pure function over many inputs (formatting, splitting, translating, parsing) | A pure property: `@given` with generators that reach the edge cases | `core/tests/switch_core/properties/test_bridge_formats.py` |
| What several processes, tasks or retries do to shared rows | A Hypothesis state machine on real Postgres | `bridge_machine.py`, `ownership_machine.py`, `takeover_machine.py` |
| Every interleaving, time, or "eventually" | A Quint model, checked with TLC | `properties/specs/ownership_eventual.qnt`, `signals.qnt` |
| What a tenant can and cannot reach over HTTP | Schemathesis over the OpenAPI schema | `test_http_surface.py`, `properties/http/` |
| A user-visible flow across the gateway, core and a platform | A fast-lane scenario against a real stack | `console/tooling-e2e/src/fast/*.ts` |
| One function's logic, an error mapping, a parser's corner | A unit test in `core/tests/switch_core/`, mirroring the module | |

A unit test is also fine as a quick regression pin beside one of the others: it
names the exact case that broke.

Whatever the level, tests that touch the database run against real PostgreSQL
(testcontainers), never mocks or SQLite.

## 2. A property starts in the catalog

Add or find the claim in `properties/catalog/<area>.yaml` before writing the
checker. The fields are described in `properties/README.md`.

- `statement` is what holds, in a sentence a reader outside the team can check.
- `levels` lists where it needs checking (`model`, `code`, `system`, `ui`). A
  level without a checker needs an entry in `gaps` saying why.
- `status` stays `proposed` while a gap is recorded.
- `notes` says where in the code the claim lives, what the checker does, and
  which planted bugs it was seen to fail on.

Tag the checker so the gate can find it:

- **pytest:** `@pytest.mark.property("area.name")`.
- **Quint:** `/// @property area.name` directly above the definition.
- **Fast-lane scenario:** `@property area.name` in the doc comment above the
  export.

`just properties check` fails when the catalog and the tags disagree.

## 3. Writing each kind

### A pure property

- Build the input from small generators that each aim at a known edge, and
  combine them. For example, mentions with trailing punctuation, links with
  parentheses in the URL, and fenced blocks left open.
- Assert what the output must keep: nothing lost, nothing over the limit, a
  round trip back to the input. Don't assert one expected string.
- Pure properties are cheap, so scale the examples: `test_bridge_formats.py`
  runs twenty times the profile's count.
- When a known limitation makes the property false, narrow the generator and
  say so in a comment and in the design doc's "Known issues". Don't loosen the
  assertion.

### A Hypothesis state machine

- **The machine** keeps a model of what should be true, and steps that do one
  thing to the real system each: post, fail, hand over, kill a process, deliver
  again. Invariants compare the real rows with the model after every step.
- **Don't race your own system.** A step that starts work in the background
  and immediately queues the next action can test an ordering the product
  never sees. Wait for the step's own effect, or read its outcome back,
  before the next step.
- **Reach.** Count what the run reached in `COVERAGE`, and list in
  `SHOULD_REACH` what it must reach at least once. Otherwise a strategy that
  quietly stopped drawing a case still passes. Across nightly shards, reach is
  judged over all shards together (`conftest.py`). An unreached target fails
  the session.
- **The test function** takes a `shard: Shard` and runs the machine with
  `settings=shard.of(settings())`, then calls
  `shard.reached(COVERAGE, SHOULD_REACH)`. Copy `test_bridge_machine.py`.
- **Fixed scenarios.** A failing sequence worth keeping goes in as a fixed
  test beside the machine, so it is replayed on every run.
- **Waits.** Waits must survive nightly load. Size them from what the
  product's own timers are, not from what passed once on your laptop.

### A Quint model

Model when a test cannot get there:

- every interleaving of a few processes;
- clocks that drift;
- a liveness claim ("from some point on, exactly one process runs the key").

The model follows the code's names: say in comments which function each action
stands for.

- Safety claims are invariants, checked with `--invariant`. Liveness claims are
  temporal formulas under explicit fairness, checked with `--temporal`, and are
  listed in `TEMPORAL` in `properties/specs/run.py`.
- Bounds live in `properties/specs/configs.qnt`: a small one for CI, a larger
  `_deep` one for nightly.
- Every property gets mutants, which are the model with one bug switched on
  through `BUGS`. Each mutant must fail it. Register them in `MUTANTS` in
  `run.py`.
- Model what the code does, not what it is meant to do. A model that skips a
  mechanism (placement, a hand-off, a suspension) can pass while the code
  strands work. Modelling placement is how the ownership model found a real
  bug.
- Run quint with the TLC backend (`--backend=tlc`), as `run.py` does. Without
  it, quint uses Apalache, which is slow here and leaves an `_apalache-out/`
  directory behind.

### The HTTP surface

`just properties-http` fuzzes the gateway as people in two workspaces. Failures
accepted for now are in `properties/http/baseline.json`, which should only
shrink. A route that now passes must be removed from it.

### A fast-lane scenario

Read `console/tooling-e2e/README.md` first.

- The harness plays every participant over HTTP. There is no provider, no
  Console and no model, so the fast lane can gate pull requests.
- A scenario is a `FastScenario` exported from a file in `src/fast/` and listed
  in `src/fast/index.ts`.
- Its header names the routes it `covers` (`GET /path`, `WS /path`), where it
  may run (`environments`), and an `owner` that is a team, never a person.
- Everything it creates goes through `fixtures`, which tear it down whether or
  not it passed.
- The coverage gate fails when a route is neither covered by a scenario nor
  listed in `surface/exemptions.json` with a reason. When a scenario covers a
  route, remove that route from the exemptions or the backlog.
- Run `pnpm typecheck` in `console/tooling-e2e`.

What the lane cannot do: run two server replicas, or sign out from the explore
lane. Record those as gaps rather than faking them.

## 4. Running

```bash
just properties check                          # catalog and checker tags agree
properties/run-machine.sh                      # every machine, CI profile
properties/run-machine.sh nightly core/tests/switch_core/properties/test_bridge_machine.py
just properties-model                          # every Quint invariant and temporal property
just properties-mutants                        # every mutant fails its property
just properties-http                           # Schemathesis over the gateway
just e2e-fast                                  # fast lane on a throwaway stack
```

- **Targeted pytest.** `just test <path>` runs the whole suite. For a few
  files, run pytest directly from `core/`:
  `uv run pytest -p no:cacheprovider -q -n auto <files>`.
- **Profiles.** `HYPOTHESIS_PROFILE=ci` (the default) runs 25 examples of 20
  steps. `nightly` runs 1000 of 30, split into shards that run side by side.
  Run the nightly for the machine you changed before you ask for review.
- **Docker.** Testcontainers needs `DOCKER_HOST` pointing at your Docker
  socket when the default does not find it. Errors that are Docker read
  timeouts are the environment, not the change: rerun those files.
- **Reading a failure.** A failing machine prints the seed and the shrunk
  sequence of steps. Replay it as a fixed scenario to debug.

## 5. Prove the checker: plant the bug

A checker counts only once it has been seen to fail. For each property:

1. Write down the bugs it should catch. Choose ones a weak checker would miss:
   a retry that is skipped, a claim that ignores the holder, an escape that is
   left out, a queue that is jumped.
2. Plant each one in the product code with a small script that patches, runs
   the checker and reverts, even when the run fails. Never leave a plant in
   the tree.
3. Each plant must make the checker fail. A plant that survives means the
   checker is too weak. Strengthen the generator, the model or the invariant,
   not the plant.
4. Put a table of the plants and what failed in the PR description.

For Quint, the plants are mutants and live in the repository (`BUGS`,
`configs.qnt`).

## 6. When a property fails

First decide which is wrong, the product or the checker. Read the shrunk
counterexample or the model's trace step by step against the code.

- **The checker is wrong** (the model races the system, a wait is too short, a
  generator makes an input the product never sees): fix the checker, and say
  in the commit what it got wrong.
- **The product is wrong**: tell the person you are working for. Describe the
  sequence in plain terms, what a user would see, and a proposed fix. Don't
  weaken the property to make it pass. The fix gets a regression test of its
  own and a CHANGELOG entry, and the property keeps checking it.
- **A known issue that will not be fixed now**: add it to "Known issues" in the
  design doc, and narrow the generator or record a gap. Name the narrowing in
  the code, so it is undone when the issue is fixed.

## 7. Pitfalls seen so far

- A strategy that silently stopped drawing a case (a `sampled_from` that lost
  an option). It was caught only by cross-shard reach. List what must be
  reached.
- A model step that queued the next action before the previous one landed,
  testing an ordering the product never produces.
- A plant that survived because the scenario never reached the code path. The
  fix was a fixed scenario that walks straight to it.
- A Quint model that let any process claim a key. It passed while the code,
  which only lets the placed process claim, could strand the key.
- Waits sized for an idle laptop, which failed under nightly load.
