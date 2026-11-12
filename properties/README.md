# Properties

What Switch promises, as a list a person can read, and the checkers that hold
it to those promises. The design is in
[`docs/design/property-testing-v1.md`](../docs/design/property-testing-v1.md).

```bash
just properties           # the catalog and the checkers' tags agree
just properties table     # each property by level: checker, gap, or neither
```

## Adding a property

Add an entry to `catalog/<area>.yaml`, where `<area>` is the id's first part:

```yaml
properties:
  - id: area.kebab-name          # unique, never reused once retired
    title: One line
    statement: >
      What holds, in a sentence a reader outside the team can check.
    kind: safety                 # safety | liveness | reachability
    formality: semi-formal       # informal | semi-formal | formal
    levels: [code, system]       # where it needs checking: model | code | system | ui
    owner: platform              # a team or role, never a person
    status: proposed             # proposed | checked | retired
    gaps:                        # optional, level: why no checker yet
      system: no history check yet
    supports: [other.id]         # optional: exists to make that property hold
    smoke: true                  # optional: shows the harness works, not Switch
```

`supports` marks a mechanism rather than something a user observes (an agent's
event numbers never skip, so that nothing is lost silently), and `smoke` marks a
check that would pass on a broken Switch if the explorer itself were working;
`just properties table` shows both in its last column, so neither reads as
assurance of its own.

## What agents are promised

The delivery properties are not equals. An agent is promised that a message
addressed to it is delivered once and that a resuming agent misses nothing
without being told: `delivery.addressed-exactly-once` and
`delivery.no-silent-loss`. The rest (`delivery.own-seq-contiguous`,
`delivery.decided-at-write`, `delivery.no-events-after-leave`, `bus.room-seq-dense`)
exist to make those two hold, and `delivery.addressing-matches-reference` is
what decides whether a message is addressed at all.

A `formal` property also has `spec: <file>.qnt::<Definition>`, a definition in
`specs/`. Fields and rules are in `gate/gate.py`.

## Adding a checker

Tag the definition that checks it with the property's id, and the gate finds it.
A tag in a comment or docstring, above nothing, or on a skipped or `xfail` test
is not a checker, and the gate says so:

| Level | Where | Tag |
| --- | --- | --- |
| model | `specs/*.qnt` | `/// @property <id>` directly above the definition |
| code | `core/tests/switch_core/properties/` | `@pytest.mark.property("<id>")` on the test |
| system | `history/*.py` | `@checks("<id>")` on the check |
| ui | `console/tooling-e2e/src/explore/spec/*.ts` | `@property <id>` in the doc comment above the export |

When every level a property lists has a checker, set `status: checked` and
remove its gaps.

## The history check

`history/delivery.py` reads the tables a finished run leaves (`messages`,
`agent_events`, `agent_event_heads`, `agent_event_drops`, `client_rooms`) and
checks what the end state shows of the delivery properties. The fast lane runs
it after each scenario, before the scenario's agents are deleted (deleting
an agent deletes its own events), and fails the scenario on a violation. It
needs the database, so it runs only on the stack the harness starts:
`SWITCH_E2E_HISTORY_CHECK` names the command (`history/check.sh`). A derived
test fails the lane if no check ever found an own event, since a check over an
empty history passes anything.

Run by hand against a stack (`just e2e-fast --keep`, then the `DB_*` variables
from its env file): `properties/history/check.sh`.

## Assertions in the server

The server states some properties as Antithesis assertions (`always`,
`sometimes`, `reachable`, `unreachable` from `antithesis.assertions`), with a
message `<property id>: <what holds>`. The gate counts one that states something (`always*`,
`unreachable`) as evidence at the `system` level; a `sometimes` shows a state was
reached, so its message does not name a property. Outside Antithesis the SDK does nothing unless
`ANTITHESIS_SDK_LOCAL_OUTPUT` names a file, which the fast lane sets for the
server it starts; `history/assertions.py` reads that file afterwards. The SDK
logs the first call per id and outcome, so a `sometimes` appears only once it
has been true, and `--require <message>` names the ones a run must have
satisfied and `--called <message>` the ones it must have made at all. An assertion never raises: a violation is evidence for a checker, not
an error path in the service.
