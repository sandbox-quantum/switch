import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appSettingsService } from '@main/core/settings/settings-service';
import { getGitExecutable } from '@main/core/utils/exec';
import { buildExternalToolEnv } from '@main/utils/childProcessEnv';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  agentTemplateRoomDocument,
  cloneTargetFor,
  composeAgentTemplateDocument,
  parseAgentTemplate,
  type ParsedAgentTemplate,
} from './agent-template-format';

export type { AgentTemplateSource, ParsedAgentTemplate } from './agent-template-format';

const execFileAsync = promisify(execFile);

// Only URL forms git can clone without also reading them as options: a value
// starting with `-` would otherwise be parsed as a flag.
const CLONEABLE_URL = /^(https?:\/\/|git@|ssh:\/\/)[^\s-]/;

export type PrepareWorkspaceResult = {
  dir: string;
  /** What happened to the repository, when the template names one. */
  repo: { target: string; outcome: 'cloned' | 'present' | 'failed'; error: string | null } | null;
};

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export const agentTemplatesController = createRPCController({
  parse: (params: { yamlText: string; instructions?: string | null }): ParsedAgentTemplate =>
    parseAgentTemplate(params.yamlText, params.instructions ?? null),

  roomDocument: (params: { yamlText: string }): string | null =>
    agentTemplateRoomDocument(params.yamlText),

  /** The document with its persona inlined, ready to store on a server. */
  compose: (params: { yamlText: string; instructions: string }): string =>
    composeAgentTemplateDocument(params.yamlText, params.instructions),

  /** Where an agent of this name would live by default: the same directory
   * the rest of the Console's locations default to, one folder per agent. */
  suggestDirectory: async (params: { agentName: string }): Promise<string> => {
    const { defaultLocationsDirectory } = await appSettingsService.get('localLocation');
    return join(defaultLocationsDirectory, params.agentName);
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
  }): Promise<PrepareWorkspaceResult> => {
    await mkdir(params.dir, { recursive: true });
    if (!params.repoUrl) return { dir: params.dir, repo: null };
    const target = cloneTargetFor(params.dir, params.repoUrl);
    if (await isDirectory(target)) {
      return { dir: params.dir, repo: { target, outcome: 'present', error: null } };
    }
    if (!CLONEABLE_URL.test(params.repoUrl)) {
      return {
        dir: params.dir,
        repo: { target, outcome: 'failed', error: `Not a URL git can clone: ${params.repoUrl}` },
      };
    }
    try {
      await execFileAsync(
        getGitExecutable(),
        ['clone', '--quiet', '--depth', '1', '--', params.repoUrl, target],
        { env: buildExternalToolEnv(), timeout: 5 * 60 * 1000 }
      );
      return { dir: params.dir, repo: { target, outcome: 'cloned', error: null } };
    } catch (e) {
      const stderr = (e as { stderr?: string }).stderr;
      const message =
        typeof stderr === 'string' && stderr.trim().length > 0
          ? stderr.trim()
          : e instanceof Error
            ? e.message
            : String(e);
      return { dir: params.dir, repo: { target, outcome: 'failed', error: message } };
    }
  },
});
