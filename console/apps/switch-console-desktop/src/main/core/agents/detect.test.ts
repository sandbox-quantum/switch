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

async function writeStoreEntry(
  dir: string,
  name: string,
  env: Record<string, string>
): Promise<void> {
  const storeDir = path.join(dir, '.switch', 'agents');
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, `${name}.json`), JSON.stringify({ env }), 'utf8');
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

  it('finds an agent the configure skill set up, which writes no settings env', async () => {
    // The standalone path deliberately leaves `.claude/settings.local.json`
    // without a SWITCH_* block: a half-set environment is what breaks those
    // sessions. Reading the settings file alone made such a directory invisible.
    await writeStoreEntry(dir, 'claude-code.solo', {
      SWITCH_API_ENDPOINT: 'https://switch-api.example.ts.net',
      SWITCH_API_TOKEN: 'secret-token-should-not-leak',
      SWITCH_AGENT_ID: '4dc89d57-6a12-41c9-814e-946a78ea419c',
    });

    expect(await detectSwitchAgent(dir)).toEqual({
      agentId: '4dc89d57-6a12-41c9-814e-946a78ea419c',
      apiEndpoint: 'https://switch-api.example.ts.net',
      dir,
    });
  });

  it('prefers the settings file when both name an agent', async () => {
    // It is what Claude Code exports into the session, so it is what the
    // directory actually resolves as.
    await writeSettings(
      dir,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'https://from-settings.example',
          SWITCH_AGENT_ID: 'id-settings',
        },
      })
    );
    await writeStoreEntry(dir, 'claude-code.solo', {
      SWITCH_API_ENDPOINT: 'https://from-store.example',
      SWITCH_API_TOKEN: 'tok',
      SWITCH_AGENT_ID: 'id-store',
    });

    expect(await detectSwitchAgent(dir)).toEqual({
      agentId: 'id-settings',
      apiEndpoint: 'https://from-settings.example',
      dir,
    });
  });

  it('names no agent when the store holds several', async () => {
    // Supported: the session picks one with `select_agent`. Nothing here can
    // make that choice, so it must not guess which agent the directory is.
    await writeStoreEntry(dir, 'one', {
      SWITCH_API_ENDPOINT: 'https://a.example',
      SWITCH_API_TOKEN: 'tok-a',
      SWITCH_AGENT_ID: 'id-a',
    });
    await writeStoreEntry(dir, 'two', {
      SWITCH_API_ENDPOINT: 'https://a.example',
      SWITCH_API_TOKEN: 'tok-b',
      SWITCH_AGENT_ID: 'id-b',
    });

    expect(await detectSwitchAgent(dir)).toBeNull();
  });

  it('ignores an unparseable store entry and still finds the good one', async () => {
    await fs.mkdir(path.join(dir, '.switch', 'agents'), { recursive: true });
    await fs.writeFile(path.join(dir, '.switch', 'agents', 'broken.json'), '{ nope', 'utf8');
    await writeStoreEntry(dir, 'good', {
      SWITCH_API_ENDPOINT: 'https://a.example',
      SWITCH_API_TOKEN: 'tok',
      SWITCH_AGENT_ID: 'id-good',
    });

    expect(await detectSwitchAgent(dir)).toEqual({
      agentId: 'id-good',
      apiEndpoint: 'https://a.example',
      dir,
    });
  });
});
