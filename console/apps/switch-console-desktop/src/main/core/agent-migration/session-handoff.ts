import { z } from 'zod';
import { WATCHER_ROOT } from '@main/core/sdk-host/state-roots';

/**
 * What a move looks at and changes on the machine the agent runs on, about
 * its watchers: Console's, and the controller's.
 *
 * Sessions do not carry over to the controller. Sessions live in one place on
 * a machine (`~/.local/state/switch/sdk-sessions`) whichever watcher started
 * them, but each session's saved state is bound to the Switch endpoint it was
 * started against (`shared-state.jsonl`'s identity record), and a session the
 * controller runs reaches Switch through the controller's local relay, at an
 * address of its own. A Console session resumed under the controller refuses
 * to start, and the room is told its owner must fix it. So the controller's
 * watcher starts each room afresh: its room placements are cleared on every
 * move, including any left from an earlier stay, which name sessions bound to
 * a relay address that may since have changed.
 *
 * Console's own watcher root keeps its placements. They still name the
 * sessions it ran before the move, which were stopped the way quitting Console
 * stops them rather than ended, so when the agent comes back each room picks
 * up the conversation it had before the move. Its stream position does move
 * on: from where it stopped, Switch would send it again every message the
 * controller answered meanwhile.
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
const records = (root) => {
  let text;
  try { text = fs.readFileSync(journal(root), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (text && !text.endsWith('\n'))
    throw new Error('The watcher journal ' + journal(root) + ' has an incomplete record; it needs a recovery review before the agent can move.');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};
// Where a watcher's stream reopens, worked out as the watcher works it out
// (AgentHostAssignments.cursor in agent-providers): the last event whose routing
// reached its journal under the server's current numbering, never past one still held.
const position = (root) => {
  const all = records(root) ?? [];
  const delivery = (r) => JSON.stringify([r.roomId, r.messageId]);
  const released = new Set(all.filter((r) => r.released).map((r) => delivery(r.released)));
  let start = all.length - 1;
  while (start >= 0 && all[start].restarted !== true) start--;
  let complete = 0, assigned = 0;
  const parked = new Map();
  for (const r of all.slice(start + 1)) {
    if (r.handled !== undefined) complete = Math.max(complete, r.handled);
    else if (r.parked !== undefined) { if (!r.wake) parked.set(r.parked, delivery(r)); }
    else if (r.config !== undefined && !r.wake && !released.has(delivery(r))) {
      complete = Math.max(complete, assigned);
      assigned = r.sequence;
    }
  }
  const waiting = [];
  for (const [sequence, identity] of parked)
    if (released.has(identity)) complete = Math.max(complete, sequence);
    else waiting.push(sequence);
  return waiting.length ? Math.min(complete, Math.min(...waiting) - 1) : complete;
};
const appendRecords = (root, lines) => {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  records(root);
  const fd = fs.openSync(journal(root), 'a', 0o600);
  try { fs.writeSync(fd, lines.map((line) => JSON.stringify(line) + '\n').join('')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const result = { watchers: [], cleared: [], resumed: [] };
for (const identity of request.identities) {
  const ours = watcherRoot(path.join(state, 'sdk-watchers'), identity.switchAgentId);
  const theirs = expand(identity.controllerRoot);
  if (request.op === 'status') {
    result.watchers.push({ switchAgentId: identity.switchAgentId, console: running(ours), controller: running(theirs) });
  } else if (request.op === 'turn-off') {
    // What the controller does for an agent no longer assigned to it, for when it is not there to.
    if (fs.existsSync(theirs)) put(path.join(theirs, 'watch.json'), { enabled: false, spawn: false });
  } else if (request.op === 'fresh-start') {
    if (running(theirs))
      throw new Error('The controller is already running agent ' + identity.switchAgentId + '; its rooms cannot be started afresh under it.');
    try { fs.unlinkSync(path.join(theirs, 'placements.json')); result.cleared.push(identity.switchAgentId); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    // A journal from an earlier stay holds a position the controller's stream knows nothing of.
    if (records(theirs) !== null) appendRecords(theirs, [{ restarted: true, at: new Date().toISOString() }]);
  } else if (request.op === 'come-back') {
    if (running(theirs) || running(ours))
      throw new Error('A watcher of agent ' + identity.switchAgentId + ' is still running; Console cannot take it back yet.');
    // Console's watcher would otherwise reopen its stream where it stopped before the
    // move and be sent again every message the controller already answered. It goes
    // on from the last one the controller's watcher routed, under the same numbering.
    const cursor = position(theirs);
    appendRecords(ours, [{ restarted: true, at: new Date().toISOString() }, ...(cursor > 0 ? [{ handled: cursor }] : [])]);
    result.resumed.push({ switchAgentId: identity.switchAgentId, cursor });
  } else throw new Error('Unknown request ' + request.op);
}
console.log(JSON.stringify(result));
`;

export type HandoffIdentity = {
  switchAgentId: string;
  /** The controller's watcher root for this agent (`~/` is the machine's home). */
  controllerRoot: string;
};

export type HandoffRequest = {
  /**
   * - `status` reads whether each side's watcher runs.
   * - `fresh-start` clears what an earlier stay left in the controller's
   *   watcher root (room placements, stream position) before it runs there.
   * - `come-back` moves Console's watcher's stream position on to where the
   *   controller's watcher stopped, so it is not sent again what the
   *   controller already answered. Its room placements stay.
   * - `turn-off` turns the controller's watcher off for an agent it no longer
   *   runs, when the controller is not there to.
   */
  op: 'status' | 'fresh-start' | 'come-back' | 'turn-off';
  identities: HandoffIdentity[];
};

const resultSchema = z.object({
  watchers: z.array(
    z.object({ switchAgentId: z.string(), console: z.boolean(), controller: z.boolean() })
  ),
  /** The agents whose controller placements were cleared. */
  cleared: z.array(z.string()),
  /** Where Console's watcher goes on from, per agent; 0 is the stream's head. */
  resumed: z.array(z.object({ switchAgentId: z.string(), cursor: z.number() })),
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
