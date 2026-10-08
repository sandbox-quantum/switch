# Add an agent provider

This is how to add a new agent CLI to Switch. If the CLI speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP), you write a hooks
file and a plugin entry, register each of them with one line, and add one line to
core's provider table. You don't write an adapter. A CLI that doesn't speak ACP
needs its own adapter; see [Not ACP](#not-acp) at the end.

Paths below are relative to the repository root. `<id>` is the provider id
Switch stores, in lowercase (`cursor`, `antigravity`). Choose it once: agent
records and sessions keep it, so it can't be renamed later.

## What you touch

| # | File | What it is |
|---|---|---|
| 1 | `console/packages/agent-providers/src/<id>/<id>-acp.ts` | The ACP hooks: how to run the CLI and what makes it different from other ACP agents |
| 2 | `console/packages/agent-providers/src/providers/registry.ts` | One line: `acpProviderRuntime(<id>Acp)` in `PROVIDER_RUNTIMES` |
| 3 | `console/packages/plugins/src/agents/impl/<id>/index.ts` and `icon.ts` | The plugin: name, description, how to find and install the CLI, and its icon |
| 4 | `console/packages/plugins/src/agents/plugin-registry.ts` | One line: the plugin in the registration list |
| 5 | `core/switch_core/providers/registry.py` | One entry in the server's provider table: the id and a label |
| 6 | `console/packages/agent-providers/src/<id>/<id>.integration.test.ts` | The conformance suite, run against the real CLI |

That's all you touch. Console's create-agent flow, the provider settings, the
agent controller's status report, the gateway's provider list and the server's
validation all read these registrations. If a change outside these files seems
to be needed, the registration is missing something. Say so in your PR rather
than adding another hardcoded provider list.

Registrations 2 and 4 must name the same providers. Console and the agent
controller refuse to start when they don't, and the error names the half that's
missing.

## 1. The ACP hooks

Copy `console/packages/agent-providers/src/cursor/cursor-adapter.ts` or
`src/antigravity/antigravity-adapter.ts` and trim it. The interface is
`AcpProviderHooks` in `src/acp/hooks.ts`, and every field is documented there.
A minimal provider looks like this:

```ts
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';

export const exampleAcp: AcpProviderHooks = {
  provider: 'example',
  label: 'Example CLI',
  defaultBinary: 'example',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: 'example login',
};

export function createExampleAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(exampleAcp, options);
}
```

The generic adapter already handles the following, picking behaviour from what
the agent advertises. **Don't re-implement any of it in hooks:**

- the `initialize` handshake, and refusing to start when HTTP MCP servers are
  configured but the agent doesn't declare `mcpCapabilities.http`;
- session start, and resume through `session/load` or `session/resume`. When the
  agent advertises neither, the host starts a fresh conversation and keeps the
  transcript;
- the session's MCP servers, both stdio and HTTP;
- prompts, attachments (images, audio and embedded resources where advertised,
  resource links otherwise) and the system context;
- streaming text and tool calls into the transcript, including diffs and raw
  output;
- permission requests:
  - allow once without asking for tools on the session's own MCP servers,
    everything in full access, and edits in auto-accept-edits;
  - otherwise offer allow once, allow for this session, and reject, and never
    offer permanent policies;
- model selection through a `model` config option or through the session's
  `models` list;
- cancel, queued turns, process exit and errors.

Add hooks only for what really differs:

| Hook | When you need it |
|---|---|
| `launch` (required) | The binary, its arguments and its environment. It may prepare the host first, as Antigravity does with its profile directory. The environment is complete and not merged with anything, so add to `env`, never to `process.env`. |
| `loginCommand` (required) | The command a person runs on the execution machine to sign in. It is shown whenever the CLI is signed out. |
| `checkSignIn` | Answers "is this CLI signed in?" **without signing it in**. Use the `handshake()` it's given, or the CLI's own status command. Without it, the check runs the handshake and reports the sign-in as unknown. |
| `inheritEnv` | Environment variables the CLI reads, such as its API key, that the session host should pass through from the machine. The common vendor keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`, proxies…) are already passed through. |
| `authMethodId` | The `authenticate` method sent on every session start. Omit it for an agent that needs none. |
| `sessionMode` | The ACP mode for each Switch runtime mode, when the agent's modes are permission levels. |
| `promptCapabilities` | Content the agent accepts without advertising it. Prefer fixing the advertisement upstream. |
| `mcpServerOf` | How a tool call names its MCP server, if the agent says so (in `_meta`, `rawInput`…). Without it, tools on registered servers still ask for permission. |
| `itemType` | Vendor typing for tool calls, such as subagents. |
| `permission` | A permission request the vendor uses for something else, such as Antigravity's questions. |
| `extensions` | Vendor-specific requests and notifications, such as Cursor's `cursor/ask_question`, `cursor/create_plan` and `update_todos`. Use `askQuestions`, `requestDecision` and `completeItem` on the context they're given; these already cancel when no turn is running. |
| `nativeSessionIdPrefix` | Only when an earlier, non-ACP runtime of the same provider stored session ids that must not be resumed. |

Then add the runtime to `PROVIDER_RUNTIMES` in `src/providers/registry.ts`:

```ts
acpProviderRuntime(exampleAcp),
```

### Sign-in checks

A sign-in check must never be what changes its answer. Don't call
`authenticate` from it: for most agents that's the sign-in itself, and it can
open a browser on the machine. The check runs whenever Console or the agent
controller asks about the provider, including on remote and headless machines.

## 2. The plugin

The plugin is what Console shows and how it finds the CLI. Copy
`console/packages/plugins/src/agents/impl/cursor/` and edit it:

- `metadata` sets the display name, a one-line description and the docs URL.
  Optional fields, all documented in
  `console/packages/core/src/agents/plugins/index.ts`:
  - `cliLabel`: for when the name alone is ambiguous ("Cursor CLI").
  - `knownAgentType`: defaults to the id.
  - `sessionStartMaySignIn`: set it when starting a session can open a sign-in
    browser, so model listing checks sign-in first.
- `hostDependency` gives the executable names to look for on `PATH`, plus
  install commands per platform.
- `mcp`, `prompt`, `sessions` and the rest: for an ACP CLI that runs only
  through the session host, copy Antigravity's (`mcp: { kind: 'none' }`,
  `prompt: { kind: 'none' }`, and a `buildCommand` that throws).
- `icon.ts` holds an SVG. Give it an `alt`, and set `invertInDark` if it is a
  dark single-colour mark.

The plugin declares no advanced-configuration fields. Those are defined only in
core's provider table (step 3), and Console builds every agent's form from what
the agent's Switch server serves. A plugin only applies values: if the provider
takes settings, its plugin lists the keys it applies and the shape of each
(`mcp.launchProfileSettings()`, or `repoAgents.advancedSettings()` for a
provider that runs named definitions) and turns them into launch inputs. Leave
both out for a provider with no settings. A field the server defines that the
plugin doesn't apply is shown as one this Console can't apply, and the agent
controller refuses a definition that sets it.

Add it to the list in `plugin-registry.ts`. The list order is the order the UI
shows.

## 3. Core's provider table

Add one entry to the provider table in `core/switch_core/providers/registry.py`
with the id and a display label. Leave everything else at its default unless the
server really needs it:

- **Advanced settings:** none by default. Empty is valid, and Console then
  offers no advanced form. When the provider does take settings, this is the
  only place their fields (label, type, help, choices) are defined: add them to
  `core/switch_core/providers/advanced_fields.py`, and have the plugin apply
  each by its key (step 2).
- **Known-agent profile:** the generic managed-agent profile, keyed by the id.

The server validates agent definitions, the gateway's provider list and
`get_advanced_config` from this table, and no migration is needed.

## 4. Conformance and the real CLI

Add `src/<id>/<id>.integration.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createExampleAdapter } from './example-acp';

describeConformance('example', {
  createAdapter: async () => createExampleAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('example', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the example binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
```

The suite runs ten scenarios against the real CLI:

- a simple turn
- a file write in full access
- an approval accepted
- an approval declined
- an interrupt
- a message mid-turn
- resume
- a question
- a subagent
- a registered MCP server

It spends real tokens and skips itself, saying why, when the binary or sign-in
is missing. It doesn't run in CI, so run it locally with the CLI installed and
signed in:

```bash
cd console/packages/agent-providers
pnpm exec vitest run src/<id>/<id>.integration.test.ts
```

Skip a scenario only when the CLI really can't do it, and give the reason in
`skip`. Record the result in the known-limits table in
`console/packages/agent-providers/README.md`.

## 5. Checks before you open the PR

```bash
cd console
pnpm -r --filter './packages/**' run build
pnpm -r run typecheck
pnpm -r run lint
pnpm -r run format:check
pnpm -r run test
```

If you changed core, also run `just check`, `just typecheck` and `just test`
from the repository root. Then fill in the PR template's agent CLI checklist,
including the recording of the CLI working in Console.

## Not ACP

A CLI with its own protocol needs an adapter that implements `ProviderAdapter`
(`console/packages/agent-providers/src/adapter.ts`). Codex (JSON-RPC
app-server), OpenCode (HTTP and SSE) and Claude (the Agent SDK) are the
examples. Register it in `PROVIDER_RUNTIMES` with its own `createAdapter`,
`checkSignIn` and `loginCommand`. Everything after step 1 is the same.
