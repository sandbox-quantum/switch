import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import util from 'node:util';
import { parseDocument } from 'yaml';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const DSH_LOGIN = 'dsh web';
const SETUP = `${signInWith(DSH_LOGIN)} Configure the ACP profile's DeepSeek API key in Models, or set DEEPSEEK_API_KEY on the execution machine.`;

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** DSH's ACP bridge normalizes server names before qualifying MCP tool names. */
function mcpNamespace(name: string): string {
  if (/^[A-Za-z0-9_-]{1,32}$/.test(name)) return name;
  const slug =
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'server';
  return `${slug}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

/** The official automation profile; no interactive authentication RPC is needed. */
export const deepseekHarnessAcp: AcpProviderHooks = {
  provider: 'deepseek-harness',
  label: 'DeepSeek Harness',
  defaultBinary: 'dsh',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--profile', 'acp'],
    env,
  }),
  loginCommand: DSH_LOGIN,
  inheritEnv: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED'],
  checkSignIn: async ({ env, cwd, handshake }) => {
    // ACP always returns authMethods: []; it says nothing about model credentials.
    // Inspect the shipped profile's credential layers without running a prompt,
    // authenticate, or the web UI. Custom provider routes cannot be inferred here.
    try {
      const userHome = env.HOME || env.USERPROFILE || homedir();
      const selectedHome = env.DSH_HOME?.trim() ? env.DSH_HOME : join(userHome, '.dsh');
      const home = resolve(
        cwd,
        selectedHome === '~'
          ? userHome
          : /^~[/\\]/.test(selectedHome)
            ? join(userHome, selectedHome.slice(2))
            : selectedHome
      );
      const filename = join(home, '.credentials.yaml');
      const text = await optionalFile(filename);
      let stored: unknown;
      let hasOtherCredentials = false;
      if (text !== undefined) {
        if (process.platform !== 'win32' && ((await stat(filename)).mode & 0o077) !== 0)
          return readiness(
            'unknown',
            `DSH credentials must be readable only by their owner. ${SETUP}`
          );
        const document = parseDocument(text);
        if (document.errors.length)
          return readiness('unknown', `DSH credentials are invalid. ${SETUP}`);
        const data: unknown = document.toJS() ?? {};
        const mapping = (value: unknown): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value);
        if (!mapping(data) || (Object.keys(data).length && data.version !== 1))
          return readiness('unknown', `DSH credential format is not supported. ${SETUP}`);
        if (
          (data.refs !== undefined &&
            data.refs !== null &&
            (!mapping(data.refs) ||
              Object.entries(data.refs).some(
                ([ref, value]) =>
                  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) ||
                  typeof value !== 'string' ||
                  value.length === 0
              ))) ||
          (data.records !== undefined && data.records !== null && !mapping(data.records))
        )
          return readiness('unknown', `DSH credentials are invalid. ${SETUP}`);
        stored = mapping(data.refs) ? data.refs.DEEPSEEK_API_KEY : undefined;
        hasOtherCredentials =
          (mapping(data.records) && Object.keys(data.records).length > 0) ||
          (mapping(data.refs) && Object.keys(data.refs).some((ref) => ref !== 'DEEPSEEK_API_KEY'));
      }
      // Access at check time so hosts without parseEnv can still load other providers.
      const projectEnv = util.parseEnv((await optionalFile(join(cwd, '.env'))) ?? '');
      const homeEnv = util.parseEnv((await optionalFile(join(home, '.env'))) ?? '');
      const key =
        stored ?? env.DEEPSEEK_API_KEY ?? projectEnv.DEEPSEEK_API_KEY ?? homeEnv.DEEPSEEK_API_KEY;
      if (typeof key !== 'string' || !key.trim())
        return readiness(hasOtherCredentials ? 'unknown' : 'unauthenticated', SETUP);
      await handshake();
      return readiness(
        'authenticated',
        'DeepSeek API key configured; validity is checked on the first model request.'
      );
    } catch {
      // Never include credential contents or provider output in a status message.
      return readiness('unknown', `Could not verify DeepSeek Harness setup. ${SETUP}`);
    }
  },
  // DSH reports every native tool as kind: "other", with the tool name as title.
  itemType: ({ title }) => {
    if (title === 'bash' || title === 'pwsh') return 'command_execution';
    if (title === 'write' || title === 'edit' || title === 'apply_patch') return 'file_change';
    return undefined;
  },
  mcpServerOf: ({ title }, serverNames) => {
    // A permission request contains only the call id. The adapter remembers
    // the server from the preceding tool update. Ambiguous names fail closed.
    const matches = [...serverNames].filter((name) =>
      title?.startsWith(`mcp__${mcpNamespace(name)}__`)
    );
    return matches.length === 1 ? matches[0] : undefined;
  },
};

export function createDeepseekHarnessAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(deepseekHarnessAcp, options);
}
