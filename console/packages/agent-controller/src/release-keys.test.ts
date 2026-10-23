import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRUSTED_RELEASE_KEYS } from './release-keys';
import { publicKeyOf } from './release-signing';
import { signRelease, testSigningKey } from './testing/release-signing';

const installSh = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'install.sh'),
  'utf8'
);

/** The text between `# BEGIN <name>` and `# END <name>` in install.sh, inside its single quotes. */
function installShBlock(name: string): string {
  const match = new RegExp(`# BEGIN ${name}\\n[A-Z_]+='([^']*)'\\n# END ${name}\\n`).exec(
    installSh
  );
  if (!match) throw new Error(`install.sh has no ${name} block.`);
  return match[1]!;
}

describe('TRUSTED_RELEASE_KEYS', () => {
  it('lists Ed25519 public keys under ids of their own', () => {
    for (const key of TRUSTED_RELEASE_KEYS) expect(() => publicKeyOf(key)).not.toThrow();
    const ids = TRUSTED_RELEASE_KEYS.map((key) => key.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it('is the list install.sh carries', () => {
    const lines = installShBlock('TRUSTED RELEASE KEYS')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, publicKey, ...rest] = line.split(/\s+/);
        expect(rest).toEqual([]);
        return { id, publicKey };
      });
    expect(lines).toEqual(TRUSTED_RELEASE_KEYS.map(({ id, publicKey }) => ({ id, publicKey })));
  });
});

describe("install.sh's signature check", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'install-sh-verify-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const script = installShBlock('VERIFY RELEASE');
  const key = testSigningKey('release-test');
  const other = testSigningKey('release-other');

  /** Runs the check as install.sh does; its stdout, or the error it fails with. */
  function check(signature: string, keys: string, version = '0.31.0') {
    const file = join(dir, 'package.tgz');
    writeFileSync(file, 'a package');
    writeFileSync(`${file}.sig`, signature);
    try {
      return {
        ok: true,
        out: execFileSync(process.execPath, ['-e', script, file, `${file}.sig`, version], {
          env: { TRUSTED_RELEASE_KEYS: keys },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      };
    } catch (error) {
      return { ok: false, out: String((error as { stderr?: string }).stderr) };
    }
  }

  const sha = createHash('sha256').update('a package').digest('hex');
  const line = (k: typeof key) => `${k.trusted.id} ${k.trusted.publicKey}`;

  it('accepts a release signed with a listed key, and names the key', () => {
    expect(check(signRelease(key, '0.31.0', sha), `\n${line(other)}\n${line(key)}\n`)).toEqual({
      ok: true,
      out: 'release-test',
    });
  });

  it('refuses a wrong key, a tampered package, another version, garbage, and no keys', () => {
    expect(check(signRelease(other, '0.31.0', sha), line(key))).toMatchObject({
      ok: false,
      out: expect.stringMatching(/does not verify/),
    });
    expect(check(signRelease(key, '0.31.0', 'c'.repeat(64)), line(key)).ok).toBe(false);
    expect(check(signRelease(key, '0.30.0', sha), line(key)).ok).toBe(false);
    expect(check('nonsense', line(key))).toMatchObject({
      ok: false,
      out: expect.stringMatching(/not a base64 Ed25519 signature/),
    });
    expect(check(signRelease(key, '0.31.0', sha), '\n')).toMatchObject({
      ok: false,
      out: expect.stringMatching(/trusts no release signing key/),
    });
  });
});

describe('scripts/sign-release.mjs', () => {
  const signScript = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'sign-release.mjs'
  );
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sign-release-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sign(env: Record<string, string>) {
    const file = join(dir, 'switch-agent-controller-0.31.0.tgz');
    writeFileSync(file, 'a package');
    try {
      execFileSync(process.execPath, [signScript, file, '0.31.0'], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return '';
    } catch (error) {
      return String((error as { stderr?: string }).stderr);
    }
  }

  it('reads the same trusted keys under plain node as the controller is built with', () => {
    const read = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { TRUSTED_RELEASE_KEYS } = await import(${JSON.stringify(join(dirname(signScript), '..', 'src', 'release-keys.ts'))}); process.stdout.write(JSON.stringify(TRUSTED_RELEASE_KEYS));`,
      ],
      { encoding: 'utf8' }
    );
    expect(TRUSTED_RELEASE_KEYS.length).toBeGreaterThan(0);
    expect(JSON.parse(read)).toEqual(TRUSTED_RELEASE_KEYS);
  });

  it('fails loud with no signing key', () => {
    expect(sign({})).toMatch(/CONTROLLER_RELEASE_SIGNING_KEY is not set/);
  });

  it('refuses a key whose public half no controller trusts', () => {
    const key = testSigningKey('untrusted');
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const said = sign({ CONTROLLER_RELEASE_SIGNING_KEY: pem });
    expect(said).toMatch(/is not in src\/release-keys.ts/);
  });
});
