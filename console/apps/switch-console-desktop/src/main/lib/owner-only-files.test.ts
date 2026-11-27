import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeDirOwnerOnly,
  makeFileOwnerOnly,
  restrictExistingFilesToOwner,
} from './owner-only-files';

const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(process.platform === 'win32')('owner-only files', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'owner-only-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a folder 0700, and narrows one that was open', () => {
    const fresh = join(root, 'fresh');
    makeDirOwnerOnly(fresh);
    expect(mode(fresh)).toBe(0o700);

    const open = join(root, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    makeDirOwnerOnly(open);
    expect(mode(open)).toBe(0o700);
  });

  it('creates a file 0600, and narrows one that was open without touching its content', () => {
    const fresh = join(root, 'fresh.db');
    makeFileOwnerOnly(fresh);
    expect(mode(fresh)).toBe(0o600);
    expect(readFileSync(fresh, 'utf8')).toBe('');

    const open = join(root, 'open.db');
    writeFileSync(open, 'kept', { mode: 0o644 });
    chmodSync(open, 0o644);
    makeFileOwnerOnly(open);
    expect(mode(open)).toBe(0o600);
    expect(readFileSync(open, 'utf8')).toBe('kept');
  });

  it('narrows the files that exist and skips the ones that do not', () => {
    const present = join(root, 'present.log');
    writeFileSync(present, 'x', { mode: 0o644 });
    chmodSync(present, 0o644);

    restrictExistingFilesToOwner([present, join(root, 'absent.log')]);

    expect(mode(present)).toBe(0o600);
  });
});
