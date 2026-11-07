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
```

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
