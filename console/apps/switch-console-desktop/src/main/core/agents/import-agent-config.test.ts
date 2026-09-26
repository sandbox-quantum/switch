import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import {
  decideArtifactSync,
  fingerprintArtifact,
  readAgentConfigFile,
  writeAgentConfigFile,
} from './agent-config-file';
import { acknowledgeDefinition, importAgentConfig } from './import-agent-config';

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-console-config-import-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const NAME = 'reviewer';
const DEF_PATH = '.claude/agents/reviewer.md';
const CONFIG_PATH = '.switch/config/reviewer.json';

const claudeRepoAgents = getPlugin('claude').behavior.repoAgents!;

function importClaude(pluginFs = createPluginFs(dir)) {
  return importAgentConfig({
    workdirFs: pluginFs,
    repoAgents: claudeRepoAgents,
    name: NAME,
    providerConfig: null,
  });
}

/** What an earlier version left behind: the definition it generated, and a
 * config file carrying that definition's fingerprint. */
async function writeGenerated(params: {
  instructions: string;
  description: string;
  settings?: RepoAgentAttributes;
}) {
  const generated = claudeRepoAgents.renderDefinition({
    ...params.settings,
    name: NAME,
    description: params.description,
    instructions: params.instructions,
  });
  await write(DEF_PATH, generated);
  await write(
    CONFIG_PATH,
    JSON.stringify({
      instructions: params.instructions,
      ...(params.settings ? { settings: params.settings } : {}),
      rendered: { [DEF_PATH]: fingerprintArtifact(generated) },
    })
  );
}

async function write(relPath: string, content: string) {
  await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
  await fs.writeFile(path.join(dir, relPath), content, 'utf8');
}

async function readRaw(relPath: string) {
  return fs.readFile(path.join(dir, relPath), 'utf8');
}

describe('importAgentConfig', () => {
  it('takes over a definition that predates the config file', async () => {
    await write(
      DEF_PATH,
      `---\nname: ${NAME}\ndescription: Reviews diffs\nmodel: haiku\n---\n\nBe thorough.\n`
    );

    expect(await importClaude()).toBe(true);

    const config = await readAgentConfigFile(createPluginFs(dir), NAME);
    expect(config?.description).toBe('Reviews diffs');
    expect(config?.instructions).toBe('Be thorough.');
    expect(config?.settings).toMatchObject({ model: 'haiku' });
  });

  it('keeps the config when the definition is still what was generated from it', async () => {
    await writeGenerated({
      instructions: 'From the config.',
      description: 'Reviews diffs',
      settings: { model: 'opus' },
    });

    await importClaude();

    const config = await readAgentConfigFile(createPluginFs(dir), NAME);
    expect(config?.instructions).toBe('From the config.');
    expect(config?.settings).toMatchObject({ model: 'opus' });
    // The description only ever lived in the definition.
    expect(config?.description).toBe('Reviews diffs');
  });

  it('takes over a hand edit made to the definition since it was generated', async () => {
    await writeGenerated({ instructions: 'Generated.', description: 'Reviews diffs' });
    await write(
      DEF_PATH,
      `---\nname: ${NAME}\ndescription: Reviews diffs\nmodel: haiku\n---\n\nHand written.\n`
    );

    await importClaude();

    const config = await readAgentConfigFile(createPluginFs(dir), NAME);
    expect(config?.instructions).toBe('Hand written.');
    expect(config?.settings).toMatchObject({ model: 'haiku' });
  });

  it('changes nothing when run again over what it already took over', async () => {
    await writeGenerated({ instructions: 'Generated.', description: 'Reviews diffs' });
    await importClaude();
    const first = await readRaw(CONFIG_PATH);

    expect(await importClaude()).toBe(false);
    expect(await readRaw(CONFIG_PATH)).toBe(first);
  });

  it('records the definition it left behind, so an older Console regenerates it', async () => {
    // An older Console still reconciles the two on every read. Without the
    // fingerprint it would take the stale definition for a hand edit and copy
    // it over the config.
    await writeGenerated({ instructions: 'Generated.', description: 'Reviews diffs' });
    await importClaude();
    const pluginFs = createPluginFs(dir);
    const saved = (await readAgentConfigFile(pluginFs, NAME))!;
    await writeAgentConfigFile(pluginFs, NAME, { ...saved, instructions: 'Saved later.' });

    const config = (await readAgentConfigFile(pluginFs, NAME))!;
    expect(
      decideArtifactSync({
        current: await readRaw(DEF_PATH),
        generated: claudeRepoAgents.renderDefinition({
          name: NAME,
          description: config.description ?? '',
          instructions: config.instructions ?? '',
        }),
        lastRendered: config.rendered?.[DEF_PATH],
      })
    ).toBe('write');
  });

  it('leaves alone a config file written over an acknowledged leftover definition', async () => {
    // What adding an agent under a name an earlier agent used writes.
    const pluginFs = createPluginFs(dir);
    await write(DEF_PATH, `---\nname: ${NAME}\ndescription: Stale\n---\n\nStale.\n`);
    await writeAgentConfigFile(
      pluginFs,
      NAME,
      await acknowledgeDefinition({
        workdirFs: pluginFs,
        repoAgents: claudeRepoAgents,
        name: NAME,
        config: { description: 'Mine', instructions: 'Mine.' },
      })
    );

    await importClaude();

    const config = await readAgentConfigFile(pluginFs, NAME);
    expect(config).toMatchObject({ instructions: 'Mine.' });
  });

  it('drops a hand-typed value this app would not offer', async () => {
    await write(
      DEF_PATH,
      `---\nname: ${NAME}\ndescription: Reviews diffs\neffort: High\nmaxTurns: 2.5\nmodel: opus\n---\n\nBe thorough.\n`
    );

    await importClaude();

    const config = await readAgentConfigFile(createPluginFs(dir), NAME);
    expect(config?.settings).toMatchObject({ model: 'opus' });
    expect(config?.settings).not.toHaveProperty('effort');
    expect(config?.settings).not.toHaveProperty('maxTurns');
  });

  it('does not take over an empty definition', async () => {
    // A definition cut off mid-write reads as a file with nothing in it; taking
    // that over is what used to blank agents' instructions.
    await writeGenerated({
      instructions: 'Keep me.',
      description: 'Reviews diffs',
      settings: { model: 'opus' },
    });
    await write(DEF_PATH, '');

    await importClaude();

    const config = await readAgentConfigFile(createPluginFs(dir), NAME);
    expect(config?.instructions).toBe('Keep me.');
    expect(config?.settings).toMatchObject({ model: 'opus' });
  });

  it('gives an agent with nothing on disk an empty config file', async () => {
    expect(await importClaude()).toBe(true);
    expect(await readAgentConfigFile(createPluginFs(dir), NAME)).toEqual({});
  });

  it('never writes the definition', async () => {
    const definition = `---\nname: ${NAME}\ndescription: Reviews diffs\n---\n\nTheirs.\n`;
    await write(DEF_PATH, definition);

    await importClaude();

    expect(await readRaw(DEF_PATH)).toBe(definition);
  });

  it('refuses to write over a config file it cannot parse', async () => {
    await write(CONFIG_PATH, '{ not json');

    await expect(importClaude()).rejects.toThrow(/not valid JSON/);
    expect(await readRaw(CONFIG_PATH)).toBe('{ not json');
  });

  it('seeds a config file from the agent row for a provider without definitions', async () => {
    const pluginFs = createPluginFs(dir);
    await importAgentConfig({
      workdirFs: pluginFs,
      repoAgents: null,
      name: NAME,
      providerConfig: {
        version: '2',
        providerId: 'codex',
        values: { model: 'gpt-5', instructions: 'Be brief.' },
      },
    });

    const config = await readAgentConfigFile(pluginFs, NAME);
    expect(config?.instructions).toBe('Be brief.');
    expect(config?.settings).toEqual({ model: 'gpt-5' });
  });

  it('prefers an existing config file over the agent row', async () => {
    const pluginFs = createPluginFs(dir);
    await write(CONFIG_PATH, JSON.stringify({ instructions: 'From the file.' }));

    expect(
      await importAgentConfig({
        workdirFs: pluginFs,
        repoAgents: null,
        name: NAME,
        providerConfig: {
          version: '2',
          providerId: 'codex',
          values: { instructions: 'From the row.' },
        },
      })
    ).toBe(false);
    expect((await readAgentConfigFile(pluginFs, NAME))?.instructions).toBe('From the file.');
  });
});
