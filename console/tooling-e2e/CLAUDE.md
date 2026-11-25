# End-to-end harness

Read `README.md` here for the lanes and how to run them, and the `testing`
skill (`.claude/skills/testing/SKILL.md` at the repository root) for when to
write a scenario rather than another kind of test.

- **A fast-lane scenario** is a `FastScenario` exported from a file in
  `src/fast/` and listed in `src/fast/index.ts`.
- **Its header:**
  - `covers` lists the routes it exercises, `METHOD /path` or `WS /path`.
  - `environments` says where it may run. A scenario that writes uses
    `WRITABLE` or narrower; one that needs the deployment operator runs only
    on `ephemeral`.
  - `owner` is a team, never a person.
- **Clean-up.** Everything a scenario creates goes through `fixtures`, which
  tear it down whether or not it passed.
- **A scenario that checks a catalog property** carries
  `@property area.name` in the doc comment directly above its export, for
  `just properties check`.
- **The coverage gate** fails when a route is neither covered by a scenario
  nor listed in `surface/exemptions.json` with a reason. Remove a route from
  the exemptions or the backlog once a scenario covers it. After changing the
  server's routes, run `just e2e-surface` to refresh
  `surface/server-surface.json`.
- **Before pushing,** run `pnpm typecheck` and `pnpm test`. With
  `SWITCH_E2E_LANE` unset, `pnpm test` runs only the harness's own unit tests.
