export const ANTIGRAVITY_LAUNCHER = String.raw`#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const version = '1.1.1';
if (process.argv[2] === '--version') { console.log(version); process.exit(0); }
const login = process.argv[2] === '--login';
if (process.argv.length > (login ? 3 : 2)) throw new Error('Use antigravity-acp, --version, or --login.');
const root = join(homedir(), '.local', 'share', 'switch', 'antigravity-acp', version);
const profile = process.env.GEMINI_HOME || join(homedir(), '.local', 'state', 'switch', 'antigravity-acp');
mkdirSync(profile, { recursive: true, mode: 0o700 });
try { writeFileSync(join(profile, 'settings.json'), JSON.stringify({ auth: { type: 'oauth-personal' } }), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const temp = mkdtempSync(join(profile, 'runtime-'));
const child = spawn(join(root, 'agy_acp_server.par'), process.platform === 'linux' ? ['--uid='] : [], {
  stdio: login ? ['pipe', 'pipe', 'inherit'] : 'inherit',
  env: { ...process.env, GEMINI_HOME: profile, AGY_ACP_FORCE_FILE_STORAGE: '1', PYTHONUNBUFFERED: '1', TMPDIR: temp,
    ANTIGRAVITY_HARNESS_PATH: join(root, 'localharness_external') },
});
let force;
const stop = () => { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 2000); force.unref(); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('close', (code) => { clearTimeout(force); if (timeout) clearTimeout(timeout); rmSync(temp, { recursive: true, force: true }); process.exitCode = process.exitCode ?? code ?? 1; });
let timeout;
if (login) {
  timeout = setTimeout(() => { console.error('Antigravity sign-in timed out. Run --login to retry.'); process.exitCode = 1; stop(); }, 180000);
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { if (line.startsWith('Open the following link to authenticate the ACP server:')) console.log(line); return; }
    if (message.error) { console.error('Antigravity sign-in failed:', message.error.message); process.exitCode = 1; stop(); }
    else if (message.id === 1) send(2, 'authenticate', { methodId: 'oauth-personal' });
    else if (message.id === 2) { console.log('Signed in to Antigravity ACP.'); process.exitCode = 0; stop(); }
  });
  send(1, 'initialize', { protocolVersion: 1, clientInfo: { name: 'switch-console-login', version: '1' }, clientCapabilities: {} });
}
`;
