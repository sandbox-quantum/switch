import { z } from 'zod';

/**
 * The scripts Console runs with `node -e` on an SSH host to install, run and
 * remove the headless agents controller there. They are plain CommonJS for
 * whatever Node the host has: the check that it is new enough is one of them.
 *
 * Paths starting `~/` are the host's home. Every script takes one argument,
 * the JSON of its options, and prints one line of JSON.
 */

/** The controller stores its state with `node:sqlite`, which Node has from 22.13. */
export const MIN_NODE = [22, 13] as const;

const EXPAND = String.raw`
const os = require('node:os'), path = require('node:path'), fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto');
const expand = (p) => p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const put = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID();
  fs.writeFileSync(tmp, text, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
};
`;

/**
 * Looks the host over before anything is installed: its Node, whether this
 * build's controller bundle is there already (removing ones no running
 * process names), and how a long-lived process can be kept running there.
 *
 * systemd counts only with lingering on: without it, a user's units stop when
 * their last session ends, which for a host Console reaches over SSH is as
 * soon as Console disconnects.
 *
 * Options: `{ bundleName, hash }`.
 */
export const PREPARE_SCRIPT = String.raw`${EXPAND}
const o = JSON.parse(process.argv[1]);
const directory = path.join(os.homedir(), '.local', 'state', 'switch', 'sdk-host');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
let present = false;
try { present = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, o.bundleName))).digest('hex') === o.hash; }
catch (e) { if (e.code !== 'ENOENT') throw e; }
let running = '';
try { running = cp.execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' }); } catch (e) {}
for (const name of fs.readdirSync(directory))
  if (name !== o.bundleName && /^agent-controller-[a-f0-9]{64}\.mjs$/.test(name) && running && !running.includes(name))
    fs.rmSync(path.join(directory, name), { force: true });
let systemd = false, linger = false;
try { cp.execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5000 }); systemd = true; } catch (e) {}
try { linger = /Linger=yes/.test(cp.execFileSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'], { encoding: 'utf8', timeout: 5000 })); } catch (e) {}
console.log(JSON.stringify({
  node: process.versions.node,
  execPath: process.execPath,
  path: process.env.PATH || '',
  hostname: os.hostname(),
  home: os.homedir(),
  directory,
  present,
  systemd: systemd && linger,
}));
`;

export const prepareResultSchema = z.object({
  node: z.string(),
  execPath: z.string(),
  path: z.string(),
  hostname: z.string(),
  home: z.string(),
  directory: z.string(),
  present: z.boolean(),
  systemd: z.boolean(),
});

export type PrepareResult = z.infer<typeof prepareResultSchema>;

/** Whether a Node version is new enough for the controller. */
export function nodeIsNewEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/**
 * Enrolls the controller with a one-time code: runs its own `enroll`, which
 * refuses a data directory that already holds another controller. The code is
 * on its command line only for the moment `enroll` runs, and is spent by it.
 *
 * Options: `{ node, bundle, server, code, name, dataDir }`.
 */
export const ENROLL_SCRIPT = String.raw`${EXPAND}
const o = JSON.parse(process.argv[1]);
const dataDir = expand(o.dataDir);
const result = cp.spawnSync(o.node, [expand(o.bundle), 'enroll', '--server', o.server, '--code', o.code, '--name', o.name, '--data-dir', dataDir], { encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) {
  const reason = String(result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).pop() || ('exit ' + result.status);
  console.log(JSON.stringify({ ok: false, reason: reason.replace(/^switch-agent-controller: /, '') }));
} else {
  const match = /Enrolled as controller (\S+)/.exec(result.stdout);
  console.log(JSON.stringify({ ok: true, controllerId: match ? match[1] : null }));
}
`;

export const enrollResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), controllerId: z.string().nullable() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

/**
 * Keeps the controller running under the supervisor: started again on exit
 * code 1 with a backoff, and left stopped on 0 (stopped), 2 (configuration),
 * 3 (revoked) and 4 (taken over), as the controller's README asks of any
 * supervisor. Records itself in `console-supervisor.json` in the data
 * directory. A run that lasted ten minutes resets the backoff.
 *
 * Options: `{ node, bundle, dataDir, sharedHost, path }`.
 */
export const SUPERVISOR_SCRIPT = String.raw`${EXPAND}
const o = JSON.parse(process.argv[1]);
const dataDir = expand(o.dataDir);
const stateFile = path.join(dataDir, 'console-supervisor.json');
let child = null, stopping = false, attempt = 0;
const record = (extra) => put(stateFile, JSON.stringify(Object.assign({ pid: process.pid, bundle: o.bundle, dataDir: dataDir }, extra)));
process.on('SIGTERM', () => { stopping = true; if (child) child.kill('SIGTERM'); else { record({ state: 'stopped' }); process.exit(0); } });
const start = () => {
  const started = Date.now();
  record({ state: 'running', since: new Date(started).toISOString() });
  child = cp.spawn(o.node, [expand(o.bundle), 'run', '--data-dir', dataDir, '--shared-host-bundle', expand(o.sharedHost)], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { PATH: o.path || process.env.PATH, SWITCH_CONTROLLER_LOG_LEVEL: 'info' }),
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) { record({ state: 'stopped' }); process.exit(0); }
    if ([0, 2, 3, 4].includes(code)) { record({ state: 'exited', code: code }); process.exit(0); }
    if (Date.now() - started > 600000) attempt = 0;
    attempt += 1;
    const wait = Math.min(5000 * Math.pow(2, Math.min(attempt - 1, 4)), 60000);
    record({ state: 'restarting', code: code, signal: signal, retryAt: new Date(Date.now() + wait).toISOString() });
    setTimeout(start, wait);
  });
};
start();
`;

/**
 * Starts the controller as a long-lived process: a systemd user unit where
 * that can outlive Console's SSH session, otherwise the supervisor above,
 * detached into a session of its own so the SSH connection closing does not
 * take it down. The detached supervisor does not come back after the host
 * reboots; a systemd unit does.
 *
 * Options: `{ supervision, unit, unitText, supervisor, args }`.
 */
export const START_SCRIPT = String.raw`${EXPAND}
const o = JSON.parse(process.argv[1]);
const dataDir = expand(o.args.dataDir);
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (o.supervision === 'systemd') {
  const file = path.join(os.homedir(), '.config', 'systemd', 'user', o.unit);
  put(file, o.unitText, 0o644);
  cp.execFileSync('systemctl', ['--user', 'daemon-reload']);
  cp.execFileSync('systemctl', ['--user', 'enable', o.unit]);
  cp.execFileSync('systemctl', ['--user', 'restart', o.unit]);
  console.log(JSON.stringify({ pid: null }));
} else {
  const existing = readJson(path.join(dataDir, 'console-supervisor.json'));
  if (existing && existing.pid && alive(existing.pid) && ['running', 'restarting'].includes(existing.state))
    throw new Error('The controller is already running on this host (pid ' + existing.pid + ').');
  const log = fs.openSync(path.join(dataDir, 'console-controller.log'), 'a', 0o600);
  const child = cp.spawn(process.execPath, ['-e', o.supervisor, JSON.stringify(o.args)], { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  console.log(JSON.stringify({ pid: child.pid }));
}
`;

/**
 * Whether the controller runs, and if not, what it last said.
 *
 * Options: `{ supervision, unit, dataDir }`.
 */
export const STATUS_SCRIPT = String.raw`${EXPAND}
const o = JSON.parse(process.argv[1]);
const dataDir = expand(o.dataDir);
const tail = () => {
  const file = path.join(dataDir, 'console-controller.log');
  try { const text = fs.readFileSync(file, 'utf8'); return text.trim().split('\n').slice(-5).join('\n'); }
  catch (e) { return ''; }
};
if (o.supervision === 'systemd') {
  let state = 'unknown', code = null;
  try { state = cp.execFileSync('systemctl', ['--user', 'is-active', o.unit], { encoding: 'utf8' }).trim(); }
  catch (e) { state = String(e.stdout || 'inactive').trim() || 'inactive'; }
  try { code = Number(cp.execFileSync('systemctl', ['--user', 'show', o.unit, '-p', 'ExecMainStatus', '--value'], { encoding: 'utf8' }).trim()); } catch (e) {}
  let log = '';
  try { log = cp.execFileSync('journalctl', ['--user', '-u', o.unit, '-n', '5', '--no-pager', '-o', 'cat'], { encoding: 'utf8' }).trim(); } catch (e) {}
  console.log(JSON.stringify({ running: state === 'active' || state === 'activating', state: state, code: code, log: log }));
} else {
  const saved = readJson(path.join(dataDir, 'console-supervisor.json'));
  const up = !!(saved && saved.pid && alive(saved.pid) && ['running', 'restarting'].includes(saved.state));
  console.log(JSON.stringify({ running: up, state: saved ? saved.state : 'never-started', code: saved && saved.code !== undefined ? saved.code : null, log: up ? '' : tail() }));
}
`;

export const statusResultSchema = z.object({
  running: z.boolean(),
  state: z.string(),
  code: z.number().nullable(),
  log: z.string(),
});

export type HostProcessStatus = z.infer<typeof statusResultSchema>;

/**
 * Stops the controller for good and cleans up after it: the unit disabled and
 * removed, or the supervisor stopped; every agent watcher it ran turned off
 * (the controller does that itself when it hears it was revoked, but it may
 * not have); and, with `wipe`, the controller's identity, credential and the
 * agents' relay credentials removed. Watcher roots and workspaces stay.
 *
 * Options: `{ supervision, unit, dataDir, wipe }`.
 */
export const STOP_SCRIPT = String.raw`${EXPAND}
const o = JSON.parse(process.argv[1]);
const dataDir = expand(o.dataDir);
if (o.supervision === 'systemd') {
  try { cp.execFileSync('systemctl', ['--user', 'disable', '--now', o.unit], { stdio: 'ignore' }); } catch (e) {}
  fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', o.unit), { force: true });
  try { cp.execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch (e) {}
} else {
  const saved = readJson(path.join(dataDir, 'console-supervisor.json'));
  if (saved && saved.pid && alive(saved.pid)) {
    let owned = true;
    // The supervisor names its data directory as it was given, which may be the ~/ form.
    try {
      const args = cp.execFileSync('ps', ['-p', String(saved.pid), '-o', 'args='], { encoding: 'utf8' });
      owned = args.includes('console-supervisor.json') && (args.includes(dataDir) || args.includes(o.dataDir));
    } catch (e) { owned = false; }
    if (owned) {
      process.kill(saved.pid, 'SIGTERM');
      let i = 0;
      for (; i < 75 && alive(saved.pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      if (alive(saved.pid)) throw new Error('The controller on this host did not stop within 15 s of being asked (pid ' + saved.pid + ').');
    }
  }
}
let turnedOff = 0;
const watchers = path.join(dataDir, 'watchers');
let names = [];
try { names = fs.readdirSync(watchers); } catch (e) { if (e.code !== 'ENOENT') throw e; }
for (const name of names) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)) continue;
  put(path.join(watchers, name, 'watch.json'), JSON.stringify({ enabled: false, spawn: false }));
  turnedOff += 1;
}
if (o.wipe) {
  for (const name of ['controller.db', 'controller.db-wal', 'controller.db-shm', 'console-supervisor.json'])
    fs.rmSync(path.join(dataDir, name), { force: true });
  fs.rmSync(path.join(dataDir, 'agents'), { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, 'secrets'), { recursive: true, force: true });
}
console.log(JSON.stringify({ turnedOff: turnedOff }));
`;

/** The systemd user unit that runs the controller, restarted only on exit code 1. */
export function systemdUnit(input: {
  description: string;
  node: string;
  bundle: string;
  dataDir: string;
  sharedHost: string;
  path: string;
}): string {
  const quote = (value: string) => `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return [
    '[Unit]',
    `Description=${input.description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${[input.node, input.bundle, 'run', '--data-dir', input.dataDir, '--shared-host-bundle', input.sharedHost].map(quote).join(' ')}`,
    `Environment=${quote(`PATH=${input.path}`)}`,
    'Environment=SWITCH_CONTROLLER_LOG_LEVEL=info',
    'Restart=on-failure',
    'RestartSec=5',
    'RestartPreventExitStatus=2 3 4',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
