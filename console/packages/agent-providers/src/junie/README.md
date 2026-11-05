# Junie Agent Provider (ACP)

Integrates [JetBrains Junie](https://www.jetbrains.com/junie/) as an Agent Client Protocol (ACP) agent provider in Switch Console and Switch Core.

## Installation

Install Junie CLI globally using the official installer or package manager:

- **macOS / Linux**:
  ```bash
  curl -fsSL https://junie.jetbrains.com/install.sh | bash
  # Or via npm
  npm install -g @jetbrains/junie
  ```
- **Windows** (PowerShell):
  ```powershell
  irm https://junie.jetbrains.com/install.ps1 | iex
  # Or via npm
  npm install -g @jetbrains/junie
  ```

Ensure `junie` is accessible on your system `PATH`.

## Authentication

Junie supports multiple authentication methods:

1. **JetBrains Account**:
   Run `junie login` on the execution host and complete the browser authentication. The session token is cached in `~/.junie/secure_credentials.json`.
2. **Junie API Key**:
   Set `JUNIE_API_KEY="your-api-key"` in the machine environment or session configuration.
3. **Bring Your Own Key (BYOK)**:
   Pass provider keys directly into the environment:
   - `JUNIE_ANTHROPIC_API_KEY`
   - `JUNIE_OPENAI_API_KEY`
   - `JUNIE_GOOGLE_API_KEY`
   - `JUNIE_GROK_API_KEY`
   - `JUNIE_META_API_KEY`
   - `JUNIE_OPENROUTER_API_KEY`
   - `JUNIE_LITELLM_URL` / `JUNIE_LITELLM_API_KEY`

## ACP Architecture and Capabilities

Junie connects via Switch's generic ACP adapter using:

```bash
junie --acp=true --skip-update-check
```

- **Model selection**: Models advertised by Junie over ACP during session initialization are presented in Switch Console's model selector.
- **Approvals & Permissions**: Handled over ACP. Tool approvals (`allow_once`, `allow_always`, `reject`) prompt in Switch rooms or are auto-approved per session runtime mode (`full-access`, `auto-accept-edits`, `approval-required`).
- **Resumable sessions**: Sessions preserve their native ACP session ID across process restarts and reconnections.
- **MCP routing**: Junie MCP tool calls (`_meta.is_mcp_tool_call` and `server/tool` pattern) are resolved to registered Switch room tools and connectors.
- **Mid-turn message queueing and interrupts**: Handled by the generic adapter (`!interrupt` cancels turns cleanly).

## Testing

Run unit tests:

```bash
pnpm exec vitest run src/junie/junie-acp.test.ts
```

Run real-CLI integration conformance tests:

```bash
pnpm exec vitest run src/junie/junie.integration.test.ts
```
