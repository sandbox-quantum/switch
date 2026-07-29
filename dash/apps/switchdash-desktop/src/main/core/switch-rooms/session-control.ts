/**
 * Per-agent-type support for the Switch session-control commands
 * (reset / compact / interrupt) and the keystroke recipe for executing each.
 *
 * Resolved by `providerId`, mirroring `PluginPromptInjector` — the switch-core
 * side declares whether a command is supported at all (per agent-type) and
 * whether it depends on the session; this module is the switchdash half that
 * (a) reports which commands a live session can actually execute, and (b)
 * turns a queued `command` event into concrete keystrokes for the injection
 * sink. A provider with no entry supports none of the commands.
 */

/** Which session-control commands a managed session can execute. Reported to
 * switch-core in the runtime-state POST as its `control_capabilities`. */
export interface SessionControlCapabilities {
  reset: boolean;
  compact: boolean;
  interrupt: boolean;
}

/** A single keystroke step to run against the injection sink. */
export type SessionControlAction =
  /** Write raw bytes directly (e.g. an ESC interrupt); no submit keystroke. */
  | { kind: 'raw'; data: string }
  /** Inject text like a prompt (built via the provider's PromptInjector) and
   *  submit it. */
  | { kind: 'prompt'; text: string };

/** Context a command plan may need — e.g. reset must reconnect to the room and
 * re-assume the role the agent held before its context was cleared. */
export interface SessionControlContext {
  /** Human-readable room name (falls back to the room id when unknown). */
  room: string;
  /** Role the agent held in the room before the reset, or null if none. */
  role: string | null;
  /** Thread root of the originating command message, so the completion notice
   * can be posted as a reply in that thread. null when not in a thread. */
  threadId: string | null;
  /** Name of the user who issued the command, so the completion notice can be
   * addressed (targeted) back to them. null when unknown. */
  user: string | null;
}

export interface SessionControl {
  /** The commands this provider can execute in a managed session. */
  readonly capabilities: SessionControlCapabilities;
  /** The keystroke steps for a command, or null if it isn't supported. */
  plan(command: string, ctx: SessionControlContext): SessionControlAction[] | null;
}

const ESC = '\x1b';

/**
 * Build the reconnect-and-announce prompt run after a reset (`/clear`) or a
 * compaction (`/compact`): both drop or condense the agent's context, so it
 * must reconnect to the room, re-assume the role it held, and post back in the
 * room that the operation is done. The MCP connection and role lease persist
 * across /clear and /compact — this re-establishes the agent's *understanding*.
 */
function reconnectAndAnnounce(ctx: SessionControlContext, done: string): string {
  const assume = ctx.role ? ` and assume the role ${ctx.role}` : '';
  // Address the completion notice back to whoever issued the command (targeted
  // so they get notified), and reply into the originating command's thread when
  // there is one so it sits under the !reset/!compact message.
  const thread = ctx.threadId ? ` as a threaded reply to message ${ctx.threadId}` : '';
  const notice = ctx.user
    ? `send a targeted message to ${ctx.user}${thread} in this room`
    : `post a short message${thread} in this room`;
  return (
    `connect to switch room "${ctx.room}"${assume}, then ${notice} ` +
    `letting them know your ${done} and you're ready to continue.`
  );
}

/** Claude Code: driven as a TUI, so all three commands are keystroke recipes. */
const CLAUDE_CONTROL: SessionControl = {
  capabilities: { reset: true, compact: true, interrupt: true },
  plan(command, ctx) {
    switch (command) {
      case 'interrupt':
        // Claude interrupts the current turn on ESC; no submit.
        return [{ kind: 'raw', data: ESC }];
      case 'compact':
        return [
          { kind: 'prompt', text: '/compact' },
          { kind: 'prompt', text: reconnectAndAnnounce(ctx, 'context has been compacted') },
        ];
      case 'reset':
        return [
          { kind: 'prompt', text: '/clear' },
          { kind: 'prompt', text: reconnectAndAnnounce(ctx, 'session has been reset') },
        ];
      default:
        return null;
    }
  },
};

/**
 * Codex: also a TUI, and its recipes happen to match Claude's — ESC interrupts
 * the current turn (Ctrl+C would exit the session instead), `/clear` starts a
 * fresh chat, `/compact` summarises the transcript. Kept as its own object
 * rather than aliasing CLAUDE_CONTROL: the two CLIs are free to diverge, and a
 * shared reference would make a Claude-only change silently apply to Codex.
 */
const CODEX_CONTROL: SessionControl = {
  capabilities: { reset: true, compact: true, interrupt: true },
  plan(command, ctx) {
    switch (command) {
      case 'interrupt':
        return [{ kind: 'raw', data: ESC }];
      case 'compact':
        return [
          { kind: 'prompt', text: '/compact' },
          { kind: 'prompt', text: reconnectAndAnnounce(ctx, 'context has been compacted') },
        ];
      case 'reset':
        // Codex refuses /clear while a turn is running, so interrupt first.
        return [
          { kind: 'raw', data: ESC },
          { kind: 'prompt', text: '/clear' },
          { kind: 'prompt', text: reconnectAndAnnounce(ctx, 'session has been reset') },
        ];
      default:
        return null;
    }
  },
};

const NO_CONTROL: SessionControl = {
  capabilities: { reset: false, compact: false, interrupt: false },
  plan: () => null,
};

const BY_PROVIDER: Record<string, SessionControl> = {
  claude: CLAUDE_CONTROL,
  codex: CODEX_CONTROL,
};

/** Resolve the session-control support + recipes for a provider. */
export function resolveSessionControl(providerId: string): SessionControl {
  return BY_PROVIDER[providerId] ?? NO_CONTROL;
}
