import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredAgent } from './switch-client.ts';

/**
 * Write the harness's throwaway agent into a working directory the way Switch
 * Console does, so a session started there authenticates as that agent.
 *
 * This mirrors `writeNeutralAgentSettingsFs` in
 * `console/apps/switch-console-desktop/src/main/core/agents/write-switch-settings.ts`
 * — deliberately a small copy rather than an import, because this package must
 * not depend on the Electron app's main-process tree.
 *
 * The layout it must match exactly (see `switch-settings-paths.ts`):
 *
 * - `<workingDir>/.switch/agents/<slug>.json` — the per-agent credential, the
 *   only file that carries `SWITCH_API_TOKEN`. `slug` is the **agent name**,
 *   which is also how the console keys credentials: an agent is found by name
 *   *within a working directory*, so the same name in a different directory is a
 *   different provisioning, and a session started in the wrong directory finds
 *   nothing.
 * - `<workingDir>/.switch/agents/.gitignore` containing `*` — written first,
 *   before the token reaches disk.
 *
 * The credential lives under an `env` key because the console injects that
 * object as process environment at launch, and the agent runtime falls back to
 * reading the same file.
 */
export async function writeAgentCredentials(params: {
  workingDir: string;
  agent: RegisteredAgent;
  apiEndpoint: string;
}): Promise<string> {
  const dir = path.join(params.workingDir, '.switch', 'agents');
  await fs.mkdir(dir, { recursive: true });

  const gitignore = path.join(dir, '.gitignore');
  try {
    await fs.access(gitignore);
  } catch {
    await fs.writeFile(gitignore, '*\n', 'utf8');
  }

  const file = path.join(dir, `${params.agent.name}.json`);
  const content = {
    env: {
      SWITCH_API_ENDPOINT: params.apiEndpoint,
      SWITCH_AGENT_ID: params.agent.id,
      SWITCH_API_TOKEN: params.agent.apiKey,
    },
  };
  await fs.writeFile(file, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Provision a Claude Code agent's on-disk definition and its committed config,
 * the way Switch Console does when the agent is added through the app.
 *
 * A Claude agent is launched as a **named definition** — `--agent <name>` for a
 * PTY session, the SDK's `agent` option for a provider-backed one — and Claude
 * Code fails a session naming an agent it cannot find, so the definition has to
 * exist before the console starts one. Two files, mirroring
 * `syncAgentConfig` in `src/main/core/agents/agent-config-sync.ts`:
 *
 * - `<workingDir>/.claude/agents/<name>.md` — the definition Claude reads. Its
 *   frontmatter is what `serializeDefinition` writes (name, description, then
 *   the advanced fields that are set), and its body is the system prompt.
 * - `<workingDir>/.switch/config/<name>.json` — the committed, secret-free
 *   config the definition is generated from, which is also where the console
 *   reads the agent's model and reasoning effort at launch.
 *
 * The `rendered` fingerprint the console records is deliberately omitted: with
 * no fingerprint the console treats a hand-written definition as hand-edited and
 * reads it back rather than overwriting it, which is what a harness wants.
 */
export async function writeClaudeAgentDefinition(params: {
  workingDir: string;
  agentName: string;
  description: string;
  instructions: string;
  model: string;
  effort: string;
}): Promise<{ definitionPath: string; configPath: string }> {
  const definitionDir = path.join(params.workingDir, '.claude', 'agents');
  await fs.mkdir(definitionDir, { recursive: true });
  const definitionPath = path.join(definitionDir, `${params.agentName}.md`);
  const definition = [
    '---',
    `name: ${params.agentName}`,
    `description: ${params.description.replace(/\s+/g, ' ')}`,
    `model: ${params.model}`,
    `effort: ${params.effort}`,
    '---',
    '',
    params.instructions,
    '',
  ].join('\n');
  await fs.writeFile(definitionPath, definition, 'utf8');

  const configDir = path.join(params.workingDir, '.switch', 'config');
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, `${params.agentName}.json`);
  const config = {
    instructions: params.instructions,
    settings: { model: params.model, effort: params.effort },
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return { definitionPath, configPath };
}

/** Remove the two files written by {@link writeClaudeAgentDefinition}. */
export async function removeClaudeAgentDefinition(params: {
  workingDir: string;
  agentName: string;
}): Promise<void> {
  await fs.rm(path.join(params.workingDir, '.claude', 'agents', `${params.agentName}.md`), {
    force: true,
  });
  await fs.rm(path.join(params.workingDir, '.switch', 'config', `${params.agentName}.json`), {
    force: true,
  });
}

/** Remove a credentials file written by {@link writeAgentCredentials}. */
export async function removeAgentCredentials(params: {
  workingDir: string;
  agentName: string;
}): Promise<void> {
  const file = path.join(params.workingDir, '.switch', 'agents', `${params.agentName}.json`);
  await fs.rm(file, { force: true });
}
