import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';
import { quoteShellArg } from '@main/utils/shellEscape';

const TMUX_SESSION_PREFIX = 'switchdash-';
const TMUX_HISTORY_LIMIT = 100_000;

/**
 * Build an exact-match tmux target. tmux resolves a bare `-t name` by prefix
 * (then fnmatch) when there is no exact hit, so an agent session named `<x>`
 * would resolve to its own `<x>-sidecar` session — which is created first on
 * remote sessions. The `=` prefix forces an exact session-name match.
 */
export function exactTmuxTarget(sessionName: string): string {
  return `=${sessionName}`;
}

export function buildTmuxShellLine(
  sessionName: string,
  commandLine: string,
  paneEnv?: Record<string, string>
): string {
  const quotedName = JSON.stringify(sessionName);
  const quotedTarget = JSON.stringify(exactTmuxTarget(sessionName));
  // set-option/show-options reject a bare `=name` target ("no such session"),
  // unlike has-session/attach-session. A trailing colon makes them parse it as
  // a session target while keeping the `=` exact-match guarantee.
  const quotedOptionTarget = JSON.stringify(`${exactTmuxTarget(sessionName)}:`);
  const quotedCmd = JSON.stringify(commandLine);
  // Set the agent's env on the tmux session itself with `-e`. A new pane inherits
  // the tmux SERVER's environment, NOT that of the shell invoking `new-session`,
  // so env merely exported in the outer command never reaches the agent process
  // (this is what left `SWITCHDASH_HOOK_*` unset and broke remote hook delivery).
  // Single-quoted so values survive the surrounding shell + JSON wrapping; tmux
  // applies them only when it creates the session (existing sessions are reused).
  const envFlags = paneEnv
    ? Object.entries(paneEnv)
        .map(([key, value]) => `-e ${quoteShellArg(`${key}=${value}`)}`)
        .join(' ')
    : '';
  const newSessionFlags = envFlags ? `-d ${envFlags}` : '-d';
  // `-u` forces tmux into UTF-8 mode regardless of the inherited locale. GUI-launched
  // apps (e.g. Electron on macOS) often have no LANG set, so without this tmux assumes a
  // non-UTF-8 locale and mangles multibyte glyphs like Nerd-font/box-drawing characters.
  const checkExists = `tmux has-session -t ${quotedTarget} 2>/dev/null`;
  const newSession = `tmux -u new-session ${newSessionFlags} -s ${quotedName} ${quotedCmd}`;
  const enableMouse = `tmux set-option -t ${quotedOptionTarget} mouse on 2>/dev/null || true`;
  const setHistoryLimit = `tmux set-option -t ${quotedOptionTarget} history-limit ${TMUX_HISTORY_LIMIT} 2>/dev/null || true`;
  // With multiple clients (different laptops) attached to the same session, tmux
  // otherwise clamps the shared window to the SMALLEST client, cramping the active
  // user whenever an idle viewer with a smaller terminal is attached. `latest`
  // sizes the window to the most-recently-active client instead, so a passive
  // viewer no longer constrains whoever is actually driving the session.
  const setWindowSize = `tmux set-option -t ${quotedOptionTarget} window-size latest 2>/dev/null || true`;
  const configure = `(${enableMouse}) && (${setHistoryLimit}) && (${setWindowSize})`;
  const attach = `tmux -u attach-session -t ${quotedTarget}`;
  const script = `(${checkExists} || ${newSession}) && ${configure} && ${attach}`;
  return `/bin/sh -c ${JSON.stringify(script)}`;
}

export function makeTmuxSessionName(sessionId: string): string {
  const encoded = Buffer.from(sessionId, 'utf8').toString('base64url');
  return `${TMUX_SESSION_PREFIX}${encoded}`;
}

/**
 * tmux session name for an AGENT conversation's pane, derived from the
 * conversationId alone. The conversationId is minted once (by whichever client
 * or the VM sidecar starts the session) and is shared verbatim across every
 * switchdash client and the sidecar, so all of them compute the identical tmux
 * name and attach to the SAME pane — enabling concurrent multi-client access
 * (CHOO-1181). It must NOT fold in projectId/scopeId: those are switchdash-
 * instance-local ids that differ per client, which would give each client a
 * different pane name and silently spawn a fresh blank session on attach.
 */
export function makeAgentTmuxSessionName(conversationId: string): string {
  return makeTmuxSessionName(`conv-${conversationId}`);
}

export async function killTmuxSession(ctx: IExecutionContext, sessionName: string): Promise<void> {
  try {
    await ctx.exec('tmux', ['kill-session', '-t', exactTmuxTarget(sessionName)]);
  } catch (err) {
    log.debug('killTmuxSession: tmux session not found or already dead', {
      sessionName,
      error: String(err),
    });
  }
}
