import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from 'ssh2';
import { expect, it, vi } from 'vitest';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import {
  spawnProxyCommand,
  spawnProxyJump,
  type SpawnProcess,
  type TransportResult,
} from '@main/core/ssh/transport/transports';
import { quoteShellArg } from '@main/utils/shellEscape';

const state = vi.hoisted(() => ({ proxy: undefined as unknown }));
vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: async () => state.proxy,
}));
vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: () => resolve('dist-sidecar/shared-host.mjs'),
}));
const { deploySharedHost } = await import('./shared-host-deployment');

it.skipIf(!process.env.SDK_SSH_TEST_KEY).each(['direct', 'proxy-command', 'proxy-jump'])(
  'deploys and reconnects the shared host bundle over %s',
  async (mode) => {
    const keyPath = process.env.SDK_SSH_TEST_KEY!;
    const port = Number(process.env.SDK_SSH_TEST_PORT);
    const key = await readFile(keyPath);
    const sshArgs = [
      '-i',
      keyPath,
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
    ];
    let tunnel: TransportResult | undefined;
    const client = new Client();
    const proxy = new SshClientProxy('sdk-transport-test');
    state.proxy = proxy;
    const connect = async () => {
      if (mode === 'proxy-jump')
        tunnel = spawnProxyJump(`root@127.0.0.1:${port}`, '127.0.0.1', 22, ((
          command,
          args,
          options
        ) => spawn(command, [...sshArgs, ...args], options)) as SpawnProcess);
      if (mode === 'proxy-command')
        tunnel = spawnProxyCommand(
          `ssh ${sshArgs.map(quoteShellArg).join(' ')} -p ${port} -W %h:%p root@127.0.0.1`,
          { host: '127.0.0.1', port: 22, username: 'root' }
        );
      const ready = once(client, 'ready');
      client.connect({
        host: '127.0.0.1',
        port,
        username: 'root',
        privateKey: key,
        ...(tunnel ? { sock: tunnel.sock } : {}),
      });
      await ready;
      proxy.update(client);
    };
    const identity = randomUUID();
    let root: string | undefined;
    try {
      await connect();
      const deployed = await deploySharedHost(
        {
          kind: 'ssh',
          host: 'local-fixture',
          connectionId: 'sdk-transport-test',
          dir: '/workspace',
        },
        '/workspace',
        identity,
        false
      );
      root = deployed.root;
      await expect(deployed.ctx.exec('node', [deployed.entrypoint])).rejects.toThrow(
        'requires a state directory'
      );
      const local = await mkdtemp(join(tmpdir(), 'sdk-remote-capabilities-'));
      try {
        const bundle = join(local, 'check.mjs');
        await build({
          stdin: {
            contents: `
            import assert from 'node:assert/strict';
            import { createHash, randomUUID } from 'node:crypto';
            import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
            import { join } from 'node:path';
            import { execFileSync } from 'node:child_process';
            import { stageAttachment } from ${JSON.stringify(resolve('../../packages/agent-providers/src/host/attachments.ts'))};
            import { prepareOpencodeHome } from ${JSON.stringify(resolve('../../packages/agent-providers/src/opencode/home.ts'))};
            const root = process.argv[2];
            await mkdir(root, { recursive: true });
            const home = join(root, 'home');
            const source = join(home, '.config/opencode');
            await mkdir(join(source, 'skills/native'), { recursive: true });
            await writeFile(join(source, 'skills/native/SKILL.md'), 'Native remote skill');
            const server = join(source, 'probe.mjs');
            await writeFile(server, 'process.stdout.write(process.env.SDK_FIXTURE_VALUE)');
            const original = JSON.stringify({ instructions: ['rules.md'], mcp: { native: { type: 'local', command: ['node', server], environment: { SDK_FIXTURE_VALUE: 'REMOTE_MCP_OK' } } } });
            await writeFile(join(source, 'opencode.jsonc'), original);
            await writeFile(join(home, 'auth-marker'), 'User configuration remains unchanged');
            const prepared = await prepareOpencodeHome({ mcp: {}, permission: {} }, [{ name: 'managed', content: 'Managed remote skill' }], { HOME: home });
            try {
              const settings = JSON.parse(await readFile(join(prepared, 'opencode/opencode.json'), 'utf8'));
              assert.equal(settings.instructions[0], join(source, 'rules.md'));
              assert.equal(await readFile(join(prepared, 'opencode/skills/native/SKILL.md'), 'utf8'), 'Native remote skill');
              assert.equal(await readFile(join(settings.skills.paths[0], 'managed/SKILL.md'), 'utf8'), 'Managed remote skill');
              const mcp = settings.mcp.native;
              assert.equal(execFileSync(mcp.command[0], mcp.command.slice(1), { env: { ...process.env, ...mcp.environment }, encoding: 'utf8' }), 'REMOTE_MCP_OK');
              assert.equal(await readFile(join(source, 'opencode.jsonc'), 'utf8'), original);
              assert.equal(await readFile(join(home, 'auth-marker'), 'utf8'), 'User configuration remains unchanged');
              const data = Buffer.from('Bytes transferred to the execution machine');
              const file = { attachmentId: randomUUID(), name: 'report.txt', mimeType: 'text/plain', bytes: data.length };
              let calls = 0;
              const download = async () => { if (++calls === 1) throw new TypeError('Temporary connection loss'); return { data, sha256: createHash('sha256').update(data).digest('hex') }; };
              const staged = await stageAttachment(root, file, download);
              assert.equal(await readFile(staged.path, 'utf8'), data.toString());
              assert.deepEqual(await stageAttachment(root, file, download), staged);
              assert.equal(calls, 3);
              console.log('REMOTE_CAPABILITIES_OK');
            } finally { await rm(prepared, { recursive: true, force: true }); }
          `,
            resolveDir: process.cwd(),
            loader: 'ts',
          },
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node20',
          outfile: bundle,
        });
        await deployed.ctx.exec('node', [
          '-e',
          "require('node:fs').mkdirSync(process.argv[1],{recursive:true})",
          root,
        ]);
        const files = new SshFileSystem(proxy, root);
        try {
          await files.copyLocalFile(bundle, 'capability-check.mjs');
        } finally {
          files.close();
        }
        expect(
          (
            await deployed.ctx.exec('node', [
              `${root}/capability-check.mjs`,
              `${root}/capability-fixture`,
            ])
          ).stdout.trim()
        ).toBe('REMOTE_CAPABILITIES_OK');
      } finally {
        await rm(local, { recursive: true, force: true });
      }

      const { stdout } = await deployed.ctx.exec('node', [
        '-e',
        "const fs=require('node:fs');fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+'/saved','native-conversation');console.log(require('node:crypto').createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex'))",
        root,
        deployed.entrypoint,
      ]);
      expect(deployed.entrypoint).toContain(stdout.trim());
      await expect(deployed.ctx.exec('node', [deployed.entrypoint])).rejects.toThrow();
      const closed = once(client, 'close');
      client.end();
      await closed;
      tunnel?.cleanup();
      tunnel = undefined;
      await connect();
      const reopened = await deploySharedHost(
        {
          kind: 'ssh',
          host: 'local-fixture',
          connectionId: 'sdk-transport-test',
          dir: '/workspace',
        },
        '/workspace',
        identity,
        false
      );
      expect(reopened.root).toBe(root);
      expect(
        (
          await reopened.ctx.exec('node', [
            '-e',
            "console.log(require('node:fs').readFileSync(process.argv[1]+'/saved','utf8'))",
            root,
          ])
        ).stdout.trim()
      ).toBe('native-conversation');
      await reopened.ctx.exec('node', [
        '-e',
        "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})",
        root,
      ]);
    } finally {
      client.end();
      tunnel?.cleanup();
    }
  },
  60000
);
