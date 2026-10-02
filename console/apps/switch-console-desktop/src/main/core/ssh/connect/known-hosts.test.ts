import { createHmac } from 'node:crypto';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkHostKey,
  expandHomePath,
  formatKnownHostsLine,
  hostLookupKeys,
  parseKnownHostsLine,
  readKeyType,
  readKnownHosts,
  rememberHostKey,
  splitKnownHostsFiles,
  type KnownHostsDeps,
} from './known-hosts';

/** A well-formed SSH public key blob: length-prefixed type, then the key body. */
function keyBlob(type: string, body: string): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length, 0);
  return Buffer.concat([length, name, Buffer.from(body, 'utf8')]);
}

const HOST_KEY = keyBlob('ssh-ed25519', 'the-real-key');
const OTHER_KEY = keyBlob('ssh-ed25519', 'someone-elses-key');

function line(host: string, key: Buffer, marker = ''): string {
  return `${marker}${host} ssh-ed25519 ${key.toString('base64')}`;
}

function deps(files: Record<string, string>): KnownHostsDeps {
  return {
    readFile: async (path) => {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    appendFile: async () => {},
    home: '/home/alice',
  };
}

describe('parseKnownHostsLine', () => {
  it('skips blanks and comments', () => {
    expect(parseKnownHostsLine('')).toBeUndefined();
    expect(parseKnownHostsLine('   ')).toBeUndefined();
    expect(parseKnownHostsLine('# a comment')).toBeUndefined();
  });

  it('skips lines missing a key', () => {
    expect(parseKnownHostsLine('host.example.com ssh-ed25519')).toBeUndefined();
  });

  it('reads host patterns, type and key', () => {
    expect(parseKnownHostsLine('a.example.com,b.example.com ssh-rsa AAAA comment')).toEqual({
      marker: undefined,
      patterns: ['a.example.com', 'b.example.com'],
      keyType: 'ssh-rsa',
      key: 'AAAA',
    });
  });

  it('reads the @revoked and @cert-authority markers', () => {
    expect(parseKnownHostsLine('@revoked host ssh-rsa AAAA')?.marker).toBe('revoked');
    expect(parseKnownHostsLine('@cert-authority host ssh-rsa AAAA')?.marker).toBe('cert-authority');
  });
});

describe('hostLookupKeys', () => {
  it('uses the bare name on port 22 and the bracketed form otherwise', () => {
    expect(hostLookupKeys('host.example.com', 22)).toEqual(['host.example.com']);
    expect(hostLookupKeys('host.example.com', 2222)).toEqual(['[host.example.com]:2222']);
  });
});

describe('checkHostKey', () => {
  const entries = (...lines: string[]) =>
    lines.map((raw) => parseKnownHostsLine(raw)).filter((entry) => entry !== undefined);

  it('matches a stored key', () => {
    expect(
      checkHostKey(entries(line('host.example.com', HOST_KEY)), 'host.example.com', 22, HOST_KEY)
    ).toEqual({ kind: 'match' });
  });

  it('reports a changed key as a mismatch, not as unknown', () => {
    // This is the case worth catching: something is answering for the host with
    // a key we did not pin.
    expect(
      checkHostKey(entries(line('host.example.com', OTHER_KEY)), 'host.example.com', 22, HOST_KEY)
    ).toEqual({ kind: 'mismatch' });
  });

  it('reports a host with no entry as unknown', () => {
    expect(
      checkHostKey(entries(line('other.example.com', HOST_KEY)), 'host.example.com', 22, HOST_KEY)
    ).toEqual({ kind: 'unknown' });
  });

  it('keeps a non-default port distinct from the same name on 22', () => {
    const stored = entries(line('host.example.com', HOST_KEY));
    expect(checkHostKey(stored, 'host.example.com', 2222, HOST_KEY)).toEqual({ kind: 'unknown' });
    expect(
      checkHostKey(
        entries(line('[host.example.com]:2222', HOST_KEY)),
        'host.example.com',
        2222,
        HOST_KEY
      )
    ).toEqual({ kind: 'match' });
  });

  it('matches a hashed host entry', () => {
    const salt = Buffer.from('0123456789abcdef0123', 'utf8');
    const digest = createHmac('sha1', salt).update('host.example.com').digest('base64');
    const hashed = `|1|${salt.toString('base64')}|${digest}`;
    expect(checkHostKey(entries(line(hashed, HOST_KEY)), 'host.example.com', 22, HOST_KEY)).toEqual(
      { kind: 'match' }
    );
  });

  it('matches a wildcard pattern', () => {
    expect(
      checkHostKey(entries(line('*.example.com', HOST_KEY)), 'host.example.com', 22, HOST_KEY)
    ).toEqual({ kind: 'match' });
  });

  it('honours a negated pattern even when another pattern matches', () => {
    expect(
      checkHostKey(
        entries(line('*.example.com,!host.example.com', HOST_KEY)),
        'host.example.com',
        22,
        HOST_KEY
      )
    ).toEqual({ kind: 'unknown' });
  });

  it('refuses a revoked key', () => {
    expect(
      checkHostKey(
        entries(line('host.example.com', HOST_KEY, '@revoked ')),
        'host.example.com',
        22,
        HOST_KEY
      )
    ).toEqual({ kind: 'revoked' });
  });

  it('does not treat a cert-authority line as proof of a plain key', () => {
    // We do not validate host certificates, so a CA line must not vouch for an
    // arbitrary key. Unknown means the key still gets pinned on first use.
    expect(
      checkHostKey(
        entries(line('host.example.com', HOST_KEY, '@cert-authority ')),
        'host.example.com',
        22,
        OTHER_KEY
      )
    ).toEqual({ kind: 'unknown' });
  });

  it('accepts the right key when the host has several stored', () => {
    expect(
      checkHostKey(
        entries(line('host.example.com', OTHER_KEY), line('host.example.com', HOST_KEY)),
        'host.example.com',
        22,
        HOST_KEY
      )
    ).toEqual({ kind: 'match' });
  });
});

describe('readKnownHosts', () => {
  it('reads every file and skips ones that are missing', async () => {
    const entries = await readKnownHosts(
      ['~/.ssh/known_hosts', '/etc/ssh/ssh_known_hosts', '/nope'],
      deps({
        '/home/alice/.ssh/known_hosts': `# mine\n${line('a.example.com', HOST_KEY)}\n`,
        '/etc/ssh/ssh_known_hosts': `${line('b.example.com', HOST_KEY)}\n`,
      })
    );
    expect(entries.map((entry) => entry.patterns[0])).toEqual(['a.example.com', 'b.example.com']);
  });
});

describe('splitKnownHostsFiles', () => {
  it('splits on spaces and keeps quoted paths whole', () => {
    expect(splitKnownHostsFiles('~/.ssh/known_hosts "/etc/ssh/my hosts"')).toEqual([
      '~/.ssh/known_hosts',
      '/etc/ssh/my hosts',
    ]);
  });

  it('drops none, which is how OpenSSH says use no file', () => {
    expect(splitKnownHostsFiles('none')).toEqual([]);
    expect(splitKnownHostsFiles(undefined)).toEqual([]);
  });
});

describe('expandHomePath', () => {
  it('expands a leading tilde', () => {
    expect(expandHomePath('~/.ssh/known_hosts', '/home/alice')).toBe(
      '/home/alice/.ssh/known_hosts'
    );
    expect(expandHomePath('/etc/ssh/ssh_known_hosts', '/home/alice')).toBe(
      '/etc/ssh/ssh_known_hosts'
    );
  });
});

describe('readKeyType', () => {
  it('reads the algorithm name out of a key blob', () => {
    expect(readKeyType(HOST_KEY)).toBe('ssh-ed25519');
  });

  it('returns undefined for something that is not a key blob', () => {
    expect(readKeyType(Buffer.from('junk'))).toBeUndefined();
    expect(readKeyType(Buffer.alloc(2))).toBeUndefined();
  });
});

describe('formatKnownHostsLine', () => {
  it('writes a plain entry', () => {
    expect(formatKnownHostsLine('host.example.com', 22, 'ssh-ed25519', HOST_KEY)).toBe(
      `host.example.com ssh-ed25519 ${HOST_KEY.toString('base64')}\n`
    );
  });

  it('writes a hashed entry that reads back as a match', () => {
    const written = formatKnownHostsLine('host.example.com', 2222, 'ssh-ed25519', HOST_KEY, {
      hash: true,
      salt: Buffer.from('0123456789abcdef0123', 'utf8'),
    });
    const entry = parseKnownHostsLine(written);
    expect(entry).toBeDefined();
    expect(checkHostKey([entry!], 'host.example.com', 2222, HOST_KEY)).toEqual({ kind: 'match' });
  });
});

describe('rememberHostKey', () => {
  function recorder(existing: string | Error): {
    deps: KnownHostsDeps;
    written: string[];
  } {
    const written: string[] = [];
    return {
      written,
      deps: {
        readFile: async () => {
          if (existing instanceof Error) throw existing;
          return existing;
        },
        appendFile: async (_path, contents) => {
          written.push(contents);
        },
        home: '/home/alice',
      },
    };
  }

  const NEW_LINE = 'new.example.com ssh-ed25519 AAAA\n';

  it('starts a line when known_hosts does not end in one', async () => {
    // Appending straight onto a hand-edited file would weld the new entry to
    // the last one and lose both.
    const { deps: recording, written } = recorder('good.example.com ssh-ed25519 BBBB');
    expect(await rememberHostKey('~/.ssh/known_hosts', NEW_LINE, recording)).toBe(true);
    expect(written).toEqual([`\n${NEW_LINE}`]);
  });

  it('does not add a blank line when the file already ends in one', async () => {
    const { deps: recording, written } = recorder('good.example.com ssh-ed25519 BBBB\n');
    expect(await rememberHostKey('~/.ssh/known_hosts', NEW_LINE, recording)).toBe(true);
    expect(written).toEqual([NEW_LINE]);
  });

  it('writes the first entry of a new or empty file as-is', async () => {
    const missing = recorder(new Error('ENOENT'));
    expect(await rememberHostKey('~/.ssh/known_hosts', NEW_LINE, missing.deps)).toBe(true);
    expect(missing.written).toEqual([NEW_LINE]);

    const empty = recorder('');
    expect(await rememberHostKey('~/.ssh/known_hosts', NEW_LINE, empty.deps)).toBe(true);
    expect(empty.written).toEqual([NEW_LINE]);
  });

  it('refuses a path that is not absolute once expanded', async () => {
    const { deps: recording, written } = recorder('');
    expect(await rememberHostKey('relative/known_hosts', NEW_LINE, recording)).toBe(false);
    expect(written).toEqual([]);
  });

  it('reports failure rather than throwing when the file cannot be written', async () => {
    const { deps: recording } = recorder('');
    expect(
      await rememberHostKey('~/.ssh/known_hosts', NEW_LINE, {
        ...recording,
        appendFile: async () => {
          throw new Error('EACCES');
        },
      })
    ).toBe(false);
  });
});

describe('a real known_hosts file on disk', () => {
  it('survives a first-use append and reads back as a match', async () => {
    // The end-to-end shape of the thing: a file with no trailing newline, an
    // append, then a re-read that must find both the old and the new entry.
    const dir = await mkdtemp(join(tmpdir(), 'switch-known-hosts-'));
    const file = join(dir, 'known_hosts');
    await writeFile(file, `good.example.com ssh-ed25519 ${OTHER_KEY.toString('base64')}`);

    const realDeps: KnownHostsDeps = {
      readFile: async (path) => await readFile(path, 'utf8'),
      appendFile: async (path, contents) => await appendFile(path, contents),
      home: '/home/alice',
    };

    const line = formatKnownHostsLine('new.example.com', 2222, 'ssh-ed25519', HOST_KEY);
    expect(await rememberHostKey(file, line, realDeps)).toBe(true);

    const entries = await readKnownHosts([file], realDeps);
    expect(entries).toHaveLength(2);
    expect(checkHostKey(entries, 'good.example.com', 22, OTHER_KEY)).toEqual({ kind: 'match' });
    expect(checkHostKey(entries, 'new.example.com', 2222, HOST_KEY)).toEqual({ kind: 'match' });
  });
});
