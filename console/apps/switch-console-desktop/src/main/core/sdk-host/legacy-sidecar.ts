import { posix } from 'node:path';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';

/**
 * Stops the sidecar an earlier generation of Console deployed for this agent,
 * and the agent panes it started.
 *
 * Before the shared host, a remote agent was served by a sidecar living under
 * the agent's own working directory, supervised by tmux rather than by
 * anything the shared host can see. Deploying over it leaves both alive: the
 * old one still holds the agent's session and still answers its rooms, while
 * Console reports the new one. Its panes outlive it, so they are stopped
 * first — killing the sidecar alone leaves the session that is actually
 * talking.
 *
 * Scoped to the agent's own directory under `.switchdash/agents/<slug>`, so a
 * host shared with other agents keeps theirs. An install predating per-agent
 * credentials recorded itself under `default` and names no owner; those are
 * left for a deliberate sweep rather than guessed at.
 */
const STOP_LEGACY_SIDECAR = `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const [repoDir, slug] = process.argv.slice(1);
const directory = path.join(repoDir, '.switchdash', 'agents', slug);
const read = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tmux = (args) => {
  try {
    cp.execFileSync('tmux', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const stopped = [];
for (const session of read('state.json')?.sessions ?? []) {
  const target = session?.tmuxTarget;
  if (typeof target !== 'string' || !target) continue;
  if (!tmux(['has-session', '-t', '=' + target])) continue;
  tmux(['kill-session', '-t', '=' + target]);
  if (tmux(['has-session', '-t', '=' + target]))
    throw new Error('Superseded agent pane ' + target + ' would not stop.');
  stopped.push(target);
}
const pid = read('sidecar.ready')?.pid;
if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) {
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) pause(100);
  if (alive(pid)) {
    process.kill(pid, 'SIGKILL');
    for (let attempt = 0; attempt < 20 && alive(pid); attempt++) pause(100);
  }
  if (alive(pid)) throw new Error('Superseded sidecar ' + pid + ' would not stop.');
  stopped.push('sidecar:' + pid);
}
console.log(JSON.stringify(stopped));
`;

export async function stopLegacySidecar(
  ctx: IExecutionContext,
  repoDir: string,
  credentialsPath: string
): Promise<void> {
  const slug = posix.basename(credentialsPath, '.json');
  if (!slug) throw new Error('Cannot identify the agent whose superseded sidecar should stop.');
  const { stdout } = await ctx.exec('node', ['-e', STOP_LEGACY_SIDECAR, repoDir, slug]);
  const stopped: string[] = JSON.parse(stdout.trim() || '[]');
  if (stopped.length)
    log.warn('Stopped a superseded sidecar deployment for this agent', { slug, stopped });
}
