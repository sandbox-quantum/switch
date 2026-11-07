# `tooling-verbosity`

Measures how much an agent writes in a room, so a change to what agents are
told (the Switch skill, the reminder under each room message, the MCP server's
instructions, the tool descriptions) can be judged on what agents actually
post rather than on how long the instructions are.

It starts a Claude Code session the way Switch Console starts one, hands it a
room message, and records what it posts. Everything the model sees comes from
the shipped code, imported rather than copied:

| What the model sees | Where it comes from |
| --- | --- |
| Session options, system prompt preset, settings | `ClaudeAdapter` (`packages/agent-providers/src/claude/claude-adapter.ts`) |
| System context | `SWITCH_SKILL_CONTEXT` (`packages/plugins/src/switch-skill/`), then the agent's instructions, as `session-launch.ts` joins them |
| The `switch` MCP server and its instructions | `serveMcpOverHttp` and `SwitchToolCatalog` (`packages/switch-agent-runtime/src/hosted.ts`) |
| Tool names, descriptions, schemas | The core operation registry, dumped by `scripts/dump_operations.py` |
| The `[Switch] … addressed you` message | `roomCommand` (`packages/agent-providers/src/host/room-prompt.ts`) |

Only the Switch server behind the tools is fake (`src/fake-switch.ts`): it
knows one room, answers the room tools from the scenario, and records posts.
The agent works in a detached worktree of this repository at the scenario's
pinned commit, so it can read code the way a real agent would. Your own
Claude Code settings and login apply, as they do to a session Console starts
on your machine.

## Running

Needs `pnpm install` and a build of the workspace packages the adapter
imports, `uv` for the operation catalog, and a logged-in `claude` on `PATH`.

```bash
# from console/
pnpm --filter "@switch-console/agent-providers^..." --filter "@switch-console/plugins^..." run build

# from console/tooling-verbosity/
../node_modules/.bin/tsx --import ./src/md-loader.mjs src/run.ts \
  --scenario design-question --runs 5 --label candidate
```

Options: `--scenario` (repeatable; all by default), `--runs`, `--label` (the
results folder), `--concurrency`, `--model`, `--timeout` (seconds per run),
`--source`, and, for an ablation, `--skill-file` (a skill file to use in place
of the tree's) and `--reminder-file` (the reminder under each message).

Results land in `results/<label>/<scenario>/` (gitignored): one JSON per run
with every post, every tool call and the metrics, and a `summary.md` with a
table and the posts themselves. Read the posts: the numbers say how long,
not whether anything needed was lost.

### Before and after

`--source` is the `console/` directory whose code the run imports. To measure
the instructions as they were, point it at a worktree of the baseline commit
(with its own `pnpm install` and build):

```bash
git worktree add ../baseline origin/main
(cd ../baseline/console && pnpm install && pnpm --filter "@switch-console/agent-providers^..." --filter "@switch-console/plugins^..." run build)
../node_modules/.bin/tsx --import ./src/md-loader.mjs src/run.ts --source ../../../baseline/console --label baseline
```

## Scenarios

`src/scenarios.ts`. Each models a kind of exchange seen in real rooms, with
made-up names: an open-ended design question, a narrow factual question, and
an explicit request for step-by-step instructions — the last one to check
that a fix for verbosity does not cut content people need.

Each run costs a real session on your Claude account.
