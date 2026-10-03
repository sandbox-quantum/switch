import { z } from 'zod';
import { WATCHER_ROOT } from '@main/core/sdk-host/state-roots';

/**
 * What moves with an agent between Console's watcher and a controller's, on
 * the machine the agent runs on, so its conversations carry on.
 *
 * Sessions live in one place on a machine (`~/.local/state/switch/sdk-sessions`)
 * whichever watcher started them, and each is named after the room message
 * that started it, so a session Console's watcher started is one the
 * controller's watcher can resume. Two things tie it to its watcher, and both
 * move:
 *
 * - **Which session attends which room** is the watcher's own record,
 *   `placements.json` in its state root, read when it starts. It is copied to
 *   the other watcher's root, so a room's next message goes to the session
 *   that has its conversation rather than to a new one.
 * - **The credentials a session reads** are named in its saved configuration
 *   (`execution.credentialsPath`), and a resumed session keeps what was saved.
 *   Console's file holds the agent's own key, which Switch refuses while a
 *   controller runs the agent; the controller's names its relay. Each of the
 *   agent's sessions is pointed at the file of whoever runs it now.
 *
 * Done only while neither watcher, nor any session of the agent, is running:
 * a live session keeps the configuration it started with, and is reported
 * back rather than rewritten under it.
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
const consoleRoot = (identity) => watcherRoot(path.join(state, 'sdk-watchers'), identity);
const result = { placements: [], rewritten: [], live: [], watchers: [] };
for (const identity of request.identities) {
  const ours = consoleRoot(identity.switchAgentId);
  const theirs = expand(identity.controllerRoot);
  if (request.op === 'status') {
    result.watchers.push({ switchAgentId: identity.switchAgentId, console: running(ours), controller: running(theirs) });
    continue;
  }
  if (request.op === 'turn-off') {
    // What the controller does for an agent no longer assigned to it, for when it is not there to.
    if (fs.existsSync(theirs)) put(path.join(theirs, 'watch.json'), { enabled: false, spawn: false });
    continue;
  }
  const [from, to] = request.op === 'hand-over' ? [ours, theirs] : [theirs, ours];
  if (running(to) || running(from))
    throw new Error('The watcher of agent ' + identity.switchAgentId + ' is still running; stop it before its sessions move.');
  const placements = read(path.join(from, 'placements.json'));
  if (placements && placements.placements && typeof placements.placements === 'object') {
    put(path.join(to, 'placements.json'), { placements: placements.placements });
    result.placements.push({ switchAgentId: identity.switchAgentId, rooms: Object.keys(placements.placements).length });
  } else if (request.op === 'hand-over') {
    // A controller root this agent used before must not route by what it held then.
    try { fs.unlinkSync(path.join(to, 'placements.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const sessions = path.join(state, 'sdk-sessions');
  let names = [];
  try { names = fs.readdirSync(sessions).filter(isStateRoot); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const name of names) {
    const root = path.join(sessions, name);
    const file = path.join(root, 'config.json');
    let config;
    try { config = readJson(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
    if (config?.session?.agentId !== identity.switchAgentId || !config.execution) continue;
    const target = request.op === 'hand-over' ? expand(identity.controllerCredentials) : identity.consoleCredentials;
    if (config.execution.credentialsPath === target) continue;
    if (running(root)) { result.live.push(config.session.sessionId); continue; }
    config.execution.credentialsPath = target;
    put(file, config);
    result.rewritten.push(config.session.sessionId);
  }
}
console.log(JSON.stringify(result));
`;

export type HandoffIdentity = {
  switchAgentId: string;
  /** The controller's watcher root for this agent (`~/` is the machine's home). */
  controllerRoot: string;
  /** The controller's relay credentials file for this agent (`~/` likewise). */
  controllerCredentials: string;
  /** Console's credentials file for this agent, absolute on the machine. */
  consoleCredentials: string;
};

export type HandoffRequest = {
  /**
   * `hand-over` to the controller, `hand-back` to Console, `status` to read
   * both watchers, or `turn-off` to turn the controller's watcher off for an
   * agent it no longer runs, when the controller is not there to.
   */
  op: 'hand-over' | 'hand-back' | 'status' | 'turn-off';
  identities: HandoffIdentity[];
};

const resultSchema = z.object({
  placements: z.array(z.object({ switchAgentId: z.string(), rooms: z.number() })),
  rewritten: z.array(z.string()),
  /** Sessions still running, so left as they were. */
  live: z.array(z.string()),
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
