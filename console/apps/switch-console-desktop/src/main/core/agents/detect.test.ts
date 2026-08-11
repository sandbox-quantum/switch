import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSwitchAgent } from './detect';

async function writeSettings(dir: string, contents: string): Promise<void> {
  const claudeDir = path.join(dir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, 'settings.local.json'), contents, 'utf8');
}

describe('detectSwitchAgent', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-console-detect-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the agent config when the SWITCH_* env block is present', async () => {
    await writeSettings(
      dir,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'https://switch-api.example.ts.net',
          SWITCH_API_TOKEN: 'secret-token-should-not-leak',
          SWITCH_AGENT_ID: '4dc89d57-6a12-41c9-814e-946a78ea419c',
        },
      })
    );

    const config = await detectSwitchAgent(dir);

    expect(config).toEqual({
      agentId: '4dc89d57-6a12-41c9-814e-946a78ea419c',
      apiEndpoint: 'https://switch-api.example.ts.net',
      dir,
    });
  });

  it('never exposes the API token', async () => {
    await writeSettings(
      dir,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'https://switch-api.example.ts.net',
          SWITCH_API_TOKEN: 'secret-token-should-not-leak',
          SWITCH_AGENT_ID: 'agent-1',
        },
      })
    );

    const config = await detectSwitchAgent(dir);

    expect(JSON.stringify(config)).not.toContain('secret-token-should-not-leak');
  });

  it('returns null when there is no settings file', async () => {
    expect(await detectSwitchAgent(dir)).toBeNull();
  });

  it('returns null when the settings file lacks the SWITCH_* env block', async () => {
    await writeSettings(dir, JSON.stringify({ env: { SOME_OTHER_VAR: 'x' } }));
    expect(await detectSwitchAgent(dir)).toBeNull();
  });

  it('returns null when SWITCH_AGENT_ID is missing', async () => {
    await writeSettings(dir, JSON.stringify({ env: { SWITCH_API_ENDPOINT: 'https://x.example' } }));
    expect(await detectSwitchAgent(dir)).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    await writeSettings(dir, '{ not valid json');
    expect(await detectSwitchAgent(dir)).toBeNull();
  });

  it('treats whitespace-only values as missing', async () => {
    await writeSettings(
      dir,
      JSON.stringify({
        env: { SWITCH_API_ENDPOINT: '   ', SWITCH_AGENT_ID: '   ' },
      })
    );
    expect(await detectSwitchAgent(dir)).toBeNull();
  });
});
