import { LocalAgentRuntime } from '@main/core/agent-runtime/impl/local-agent-runtime';
import { SshAgentRuntime } from '@main/core/agent-runtime/impl/ssh-agent-runtime';
import type { AgentRuntimeProvider } from '@main/core/agent-runtime/types';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { LocalFileSystem } from '@main/core/fs/impl/local-fs';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { FileSystemProvider } from '@main/core/fs/types';
import { LifecycleScriptService } from '@main/core/locations/lifecycle-service';
import type { LocationRuntime } from '@main/core/locations/location-runtime';
import { type LocationRuntimeFactoryResult } from '@main/core/locations/location-runtime-registry';
import { locationFileIndexService } from '@main/core/search/location-file-index-service';
import { preflightRemoteSession } from '@main/core/sessions/remote-session-preflight';
import { appSettingsService } from '@main/core/settings/settings-service';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { resolveLocalAutomationShellWithSystemFallback } from '@main/core/terminal-shell/resolver';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { LocalTerminalProvider } from '@main/core/terminals/impl/local-terminal-provider';
import { SshTerminalProvider } from '@main/core/terminals/impl/ssh-terminal-provider';
import { runLifecycleScriptWithPolicy } from '@main/core/terminals/lifecycle-script-coordinator';
import { log } from '@main/lib/logger';
import type { Session } from '@shared/core/sessions/sessions';
import { getEffectiveSessionSettings } from '../locations/settings/effective-session-settings';
import type { LocationSettingsProvider } from '../locations/settings/provider';
import { TEARDOWN_SCRIPT_WAIT_MS } from '../sessions/provision-session-error';
import type { LocationTransport } from './location-transport';
import { getSessionEnvVars } from './session-env';

type SshTransport = Extract<LocationTransport, { kind: 'ssh' }>;

function connectSshTransport(transport: SshTransport): Promise<SshClientProxy> {
  return ensureSshConnected(transport.connectionId, transport.host);
}

type LocationRuntimeFactoryContext = {
  session: Pick<Session, 'id' | 'title'>;
  workDir: string;
  settings: LocationSettingsProvider;
  logPrefix: string;
  extraHooks?: {
    onCreate?: (runtime: LocationRuntime) => Promise<void>;
    onDestroy?: (runtime: LocationRuntime) => Promise<void>;
    onDetach?: (runtime: LocationRuntime) => Promise<void>;
  };
};

/**
 * Returns a factory function suitable for passing to `LocationRuntimeRegistry.acquire`.
 * Handles all transport-specific construction (local vs SSH) and wires lifecycle
 * script hooks. Provider-specific hooks are passed via `extraHooks`.
 */
export function createLocationRuntimeFactory(
  locationId: string,
  transport: LocationTransport,
  context: LocationRuntimeFactoryContext
): () => Promise<LocationRuntimeFactoryResult> {
  return async () => {
    const workDir = context.workDir;

    // Transport: local runs on this machine; ssh runs on the agent's host. The
    // SSH connection is established here (and reused by the session providers).
    let ctx: IExecutionContext;
    let runtimeFs: FileSystemProvider;
    if (transport.kind === 'ssh') {
      const proxy = await connectSshTransport(transport);
      ctx = new SshExecutionContext(proxy, { root: transport.dir });
      runtimeFs = new SshFileSystem(proxy, transport.dir);
    } else {
      ctx = new LocalExecutionContext();
      runtimeFs = new LocalFileSystem(workDir);
    }

    // Settings (shared)
    const locationSettings = await context.settings.get();
    const bootstrapSessionEnvVars = getSessionEnvVars({
      sessionId: context.session.id,
      sessionName: context.session.title,
      sessionPath: workDir,
      rootPath: workDir,
      portSeed: workDir,
    });
    // Remote sessions require tmux — it is the persistence substrate the sidecar
    // injects into and reattaches to across UI disconnects.
    const tmuxEnabled = transport.kind === 'ssh' ? true : (locationSettings.tmux ?? false);
    const sessionLevelSettings = await getEffectiveSessionSettings({
      locationSettings: context.settings,
      sessionFs: runtimeFs,
    });
    const shellSetup = sessionLevelSettings.shellSetup ?? locationSettings.shellSetup;
    const scripts = sessionLevelSettings.scripts;

    // Location terminal provider (used only by lifecycle scripts)
    const terminalOpts = {
      sessionPath: workDir,
      tmux: tmuxEnabled,
      shellSetup,
      ctx,
      sessionEnvVars: bootstrapSessionEnvVars,
    };
    const runtimeTerminals =
      transport.kind === 'ssh'
        ? new SshTerminalProvider({
            ...terminalOpts,
            scopeId: locationId,
            proxy: await connectSshTransport(transport),
          })
        : new LocalTerminalProvider(terminalOpts);

    const lifecycleService = new LifecycleScriptService({
      locationId,
      terminals: runtimeTerminals,
    });

    const runtime: LocationRuntime = {
      id: locationId,
      path: workDir,
      fs: runtimeFs,
      settings: context.settings,
      lifecycleService,
    };

    const { logPrefix } = context;

    return {
      runtime,

      onCreateSideEffect: (rt) => {
        void locationFileIndexService.onRuntimeCreated(locationId, rt);
        void (async () => {
          if (scripts?.setup && (locationSettings.autoRunSetupScriptOnSessionCreation ?? true)) {
            const setupResult = await runLifecycleScriptWithPolicy({
              runtime: rt,
              sessionId: context.session.id,
              locationId,
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

          if (scripts?.run && (locationSettings.autoRunRunScriptOnSessionCreation ?? false)) {
            await runLifecycleScriptWithPolicy({
              runtime: rt,
              sessionId: context.session.id,
              locationId,
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

      onDestroy: async (rt) => {
        locationFileIndexService.onRuntimeDestroyed(locationId);
        const latestSessionSettings = await getEffectiveSessionSettings({
          locationSettings: context.settings,
          sessionFs: rt.fs,
        });
        const latestLocationSettings = await context.settings.get();
        const latestShellSetup =
          latestSessionSettings.shellSetup ?? latestLocationSettings.shellSetup;
        const teardownScript = latestSessionSettings.scripts?.teardown;

        if (teardownScript) {
          await runLifecycleScriptWithPolicy({
            runtime: rt,
            sessionId: context.session.id,
            locationId,
            type: 'teardown',
            script: teardownScript,
            shellSetup: latestShellSetup,
            origin: 'location-destroy',
            policy: {
              timeoutMs: TEARDOWN_SCRIPT_WAIT_MS,
              logFailure: true,
              surfaceFailure: false,
              continueOnFailure: true,
            },
            logPrefix,
          });
        }
        await context.extraHooks?.onDestroy?.(rt);
      },

      onDetach: async (rt) => {
        await context.extraHooks?.onDetach?.(rt);
      },
    };
  };
}

type AgentRuntimeOpts = {
  locationId: string;
  sessionId: string;
  sessionPath: string;
  tmuxEnabled: boolean;
  shellSetup?: string;
  sessionEnvVars: Record<string, string>;
  /** Candidate creds files (relative to the working dir) the remote preflight
   * checks, in priority order — the agent's neutral `.switch/agents/<name>.json`
   * first, then the earlier id-keyed variant of it (CHOO-1440). */
  credsRelPaths: string[];
};

async function resolveLocalAgentShellProfile(sessionId: string): Promise<ResolvedShellProfile> {
  const { defaultShell } = await appSettingsService.get('terminal');
  return await resolveLocalAutomationShellWithSystemFallback({
    intent: defaultShell,
    onFallback: (error) => {
      log.warn('buildAgentRuntime: preferred local agent shell unavailable, using fallback', {
        shell: error.shell,
        sessionId,
      });
    },
  });
}

/**
 * Creates the session's agent runtime for the given transport. The exec
 * function is derived internally from the LocationTransport.
 */
export async function buildAgentRuntime(
  transport: LocationTransport,
  opts: AgentRuntimeOpts
): Promise<AgentRuntimeProvider> {
  if (transport.kind === 'ssh') {
    const proxy = await connectSshTransport(transport);
    const ctx = new SshExecutionContext(proxy, { root: transport.dir });
    const fs = new SshFileSystem(proxy, transport.dir);
    // Gate remote session start: fail loud now (missing tools / absent creds /
    // no egress to Switch) rather than spawning an agent that never connects.
    await preflightRemoteSession({
      ctx,
      fs,
      log,
      host: transport.host,
      workDir: transport.dir,
      credsRelPaths: opts.credsRelPaths,
    });
    // Remote sessions always run under tmux — it persists the agent's PTY and
    // is the pane the sidecar injects into and reattaches to.
    return new SshAgentRuntime({
      locationId: opts.locationId,
      sessionPath: opts.sessionPath,
      sessionId: opts.sessionId,
      tmux: true,
      shellSetup: opts.shellSetup,
      ctx,
      fs,
      proxy,
      connectionId: transport.connectionId,
      sessionEnvVars: opts.sessionEnvVars,
    });
  }

  const ctx = new LocalExecutionContext();
  const agentShellProfile = await resolveLocalAgentShellProfile(opts.sessionId);
  return new LocalAgentRuntime({
    locationId: opts.locationId,
    sessionPath: opts.sessionPath,
    sessionId: opts.sessionId,
    tmux: opts.tmuxEnabled,
    shellSetup: opts.shellSetup,
    shellProfile: agentShellProfile,
    ctx,
    sessionEnvVars: opts.sessionEnvVars,
  });
}

/**
 * Resolves the session-level environment variables and settings from an
 * already-acquired location runtime. Used by providers after
 * `locationRuntimeRegistry.acquire` to avoid duplicating settings reads.
 */
export async function resolveSessionEnv(
  session: Pick<Session, 'id' | 'title'>,
  runtime: Pick<LocationRuntime, 'path' | 'fs'>,
  settings: LocationSettingsProvider
): Promise<{
  sessionEnvVars: Record<string, string>;
  tmuxEnabled: boolean;
  shellSetup?: string;
}> {
  const locationSettings = await settings.get();
  const sessionLevelSettings = await getEffectiveSessionSettings({
    locationSettings: settings,
    sessionFs: runtime.fs,
  });
  return {
    sessionEnvVars: getSessionEnvVars({
      sessionId: session.id,
      sessionName: session.title,
      sessionPath: runtime.path,
      rootPath: runtime.path,
      portSeed: runtime.path,
    }),
    tmuxEnabled: locationSettings.tmux ?? false,
    shellSetup: sessionLevelSettings.shellSetup ?? locationSettings.shellSetup,
  };
}
