import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeNodeCli } from '../testing/node-cli';
import { checkPiSignIn, parsePiModelList, PI_SIGN_IN_REQUIRED } from './sign-in';

// What Pi 1.5.0 printed, signed in to Mistral (two of its rows) and to nothing.
const TABLE = [
  'provider  model                     context  max-out  thinking  images',
  'mistral   devstral-medium-latest    262.1K   262.1K   no        no    ',
  'mistral   mistral-medium-latest     262.1K   262.1K   yes       yes   ',
  '',
].join('\n');
const NO_MODELS = [
  'No models available. Use /login to log into a provider via OAuth or API key. See:',
  '  /opt/node/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md',
  '  /opt/node/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md',
  '',
].join('\n');

describe('reading what pi --list-models prints', () => {
  it('is signed in to every provider with a model listed', () => {
    expect(parsePiModelList(TABLE)).toEqual({
      status: 'authenticated',
      message: 'Signed in to mistral.',
      models: [],
    });
    expect(
      parsePiModelList(
        `${TABLE}openai    gpt-5.1                   400K     128K     yes       yes   \n`
      ).message
    ).toBe('Signed in to mistral, openai.');
  });

  it('is signed out when Pi has no model it can use', () => {
    expect(parsePiModelList(NO_MODELS)).toMatchObject({
      status: 'unauthenticated',
      message: PI_SIGN_IN_REQUIRED,
    });
  });

  it('does not know, and says what Pi said, for anything else', () => {
    expect(parsePiModelList('', 'Error: Cannot find module "@earendil-works/pi-ai"\n')).toEqual({
      status: 'unknown',
      message:
        'Pi did not list the models it can use ("Error: Cannot find module "@earendil-works/pi-ai"").',
      models: [],
    });
  });
});

describe('checking the sign-in', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-sign-in-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function pi(models: string): Promise<string> {
    return await writeNodeCli(
      dir,
      'pi',
      `const args = process.argv.slice(2).join(' ');
if (args !== '--list-models' || process.env.PI_OFFLINE !== '1') {
  console.error('unexpected: ' + args);
  process.exit(2);
}
process.stdout.write(${JSON.stringify(models)});`
    );
  }

  it('lists the models offline, starting no login', async () => {
    const binaryPath = await pi(TABLE);
    expect(
      await checkPiSignIn({ binaryPath, cwd: dir, env: { PATH: process.env.PATH ?? '' } })
    ).toMatchObject({
      status: 'authenticated',
    });
  });

  it('reads a signed-out Pi', async () => {
    const binaryPath = await pi(NO_MODELS);
    expect(
      await checkPiSignIn({ binaryPath, cwd: dir, env: { PATH: process.env.PATH ?? '' } })
    ).toMatchObject({
      status: 'unauthenticated',
    });
  });
});
