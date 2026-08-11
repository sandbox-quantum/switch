# Risky Area: PTY And Sessions

## Main Files

- `src/main/core/pty/` — `local-pty.ts`, `pty.ts`, `pty-env.ts`, `pty-session-registry.ts`, `pty-spawn-platform.ts`, `exit-signals.ts`, `exit-classification.ts`, `controller.ts`
- `src/main/core/terminals/` — terminal lifecycle, local terminal provider (`impl/local-terminal-provider.ts`)
- `src/main/core/agent-hooks/` — hook server, event enrichment, OS notifications, hook config writer

## Core Risks

- PTY cleanup and exit handling
- resize behavior
- shell quoting and Windows command wrapping
- tmux lifecycle
- provider-specific resume/session behavior
- env passthrough safety

## Rules

- use the allowlisted env passthrough model in `src/main/core/pty/pty-env.ts`
- do not weaken quoting or spawn behavior casually
- validate both direct spawn and shell-wrapped spawn cases when changing PTY startup logic
- confirm renderer event flow if hook/plugin payload or notification behavior changes
