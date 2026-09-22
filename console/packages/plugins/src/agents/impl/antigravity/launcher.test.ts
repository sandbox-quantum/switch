import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { ANTIGRAVITY_INSTALL_COMMAND } from './install';
import { ANTIGRAVITY_LAUNCHER } from './launcher';
const exec = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
it('checks the installed version without launching the native runtime', async () => {
  const home = await mkdtemp(join(tmpdir(), 'acp-launcher-'));
  homes.push(home);
  const launcher = join(home, 'launcher.cjs');
  await writeFile(launcher, ANTIGRAVITY_LAUNCHER);
  const result = await exec(process.execPath, [launcher, '--version'], {
    env: { ...process.env, HOME: home },
  });
  expect(result.stdout.trim()).toBe('1.1.1');
  expect(await readdir(home)).toEqual(['launcher.cjs']);
  await exec('/bin/sh', ['-n', '-c', ANTIGRAVITY_INSTALL_COMMAND]);
});
it('authenticates explicitly over ACP and removes the native extraction directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'acp-launcher-'));
  homes.push(home);
  const root = join(home, '.local/share/switch/antigravity-acp/1.1.1');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'agy_acp_server.par'),
    `#!/usr/bin/env node
const { createInterface } = require('node:readline');
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 if(request.method==='authenticate' && request.params.methodId!=='oauth-personal')process.exit(2);
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}})+'\\n');
});
`,
    { mode: 0o755 }
  );
  const launcher = join(home, 'launcher.cjs');
  await writeFile(launcher, ANTIGRAVITY_LAUNCHER);
  const profile = join(home, 'profile');
  const result = await exec(process.execPath, [launcher, '--login'], {
    env: { ...process.env, HOME: home, GEMINI_HOME: profile },
    timeout: 10000,
  });
  expect(result.stdout).toContain('Signed in to Antigravity ACP.');
  expect(await readdir(profile)).toEqual(['settings.json']);
});

it('ships the tested launcher in the standalone shell installer', async () => {
  const installer = new URL(
    '../../../../../../../scripts/install-antigravity-acp.sh',
    import.meta.url
  );
  const source = await readFile(installer, 'utf8');
  const embedded =
    source.split("<<'SWITCH_ACP_LAUNCHER'\n")[1].split('\nSWITCH_ACP_LAUNCHER')[0] + '\n';
  expect(embedded).toBe(ANTIGRAVITY_LAUNCHER);
  await exec('/bin/bash', ['-n', installer.pathname]);
});
