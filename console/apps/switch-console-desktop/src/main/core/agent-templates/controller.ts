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
  cloneTargetFor,
  composeAgentTemplateDocument,
  firstFreeDirectory,
  parseAgentTemplate,
  type ParsedAgentTemplate,
} from './agent-template-format';
import {
  coreDocumentFor,
  dropUnsetParams,
  parseTemplateAgents,
  substituteAgentSlots,
  type TemplateAgents,
  templateKind,
  type TemplateKind,
} from './template-document';
import { summarizeTemplate, type TemplateSummary } from './template-summary';

export type { AgentTemplateSource, ParsedAgentTemplate } from './agent-template-format';
export type { ParsedAgentEntry, TemplateAgents, TemplateKind } from './template-document';
export type { CreatedThing, TemplateSummary } from './template-summary';

const execFileAsync = promisify(execFile);

// Only URL forms git can clone without also reading them as options: a value
// starting with `-` would otherwise be parsed as a flag.
const CLONEABLE_URL = /^(https?:\/\/|git@|ssh:\/\/)[^\s-]/;

export type PrepareWorkspaceResult = {
  dir: string;
  /** What happened to the repository, when the template names one. */
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

// The same folder-per-agent layout as this machine, under the host's home:
// the Console's default locations directory is `~/switchdash/repositories`.
const REMOTE_LOCATIONS_DIR = 'switchdash/repositories';

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
    const target = cloneTargetFor(dir, repoUrl);
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

  /** Which page a document opens on: agent, room, or group. */
  kind: (params: { yamlText: string }): TemplateKind => templateKind(params.yamlText),

  /** Every agent the Console would create for a document (none for a room template). */
  parseAgents: (params: { yamlText: string; instructions?: string | null }): TemplateAgents =>
    parseTemplateAgents(params.yamlText, params.instructions ?? null),

  /** The server's half of a document, or null when there is none. */
  coreDocument: (params: { yamlText: string; keepConsoleParams?: boolean }): string | null =>
    coreDocumentFor(params.yamlText, { keepConsoleParams: params.keepConsoleParams }),

  /** The server's half without params the person left unset (a bridge, for the default app). */
  dropParams: (params: { coreYaml: string; names: string[] }): string =>
    dropUnsetParams(params.coreYaml, params.names),

  /** The server's half with agent slots renamed (an existing agent, or a taken name). */
  substituteSlots: (params: { coreYaml: string; replacements: Record<string, string> }): string =>
    substituteAgentSlots(params.coreYaml, params.replacements),

  /** The document with its persona inlined, ready to store on a server. */
  compose: (params: { yamlText: string; instructions: string }): string =>
    composeAgentTemplateDocument(params.yamlText, params.instructions),

  /** Where an agent of this name would live by default: the same directory
   * the rest of the Console's locations default to, one folder per agent. On
   * a host, the same layout under the host's home. */
  suggestDirectory: async (params: {
    agentName: string;
    sshHost?: string | null;
  }): Promise<string> => {
    if (params.sshHost) {
      const ctx = await remoteContext(params.sshHost);
      try {
        const home = await resolveRemoteHome(ctx);
        const base = `${home.replace(/\/+$/, '')}/${REMOTE_LOCATIONS_DIR}/${params.agentName}`;
        // `await` matters: a bare `return` would run the `finally` (and
        // dispose the context) before the probes had finished.
        return await firstFreeDirectory(base, async (dir) => {
          // Both branches exit 0: a non-zero exit is a failed command to the
          // runner, and "free" is not a failure.
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
   * Make the working directory exist and, when the template names a
   * repository, put a shallow clone of it inside. Cloning is best effort: the
   * agent's instructions tell it to clone for itself if the clone is missing,
   * so a failure here is reported, not thrown.
   */
  prepareWorkspace: async (params: {
    dir: string;
    repoUrl: string | null;
    sshHost?: string | null;
  }): Promise<PrepareWorkspaceResult> => {
    if (params.sshHost) return prepareRemoteWorkspace(params.sshHost, params.dir, params.repoUrl);
    await mkdir(params.dir, { recursive: true });
    if (!params.repoUrl) return { dir: params.dir, repo: null };
    const target = cloneTargetFor(params.dir, params.repoUrl);
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
