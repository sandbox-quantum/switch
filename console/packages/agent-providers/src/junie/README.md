# Junie ACP

Install the Junie CLI using the provider's install action or the official
[Junie instructions](https://junie.jetbrains.com/docs/junie-cli.html). The session
host resolves `junie` on PATH, including the Windows executable or npm command shim.
Run `junie` on the execution host and use `/account` to configure a JetBrains
account or BYOK provider. Headless hosts can pass the documented `JUNIE_*` keys.

The sign-in check starts ACP and performs only `initialize`. It reports
`unknown`, since neither a configured key nor the advertised authentication
methods validate credentials. Authentication errors are reported by the actual
session. The check never sends `authenticate`, starts a task or opens a browser.

Junie runs through the shared ACP adapter. That adapter handles model selection,
conversation recovery, queued messages, room context and permission decisions.
The Junie hook associates marked `server/tool` MCP calls with their server so
caller-registered room tools do not wait for a redundant approval. Connector
servers and unregistered names retain the shared adapter's permission policy.
Junie user-input extensions and subagent event mapping are not implemented.

## OpenRouter with a custom profile

Junie build 3959.5 rejected raw free-model IDs with `--provider openrouter`.
Its documented Custom profile path accepted the same OpenRouter model. For an
isolated free-only environment, put the following in
`$JUNIE_HOME/models/openrouter-free.json` and set
`JUNIE_MODEL=custom:openrouter-free`. Leave `JUNIE_LLM_PROVIDER` unset so it does
not override Custom selection.

```json
{
  "id": "cohere/north-mini-code:free",
  "baseUrl": "https://openrouter.ai/api/v1/chat/completions",
  "apiType": "OpenAICompletion",
  "apiKey": "${JUNIE_OPENROUTER_API_KEY}",
  "primaryModel": { "id": "cohere/north-mini-code:free" },
  "fasterModel": { "id": "cohere/north-mini-code:free" }
}
```

Verify the model's current availability and prices before use. Enforce a
free-only model allowlist and zero-dollar limit on the OpenRouter key. Junie
can otherwise choose a separately billed helper model even with a free primary
model. Keep credentials in the execution environment, outside the JSON profile.
This is OpenRouter inference through Junie's Custom provider, not proof that the
built-in OpenRouter provider accepts arbitrary model IDs.

The real integration suite is `junie.integration.test.ts`. It uses the standard
ten conformance scenarios and the installed CLI. It consumes model requests.
Use an explicitly configured execution environment, and report failures and
unsupported cases rather than treating excluded tests as passed.
