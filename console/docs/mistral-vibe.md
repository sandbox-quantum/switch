# Mistral Vibe provider

Mistral Vibe runs through Switch's generic ACP adapter on both Console's session
host and the headless agent controller. Its stored provider ID is `mistral-vibe`.
No additional advanced settings are required.

## Installation and sign-in

Install with `uv tool install mistral-vibe`, with `uv` already installed and its
tool directory on `PATH`. Mistral also provides an installer that installs `uv`:
[official installation instructions](https://docs.mistral.ai/vibe/code/cli/install-setup).
The final checks used Mistral Vibe 3.1.0 on Ubuntu 26.04.1 LTS; initial native
protocol checks also ran against 3.0.4.

The ACP executable is **`vibe-acp` with no arguments**. `vibe-acp --help` lists
`--setup` and `--version`; the
[official entrypoint](https://github.com/mistralai/mistral-vibe/blob/v3.1.0/vibe/acp/entrypoint.py)
starts ACP directly. The hooks do not assume a `vibe acp` subcommand.

Switch discovers `vibe-acp` on the execution machine's `PATH`. Sign-in detection
initializes ACP and calls Vibe's read-only `_auth/status` extension in its
[agent implementation](https://github.com/mistralai/mistral-vibe/blob/v3.1.0/vibe/acp/agent.py). It never
calls `authenticate` or starts setup. Missing credentials produce the hint
`vibe-acp --setup`. A positive result establishes local credential/configuration
presence, not key validity, account quota or access to every model.

`VIBE_HOME` selects the native profile. The shared environment allowlist already
passes `MISTRAL_API_KEY`; Vibe's hooks additionally pass its profile/custom console
settings and the Linux session variables its OS keyring can need. Sign-in belongs
to the machine executing the agent.

## Models and permissions

Models come from Vibe's session `model` config option. Switch displays the
configured aliases and sends the selected alias through
`session/set_config_option`; Vibe resolves it to the model's actual API name.
There is no hardcoded list of Mistral marketing names. In particular, an isolated
default 3.0.4 profile can expose only one model.

| Switch mode | Vibe mode |
|---|---|
| Approval required | `ask` |
| Auto-accept edits | `accept-edits` |
| Auto | `ask` |
| Bypass permissions / full access | `auto-approve` |

The default 3.1.0 mode catalogue omits smart approval. Auto mode therefore asks a
person; bypass uses Vibe's native auto-approval. Vibe's existing native policies
can also settle requests before they reach Switch.

Allow once, allow for the session and deny map to Vibe's
[offered option IDs](https://github.com/mistralai/mistral-vibe/blob/v3.1.0/vibe/acp/utils.py).
Permanent grants, including file-path grants, are removed before the generic
adapter chooses options. Interrupting or stopping cancels pending requests.

## Why the generic ACP hooks changed

Four small hooks support differences verified in Vibe 3.1.0:

- Vibe accepts HTTP MCP servers but omits `mcpCapabilities` in `initialize`.
  An optional transport declaration fills that omission. An explicit `false`
  from any agent still refuses startup with HTTP tools.
- A permission-options filter removes permanent grants that Vibe labels
  `allow_always`, the same kind it uses for session-only grants.
- MCP tool attribution receives the session's registered server names because
  Vibe reports normalized names in `_meta.tool_name`. Colliding names are left
  for approval rather than attributed to the wrong server.
- Vibe does not save an empty session for later loading. Its structured
  missing-session error maps to Switch's existing conversation recovery:
  start fresh when no provider answer was lost, otherwise request a reset
  decision and retain the transcript.

The adapter still owns sessions, models, tool events, queues, cancellation and
resume. Vibe's `_meta.effect_kind` identifies subagent activity. User questions
use ACP elicitation, which Switch does not advertise, so that conformance
scenario has an explicit skip.

The bundled Buddy template also includes Vibe in its default provider preference
list. That existing list is separate from the provider registry, and its
consistency test requires updating it when a provider is added. Template
revisions are recorded by the release workflow.

## Automated regression checks

On 2026-11-04:

| Check | Result |
|---|---|
| Generic ACP adapter and Vibe hook tests | 57 passed |
| Full provider unit suite | 980 passed, 8 skipped |
| Full plugin suite | 139 passed |
| Full controller suite | 410 passed, 2 skipped |
| Desktop provider, setup/status and Buddy regressions (`node`/`main-db`) | 92 passed |
| Core provider, gateway, settings, room labels and template regressions | 153 passed |
| Workspace typecheck, lint and format checks | Passed |
| Workspace package builds and full desktop build, including sidecar/local server | Passed |
| Repository-wide Ruff checks and Core mypy | Passed (618 source files typechecked) |

The controller status tests now derive expected probe counts from the provider
registry, preserving the TTL/cache assertions as providers are added. Browser
tests were excluded as required by `console/AGENTS.md`; the full desktop test
suite was not run.

## Reproducing validation

From `console/`, with `vibe-acp` on `PATH`:

```sh
pnpm --filter @switch-console/agent-providers exec vitest run src/mistral-vibe/mistral-vibe.integration.test.ts --reporter=verbose
```

The real-CLI checks use temporary native profiles with telemetry disabled. They
separate credential-presence checks from usable-account checks. The local-model
scenario runs the actual Vibe process against a scripted localhost completion
endpoint; it does not exercise Mistral's hosted inference service.
On 2026-11-04, this file finished with **6 passed, 10 skipped** on Vibe 3.1.0.
Vibe executes a real HTTP MCP `tools/call` against the fixture, receives its room
context and auto-approves that registered Switch server without opening a
permission request.
It also drives Vibe's native file-writing tool: an approved write creates its
file and emits file-change activity, denied and interrupted writes leave no
file, interrupt resolves the pending approval as cancelled, and native
auto-approve writes without opening a Switch approval request.

The built Linux controller's `precheck` command was run with an isolated home,
no display, no enrollment and a PATH containing only Node, Vibe and system tools.
With Vibe 3.1.0 it reported:

| Native setup | Controller result |
|---|---|
| Installed, no credentials | `installed: true`, `auth: missing`, setup hint |
| Installed, keyless local provider configured | `installed: true`, `auth: ok`, `auth_source: local` |
| Executable removed from PATH | `installed: false`, `reason: provider_not_installed` |

The install command also completed with stdin closed and isolated `UV_TOOL_DIR`
and `UV_TOOL_BIN_DIR`. Controller probing and real ACP execution are covered;
an enrolled controller answering a real server room remains a manual check.

Hook unit tests use a fake ACP process for tool activity, allow/deny/session
decisions, permanent-grant filtering, automatic approvals and cancellation of
pending approvals. Host regression tests use fake provider events for room
assignment recovery and chat publication. Native tool execution is covered by
the scripted local-model check above; successful approval clicks in a live room
remain a manual check.

Live conformance requires a working native sign-in or `MISTRAL_API_KEY`. Without
one, all ten live scenarios skip with `Sign in on the execution machine with
vibe-acp --setup.` This is not evidence of a live room reply or a successful
hosted model call.

The Console walkthrough/video, a real server room mention, and approval clicks
in the GUI require a graphical session and a usable account. They remain manual
acceptance checks; automated adapter events alone do not prove them.
