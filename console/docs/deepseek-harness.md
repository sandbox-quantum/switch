# DeepSeek Harness

Switch runs the official `@deepseek-ai/dsh-acp` automation server through the
shared ACP adapter, on both Console and the headless agent controller. The
provider id is `deepseek-harness`.

## Setup

Install `npm install -g @deepseek-ai/dsh` on the execution machine. Switch
detects the `dsh` executable and probes `dsh --version`; it never launches a
profile or login for installation detection. Sessions use `dsh --profile acp`.

Run `dsh web` on that machine and configure the DeepSeek API key in Models,
or supply `DEEPSEEK_API_KEY` in the controller's environment. `dsh auth login`
is not a supported launcher command. `DSH_HOME`, `DEEPSEEK_BASE_URL` and
`DSH_TELEMETRY_DISABLED` are also passed through to the execution host.

The sign-in check reads the shipped profile's credential layers: the owner-only
`$DSH_HOME/.credentials.yaml` version-1 `refs` store, the launch environment,
the working directory's `.env`, then `$DSH_HOME/.env`. Without `DSH_HOME`, the
home is `~/.dsh`. Blank `DSH_HOME` uses that default; relative paths resolve
against the execution directory and `~` expands to the execution user's home.
Empty launch key values shadow dotenv fallbacks, as in DSH.
After finding a key it checks ACP startup, without a model call or
`authenticate`. "Authenticated" means a key is configured, not that a remote
service has validated it. Invalid stores and unrecognized stored credentials report
unknown. Custom compositions using other credential references or provider
routes may require checking setup in DSH itself.

ACP's `authMethods: []` does **not** prove a model is authenticated: the server's
`authenticate` method always succeeds. Credentials remain on the execution
machine; Switch does not copy them into agent definitions.

## Capabilities And Limits

Verified against the published developer preview `dsh 0.2.1-rc.5` on
2026-11-04. Upstream contracts:
[launcher](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md),
[ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md),
[credentials](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/credentials-local/README.md).

| Feature | Behavior |
| --- | --- |
| Models | Live ACP `model` config choices; opaque provider/model IDs are forwarded unchanged with `session/set_config_option`. |
| Sessions | `session/new`, prompts, cancellation, and advertised `session/resume`; persisted model selection survives restart. |
| Room tools | Stdio and HTTP MCP. Qualified `mcp__<server>__<tool>` names map to registered servers, including DSH's normalized server names. Ambiguous names never grant automatic approval. |
| Activity | Generic DSH tool updates produce activity items; `bash`/`pwsh` are commands and `write`/`edit`/`apply_patch` are file changes. Assistant output arrives as committed messages, rather than token-level deltas. |
| Permissions | One-shot allow/reject/cancel, when DSH asks. Full access answers exposed requests with allow-once; it never creates a durable grant or disables DSH's sandbox. Exposed room-tool requests are allowed once; exposed connector requests still ask. |
| Mid-turn messages | Queued as subsequent turns. No in-turn steering. |
| Unsupported | Elicitation, structured subagent activity, `session/load`, transcript replay, modes, commands, plans, terminals, client filesystem operations, session deletion and forks. |

DSH's configured sandbox and permission policy remain authoritative. ACP offers
no session-mode selector: Switch cannot require approval for native operations
DSH already permits, or authorize actions DSH rejects before requesting client
approval. Auto-review and auto-accept-edits are not advertised as native DSH
modes. DSH's default workspace-write policy permits ordinary workspace writes.
The conformance approval prompts therefore explicitly request a per-call
sandbox escalation to exercise the approval channel.
The real CLI also permits ordinary MCP calls without asking ACP, including
connector tools. Switch's connector approval handling only applies when DSH
exposes a permission request; it cannot enforce an approval DSH never requests.

## Shared Integration Changes

The shared adapter now supplies the session's registered MCP names to the
existing provider hook. DSH reports a qualified tool title and only a call ID
in permission requests, so its hook must match that title against registered
names, including DSH's normalization, before identifying a room or connector.
Existing providers retain their hook behavior.

The conformance suite accepts an optional approval prompt suffix to exercise
DSH's per-call escalation; other providers keep their existing prompts.
The buddy telemetry changes add the provider to its existing closed catalogue
and disclosure. Controller and backend tests update the expected provider list.

## Verification

From `console/packages/agent-providers`:

```sh
pnpm exec vitest run src/deepseek-harness/deepseek-harness.integration.test.ts --reporter=verbose
```

The integration file has two kinds of evidence:

- Real DSH processes with isolated homes and a local scripted Messages endpoint:
  assert the outgoing model ID, actual file writes, allow/reject/auto-approval,
  cancellation, queueing, MCP calls over stdio and HTTP, and persisted
  conversation history and model selection after process restart.
  No production API key or model service is used for these checks.
- The ten shared conformance scenarios against a real model service. These
  require execution-host credentials. Elicitation and structured subagent
  activity have explicit unsupported skips; other scenarios skip only when
  the CLI or its credentials are unavailable.

Unit tests cover credential precedence, safe readiness failures, launch and
protocol behavior, tool classification, registered room versus connector
approvals, ambiguous MCP names, queueing, cancellation and resume.
Plugin launch tests cover model and room instruction forwarding; controller
tests cover installation discovery and missing executables.

On 2026-11-04, the real-CLI file against `dsh 0.2.1-rc.5` finished with
**8 passed, 10 skipped**. Seven cases used the local scripted model endpoint
(including readiness, restored conversation history, and stdio/HTTP MCP);
the eighth checked model configuration and resume without a model request.
All ten live-model conformance cases skipped because no execution-host
credentials were configured. The built headless host's readiness and model
discovery probes, and the built controller's CLI startup check, also passed.

Live model conformance and a Console room demonstration/video still require a
configured account and a graphical Console session. Local scripted model
responses do not establish live model behavior or UI interaction.
