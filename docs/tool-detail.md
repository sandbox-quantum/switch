# Safe Tool Execution Visibility in Collaboration Rooms

When autonomous agents execute tasks in shared rooms, team members need insight into what commands and tools the agent ran (e.g. `pytest`, `git diff`, database migrations) without needing to leave their collaboration channel. 

Switch enables secure, bounded tool input and output visibility across team channels while strictly protecting credentials through server-side defense-in-depth sanitization.

---

## Architecture: Server-Side Defense-in-Depth

Relying solely on client or desktop host applications to sanitize secrets creates severe security vulnerabilities: headless agent runners, Python SDK scripts, CLI bridges, and remote agent environments bypass host-only filters and risk leaking sensitive API credentials into public channels.

Switch implements **defense-in-depth sanitization in `switch-core`**:
1. Regardless of the client or agent host origin, the bridge intercepts all tool call inputs, outputs, and exit status lines before emitting them to channel renderers.
2. High-entropy API tokens, authentication headers, connection URIs, and environment variables are deterministically stripped and masked.
3. Payloads are bounded to strict size ceilings to avoid channel flooding or spam.

---

## Secret Masking Rules

The redaction engine (`switch_core.bridges.collaboration.session.redaction`) automatically sanitizes:

- **Provider API Keys:**
  - Anthropic (`sk-ant-...`)
  - OpenAI (`sk-...`)
  - GitHub Personal Access Tokens (`ghp_...`, `github_pat_...`)
  - Slack Tokens (`xoxb-...`, `xoxp-...`, `xoxa-...`)
  - AWS Access Keys (`AKIA...`, `ASIA...`)
  - Google Cloud / Gemini API Keys (`AIza...`)
- **Authentication & Headers:**
  - Authorization headers (HTTP and MCP `Authorization: Bearer ...`)
  - JSON Web Tokens (`eyJ...`)
  - Bearer tokens across headers and command lines
- **Connection Strings & Passwords:**
  - Database URI passwords (`postgres://user:pass@host`, `redis://...`, `mysql://...`)
  - Key-value assignments (`password=...`, `secret=...`, `token=...`, `api_key=...`)
- **Private Keys & Certificates:**
  - Full PEM private key blocks (`-----BEGIN RSA PRIVATE KEY-----`)
- **Environment Variables:**
  - Exported secrets (`API_KEY=...`, `DB_PASSWORD=...`, `AUTH_TOKEN=...`)

---

## Bounded Display Limits

To preserve readability in chat channels without overwhelming the thread:

- **Input Ceiling:** Up to 500 characters of tool invocation arguments or commands. Excess text is cut at line boundaries with `[input cut, X more characters]`.
- **Total Detail Ceiling:** Up to 2,000 characters total across both input and output.
- **Truncation Markers:** Preserves context by indicating exactly how many characters were omitted.

---

## Platform Rendering

- **Slack:** Displayed inside the task card within the turn plan, expandable on demand.
- **Discord & Mattermost:** Displayed as securely fenced markdown code blocks (`block()`) in the activity log, preventing payload backticks from breaking code block formatting.
- **Teams & Telegram:** Gracefully falls back to concise tool titles and outcome indicators.

---

## Access Control & Room Configuration

Tool detail visibility is **off by default** for new rooms. Only the **room owner** or a **workspace admin** (`can_manage`) may enable it:

1. **Via Gateway Web Dashboard:** In room settings, toggle **"Let people in this room open what each agent's tool calls were given and gave back"**.
2. **Via Gateway REST API:**
   ```http
   PATCH /api/rooms/{room_id}
   Content-Type: application/json

   {
     "show_tool_detail": true
   }
   ```
3. Non-breaking storage in room metadata (`metadata_`) ensures instant activation with zero risky database migrations or downtime.
