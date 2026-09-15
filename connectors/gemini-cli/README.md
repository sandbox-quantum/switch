# Gemini CLI in Switch Console

This directory supplies the Switch room workflow embedded in Console's Gemini
ACP sessions. It is not a standalone Gemini extension or plugin installer.

Sign in with `gemini`, create a local Gemini agent in Switch Console, and enable
**Drive through Gemini CLI ACP** in its advanced settings. Console supplies the
Switch MCP server, instructions, isolated settings and session storage. Gemini
login files stay outside the project directory.

The runtime supports streaming replies, tool activity, approvals, cancellation
and resume. Answer clarifying questions in the conversation: Gemini ACP does
not expose structured `ask_user` answers. Additional turns queue while a turn
is running. Remote/SSH sessions and experimental subagent support are not part
of this integration.

Verified against Gemini CLI 0.58.0. Console preserves the isolated rollout under
an alternate filename before loading on that version: its ACP loader otherwise
resets saved history when resumed within the same minute. Other versions use
the native loader directly.
