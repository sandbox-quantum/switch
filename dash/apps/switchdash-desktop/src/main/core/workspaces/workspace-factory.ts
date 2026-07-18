import { LocalAgentRuntime } from '@main/core/conversations/impl/local-agent-runtime';
import { SshAgentRuntime } from '@main/core/conversations/impl/ssh-agent-runtime';
import type { AgentRuntimeProvider } from '@main/core/conversations/types';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { LocalFileSystem } from '@main/core/fs/impl/local-fs';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { FileSystemProvider } from '@main/core/fs/types';
import { workspaceFileIndexService } from '@main/core/search/workspace-file-index-service';
import { preflightRemoteSession } from '@main/core/sessions/remote-session-preflight';
import { appSettingsService } from '@main/core/settings/settings-service';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { resolveLocalAutomationShellWithSystemFallback } from '@main/core/terminal-shell/resolver';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { LocalTerminalProvider } from '@main/core/terminals/impl/local-terminal-provider';
import { SshTerminalProvider } from '@main/core/terminals/impl/ssh-terminal-provider';
import { runLifecycleScriptWithPolicy } from '@main/core/terminals/lifecycle-script-coordinator';
import type { TerminalProvider } from '@main/core/terminals/terminal-provider';
import type { Workspace } from '@main/core/workspaces/workspace';
import { LifecycleScriptService } from '@main/core/workspaces/workspace-lifecycle-service';
import { type WorkspaceFactoryResult } from '@main/core/workspaces/workspace-registry';
import { log } from '@main/lib/logger';
import type { Session } from '@shared/core/sessions/sessions';
import { getEffectiveSessionSettings } from '../projects/settings/effective-session-settings';
import type { ProjectSettingsProvider } from '../projects/settings/provider';
import { TEARDOWN_SCRIPT_WAIT_MS } from '../sessions/provision-session-error';
import { getSessionEnvVars } from './workspace-env';

export type WorkspaceType =
  | { kind: 'local' }
  | { kind: 'ssh'; host: string; remoteRepoDir: string; connectionId: string };

type SshWorkspaceType = Extract<WorkspaceType, { kind: 'ssh' }>;

function connectSshWorkspace(type: SshWorkspaceType): Promise<SshClientProxy> {
  return ensureSshConnected(type.connectionId, type.host);
}

type WorkspaceFactoryContext = {
  session: Pick<Session, 'id' | 'title'>;
  workDir: string;
  projectId: string;
  projectPath: string;
  settings: ProjectSettingsProvider;
  logPrefix: string;
  extraHooks?: {
    onCreate?: (ws: Workspace) => Promise<void>;
    onDestroy?: (ws: Workspace) => Promise<void>;
    onDetach?: (ws: Workspace) => Promise<void>;
  };
};

/**
 * Returns a factory function suitable for passing to `WorkspaceRegistry.acquire`.
 * Handles all transport-specific construction (local vs SSH) and wires lifecycle
 * script hooks. Provider-specific hooks are passed via `extraHooks`.
 */
export function createWorkspaceFactory(
  workspaceId: string,
  _type: WorkspaceType,
  context: WorkspaceFactoryContext
): () => Promise<WorkspaceFactoryResult> {
  return async () => {
    const workDir = context.workDir;

    // Transport: local runs on this machine; ssh runs on the agent's host. The
    // SSH connection is established here (and reused by the session providers).
    let ctx: IExecutionContext;
    let workspaceFs: FileSystemProvider;
    if (_type.kind === 'ssh') {
      const proxy = await connectSshWorkspace(_type);
      ctx = new SshExecutionContext(proxy, { root: _type.remoteRepoDir });
      workspaceFs = new SshFileSystem(proxy, _type.remoteRepoDir);
    } else {
      ctx = new LocalExecutionContext();
      workspaceFs = new LocalFileSystem(workDir);
    }

    // Settings (shared)
    const projectSettings = await context.settings.get();
    const bootstrapSessionEnvVars = getSessionEnvVars({
      sessionId: context.session.id,
      sessionName: context.session.title,
      sessionPath: workDir,
      projectPath: context.projectPath,
      portSeed: workDir,
    });
    // Remote sessions require tmux — it is the persistence substrate the sidecar
    // injects into and reattaches to across UI disconnects.
    const tmuxEnabled = _type.kind === 'ssh' ? true : (projectSettings.tmux ?? false);
    const sessionLevelSettings = await getEffectiveSessionSettings({
      projectSettings: context.settings,
      sessionFs: workspaceFs,
    });
    const shellSetup = sessionLevelSettings.shellSetup ?? projectSettings.shellSetup;
    const scripts = sessionLevelSettings.scripts;

    // Workspace terminal provider (used only by lifecycle scripts)
    const terminalOpts = {
      projectId: context.projectId,
      workspaceId,
      scopeId: workspaceId,
      sessionPath: workDir,
      tmux: tmuxEnabled,
      shellSetup,
      ctx,
      sessionEnvVars: bootstrapSessionEnvVars,
    };
    const workspaceTerminals =
      _type.kind === 'ssh'
        ? new SshTerminalProvider({
            ...terminalOpts,
            proxy: await connectSshWorkspace(_type),
            connectionId: _type.connectionId,
          })
        : new LocalTerminalProvider(terminalOpts);

    const lifecycleService = new LifecycleScriptService({
      projectId: context.projectId,
      workspaceId,
      terminals: workspaceTerminals,
    });

    const workspace: Workspace = {
      id: workspaceId,
      path: workDir,
      fs: workspaceFs,
      settings: context.settings,
      lifecycleService,
    };

    const { logPrefix } = context;

    return {
      workspace,

      onCreateSideEffect: (ws) => {
        void workspaceFileIndexService.onWorkspaceCreated(workspaceId, ws);
        void (async () => {
          if (scripts?.setup && (projectSettings.autoRunSetupScriptOnSessionCreation ?? true)) {
            const setupResult = await runLifecycleScriptWithPolicy({
              workspace: ws,
              projectId: context.projectId,
              sessionId: context.session.id,
              workspaceId,
              type: 'setup',
              script: scripts.setup,
              shellSetup,
              origin: 'auto-setup',
              policy: {
                respawnAfterExit: true,
                logFailure: true,
                surfaceFailure: true,
                continueOnFailure: true,
              },
              logPrefix,
            });
            if (setupResult.kind !== 'succeeded') return;
          }

          if (scripts?.run && (projectSettings.autoRunRunScriptOnSessionCreation ?? false)) {
            await runLifecycleScriptWithPolicy({
              workspace: ws,
              projectId: context.projectId,
              sessionId: context.session.id,
              workspaceId,
              type: 'run',
              script: scripts.run,
              shellSetup,
              origin: 'auto-run',
              policy: {
                respawnAfterExit: true,
                logFailure: true,
                surfaceFailure: true,
                continueOnFailure: true,
              },
              logPrefix,
            });
          }
        })();
      },

      onCreate: context.extraHooks?.onCreate,

      onDestroy: async (ws) => {
        workspaceFileIndexService.onWorkspaceDestroyed(workspaceId);
        const latestSessionSettings = await getEffectiveSessionSettings({
          projectSettings: context.settings,
          sessionFs: ws.fs,
        });
        const latestProjectSettings = await context.settings.get();
        const latestShellSetup =
          latestSessionSettings.shellSetup ?? latestProjectSettings.shellSetup;
        const teardownScript = latestSessionSettings.scripts?.teardown;

        if (teardownScript) {
          await runLifecycleScriptWithPolicy({
            workspace: ws,
            projectId: context.projectId,
            sessionId: context.session.id,
            workspaceId,
            type: 'teardown',
            script: teardownScript,
            shellSetup: latestShellSetup,
            origin: 'workspace-destroy',
            policy: {
              timeoutMs: TEARDOWN_SCRIPT_WAIT_MS,
              logFailure: true,
              surfaceFailure: false,
              continueOnFailure: true,
            },
            logPrefix,
          });
        }
        await context.extraHooks?.onDestroy?.(ws);
      },

      onDetach: async (ws) => {
        await context.extraHooks?.onDetach?.(ws);
      },
    };
  };
}

type SessionProviderOpts = {
  projectId: string;
  sessionId: string;
  workspaceId: string;
  sessionPath: string;
  tmuxEnabled: boolean;
  shellSetup?: string;
  sessionEnvVars: Record<string, string>;
};

async function resolveLocalAgentShellProfile(sessionId: string): Promise<ResolvedShellProfile> {
  const { defaultShell } = await appSettingsService.get('terminal');
  return await resolveLocalAutomationShellWithSystemFallback({
    intent: defaultShell,
    onFallback: (error) => {
      log.warn('buildSessionProviders: preferred local agent shell unavailable, using fallback', {
        shell: error.shell,
        sessionId,
      });
    },
  });
}

/**
 * Creates the session-scoped agent runtime and terminal provider for the given
 * transport type. The exec function is derived internally from the WorkspaceType.
 */
export async function buildSessionProviders(
  _type: WorkspaceType,
  opts: SessionProviderOpts
): Promise<{ agent: AgentRuntimeProvider; terminals: TerminalProvider }> {
  if (_type.kind === 'ssh') {
    const proxy = await connectSshWorkspace(_type);
    const ctx = new SshExecutionContext(proxy, { root: _type.remoteRepoDir });
    const fs = new SshFileSystem(proxy, _type.remoteRepoDir);
    // Gate remote session start: fail loud now (missing tools / absent creds /
    // no egress to Switch) rather than spawning an agent that never connects.
    await preflightRemoteSession({ ctx, fs, log, host: _type.host, workDir: _type.remoteRepoDir });
    // Remote sessions always run under tmux — it persists the agent's PTY and
    // is the pane the sidecar injects into and reattaches to.
    return {
      agent: new SshAgentRuntime({
        projectId: opts.projectId,
        sessionPath: opts.sessionPath,
        sessionId: opts.sessionId,
        tmux: true,
        shellSetup: opts.shellSetup,
        ctx,
        fs,
        proxy,
        connectionId: _type.connectionId,
        sessionEnvVars: opts.sessionEnvVars,
      }),
      terminals: new SshTerminalProvider({
        projectId: opts.projectId,
        workspaceId: opts.workspaceId,
        scopeId: opts.sessionId,
        sessionPath: opts.sessionPath,
        tmux: true,
        shellSetup: opts.shellSetup,
        ctx,
        proxy,
        connectionId: _type.connectionId,
        sessionEnvVars: opts.sessionEnvVars,
      }),
    };
  }

  const ctx = new LocalExecutionContext();
  const agentShellProfile = await resolveLocalAgentShellProfile(opts.sessionId);
  return {
    agent: new LocalAgentRuntime({
      projectId: opts.projectId,
      sessionPath: opts.sessionPath,
      sessionId: opts.sessionId,
      tmux: opts.tmuxEnabled,
      shellSetup: opts.shellSetup,
      shellProfile: agentShellProfile,
      ctx,
      sessionEnvVars: opts.sessionEnvVars,
    }),
    terminals: new LocalTerminalProvider({
      projectId: opts.projectId,
      workspaceId: opts.workspaceId,
      scopeId: opts.sessionId,
      sessionPath: opts.sessionPath,
      tmux: opts.tmuxEnabled,
      shellSetup: opts.shellSetup,
      ctx,
      sessionEnvVars: opts.sessionEnvVars,
    }),
  };
}

/**
 * Resolves the session-level environment variables and settings from an already-acquired workspace.
 * Used by providers after `workspaceRegistry.acquire` to avoid duplicating settings reads.
 */
export async function resolveSessionEnv(
  session: Pick<Session, 'id' | 'title'>,
  workspace: Pick<Workspace, 'path' | 'fs'>,
  projectPath: string,
  settings: ProjectSettingsProvider
): Promise<{
  sessionEnvVars: Record<string, string>;
  tmuxEnabled: boolean;
  shellSetup?: string;
}> {
  const projectSettings = await settings.get();
  const sessionLevelSettings = await getEffectiveSessionSettings({
    projectSettings: settings,
    sessionFs: workspace.fs,
  });
  return {
    sessionEnvVars: getSessionEnvVars({
      sessionId: session.id,
      sessionName: session.title,
      sessionPath: workspace.path,
      projectPath,
      portSeed: workspace.path,
    }),
    tmuxEnabled: projectSettings.tmux ?? false,
    shellSetup: sessionLevelSettings.shellSetup ?? projectSettings.shellSetup,
  };
}
