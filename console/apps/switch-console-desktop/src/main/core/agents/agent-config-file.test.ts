import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import {
  decideArtifactSync,
  fingerprintArtifact,
  parseAgentConfigFile,
  readAgentConfigFile,
  serialiseAgentConfigFile,
  writeAgentConfigFile,
} from './agent-config-file';
import { agentConfigRelativePath, SWITCH_AGENTS_DIR_RELATIVE } from './switch-settings-paths';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-console-agent-config-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readRaw(slug: string): Promise<string> {
  return fs.readFile(path.join(dir, agentConfigRelativePath(slug)), 'utf8');
}

describe('agent config file location', () => {
  it('sits outside the gitignored credentials directory', () => {
    // The credentials directory is ignored wholesale because its files carry
    // the agent's token; config written inside it could never be committed,
    // which is the whole point of this file.
    expect(agentConfigRelativePath('coder').startsWith(`${SWITCH_AGENTS_DIR_RELATIVE}/`)).toBe(
      false
    );
    expect(agentConfigRelativePath('coder')).toBe('.switch/config/coder.json');
  });
});

describe('serialiseAgentConfigFile', () => {
  it('omits instructions that were never set', () => {
    expect(JSON.parse(serialiseAgentConfigFile({}))).toEqual({});
  });

  it('omits instructions cleared back to empty, rather than writing a blank', () => {
    // Absent means "not specified", which leaves the provider's own default in
    // force — a blank string pinned into the file would not.
    expect(JSON.parse(serialiseAgentConfigFile({ instructions: '' }))).toEqual({});
  });

  it('writes the prompt exactly as given, whitespace included', () => {
    const instructions = '  You review code.\n\n  Be terse.\n';
    expect(JSON.parse(serialiseAgentConfigFile({ instructions }))).toEqual({ instructions });
  });

  it('keeps keys it does not model, so a newer app’s settings survive an older one', () => {
    const out = JSON.parse(
      serialiseAgentConfigFile({ instructions: 'hi' }, { futureSetting: { a: 1 } })
    );
    expect(out).toEqual({ futureSetting: { a: 1 }, instructions: 'hi' });
  });
});

describe('parseAgentConfigFile', () => {
  it('reads instructions', () => {
    expect(parseAgentConfigFile('{"instructions":"be terse"}')).toEqual({
      instructions: 'be terse',
    });
  });

  it('treats a file with no instructions as none set', () => {
    expect(parseAgentConfigFile('{}')).toEqual({});
  });

  it('throws on malformed JSON rather than reading as empty', () => {
    // Silently reading as empty would launch the agent with no prompt and
    // overwrite the user's file on the next write.
    expect(() => parseAgentConfigFile('{not json')).toThrow(/not valid JSON/);
  });

  it('throws when the file is not an object', () => {
    expect(() => parseAgentConfigFile('["nope"]')).toThrow(/JSON object/);
  });

  it('ignores an instructions value of the wrong type', () => {
    expect(parseAgentConfigFile('{"instructions":42}')).toEqual({});
  });
});

describe('readAgentConfigFile / writeAgentConfigFile', () => {
  it('reads back what it wrote', async () => {
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, 'coder', { instructions: 'You review code.' });

    expect(await readAgentConfigFile(pluginFs, 'coder')).toEqual({
      instructions: 'You review code.',
    });
  });

  it('reads null for an agent that has no config file', async () => {
    expect(await readAgentConfigFile(createPluginFs(dir), 'nobody')).toBeNull();
  });

  it('preserves unmodelled keys across a write', async () => {
    const pluginFs = createPluginFs(dir);
    await pluginFs.write(
      agentConfigRelativePath('coder'),
      JSON.stringify({ instructions: 'old', somethingElse: true })
    );

    await writeAgentConfigFile(pluginFs, 'coder', { instructions: 'new' });

    expect(JSON.parse(await readRaw('coder'))).toEqual({
      somethingElse: true,
      instructions: 'new',
    });
  });

  it('drops instructions from the file when they are cleared', async () => {
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, 'coder', { instructions: 'temporary' });

    await writeAgentConfigFile(pluginFs, 'coder', { instructions: '' });

    expect(JSON.parse(await readRaw('coder'))).toEqual({});
    expect(await readAgentConfigFile(pluginFs, 'coder')).toEqual({});
  });

  it('writes no credentials into the file', async () => {
    const pluginFs = createPluginFs(dir);
    await writeAgentConfigFile(pluginFs, 'coder', { instructions: 'You review code.' });

    expect(await readRaw('coder')).not.toMatch(/token|api_key|apiKey/i);
  });
});

describe('settings', () => {
  it('keeps a false or zero value, which are choices, not absences', () => {
    const out = JSON.parse(
      serialiseAgentConfigFile({ settings: { background: false, maxTurns: 0 } })
    );
    expect(out.settings).toEqual({ background: false, maxTurns: 0 });
  });

  it('drops blanks, empty lists and nulls, which are not choices', () => {
    const out = JSON.parse(
      serialiseAgentConfigFile({ settings: { model: '', tools: [], effort: null, keep: 'yes' } })
    );
    expect(out.settings).toEqual({ keep: 'yes' });
  });

  it('omits the settings key entirely when nothing is set', () => {
    expect(JSON.parse(serialiseAgentConfigFile({ settings: { model: '' } }))).toEqual({});
  });

  it('round-trips through parse', () => {
    const config = { instructions: 'be terse', settings: { model: 'opus', tools: ['Read'] } };
    expect(parseAgentConfigFile(serialiseAgentConfigFile(config))).toEqual(config);
  });
});

describe('decideArtifactSync', () => {
  const generated = 'GENERATED';

  it('writes when the artifact does not exist yet', () => {
    expect(decideArtifactSync({ current: null, generated, lastRendered: undefined })).toBe('write');
  });

  it('reports in-sync when the artifact already matches', () => {
    expect(
      decideArtifactSync({
        current: generated,
        generated,
        lastRendered: fingerprintArtifact(generated),
      })
    ).toBe('in-sync');
  });

  it('writes when the artifact is exactly what we last generated', () => {
    // The config moved on; nothing local would be lost by regenerating.
    const previous = 'WHAT WE WROTE LAST TIME';
    expect(
      decideArtifactSync({
        current: previous,
        generated,
        lastRendered: fingerprintArtifact(previous),
      })
    ).toBe('write');
  });

  it('adopts when the artifact was edited since we generated it', () => {
    expect(
      decideArtifactSync({
        current: 'SOMEONE EDITED THIS BY HAND',
        generated,
        lastRendered: fingerprintArtifact('WHAT WE WROTE LAST TIME'),
      })
    ).toBe('adopt');
  });

  it('adopts an existing artifact we have never generated', () => {
    // An agent set up before this existed, or by someone else. Treating it as
    // ours to overwrite would discard a prompt this app never wrote.
    expect(
      decideArtifactSync({ current: 'HAND WRITTEN', generated, lastRendered: undefined })
    ).toBe('adopt');
  });
});
