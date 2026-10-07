import { z } from 'zod';
import { WATCHER_ROOT } from '@main/core/sdk-host/state-roots';

/**
 * What a move looks at and changes on the machine the agent runs on, about
 * its watchers: Console's, and the controller's.
 *
 * Conversations do not carry over either way: each side's watcher starts its
 * rooms afresh when it takes the agent. `start-fresh` clears a watcher root's
 * room placements and moves its stream position to the head, so it neither
 * reattaches rooms to sessions from an earlier stay nor is sent again the
 * messages the other side already answered.
 *
 * One script, run with `node -e` on the machine: locally on Electron's binary
 * as Node, on an SSH host with its Node. Takes the JSON of a `HandoffRequest`
 * and prints the JSON of a `HandoffResult`.
 */
export const HANDOFF_SCRIPT = String.raw`${WATCHER_ROOT}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), os = require('node:os');
const request = JSON.parse(process.argv[1]);
const state = path.join(os.homedir(), '.local', 'state', 'switch');
const expand = (p) => p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID();
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
};
const read = (file) => {
  try { return readJson(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const alive = (file) => {
  const saved = read(file);
  if (!saved) return false;
  if (!Number.isSafeInteger(saved.pid) || saved.pid <= 0) throw new Error('Invalid owner record ' + file);
  try { process.kill(saved.pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
};
const running = (root) => alive(path.join(root, 'shared-owner.lock')) || alive(path.join(root, 'supervisor', 'owner.json'));
const journal = (root) => path.join(root, 'assignments.jsonl');
const result = { watchers: [] };
for (const identity of request.identities) {
  const ours = watcherRoot(path.join(state, 'sdk-watchers'), identity.switchAgentId);
  const theirs = expand(identity.controllerRoot);
  if (request.op === 'status') {
    result.watchers.push({ switchAgentId: identity.switchAgentId, console: running(ours), controller: running(theirs) });
  } else if (request.op === 'turn-off') {
    // What the controller does for an agent no longer assigned to it, for when it is not there to.
    if (fs.existsSync(theirs)) put(path.join(theirs, 'watch.json'), { enabled: false, spawn: false });
  } else if (request.op === 'start-fresh') {
    const root = request.side === 'console' ? ours : theirs;
    if (running(root))
      throw new Error('A watcher of agent ' + identity.switchAgentId + ' is still running there; its rooms cannot be started afresh under it.');
    try { fs.unlinkSync(path.join(root, 'placements.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // A journal from before holds a stream position the watcher would reopen at.
    if (fs.existsSync(journal(root))) {
      const fd = fs.openSync(journal(root), 'a', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ restarted: true, at: new Date().toISOString() }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  } else throw new Error('Unknown request ' + request.op);
}
console.log(JSON.stringify(result));
`;

export type HandoffIdentity = {
  switchAgentId: string;
  /** The controller's watcher root for this agent (`~/` is the machine's home). */
  controllerRoot: string;
};

export type HandoffRequest =
  /** Reads whether each side's watcher runs. */
  | { op: 'status'; identities: HandoffIdentity[] }
  /** Turns the controller's watcher off for an agent it no longer runs, when the controller is not there to. */
  | { op: 'turn-off'; identities: HandoffIdentity[] }
  /** Clears a side's room placements and moves its stream to the head, before it takes the agent. */
  | { op: 'start-fresh'; side: 'console' | 'controller'; identities: HandoffIdentity[] };

const resultSchema = z.object({
  watchers: z.array(
    z.object({ switchAgentId: z.string(), console: z.boolean(), controller: z.boolean() })
  ),
});

export type HandoffResult = z.infer<typeof resultSchema>;

/** Runs `node -e <script> <args…>` on the agent's machine and returns its stdout. */
export type MachineScript = (script: string, args: string[]) => Promise<string>;

export async function runHandoff(
  run: MachineScript,
  request: HandoffRequest
): Promise<HandoffResult> {
  const stdout = await run(HANDOFF_SCRIPT, [JSON.stringify(request)]);
  return resultSchema.parse(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
}
