import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { appSettingsService } from '@main/core/settings/settings-service';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { resolveRemoteHome } from '@main/core/ssh/lifecycle/remote-shell-profile';
import { getGitExecutable } from '@main/core/utils/exec';
import { buildExternalToolEnv } from '@main/utils/childProcessEnv';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  agentTemplateRoomDocument,
  cloneDirectory,
  composeAgentTemplateDocument,
  firstFreeDirectory,
  parseAgentTemplate,
  type ParsedAgentTemplate,
} from './agent-template-format';
import {
  type FormOptions,
  formOptions,
  serverDocument,
  parseTemplateAgents,
  substituteAgentSlots,
  type TemplateAgents,
  templateKind,
  type TemplateKind,
} from './template-document';
import { summarizeTemplate, type TemplateSummary } from './template-summary';

export type { AgentTemplateSource, ParsedAgentTemplate } from './agent-template-format';
export type {
  FormOptions,
  ParsedAgentEntry,
  TemplateAgents,
  TemplateKind,
} from './template-document';
export type { TemplateEntity, TemplateSummary } from './template-summary';

const execFileAsync = promisify(execFile);

// Only URL forms git can clone. A value starting with `-` would be read by
// git as a command-line option, not a URL.
const CLONEABLE_URL = /^(https?:\/\/|git@|ssh:\/\/)[^\s-]/;

export type PrepareWorkspaceResult = {
  dir: string;
  /** The outcome of the clone, when the template has a `repo` field. */
  repo: {
    target: string;
    outcome: 'cloned' | 'present' | 'failed';
    error: string | null;
  } | null;
};

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function remoteContext(sshHost: string): Promise<IExecutionContext> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  return new SshExecutionContext(proxy);
}

// On a host, agents get the same one-folder-per-agent layout as on this
// machine, under the host's home. The Console's default on this machine is
// `~/.switch/agents`.
const REMOTE_LOCATIONS_DIR = '.switch/agents';

function failedRepo(dir: string, target: string, e: unknown): PrepareWorkspaceResult {
  const stderr = (e as { stderr?: string }).stderr;
  const message =
    typeof stderr === 'string' && stderr.trim().length > 0
      ? stderr.trim()
      : e instanceof Error
        ? e.message
        : String(e);
  return { dir, repo: { target, outcome: 'failed', error: message } };
}

/** Make the directory and put a shallow clone inside, on a host reached over SSH. */
async function prepareRemoteWorkspace(
  sshHost: string,
  dir: string,
  repoUrl: string | null
): Promise<PrepareWorkspaceResult> {
  const ctx = await remoteContext(sshHost);
  try {
    await ctx.exec('mkdir', ['-p', dir]);
    if (!repoUrl) return { dir, repo: null };
    const target = cloneDirectory(dir, repoUrl);
    const probe = await ctx.exec('sh', [
      '-c',
      `test -d "$1" && echo present || echo absent`,
      'sh',
      target,
    ]);
    if (probe.stdout.trim() === 'present') {
      return { dir, repo: { target, outcome: 'present', error: null } };
    }
    if (!CLONEABLE_URL.test(repoUrl)) {
      return {
        dir,
        repo: {
          target,
          outcome: 'failed',
          error: `Not a URL git can clone: ${repoUrl}`,
        },
      };
    }
    try {
      await ctx.exec('git', ['clone', '--quiet', '--depth', '1', '--', repoUrl, target]);
      return { dir, repo: { target, outcome: 'cloned', error: null } };
    } catch (e) {
      return failedRepo(dir, target, e);
    }
  } finally {
    ctx.dispose();
  }
}

export const agentTemplatesController = createRPCController({
  parse: (params: { yamlText: string; instructions?: string | null }): ParsedAgentTemplate =>
    parseAgentTemplate(params.yamlText, params.instructions ?? null),

  roomDocument: (params: { yamlText: string }): string | null =>
    agentTemplateRoomDocument(params.yamlText),

  /** What a document of any known shape creates, for a listing card. */
  summarize: (params: { yamlText: string }): TemplateSummary => summarizeTemplate(params.yamlText),

  /** Classify a document as an agent, room or group template. */
  kind: (params: { yamlText: string }): TemplateKind => templateKind(params.yamlText),

  /** The agents a document creates. Empty for a room template. */
  parseAgents: (params: { yamlText: string; instructions?: string | null }): TemplateAgents =>
    parseTemplateAgents(params.yamlText, params.instructions ?? null),

  /** The layout choices the document's `form:` block makes for the Use page. */
  form: (params: { yamlText: string }): FormOptions => formOptions(params.yamlText),

  /** The room part of a document as the server receives it, or null when the document has no rooms. */
  serverDocument: (params: { yamlText: string; keepConsoleParams?: boolean }): string | null =>
    serverDocument(params.yamlText, { keepConsoleParams: params.keepConsoleParams }),

  /** The server document with agent names replaced (see `substituteAgentSlots`). */
  substituteSlots: (params: { coreYaml: string; replacements: Record<string, string> }): string =>
    substituteAgentSlots(params.coreYaml, params.replacements),

  /** The document with every agent's instructions inlined, ready to store on a server. */
  compose: (params: { yamlText: string; instructions: string }): string =>
    composeAgentTemplateDocument(params.yamlText, params.instructions),

  /** The directory agents are kept under, on this machine or on `sshHost`:
   * the `{$agents_dir}` a template's `directory` field may refer to. */
  agentsDirectory: async (params: { sshHost?: string | null }): Promise<string> => {
    if (params.sshHost) {
      const ctx = await remoteContext(params.sshHost);
      try {
        const home = await resolveRemoteHome(ctx);
        return `${home.replace(/\/+$/, '')}/${REMOTE_LOCATIONS_DIR}`;
      } finally {
        ctx.dispose();
      }
    }
    const { defaultLocationsDirectory } = await appSettingsService.get('localLocation');
    return defaultLocationsDirectory;
  },

  /** The default working directory for an agent of this name: a folder named
   * after it under the Console's locations directory, or under the host's
   * home when `sshHost` is given. */
  suggestDirectory: async (params: {
    agentName: string;
    sshHost?: string | null;
  }): Promise<string> => {
    if (params.sshHost) {
      const ctx = await remoteContext(params.sshHost);
      try {
        const home = await resolveRemoteHome(ctx);
        const base = `${home.replace(/\/+$/, '')}/${REMOTE_LOCATIONS_DIR}/${params.agentName}`;
        // `return await`, not `return`: with a bare `return` the `finally`
        // below would dispose the SSH context before the probes finished.
        return await firstFreeDirectory(base, async (dir) => {
          // Both outcomes exit 0. The runner treats a non-zero exit as a
          // failed command, and "free" is an answer, not a failure.
          const probe = await ctx.exec('sh', [
            '-c',
            'test -e "$1/.switch" && echo taken || echo free',
            'sh',
            dir,
          ]);
          return probe.stdout.trim() === 'taken';
        });
      } finally {
        ctx.dispose();
      }
    }
    const { defaultLocationsDirectory } = await appSettingsService.get('localLocation');
    return firstFreeDirectory(join(defaultLocationsDirectory, params.agentName), (dir) =>
      isDirectory(join(dir, '.switch'))
    );
  },

  /**
   * Create the working directory and, when the template has a `repo` field,
   * put a shallow clone of it inside. A failed clone is reported in the
   * result rather than thrown, so the agent is still created and clones the
   * repository itself.
   */
  prepareWorkspace: async (params: {
    dir: string;
    repoUrl: string | null;
    sshHost?: string | null;
  }): Promise<PrepareWorkspaceResult> => {
    if (params.sshHost) return prepareRemoteWorkspace(params.sshHost, params.dir, params.repoUrl);
    await mkdir(params.dir, { recursive: true });
    if (!params.repoUrl) return { dir: params.dir, repo: null };
    const target = cloneDirectory(params.dir, params.repoUrl);
    if (await isDirectory(target)) {
      return {
        dir: params.dir,
        repo: { target, outcome: 'present', error: null },
      };
    }
    if (!CLONEABLE_URL.test(params.repoUrl)) {
      return {
        dir: params.dir,
        repo: {
          target,
          outcome: 'failed',
          error: `Not a URL git can clone: ${params.repoUrl}`,
        },
      };
    }
    try {
      await execFileAsync(
        getGitExecutable(),
        ['clone', '--quiet', '--depth', '1', '--', params.repoUrl, target],
        { env: buildExternalToolEnv(), timeout: 5 * 60 * 1000 }
      );
      return {
        dir: params.dir,
        repo: { target, outcome: 'cloned', error: null },
      };
    } catch (e) {
      return failedRepo(params.dir, target, e);
    }
  },
});
