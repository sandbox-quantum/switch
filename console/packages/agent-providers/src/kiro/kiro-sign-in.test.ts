import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { writeNodeCli } from '../testing/node-cli';
import { kiroAcp, parseKiroWhoami } from './kiro-acp';

describe('parseKiroWhoami', () => {
  it('reads a signed-in account', () => {
    expect(
      parseKiroWhoami(
        '{"accountType":"BuilderId","email":"dev@example.com","region":"us-east-1","startUrl":null}\n'
      )
    ).toEqual({ status: 'authenticated', message: 'Signed in to Kiro (BuilderId).', models: [] });
  });
  it('reads a signed-out CLI, with the command that signs it in', () => {
    expect(parseKiroWhoami('{"account":null}')).toEqual({
      status: 'unauthenticated',
      message: 'Sign in on the execution machine with kiro-cli login.',
      models: [],
    });
  });
  it.each(['', 'Not logged in', 'error: unexpected argument --format', '[]', 'null'])(
    'reports output it cannot read as unknown: %j',
    (output) => {
      expect(parseKiroWhoami(output).status).toBe('unknown');
    }
  );
});

describe('the Kiro sign-in check', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  /** A kiro-cli that records its arguments and answers `whoami` like the real one. */
  async function fakeKiro(whoami: string, exitCode: number) {
    const dir = await mkdtemp(join(tmpdir(), 'kiro-sign-in-'));
    dirs.push(dir);
    const binaryPath = await writeNodeCli(
      dir,
      'kiro-cli',
      `require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(${JSON.stringify(whoami)});
process.exit(${exitCode});`
    );
    return {
      binaryPath,
      dir,
      calls: async () => (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n'),
    };
  }

  it('asks whoami and nothing else, so the check never starts a sign-in', async () => {
    const kiro = await fakeKiro('{"accountType":"Social","email":"dev@example.com"}', 0);
    expect(
      await checkAcpSignIn(kiroAcp, { binaryPath: kiro.binaryPath, cwd: kiro.dir, env: {} })
    ).toMatchObject({ status: 'authenticated' });
    expect(await kiro.calls()).toEqual(['["whoami","--format","json"]']);
  });

  it('reads the JSON a signed-out whoami prints with its nonzero exit', async () => {
    const kiro = await fakeKiro('{"account":null}\n', 1);
    expect(
      await checkAcpSignIn(kiroAcp, { binaryPath: kiro.binaryPath, cwd: kiro.dir, env: {} })
    ).toMatchObject({ status: 'unauthenticated' });
  });
});
