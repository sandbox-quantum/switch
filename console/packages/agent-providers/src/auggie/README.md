# Auggie agent provider

Adds [Auggie](https://docs.augmentcode.com/cli/acp/agent) (Augment Code's CLI) as an agent provider for Switch. A Switch agent can run on Auggie: it is created in Switch Console, talks in rooms, and asks for approvals like the existing Claude Code, Codex, OpenCode, Cursor and Antigravity agents.

Auggie speaks the [Agent Client Protocol](https://agentclientprotocol.com) natively (`auggie --acp`), so this provider is an ACP hooks file on the generic adapter plus a plugin entry and one line in each registry. No custom adapter is written.

- **Provider id:** `auggie` (stored in agent records and sessions; it can't be renamed later)
- **Binary:** `auggie`
- **Launch:** `auggie --acp`
- **Sign in:** `auggie login`

## What's in this change

| File | Purpose |
|------|---------|
| `console/packages/agent-providers/src/auggie/auggie-acp.ts` | ACP hooks: launch, login command, sign-in check, env passthrough |
| `console/packages/agent-providers/src/auggie/auggie-acp.test.ts` | Unit tests for the hooks |
| `console/packages/agent-providers/src/auggie/auggie.integration.test.ts` | Conformance suite run against the real CLI |
| `console/packages/agent-providers/src/providers/registry.ts` | `acpProviderRuntime(auggieAcp)` added to `PROVIDER_RUNTIMES` |
| `console/packages/plugins/src/agents/impl/auggie/index.ts`, `icon.ts` | Plugin: name, description, docs URL, install commands, icon |
| `console/packages/plugins/src/agents/plugin-registry.ts` | Plugin added to the registration list |
| `core/switch_core/providers/registry.py` | `auggie` entry (id and label) in the server's provider table |
| `console/packages/agent-providers/README.md` | Known-limits table updated with any skipped scenarios |

The plugin and `PROVIDER_RUNTIMES` registrations must name the same providers, otherwise Console and the agent controller refuse to start.

## Behaviour

### Sign-in detection

Installed / not installed and signed in / signed out are detected without starting a login. The check never calls `authenticate`, so it cannot open a browser, including on remote and headless machines. When signed out, Console shows the hint **sign in with `auggie login`**.

> Implementation note: the check is based on `auggie token print` (exit code and JSON shape only; the output contains a token and is never logged or returned). If that proves unreliable it falls back to the ACP handshake. _Confirm and update this line once verified against the real CLI._

### Models

The model is chosen in Console's create-agent flow. Auggie lists its models with `auggie models list --json`.

> _To fill in after checking the handshake: whether Auggie advertises models through a `model` config option or the session's `models` list, and confirmation that the chosen model is the one actually used._

Advanced settings are empty for this provider (none are defined in core's table), so Console offers no advanced form.

### Auto-approve

Auggie has no allow-everything switch. Auto-approve is therefore handled on the Switch side by the generic ACP adapter: in full-access mode it answers the agent's permission requests with allow, so no CLI flag is needed. In other modes the adapter offers allow once, allow for this session, and reject.

Limit to note: Auggie's own permission rules (settings.json, `--permission`) are separate. A rule set to deny in Auggie can still block a tool, because Switch's auto-approve only answers ACP permission requests and does not override Auggie's own rules.

### Sessions, queueing and interrupts

Handled by the generic adapter from what Auggie advertises:

- A message sent mid-turn is queued.
- `!interrupt` stops a turn.
- The conversation resumes after a restart. If Auggie advertises neither `session/load` nor `session/resume`, the host starts a fresh conversation and keeps the transcript.
- Tool use appears on the activity card, and approvals can be approved or denied from the chat.

### Headless machines

The sign-in check and launch work on a headless agent controller machine as well as in Console. For headless sign-in, the session environment can carry `AUGMENT_SESSION_AUTH` (passed through via `inheritEnv`).

## Known limits

_Fill in after running the integration suite. Each skipped scenario needs a reason, the Auggie CLI version and the date._

| Scenario | Status | Reason / CLI version / date |
|----------|--------|-----------------------------|
| simple turn | | |
| file write in full access | | |
| approval accepted | | |
| approval declined | | |
| interrupt | | |
| message mid-turn | | |
| resume | | |
| question | | |
| subagent | | |
| registered MCP server | | |

Known to verify: Auggie's ACP docs say not every interactive-mode feature is supported in ACP mode. Whether it declares `mcpCapabilities.http` decides if HTTP MCP servers work; without it the adapter refuses to start with them configured.

## Out of scope

- Hosted cloud agents
- Logins pushed from Console

## Development

Prerequisites: Auggie installed (`npm install -g @augmentcode/auggie`) and signed in (`auggie login`) with an account that can make model calls.

From `console/`:

```sh
pnpm install
pnpm -r --filter './packages/**' run build
pnpm -r run typecheck
pnpm -r run lint
pnpm -r run format:check
pnpm -r run test
```

Because core changed, also run from the repository root:

```sh
just check
just typecheck
just test
```

### Real-CLI integration test

This spends real model calls and is not run in CI. It skips itself, with a stated reason, if the `auggie` binary or sign-in is missing.

```sh
cd console/packages/agent-providers
pnpm exec vitest run src/auggie/auggie.integration.test.ts
```

It runs ten scenarios: simple turn, file write in full access, approval accepted, approval declined, interrupt, message mid-turn, resume, question, subagent, and a registered MCP server. The suite gives the CLI a minimal environment (PATH, HOME and a few basics). If Auggie needs `AUGMENT_SESSION_AUTH` to sign in, pass it through in `env`, otherwise it falls back to interactive login and times out.

### Integration test summary

_Paste the summary the test prints here (and in the PR)._

```
<paste summary>
```

## Pull request checklist

- [ ] Real-CLI test summary pasted in the PR template
- [ ] Short video: Auggie shown as signed in in the agent setup, agent created with a chosen model, reply in a room, shell command asking for permission first
- [ ] Auto-approve handling described (see above)
- [ ] Skipped scenarios recorded in `agent-providers/README.md` with reason, CLI version and date
- [ ] Any change outside the files listed above is explained in the PR
