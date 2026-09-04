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

/** Remove a credentials file written by {@link writeAgentCredentials}. */
export async function removeAgentCredentials(params: {
  workingDir: string;
  agentName: string;
}): Promise<void> {
  const file = path.join(params.workingDir, '.switch', 'agents', `${params.agentName}.json`);
  await fs.rm(file, { force: true });
}
