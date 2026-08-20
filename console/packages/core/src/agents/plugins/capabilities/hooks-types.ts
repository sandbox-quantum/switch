export const HOOK_EVENTS = [
  'notification',
  'stop',
  'session',
  'start',
  'tool-use',
  'tool-done',
  'tool-use-failure',
  'subagent',
  'subagent-done',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookRegistration = {
  event: string;
  command: string;
};

/**
 * The machine the hook command will run on.
 *
 * This is the *session's* host, not Switch Console's: a remote session's hooks are
 * written into a config file on the SSH host and run there, so a Windows
 * console installing hooks on a Linux VM must still emit the POSIX command.
 */
export type HookCommandOptions = {
  platform: NodeJS.Platform;
};

/**
 * A hook command that is only a string once the platform it will run on is
 * known. Deferring it is what keeps the target platform, rather than the
 * platform that happened to import the module, from deciding the shell.
 */
export type HookCommand = (opts: HookCommandOptions) => string;

export type NotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success'
  | 'elicitation_dialog'
  | 'startup_prompt';

/**
 * Normalised hook event produced by a plugin's parseHookEvent method.
 *
 * - kind: 'status'   — maps to an agent lifecycle event (start/stop/error/notification)
 * - kind: 'session'  — carries a provider session id to persist on the session
 * - kind: 'activity' — a short line describing what the running turn is doing
 *                      right now (e.g. a tool call); surfaced as incremental
 *                      progress while the coarse status stays 'working'
 * - kind: 'ignore'   — event should be silently dropped
 */
export type CanonicalHookEvent =
  | {
      kind: 'status';
      type: 'start' | 'stop' | 'error' | 'notification';
      notificationType?: NotificationType;
      title?: string;
      message?: string;
      lastAssistantMessage?: string;
    }
  | { kind: 'session'; providerSessionId: string }
  | { kind: 'activity'; detail: string }
  | { kind: 'ignore' };
