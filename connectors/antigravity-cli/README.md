# Antigravity CLI in Switch Console

This directory supplies the Switch room workflow embedded in Console's
Antigravity CLI sessions. It is not a standalone Antigravity extension or plugin
installer.

Sign in with `agy`, create a local Antigravity agent in Switch Console, and
enable the **Antigravity CLI runtime** in its advanced settings. Console runs
`agy --input-format stream-json --output-format stream-json` and supplies the
Switch MCP server, instructions and session storage. Antigravity reads its MCP
servers from `~/.gemini/config/mcp_config.json`.

The runtime supports streaming replies, tool activity, cancellation and resume.
Headless Antigravity cannot prompt: approval requests are auto-denied and
clarifying questions are skipped, so ask in the room instead of waiting for an
answer the CLI will never surface. Interrupting restarts the process and resumes
from the conversation id, so the reply to an interrupted turn arrives in a fresh
process. Additional turns queue while a turn is running. Remote/SSH sessions are
not part of this integration.

Verified against Antigravity CLI 1.2.4.
