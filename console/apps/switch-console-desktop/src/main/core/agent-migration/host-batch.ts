import { z } from 'zod';
import { WATCHER_ROOT } from '@main/core/sdk-host/state-roots';
import type { MachineScript } from './session-handoff';

/**
 * Turns off the Console watchers of several agents on one host, in one
 * command, and waits for them all at once.
 *
 * Moving an agent makes Switch close its watcher's connection, which the
 * watcher's supervisor takes for a crash and answers by sleeping before a
 * restart; one asleep then is slow to notice it was turned off. So a watcher
 * still up when the wait runs out is sent SIGTERM, then SIGKILL, rather than
 * left running. Only a process whose command line names the shared host is
 * signalled, so a PID file outliving its process cannot take another one down.
 *
 * Takes the JSON of `{ identities, waitMs, killWaitMs }` and prints, per
 * identity, null when its watcher is down or the reason it is not.
 */
export const STOP_WATCHERS_SCRIPT = String.raw`${WATCHER_ROOT}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process');
const o = JSON.parse(process.argv[1]);
const base = path.join(require('node:os').homedir(), '.local', 'state', 'switch', 'sdk-watchers');
const put = (file, data) => {
  const tmp = file + '.' + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const pidIn = (root, file) => {
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).pid;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const commandOf = (pid) => {
  try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' '); }
  catch (e) {
    try { return cp.execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); }
    catch { return ''; }
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const out = {}, roots = {};
for (const identity of o.identities) {
  try {
    const root = watcherRoot(base, identity);
    if (!fs.existsSync(root)) { out[identity] = null; continue; }
    try { fs.unlinkSync(path.join(root, 'taken-over.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    put(path.join(root, 'watch.json'), { enabled: false, spawn: false });
    roots[identity] = root;
  } catch (e) {
    out[identity] = e.message;
  }
}
const live = (identity) =>
  ['shared-owner.lock', 'supervisor/owner.json']
    .map((file) => pidIn(roots[identity], file))
    .filter((pid) => pid !== null && alive(pid));
const signal = (identities, sig) => {
  for (const identity of identities)
    for (const pid of live(identity))
      if (commandOf(pid).includes('shared-host')) try { process.kill(pid, sig); } catch {}
};
let deadline = Date.now() + o.waitMs, stage = 0;
for (;;) {
  const pending = Object.keys(roots).filter((identity) => live(identity).length > 0);
  if (!pending.length) break;
  if (Date.now() >= deadline) {
    if (stage === 2) {
      for (const identity of pending) out[identity] = 'Its watcher on the host did not stop, even when killed.';
      break;
    }
    signal(pending, stage === 0 ? 'SIGTERM' : 'SIGKILL');
    stage += 1;
    deadline = Date.now() + o.killWaitMs;
  }
  sleep(200);
}
for (const identity of Object.keys(roots)) if (!(identity in out)) out[identity] = null;
console.log(JSON.stringify(out));
`;

/**
 * Reads several files on a host in one command. Takes a JSON array of absolute
 * paths and prints an object from path to its text, or null where there is none.
 */
export const READ_FILES_SCRIPT = String.raw`
const fs = require('node:fs');
const out = {};
for (const file of JSON.parse(process.argv[1])) {
  try { out[file] = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; out[file] = null; }
}
console.log(JSON.stringify(out));
`;

/** Removes several files on a host in one command. Takes a JSON array of absolute paths. */
export const DELETE_FILES_SCRIPT = String.raw`
const fs = require('node:fs');
for (const file of JSON.parse(process.argv[1])) fs.rmSync(file, { force: true });
console.log('{}');
`;

const lastLine = (stdout: string): unknown => JSON.parse(stdout.trim().split('\n').at(-1) ?? '');

/** Per identity, null when its watcher is down, or why it is not. */
export async function stopWatchers(
  run: MachineScript,
  identities: string[],
  timing: { waitMs: number; killWaitMs: number }
): Promise<Record<string, string | null>> {
  const stdout = await run(STOP_WATCHERS_SCRIPT, [JSON.stringify({ identities, ...timing })]);
  return z.record(z.string(), z.string().nullable()).parse(lastLine(stdout));
}

export async function readFiles(
  run: MachineScript,
  paths: string[]
): Promise<Record<string, string | null>> {
  const stdout = await run(READ_FILES_SCRIPT, [JSON.stringify(paths)]);
  return z.record(z.string(), z.string().nullable()).parse(lastLine(stdout));
}

export async function deleteFiles(run: MachineScript, paths: string[]): Promise<void> {
  await run(DELETE_FILES_SCRIPT, [JSON.stringify(paths)]);
}
