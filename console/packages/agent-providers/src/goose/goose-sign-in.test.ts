import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { writeNodeCli } from '../testing/node-cli';
import { gooseAcp, parseGooseInfo } from './goose-acp';

/** What `goose info --verbose` 1.56.0 prints, with `settings` as config.yaml's top-level keys. */
function gooseInfo(settings: string[]): string {
  return [
    'goose Version:',
    '  Version:                  1.56.0',
    '',
    'Paths:',
    'Config dir:              /home/test/.config/goose                              missing (can create)',
    'Config yaml:             /home/test/.config/goose/config.yaml                  missing (can create)',
    '',
    'goose Configuration:',
    ...settings,
    '  extensions:',
    '    developer:',
    '      enabled: true',
    '      type: platform',
    '      name: developer',
    '',
  ].join('\n');
}

describe('parseGooseInfo', () => {
  it('reads the provider and model Goose is set up with', () => {
    expect(
      parseGooseInfo(gooseInfo(['  GOOSE_MODEL: gpt-4o', '  GOOSE_PROVIDER: openai']))
    ).toEqual({
      status: 'authenticated',
      message: 'Goose uses openai (gpt-4o). Its key is checked by the first turn.',
      models: [],
    });
  });
  it('reads a quoted provider set without a model', () => {
    expect(parseGooseInfo(gooseInfo(["  GOOSE_PROVIDER: 'anthropic'"])).message).toBe(
      'Goose uses anthropic. Its key is checked by the first turn.'
    );
  });
  it('reports a Goose with no provider as unconfigured, with the command that sets one', () => {
    expect(parseGooseInfo(gooseInfo([]))).toEqual({
      status: 'unconfigured',
      message:
        'Goose has no model provider. Choose one on the execution machine with goose configure.',
      models: [],
    });
  });
  it('ignores a provider named inside another setting', () => {
    expect(parseGooseInfo(gooseInfo(['  extra:', '    GOOSE_PROVIDER: openai'])).status).toBe(
      'unconfigured'
    );
  });
  it.each(['', 'error: unexpected argument --verbose', 'goose Version:\n  Version: 1.56.0'])(
    'reports output it cannot read as unknown: %j',
    (output) => {
      expect(parseGooseInfo(output).status).toBe('unknown');
    }
  );
});

describe('the Goose sign-in check', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  /** A goose that records its arguments and, like the real one, reads GOOSE_PROVIDER from its environment. */
  async function fakeGoose() {
    const dir = await mkdtemp(join(tmpdir(), 'goose-sign-in-'));
    dirs.push(dir);
    const info = JSON.stringify(gooseInfo(['@PROVIDER@']));
    const binaryPath = await writeNodeCli(
      dir,
      'goose',
      `require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
const provider = process.env.GOOSE_PROVIDER;
process.stdout.write(${info}.replace('@PROVIDER@\\n', provider ? '  GOOSE_PROVIDER: ' + provider + '\\n' : ''));`
    );
    return {
      binaryPath,
      dir,
      calls: async () => (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n'),
    };
  }

  it('asks info --verbose and nothing else, so the check never starts a model request', async () => {
    const goose = await fakeGoose();
    expect(
      await checkAcpSignIn(gooseAcp, {
        binaryPath: goose.binaryPath,
        cwd: goose.dir,
        env: { GOOSE_PROVIDER: 'anthropic' },
      })
    ).toMatchObject({ status: 'authenticated' });
    expect(await goose.calls()).toEqual(['["info","--verbose"]']);
  });

  it('reports a Goose with no provider in its environment or config as unconfigured', async () => {
    const goose = await fakeGoose();
    expect(
      await checkAcpSignIn(gooseAcp, { binaryPath: goose.binaryPath, cwd: goose.dir, env: {} })
    ).toMatchObject({ status: 'unconfigured' });
  });
});
