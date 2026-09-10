import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ensureSharedProcess } from './launch';
import type { SharedHostConfig } from './shared-config';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shared-launch-'));
  roots.push(root);
  const config: SharedHostConfig = {
    session: {
      sessionId: 'session',
      agentId: 'agent',
      hostId: 'host',
      epoch: 'initial',
      provider: 'codex',
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider: 'codex',
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
    },
  };
  return {
    root,
    config,
    entrypoint: join(root, 'worker.cjs'),
    resuming: true,
    watcher: false,
    restart: true,
  };
}
it('refuses to replace missing conversation state with a fresh session', async () => {
  await expect(ensureSharedProcess(await fixture())).rejects.toThrow('no saved SDK conversation');
});
it.skipIf(process.platform === 'win32')(
  'waits for the old owner to exit before starting its replacement',
  async () => {
    const input = await fixture();
    await writeFile(join(input.root, 'config.json'), JSON.stringify(input.config));
    await writeFile(
      input.entrypoint,
      `const fs=require('node:fs');fs.appendFileSync(process.argv[2]+'/trace','new\\n');`
    );
    const old = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');const root=process.argv[1];fs.writeFileSync(root+'/shared-owner.lock',JSON.stringify({pid:process.pid}));process.on('SIGTERM',()=>{setTimeout(()=>{fs.appendFileSync(root+'/trace','old-stopped\\n');process.exit(0)},200)});console.log('ready');setInterval(()=>{},1000);`,
        input.root,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await once(old.stdout!, 'data');
      const exit = once(old, 'exit');
      await ensureSharedProcess(input);
      await exit;
      await expect
        .poll(async () => readFile(join(input.root, 'trace'), 'utf8'))
        .toBe('old-stopped\nnew\n');
      expect(JSON.parse(await readFile(join(input.root, 'config.json'), 'utf8')).session).toEqual(
        input.config.session
      );
    } finally {
      if (old.exitCode === null) old.kill('SIGKILL');
    }
  }
);
