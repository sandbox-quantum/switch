import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { readAgentConfigFile, writeAgentConfigFile } from './agent-config-file';
import { syncAgentConfig } from './agent-config-sync';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-console-config-sync-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const NAME = 'reviewer';
const DESCRIPTION = 'Reviews diffs';
const DEF_PATH = '.claude/agents/reviewer.md';

const claudeRepoAgents = getPlugin('claude').behavior.repoAgents ?? null;

function sync(pluginFs = createPluginFs(dir)) {
  return syncAgentConfig({
    workspaceFs: pluginFs,
    repoAgents: claudeRepoAgents,
    name: NAME,
    description: DESCRIPTION,
  });
}

async function readDefinition(): Promise<string> {
  return fs.readFile(path.join(dir, DEF_PATH), 'utf8');
}

describe('syncAgentConfig', () => {
  it('does nothing for a provider whose files are rebuilt at launch', async () => {
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, NAME, { instructions: 'be terse' });

    const result = await syncAgentConfig({
      workspaceFs: pluginFs,
      repoAgents: null,
      name: NAME,
      description: DESCRIPTION,
    });

    expect(result.action).toBe('not-applicable');
    expect(result.config.instructions).toBe('be terse');
  });

  it('generates the definition from the config', async () => {
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, NAME, {
      instructions: 'Be careful.',
      settings: { model: 'opus' },
    });

    const result = await sync(pluginFs);

    expect(result.action).toBe('written');
    const definition = await readDefinition();
    expect(definition).toContain('model: opus');
    expect(definition).toContain('Be careful.');
  });

  it('reports in-sync on a second run, rather than rewriting', async () => {
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, NAME, { instructions: 'Be careful.' });
    await sync(pluginFs);

    expect((await sync(pluginFs)).action).toBe('in-sync');
  });

  it('regenerates when the config changed and nobody touched the definition', async () => {
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, NAME, { instructions: 'First.' });
    await sync(pluginFs);

    const config = (await readAgentConfigFile(pluginFs, NAME)) ?? {};
    await writeAgentConfigFile(pluginFs, NAME, { ...config, instructions: 'Second.' });
    const result = await sync(pluginFs);

    expect(result.action).toBe('written');
    expect(await readDefinition()).toContain('Second.');
  });

  it('reads a hand-edited definition back into the config instead of overwriting it', async () => {
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, NAME, { instructions: 'Generated.' });
    await sync(pluginFs);

    // Somebody edits the subagent file directly, as they always could.
    await pluginFs.write(
      DEF_PATH,
      `---\nname: ${NAME}\ndescription: ${DESCRIPTION}\nmodel: haiku\n---\n\nHand written.\n`
    );
    const result = await sync(pluginFs);

    expect(result.action).toBe('adopted');
    expect(result.config.instructions).toBe('Hand written.');
    expect(result.config.settings).toMatchObject({ model: 'haiku' });
    expect(await readDefinition()).toContain('Hand written.');
  });

  it('settles after adopting, rather than reporting a hand edit forever', async () => {
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, NAME, { instructions: 'Generated.' });
    await sync(pluginFs);
    await pluginFs.write(
      DEF_PATH,
      `---\nname: ${NAME}\ndescription: ${DESCRIPTION}\n---\n\nHand written.\n`
    );

    expect((await sync(pluginFs)).action).toBe('adopted');
    expect((await sync(pluginFs)).action).toBe('in-sync');
  });

  it('adopts a definition that already existed before this app ever wrote one', async () => {
    // An agent onboarded from a directory someone else set up. Overwriting it
    // would discard a prompt this app never wrote.
    const pluginFs = createPluginFs(dir);
    await pluginFs.write(
      DEF_PATH,
      `---\nname: ${NAME}\ndescription: ${DESCRIPTION}\n---\n\nTheirs, not ours.\n`
    );

    const result = await sync(pluginFs);

    expect(result.action).toBe('adopted');
    expect(result.config.instructions).toBe('Theirs, not ours.');
  });

  it('picks up the config an agent already carries when onboarded elsewhere', async () => {
    // The whole point of the file being committed: a second machine opening the
    // same working directory gets the same agent.
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, NAME, {
      instructions: 'Set on another machine.',
      settings: { model: 'opus' },
    });

    const result = await sync(pluginFs);

    expect(result.config.instructions).toBe('Set on another machine.');
    expect(await readDefinition()).toContain('Set on another machine.');
  });

  it('writes the definition when there is no config at all', async () => {
    const result = await sync();

    expect(result.action).toBe('written');
    // No instructions set, so the description stands in as the prompt.
    expect(await readDefinition()).toContain(DESCRIPTION);
  });
});
