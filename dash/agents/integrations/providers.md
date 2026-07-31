# Providers

## Source Of Truth

- `packages/plugins/src/agents/impl/<id>/index.ts` — the provider plugin. Authoritative for
  everything behavioral.
- `src/shared/core/providers/agent-provider-registry.ts` — ids, display metadata, and a
  descriptive mirror of the plugin's argv. Never authoritative.
- `src/main/core/dependencies/registry.ts`
- `src/main/core/pty/`

## Current Providers (31)

codex, claude, grok, devin, cursor, gemini, antigravity, qwen, droid, amp, commandcode, opencode, hermes, copilot, charm, auggie, goose, kimi, kilocode, kiro, rovo, cline, continue, codebuff, freebuff, mistral, jules, junie, pi, letta, autohand

## Where Provider Metadata Lives

The plugin (`packages/plugins/src/agents/impl/<id>/index.ts`) owns everything that affects
behavior:

- argv shaping — auto-approve flags, initial prompt handling, resume and session flags,
  default args — via the `buildStandardCommand` spec in `behavior.prompt.buildCommand`
- CLI name, detection commands, and version args — via `hostDependency`
- prompt delivery mode, including keystroke injection — via `capabilities.prompt.kind`
- hook support — via `capabilities.hooks`
- the provider icon — via the plugin's `icon` asset

`agent-provider-registry.ts` holds the `AGENT_PROVIDER_IDS` list, per-provider display
metadata (name, one-line description, docs URL, icon, install command), and a mirror of the
argv fields above. It builds no commands and nothing reads the mirror at spawn time — it
exists so the provider table can be read in one place. Change the plugin first, then the
mirror. `src/main/core/providers/provider-argv-parity.test.ts` fails if Codex's two drift
apart; the other providers' mirrors are unguarded, so treat them as hints, not facts.

## Agent Hooks And Notifications

Agent activity, completion, and attention notifications come from explicit hooks or plugins
installed by `src/main/core/agent-hooks/`. Switchdash does not infer agent status from terminal
output. If a provider has no hook/plugin integration for an event, the renderer should not show
or notify an inferred status for that event.

## Provider Runtime Notes

- Claude uses deterministic `--session-id` values for conversation isolation.
- Agents that cannot receive an interactive initial prompt via argv or stdin use keystroke
  injection — Switchdash types the prompt into the TUI after startup.
- `src/main/core/agent-hooks/agent-hook-service.ts` forwards hook events to renderer windows and can show OS notifications. It also writes hook config files for hook-capable providers, including `.claude/settings.local.json`, `.qwen/settings.json`, and provider-specific global hook files.
- Qwen Code hooks use the documented Qwen settings schema in `.qwen/settings.json`. Switchdash installs command hooks for permission requests and session end/stop events while preserving unrelated user hooks.

## Adding Or Changing A Provider

1. add or update the plugin in `packages/plugins/src/agents/impl/<id>/index.ts` — this is where
   argv, dependencies, capabilities, and hooks are defined
2. for a new provider only, add the id to `AGENT_PROVIDER_IDS` and a display entry to
   `AGENT_PROVIDERS` in `src/shared/core/providers/agent-provider-registry.ts`
   (`plugin-registry.ts` fails at load if the id list and the plugins disagree)
3. update allowlisted agent env vars in `src/main/core/pty/pty-env.ts` if needed
4. validate detection behavior in `src/main/core/dependencies/`
5. add or update tests for any non-standard behavior
