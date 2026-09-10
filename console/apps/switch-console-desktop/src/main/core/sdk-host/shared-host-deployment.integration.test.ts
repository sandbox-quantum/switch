import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'ssh2';
import { expect, it, vi } from 'vitest';
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
