#!/usr/bin/env node
// Dev only: enrolls and runs a crowd of headless agents controllers on this
// computer against the local Switch server a dev Console runs, so pages that
// list machines can be tried with many real ones.
//
//   node scripts/dev-machines.mjs [--count 20] [--offline 3]
//     [--user-data-dir switchdash-dev-machines] [--prefix test-machine]
//
// Each controller keeps its own data directory under
// ~/.switch/dev-machines/<user-data-dir>/<name>, with its credential in a file
// there, so they share nothing with each other or with this computer's own
// controller. A machine is enrolled once and reused on the next run; delete its
// directory (and remove it in Switch) to start it over. `--offline N` stops the
// last N a few seconds after they connect, so they show as offline. Ctrl-C
// stops them all.
//
// Only a native local server (no Docker) is supported: its admin sign-in is
// read from the environment file Console starts it with.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    count: { type: 'string', default: '20' },
    offline: { type: 'string', default: '0' },
    'user-data-dir': { type: 'string', default: 'switchdash-dev-machines' },
    prefix: { type: 'string', default: 'test-machine' },
  },
});

const count = wholeNumber('--count', args.count);
const offline = wholeNumber('--offline', args.offline);
if (offline > count) fail('--offline cannot be more than --count.');

const DESCRIPTIONS = [
  'Build box in the office',
  null,
  'GPU workstation for the model experiments',
  'Shared CI runner',
  null,
  'Spare laptop under the desk',
];
/**
 * Lines each controller prints that say nothing here: Node's notice about
 * SQLite, and the warning that the credential is in a file, which this
 * script asks for.
 */
const EXPECTED_NOISE = [
  'ExperimentalWarning',
  'node --trace-warnings',
  'No OS keychain backend is in use',
];
/** The controllers' environment: quiet unless something goes wrong. */
const CHILD_ENV = {
  ...process.env,
  SWITCH_CONTROLLER_LOG_LEVEL: process.env.SWITCH_CONTROLLER_LOG_LEVEL ?? 'warn',
};
/** How long a machine meant to show as offline runs first, so it has connected once. */
const OFFLINE_AFTER_MS = 20_000;

const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
if (!existsSync(cli))
  fail(`${cli} is missing: build the workspace packages first (pnpm -r --filter './packages/**' run build).`);

const server = localServer(args['user-data-dir']);
const root = join(homedir(), '.switch', 'dev-machines', args['user-data-dir']);
const machines = Array.from({ length: count }, (_, i) => {
  const name = `${args.prefix}-${String(i + 1).padStart(2, '0')}`;
  return { name, dir: join(root, name), description: DESCRIPTIONS[i % DESCRIPTIONS.length] };
});

const children = new Set();
let stopping = false;
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

let cookie = null;
for (const machine of machines) {
  if (existsSync(join(machine.dir, '.dev-machine'))) continue;
  cookie ??= await signIn();
  await enroll(machine, await enrollmentCode());
}

console.log(`Running ${count} controllers against ${server.url}. Ctrl-C stops them all.`);
machines.forEach((machine, i) => {
  const child = run(machine);
  if (i >= count - offline)
    setTimeout(() => {
      if (stopping || child.exitCode !== null) return;
      console.log(`[${machine.name}] stopping it so it shows as offline`);
      child.kill('SIGTERM');
    }, OFFLINE_AFTER_MS);
});

function wholeNumber(flag, value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) fail(`${flag} takes a whole number, not ${value}.`);
  return number;
}

function fail(message) {
  console.error(`dev-machines: ${message}`);
  process.exit(1);
}

/** The local server's address and admin sign-in, from the files Console keeps for it. */
function localServer(userDataDir) {
  const appData =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  const base = join(appData, userDataDir, 'local-switch-server');
  const portsFile = join(base, 'ports.json');
  const envFile = join(base, 'native', 'run', 'switch-core.env');
  if (!existsSync(portsFile))
    fail(`No local server in ${base}. Start one from the Console run with SWITCH_CONSOLE_USER_DATA_DIR=${userDataDir}.`);
  if (!existsSync(envFile))
    fail(`${envFile} is missing: only a local server that runs without Docker is supported.`);
  const env = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  );
  const { api } = JSON.parse(readFileSync(portsFile, 'utf8'));
  if (!env.GATEWAY_ADMIN_EMAIL || !env.GATEWAY_ADMIN_PASSWORD)
    fail(`${envFile} names no admin sign-in.`);
  return {
    url: `http://127.0.0.1:${api}`,
    email: env.GATEWAY_ADMIN_EMAIL,
    password: env.GATEWAY_ADMIN_PASSWORD,
  };
}

async function signIn() {
  const res = await fetch(`${server.url}/gateway/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: server.email, password: server.password }),
  });
  if (!res.ok) fail(`Signing in to ${server.url} failed with HTTP ${res.status}. Is the local server running?`);
  const session = res.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');
  if (!session) fail('The server signed in but set no session cookie.');
  return session;
}

async function enrollmentCode() {
  const res = await fetch(`${server.url}/gateway/management/enrollment-codes`, {
    method: 'POST',
    headers: { cookie },
  });
  if (!res.ok)
    fail(`The server gave no enrollment code (HTTP ${res.status}): ${await res.text()}`);
  return (await res.json()).code;
}

async function enroll(machine, code) {
  mkdirSync(machine.dir, { recursive: true });
  const enrollArgs = [
    cli,
    'enroll',
    '--server',
    server.url,
    '--code',
    code,
    '--name',
    machine.name,
    '--data-dir',
    machine.dir,
    '--secret-store',
    'file',
  ];
  if (machine.description) enrollArgs.push('--description', machine.description);
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, enrollArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: CHILD_ENV,
    });
    relay(machine, child.stderr);
    child.on('exit', resolve);
  });
  if (exitCode !== 0) fail(`Enrolling ${machine.name} failed (exit ${exitCode}).`);
  writeFileSync(join(machine.dir, '.dev-machine'), `${machine.name}\n`);
  console.log(`[${machine.name}] enrolled`);
}

function run(machine) {
  const child = spawn(process.execPath, [cli, 'run', '--data-dir', machine.dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: CHILD_ENV,
  });
  children.add(child);
  relay(machine, child.stdout);
  relay(machine, child.stderr);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    const why =
      code === 3 || code === 6
        ? `: Switch no longer knows it. Delete ${machine.dir} to enroll it again.`
        : '';
    console.log(`[${machine.name}] exited (${signal ?? `code ${code}`})${why}`);
  });
  return child;
}

/** A controller's output, each line under its name, without the lines expected here. */
function relay(machine, stream) {
  createInterface({ input: stream }).on('line', (line) => {
    if (EXPECTED_NOISE.some((noise) => line.includes(noise))) return;
    console.log(`[${machine.name}] ${line}`);
  });
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping ${children.size} controllers…`);
  for (const child of children) child.kill('SIGTERM');
  const wait = setInterval(() => {
    if (children.size > 0) return;
    clearInterval(wait);
    process.exit(0);
  }, 200);
}
