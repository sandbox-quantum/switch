import ssh2 from 'ssh2';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';

/**
 * `inspectRemoteDir` over a real SFTP connection.
 *
 * The sibling unit test replaces `SshFileSystem` with a fake whose `stat`
 * returns `null` for anything absent. That is an assumption about the wire, not
 * a fact: `stat` resolves `null` only because it recognises SFTP status 2, and
 * if a server reported absence any other way the probe would throw instead of
 * answering `creatable` — breaking every remote add while the unit tests stayed
 * green. Here the only fakes are the connection handshake and the directory
 * tree; the SFTP protocol, `SshFileSystem` and the probe are real.
 */

const { Client, Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** The fake host's tree. Everything not named here does not exist. */
const TREE = new Map<string, 'dir' | 'file' | 'denied'>([
  ['/home/u', 'dir'],
  ['/home/u/agents', 'dir'],
  ['/home/u/agents/existing', 'dir'],
  ['/home/u/notes.txt', 'file'],
  ['/locked', 'denied'],
  ['/locked/inner', 'denied'],
]);

let server: ssh2.Server;
let client: ssh2.Client;
/** SFTP channels the server has opened, and how many have since closed. */
const channels = { opened: 0, closed: 0 };

const ensureSshConnected = vi.hoisted(() => vi.fn());
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected }));
vi.mock('@main/core/locations/location-transport', () => ({
  sshConnectionIdForHost: (host: string) => `conn:${host}`,
}));

const { inspectRemoteDir } = await import('./remote-dir');

beforeAll(async () => {
  const { private: hostKey } = utils.generateKeyPairSync('ed25519');

  server = new Server({ hostKeys: [hostKey] }, (conn) => {
    conn.on('authentication', (ctx) => ctx.accept());
    conn.on('ready', () => {
      conn.on('session', (acceptSession) => {
        acceptSession().on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          channels.opened += 1;
          sftp.on('close', () => {
            channels.closed += 1;
          });

          // Answer STAT the way an OpenSSH server does: absent paths are a
          // status code, not a silence and not a different error.
          const onStat = (reqid: number, path: string) => {
            const kind = TREE.get(path);
            if (kind === 'denied') return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
            if (!kind) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftp.attrs(reqid, {
              mode: (kind === 'dir' ? S_IFDIR : S_IFREG) | 0o755,
              size: 0,
              uid: 0,
              gid: 0,
              atime: 0,
              mtime: 0,
            });
          };
          sftp.on('STAT', onStat);
          sftp.on('LSTAT', onStat);
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  client = new Client();
  await new Promise<void>((resolve, reject) => {
    client
      .on('ready', () => resolve())
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'u', password: 'p' });
  });
});

afterAll(() => {
  client?.end();
  server?.close();
});

beforeEach(() => {
  channels.opened = 0;
  channels.closed = 0;
  // Only the handshake is stubbed: everything the probe does with the result is
  // the real `SshFileSystem` talking real SFTP to the server above.
  ensureSshConnected.mockImplementation(
    async () =>
      ({
        sftp: (cb: (err: Error | undefined, sftp: unknown) => void) => client.sftp(cb),
      }) as unknown as SshClientProxy
  );
});

describe('inspectRemoteDir over real SFTP', () => {
  it('reports an existing directory', async () => {
    expect(await inspectRemoteDir('host', '/home/u/agents/existing')).toEqual({
      dir: '/home/u/agents/existing',
      status: 'directory',
    });
  });

  // The case the whole fix turns on. A server reporting absence as anything the
  // mapping does not recognise would surface here as a rejection.
  it('reports a missing leaf under an existing parent as creatable', async () => {
    expect(await inspectRemoteDir('host', '/home/u/agents/deploy')).toEqual({
      dir: '/home/u/agents/deploy',
      status: 'creatable',
    });
  });

  it('reports a missing leaf whose parent is also missing', async () => {
    expect(await inspectRemoteDir('host', '/home/u/nope/deploy')).toEqual({
      dir: '/home/u/nope/deploy',
      status: 'missing',
    });
  });

  it('tells a regular file apart from a directory', async () => {
    expect(await inspectRemoteDir('host', '/home/u/notes.txt')).toEqual({
      dir: '/home/u/notes.txt',
      status: 'file',
    });
  });

  // Absence and unreadability are different answers. Reporting a denied path as
  // `missing` would send the user off to create a directory already there.
  it('propagates permission denied rather than calling it missing', async () => {
    await expect(inspectRemoteDir('host', '/locked/inner')).rejects.toThrow(/Permission denied/i);
  });

  it('normalises the path it probes, over the wire', async () => {
    expect(await inspectRemoteDir('host', '/home/u/./x/../agents/existing/')).toEqual({
      dir: '/home/u/agents/existing',
      status: 'directory',
    });
  });

  // SFTP channels do not self-close, and enough leaks exhaust the host's
  // MaxSessions — every later channel open then fails for the whole app.
  it('closes its SFTP channel on both the success and the failure path', async () => {
    await inspectRemoteDir('host', '/home/u/agents/existing');
    await expect(inspectRemoteDir('host', '/locked/inner')).rejects.toThrow();

    expect(channels.opened).toBe(2);
    await vi.waitFor(() => expect(channels.closed).toBe(2));
  });

  it('opens no channel at all for a relative path', async () => {
    expect(await inspectRemoteDir('host', 'agents/deploy')).toEqual({
      dir: 'agents/deploy',
      status: 'relative',
    });
    expect(channels.opened).toBe(0);
  });
});
