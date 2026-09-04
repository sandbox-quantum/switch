import { describe, expect, it } from 'vitest';
import { findOrphanedRuntimes, parseProcessTable, staleSessionDirs } from './reap';

/**
 * The reaper's predicate, against process tables shaped like the real ones.
 *
 * These are the actual command lines from the machine that prompted this, with
 * the pids kept: 15860 and 76532 are the two that had grown to 470 MB and
 * 367 MB, and 15765 / 76464 are their wrappers — alive, orphaned to launchd,
 * and the reason "is the parent dead?" is the wrong question. Any predicate
 * that misses those two misses the bug.
 */

const NPX_BIN = '/Users/dev/.npm/_npx/6dbe1f0400d7a251/node_modules/.bin/switch-agent-runtime';

/** The three-deep tree a live session produces. */
function liveSession(hostPid: number, wrapperPid: number, runtimePid: number) {
  return [
    { pid: hostPid, ppid: 501, command: 'claude' },
    {
      pid: wrapperPid,
      ppid: hostPid,
      command: 'npm exec @sandboxaq/switch-agent-runtime@0.3.2',
    },
    { pid: runtimePid, ppid: wrapperPid, command: `node ${NPX_BIN}` },
  ];
}

/** The same tree after the host died: the wrapper survives, reparented to init. */
function orphanedSession(wrapperPid: number, runtimePid: number) {
  return [
    { pid: wrapperPid, ppid: 1, command: 'npm exec @sandboxaq/switch-agent-runtime@0.3.1' },
    { pid: runtimePid, ppid: wrapperPid, command: `node ${NPX_BIN}` },
  ];
}

const INIT = { pid: 1, ppid: 0, command: '/sbin/launchd' };

describe('parsing the process table', () => {
  it('reads pid, ppid and the full command line', () => {
    const rows = parseProcessTable(
      ['  501     1 /sbin/launchd', '15860 15765 node /path/to/switch-agent-runtime --flag'].join(
        '\n'
      )
    );
    expect(rows).toEqual([
      { pid: 501, ppid: 1, command: '/sbin/launchd' },
      { pid: 15860, ppid: 15765, command: 'node /path/to/switch-agent-runtime --flag' },
    ]);
  });

  it('skips headers, blanks and anything malformed', () => {
    const rows = parseProcessTable(['  PID  PPID COMMAND', '', '   ', 'garbage'].join('\n'));
    expect(rows).toEqual([]);
  });
});

describe('finding runtimes whose host is gone', () => {
  it('spares a runtime whose host is alive', () => {
    const rows = [INIT, ...liveSession(900, 901, 902)];
    expect(findOrphanedRuntimes(rows, 999)).toEqual([]);
  });

  it('catches the orphan whose wrapper is alive but reparented', () => {
    const rows = [INIT, ...orphanedSession(15765, 15860)];
    // Both, not just the runtime: the wrapper is dead weight once its child is.
    expect(findOrphanedRuntimes(rows, 999).sort((a, b) => a - b)).toEqual([15765, 15860]);
  });

  it('catches a runtime reparented directly, its wrapper already gone', () => {
    const rows = [INIT, { pid: 76532, ppid: 1, command: `node ${NPX_BIN}` }];
    expect(findOrphanedRuntimes(rows, 999)).toEqual([76532]);
  });

  it('catches a runtime whose parent vanished from the snapshot', () => {
    const rows = [INIT, { pid: 4242, ppid: 4241, command: `node ${NPX_BIN}` }];
    expect(findOrphanedRuntimes(rows, 999)).toEqual([4242]);
  });

  it('sorts the live from the dead in one pass', () => {
    const rows = [INIT, ...liveSession(900, 901, 902), ...orphanedSession(15765, 15860)];
    expect(findOrphanedRuntimes(rows, 999).sort((a, b) => a - b)).toEqual([15765, 15860]);
  });

  it('ignores processes that are not the runtime', () => {
    const rows = [
      INIT,
      { pid: 300, ppid: 1, command: 'npm exec @playwright/mcp@latest' },
      { pid: 301, ppid: 1, command: '/Applications/Discord.app/Contents/MacOS/Discord' },
    ];
    expect(findOrphanedRuntimes(rows, 999)).toEqual([]);
  });

  /**
   * A substring match on the package name kills these, and an early draft of
   * this did. Any shell that merely mentions the runtime — installing it,
   * grepping for it, or a tool invocation quoting it back — carries the name in
   * its own command line, and an orphaned one is indistinguishable from the
   * real thing unless the match is anchored.
   */
  it.each([
    ['a shell running npx for it', "/bin/zsh -c 'npx -y @sandboxaq/switch-agent-runtime@0.3.2'"],
    ['a shell greping for it', '/bin/bash -c pkill -f switch-agent-runtime@0.3.2'],
    ['an editor with the path open', 'vim /src/switch-agent-runtime/bin.ts'],
    [
      'a shell quoting the binary path',
      "/bin/sh -c 'node /x/node_modules/.bin/switch-agent-runtime'",
    ],
  ])('does not reap %s, even orphaned', (_name, command) => {
    expect(findOrphanedRuntimes([INIT, { pid: 400, ppid: 1, command }], 999)).toEqual([]);
  });

  it('still reaps the genuine article in the same table', () => {
    const rows = [
      INIT,
      { pid: 400, ppid: 1, command: "/bin/zsh -c 'grep switch-agent-runtime@0.3.2 log'" },
      ...orphanedSession(15765, 15860),
    ];
    expect(findOrphanedRuntimes(rows, 999).sort((a, b) => a - b)).toEqual([15765, 15860]);
  });

  // The reaper runs inside a runtime, so its own chain looks exactly like the
  // thing it hunts. Nothing else stops it turning on the session it serves.
  it('never reaps itself', () => {
    const rows = [INIT, ...liveSession(900, 901, 902)];
    expect(findOrphanedRuntimes(rows, 902)).toEqual([]);
  });

  it('never reaps itself even when its own chain looks orphaned', () => {
    const rows = [INIT, ...orphanedSession(15765, 15860)];
    expect(findOrphanedRuntimes(rows, 15860)).toEqual([]);
  });

  it('spares its own wrapper along with itself', () => {
    const rows = [INIT, ...orphanedSession(15765, 15860)];
    expect(findOrphanedRuntimes(rows, 15860)).not.toContain(15765);
  });

  it('terminates on a parent cycle rather than hanging', () => {
    const rows = [
      { pid: 10, ppid: 11, command: `node ${NPX_BIN}` },
      { pid: 11, ppid: 10, command: `node ${NPX_BIN}` },
    ];
    expect(findOrphanedRuntimes(rows, 999).sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it('walks through several wrapper layers to reach the host', () => {
    const rows = [
      INIT,
      { pid: 900, ppid: 501, command: 'codex' },
      { pid: 901, ppid: 900, command: 'npx -y @sandboxaq/switch-agent-runtime@0.3.2' },
      { pid: 902, ppid: 901, command: 'npm exec @sandboxaq/switch-agent-runtime@0.3.2' },
      { pid: 903, ppid: 902, command: `node ${NPX_BIN}` },
    ];
    expect(findOrphanedRuntimes(rows, 999)).toEqual([]);
  });
});

describe('sweeping stale session directories', () => {
  const alive = (pid: number) => pid === 900;

  it('removes only directories whose process is gone', () => {
    expect(staleSessionDirs(['900', '901', '902'], alive, 'none')).toEqual(['901', '902']);
  });

  it('keeps the caller’s own directory whatever its liveness looks like', () => {
    expect(staleSessionDirs(['901', '902'], alive, '901')).toEqual(['902']);
  });

  it('ignores entries that are not pids', () => {
    expect(staleSessionDirs(['901', 'media', '.DS_Store', ''], alive, 'none')).toEqual(['901']);
  });

  it('returns nothing for an empty directory', () => {
    expect(staleSessionDirs([], alive, 'none')).toEqual([]);
  });

  // The app sweeps the same root and owns no session directory of its own.
  it('spares nothing extra when the caller has no directory to keep', () => {
    expect(staleSessionDirs(['900', '901'], alive, null)).toEqual(['901']);
  });

  it('still spares a live pid when there is nothing to keep', () => {
    expect(staleSessionDirs(['900'], alive, null)).toEqual([]);
  });
});
