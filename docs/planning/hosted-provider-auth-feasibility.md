# Hosted provider authentication feasibility

Status: phase 1 planning evidence, 2026-09-17

This note evaluates whether Switch can start hosted sessions for Codex, Claude Code, OpenCode, Antigravity, and Cursor with a credential supplied by each user and without opening a provider browser login in hosted onboarding. It distinguishes:

- **Accepted input**: provider documentation says the key or token is an authentication input.
- **Locally recognized**: the pinned CLI/adapter reports that input as authenticated.
- **Execution verified**: an isolated session completes a minimal model request with only that input.

No credential files or environment values were read, and no provider requests were made. “Supported” below means a documented non-browser input and a concrete adapter path exist. It does not mean Switch has already verified execution.

## Decision matrix

| Provider | Credential | Status | Established evidence | Required execution proof |
| --- | --- | --- | --- | --- |
| Codex | Personal OpenAI API key | **Supported with provisioning** | Codex documents `codex login --with-api-key`; the adapter can isolate `CODEX_HOME` and checks `account/read`. | Pipe the key over stdin into a fresh hosted `CODEX_HOME`, then require `account/read` and one real turn. Raw `OPENAI_API_KEY` passthrough alone is not the documented default app-server login path. |
| Claude Code | `ANTHROPIC_API_KEY` | **Supported** | Claude documents the variable for noninteractive Claude Code and Agent SDK use; the adapter passes an explicit environment. | `claude auth status` plus one real turn in an isolated `CLAUDE_CONFIG_DIR`. |
| Claude Code | Setup token in `CLAUDE_CODE_OAUTH_TOKEN` | **Implemented in the new hosted bootstrap; live check pending** | Claude documents `claude setup-token` for scripts/CI. Static inspection shows the bundled 2.1.260 CLI recognizes the variable. The phase 1 hosted bootstrap maps the credential kind to this exact variable and persists only its name in `inheritEnv`. | Pin a no-network status test and run one isolated turn. Product/legal review is also needed; see below. |
| OpenCode | Declared backend credential such as `OPENAI_API_KEY` | **Supported for a declared subset** | OpenCode documents environment-backed provider credentials; the adapter starts an isolated server with explicit environment and model selection. | Prove the exact backend, credential, provider/model IDs, `/provider` state, and one real turn. There is no generic “OpenCode API key.” |
| Antigravity | Personal API key/provider token | **Blocked** | The current runtime is hard-wired to `oauth-personal` and rejects an emitted browser URL. Its ACP registry entry supplies no key/token method. | A primary-source non-browser credential contract and adapter proof. `GEMINI_API_KEY`/`GOOGLE_API_KEY` acceptance is unknown. |
| Cursor | Personal Cursor API key | **Supported** | Cursor documents `--api-key`/`CURSOR_API_KEY` for headless automation and ACP pre-authentication; the adapter passes an explicit environment. | Use the documented status surface and one ACP turn with only that key. The current `agent about` email heuristic is insufficient. |

The full five-provider promise is therefore not ready. Four providers have a plausible non-browser path, subject to provider-specific provisioning and isolated execution tests. Antigravity lacks a documented key/token path in the current integration and blocks full compatibility.

## Minimal first provider

Start with **Claude Code using `ANTHROPIC_API_KEY`**. The installed adapter already accepts an explicit environment, Anthropic documents the variable for noninteractive CLI/Agent SDK execution, and no credential-file materialization is required. Use a per-tenant `CLAUDE_CONFIG_DIR`, no ambient credentials, and two readiness stages:

1. `claude auth status` identifies the expected source.
2. A minimal turn completes with the selected model using only the supplied credential.

This first slice should exercise secret-reference resolution, redacted diagnostics, rotation, isolated provider state, and teardown. Cursor and individual OpenCode backends can follow. Codex adds an explicit stdin-login provisioning step.

## Phase 1 implementation checkpoint

The new operator bootstrap currently accepts **Claude only**. Its strict deployment schema distinguishes `api-key` from `setup-token`; the implementation maps those kinds to `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. It persists credential-file paths and the selected environment-variable name, not the provider credential value. At launch it builds a minimal process environment from controlled state directories, six operational variables (`PATH`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `TERM`), and the selected Claude credential.

This is implementation evidence for credential delivery, not provider execution evidence. No real Claude credential was used in this review, and neither credential type has completed a hosted model turn. The other four providers are not accepted by the new bootstrap schema; their matrix entries describe baseline adapter feasibility and required future work.

Mounted credential paths stay outside both the private hosted state and workspace directories. Production secret rotation still needs an explicit contract: either treat the resolved mount as immutable for one deployment, or re-resolve and fully revalidate a rotated mount before each worker start. A path validated only once and followed again later is not a complete rotation boundary.

Raw worker diagnostics require separate protection before this path handles real secrets. The shared daemon can persist an error message to `supervisor/failure.json`, and the supervisor appends child output to `supervisor/worker.log`. Redacting only the final bootstrap exception does not sanitize those files. Redaction must cover the selected provider credential and Switch execution token, including values split across output chunks, while leaving ordinary agent transcript handling outside this narrow diagnostic claim.

## Provider evidence

### Codex

OpenAI documents API-key authentication for programmatic CLI workflows and CI. Its flow pipes the value into `codex login --with-api-key`, after which authentication is cached. Some ChatGPT-connected features are unavailable with API-key authentication. See [Codex authentication](https://learn.chatgpt.com/docs/auth).

Switch starts `codex app-server` with an explicit environment and rejects a missing account when authentication is required ([`codex-adapter.ts`](../../console/packages/agent-providers/src/codex/codex-adapter.ts)). The provider-home helper creates a per-session `CODEX_HOME`, but its current path copies `auth.json` from another home ([`home.ts`](../../console/packages/agent-providers/src/codex/home.ts)). Hosted onboarding should create a fresh home and feed the key to `codex login --with-api-key` over stdin. It must not put the key in arguments, logs, or durable host configuration.

`OPENAI_API_KEY` is in the native allowlist ([`agent-env.ts`](../../console/apps/switch-console-desktop/src/main/core/sdk-host/agent-env.ts)), which proves only that the variable can cross that boundary. It does not establish app-server account authentication. Require fresh-home login, `account/read`, and a real turn.

### Claude Code

Anthropic documents `ANTHROPIC_API_KEY` for noninteractive Claude Code/Agent SDK use and `CLAUDE_CODE_OAUTH_TOKEN` for a token created by `claude setup-token` for scripts and CI. The user creates the latter outside Switch; `setup-token` itself opens a browser. Anthropic describes it as inference-only, valid for one year, and unavailable for Remote Control/connectors. See [Claude Code authentication](https://code.claude.com/docs/en/authentication).

The Agent SDK adapter passes `input.env` to the SDK process ([`claude-adapter.ts`](../../console/packages/agent-providers/src/claude/claude-adapter.ts)). Readiness runs `claude auth status` and checks `loggedIn` ([`provider-readiness.ts`](../../console/packages/agent-providers/src/host/provider-readiness.ts)). The pinned `@anthropic-ai/claude-agent-sdk` 0.3.260 bundles Claude Code 2.1.260. Static inspection of that binary's embedded source shows `auth status` includes `CLAUDE_CODE_OAUTH_TOKEN` in its token-source check and reports `oauth_token`. This is version-specific implementation evidence, not a stable public contract; keep it pinned with a no-network local test.

The baseline desktop/SSH native allowlist in [`agent-env.ts`](../../console/apps/switch-console-desktop/src/main/core/sdk-host/agent-env.ts) omits `CLAUDE_CODE_OAUTH_TOKEN`, so that path can still report unauthenticated even when a caller supplied the token. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are present there.

The phase 1 hosted bootstrap is a separate path. [`hosted-bootstrap.ts`](../../console/packages/agent-providers/src/host/hosted-bootstrap.ts) maps `setup-token` to `CLAUDE_CODE_OAUTH_TOKEN`, includes only the variable name in the persisted config, and supplies the resolved value in the controlled process environment. That closes the hosted wiring gap in code; local recognition and real execution remain unverified. The desktop allowlist should be changed only if setup-token support is also intended for desktop/SSH launches.

Anthropic's [Agent SDK hosting guide](https://code.claude.com/docs/en/agent-sdk/hosting) describes hosted products, secret-manager injection, per-tenant `CLAUDE_CONFIG_DIR`, distinct working directories, controlled settings sources, and disabling cross-tenant auto-memory.

There is also an explicit compatibility caution, without drawing a legal conclusion. Anthropic's [legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) says running Claude Code in a hosted product/service requires the Commercial Terms unless otherwise agreed; built-in authentication methods must not be removed or restricted; and each end user must authenticate with their own API key, subscription credentials, or third-party credential and be billed directly. Free/Pro/Max subscriptions otherwise use Consumer Terms. Switch should obtain product/legal review before promising personal subscription setup tokens in hosted execution and preserve the CLI's built-in auth behavior while offering a non-browser Switch onboarding path.

### OpenCode

OpenCode's [CLI documentation](https://dev.opencode.ai/docs/cli/) describes credentials from its store, environment, and project `.env`. Its [provider documentation](https://opencode.ai/v2/docs/providers) exposes environment-variable names per provider. “OpenCode supported” is too broad: every offered backend is a separate compatibility claim.

Switch starts an OpenCode server with temporary XDG configuration and explicit environment ([`server.ts`](../../console/packages/agent-providers/src/opencode/server.ts)). Readiness accepts any connected entry returned by `/provider` ([`provider-readiness.ts`](../../console/packages/agent-providers/src/host/provider-readiness.ts)). That may accept an unrelated ambient credential and does not prove the chosen model. Assert the expected provider ID and model, then complete a real turn from an environment containing only the intended backend variable. Publish a small allowlist of tested `(OpenCode version, provider ID, credential variable, model ID)` tuples.

### Antigravity

The runtime writes `oauth-personal`, starts ACP with `BROWSER=false`, invokes ACP authentication with `oauth-personal`, and treats an emitted authentication URL as failure ([`runtime.ts`](../../console/packages/agent-providers/src/antigravity/runtime.ts)). That is a suppressed browser-OAuth path, not an API-key implementation.

The public [Antigravity ACP manifest](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) marks the agent authenticated but specifies no key/token credential. The [ACP registry documentation](https://agentclientprotocol.com/get-started/registry) requires authenticated agents to support authentication but does not define Antigravity's method. Although `GEMINI_API_KEY` and `GOOGLE_API_KEY` are in Switch's native allowlist, no inspected primary source or adapter path establishes that Antigravity ACP accepts them. Copied Google profiles, captured OAuth tokens, and `GEMINI_HOME` also remain unknown.

### Cursor

Cursor's [ACP documentation](https://prod.cursor.com/docs/cli/acp) names `cursor_login` and documents `agent login`, `--api-key`/`CURSOR_API_KEY`, and `--auth-token`/`CURSOR_AUTH_TOKEN` as pre-authentication options. Its [CLI authentication documentation](https://docs.cursor.com/en/cli/reference/authentication) describes API keys for headless automation.

The adapter starts `agent acp` with an explicit environment and supports `cursor_login` ([`cursor-adapter.ts`](../../console/packages/agent-providers/src/cursor/cursor-adapter.ts)). `CURSOR_API_KEY` is allowed by [`agent-env.ts`](../../console/apps/switch-console-desktop/src/main/core/sdk-host/agent-env.ts); `CURSOR_AUTH_TOKEN` is not. Phase 1 can use the narrower API-key route.

Readiness currently runs `agent about` and treats a parsed email as authenticated ([`provider-readiness.ts`](../../console/packages/agent-providers/src/host/provider-readiness.ts)). Cursor's public reference names `agent status`; local status still does not prove model execution. Require one minimal ACP turn. Cursor also warns that network failures can appear as invalid-key errors, so diagnostics should store a redacted category and retry context rather than raw stderr ([Cursor CLI integrations help](https://prod.cursor.com/help/integrations/cli)).

## Hosted implementation constraints

### Keep provider secrets out of durable config

`SharedHostConfig` includes environment data and the launcher serializes the object to durable `config.json` mode `0600` ([`launch.ts`](../../console/packages/agent-providers/src/host/launch.ts), [`shared-config.ts`](../../console/packages/agent-providers/src/host/shared-config.ts)). File mode does not make plaintext credentials suitable for hosted persistence.

Persist opaque secret references only. Resolve immediately before process spawn, provide the value through stdin or a minimal child environment as required, and discard it when the process exits. Redact values, authorization headers, query parameters, subprocess arguments, environment dumps, and provider stderr before persistence or transport.

### Reject ambient credentials and isolate state

The shared runtime forwards `sessionEnvVars` and uses the native allowlist as inherited environment ([`shared-agent-runtime.ts`](../../console/apps/switch-console-desktop/src/main/core/sdk-host/shared-agent-runtime.ts), [`agent-env.ts`](../../console/apps/switch-console-desktop/src/main/core/sdk-host/agent-env.ts)). On a multi-tenant worker, an allowlist still inherits ambient credentials. Construct every provider process from a deny-by-default environment, add operational variables explicitly, and resolve exactly one tenant credential for the selected provider/backend.

Use fresh tenant state: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, OpenCode XDG directories, Cursor state if configurable, and any future Antigravity profile. Never copy a developer or worker provider home into a hosted session.

### Report readiness in stages

Persist redacted stages rather than one authenticated boolean:

1. `credential_resolved`: secret reference resolved, value never logged.
2. `credential_recognized`: pinned CLI reports the expected source.
3. `provider_selected`: expected backend/account is active.
4. `model_usable`: a minimal request completes on the selected model.

This prevents a cached account, an unrelated OpenCode backend, or a local email string from masquerading as API-key-only execution. Updates should create a new secret version and process; do not assume a live CLI rereads environment. Separate expired/revoked credentials, rate limits, unavailable models, and transport failures in redacted diagnostics.

## Phase 1 acceptance evidence

For each advertised path, record these checks against pinned versions:

| Evidence | Required result |
| --- | --- |
| Empty provider home | No copied login, keychain, cookies, credential file, or worker account. |
| Minimal environment | Only the declared credential and operational variables reach the child. |
| Local auth probe | Reports the expected source, not merely any logged-in state. |
| Real execution | One request succeeds for the explicitly selected model. |
| Negative control | The same isolated setup without the credential fails unauthenticated. |
| Cross-tenant control | A second tenant cannot reuse the first tenant's state or secret reference. |
| Redaction control | Logs, responses, metrics, config, crash reports, and raw provider errors contain no credential or reversible fragment. |
| Rotation control | Replacement starts a fresh process and the old secret version stops being usable. |

Until this evidence exists, UI copy should say the credential was accepted or locally recognized rather than that the provider is connected and ready.
