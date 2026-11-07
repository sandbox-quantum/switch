import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

const CLINE_LOGIN = 'cline auth';

/** Cline CLI running over the Agent Client Protocol. */
export const clineAcp: AcpProviderHooks = {
  provider: 'cline',
  label: 'Cline CLI',
  defaultBinary: 'cline',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: async ({ binaryPath, env, mcpServers = {} }) => {
    const tempDir = await mkdtemp(join(tmpdir(), 'switch-cline-'));
    await chmod(tempDir, 0o700);
    const settingsPath = join(tempDir, 'cline_mcp_settings.json');

    const settings = {
      mcpServers: Object.fromEntries(
        Object.entries(mcpServers).map(([name, spec]) => [
          name,
          spec.transport === 'http'
            ? {
                type: 'streamableHttp',
                url: spec.url,
                headers: spec.headers ?? {},
                disabled: false,
                autoApprove: [],
              }
            : {
                // Cline's docs format for stdio MCP servers (command, args, env); not yet verified against the real CLI.
                command: spec.command,
                args: spec.args ?? [],
                env: {
                  ...Object.fromEntries(
                    (spec.envVars ?? [])
                      .filter((key) => env[key] !== undefined)
                      .map((key) => [key, env[key]])
                  ),
                  ...spec.env,
                },
                disabled: false,
                autoApprove: [],
              },
        ])
      ),
    };

    await writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

    return {
      command: binaryPath,
      args: ['--acp'],
      env: {
        ...env,
        CLINE_MCP_SETTINGS_PATH: settingsPath,
        CLINE_SESSION_BACKEND_MODE: 'local',
      },
      mcpServersInLaunch: true,
      release: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  },
  loginCommand: CLINE_LOGIN,
  checkSignIn: async ({ env }) => {
    const home = env.HOME || env.USERPROFILE;
    if (!home) return readiness('unauthenticated', signInWith(CLINE_LOGIN));
    const providersPath = join(home, '.cline', 'data', 'settings', 'providers.json');
    try {
      const fileStat = await stat(providersPath);
      if (fileStat.isFile() && fileStat.size > 0) {
        return readiness('authenticated', 'Signed in.');
      }
    } catch {
      // File missing or inaccessible
    }
    return readiness('unauthenticated', signInWith(CLINE_LOGIN));
  },
  sessionMode: () => 'act',
};

export function createClineAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(clineAcp, options);
}
