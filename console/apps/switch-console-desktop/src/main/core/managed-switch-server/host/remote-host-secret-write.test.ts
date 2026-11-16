import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The remote stack's `.env` holds its database passwords, signing keys and
 * admin password. It used to be created by a plain SFTP open (the server's
 * umask, usually 0644) and chmod'd in a separate round trip afterwards, so
 * another account on the host could read it in between. Here the SFTP layer
 * is real; only the wire is faked.
 */

const h = vi.hoisted(() => ({
  execs: [] as string[][],
  ensureSshConnected: vi.fn(),
}));

vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  exitDescription: () => '',
  buildSshCommand: () => '',
  SshExecutionContext: class {
    async exec(command: string, args: string[]) {
      h.execs.push([command, ...args]);
      return { stdout: command === 'sh' ? '/home/bob' : '', stderr: '' };
    }
    dispose() {}
  },
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: h.ensureSshConnected,
}));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../paths', () => ({ remoteServerStateDir: (slug: string) => `/state/${slug}` }));
vi.mock('./remote-free-port', () => ({ pickRemoteFreePorts: vi.fn() }));
vi.mock('@main/core/locations/location-transport', () => ({
  sshConnectionIdForHost: (host: string) => `ssh:${host}`,
}));

const { createRemoteServerHost } = await import('./remote-host');

type Call = [string, ...unknown[]];

function fakeProxy() {
  const calls: Call[] = [];
  const handle = Buffer.from('handle');
  const done = (cb: unknown) => (cb as (err?: Error) => void)();
  const sftp = {
    on: vi.fn(),
    mkdir: (path: string, cb: unknown) => {
      calls.push(['mkdir', path]);
      (cb as (err?: Error) => void)(Object.assign(new Error('Failure'), { code: 4 }));
    },
    chmod: (path: string, mode: number, cb: unknown) => {
      calls.push(['chmod', path, mode]);
      done(cb);
    },
    open: (path: string, flags: string, ...rest: unknown[]) => {
      const cb = rest.at(-1) as (err: Error | undefined, handle: Buffer) => void;
      calls.push(rest.length > 1 ? ['open', path, flags, rest[0]] : ['open', path, flags]);
      cb(undefined, handle);
    },
    fchmod: (_handle: Buffer, mode: number, cb: unknown) => {
      calls.push(['fchmod', mode]);
      done(cb);
    },
    write: (_handle: Buffer, buffer: Buffer, ...rest: unknown[]) => {
      calls.push(['write', buffer.toString('utf-8')]);
      done(rest.at(-1));
    },
    close: (_handle: Buffer, cb: unknown) => {
      calls.push(['close']);
      done(cb);
    },
    ext_openssh_rename: (from: string, to: string, cb: unknown) => {
      calls.push(['rename', from, to]);
      done(cb);
    },
  };
  const proxy = {
    sftp: (cb: (err: Error | undefined, value: unknown) => void) => cb(undefined, sftp),
  };
  return { proxy, calls };
}

const SECRETS = 'DB_PASSWORD=fake-db\nGATEWAY_ADMIN_PASSWORD=fake-admin\n';

beforeEach(() => {
  h.execs.length = 0;
});

describe('the remote managed server', () => {
  it('creates its working directory readable by its owner alone', async () => {
    const { proxy } = fakeProxy();
    h.ensureSshConnected.mockResolvedValue(proxy);

    const host = await createRemoteServerHost('vm-1');

    expect(host.workingDir).toBe('/home/bob/.switchdash/switch-server');
    expect(h.execs).toContainEqual(['mkdir', '-p', '-m', '700', host.workingDir]);
    expect(h.execs).toContainEqual(['chmod', '700', host.workingDir]);
  });

  it('writes .env to a 0600 temporary file and renames it into place, never opening .env itself', async () => {
    const { proxy, calls } = fakeProxy();
    h.ensureSshConnected.mockResolvedValue(proxy);
    const host = await createRemoteServerHost('vm-1');
    h.execs.length = 0;

    await host.writeFile('.env', SECRETS, 0o600);

    const target = '/home/bob/.switchdash/switch-server/.env';
    const opened = calls.filter((call) => call[0] === 'open');
    expect(opened).toHaveLength(1);
    const temporary = opened[0]![1] as string;
    expect(temporary).not.toBe(target);
    expect(opened[0]).toEqual(['open', temporary, 'wx', { mode: 0o600 }]);
    expect(calls).toContainEqual(['chmod', '/home/bob/.switchdash/switch-server', 0o700]);
    expect(calls).toContainEqual(['write', SECRETS]);
    expect(calls.at(-1)).toEqual(['rename', temporary, target]);
    // No chmod after the fact: the content was never in a wider file.
    expect(h.execs).toEqual([]);
  });

  it('still writes a file with no mode the plain way', async () => {
    const { proxy, calls } = fakeProxy();
    h.ensureSshConnected.mockResolvedValue(proxy);
    const host = await createRemoteServerHost('vm-1');

    await host.writeFile('standalone-docker-compose.yml', 'services: {}\n');

    expect(calls).toContainEqual([
      'open',
      '/home/bob/.switchdash/switch-server/standalone-docker-compose.yml',
      'w',
    ]);
    expect(calls.some((call) => call[0] === 'rename')).toBe(false);
  });
});
