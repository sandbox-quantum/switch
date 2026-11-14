import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OPENCODE2_MODELS_ARGS, OPENCODE_MODELS_ARGS, opencodeLaunchProfileModels } from './models';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', `models-verbose-${name}.txt`), 'utf8');

/** A host whose `opencode --version` is `version`, answering anything else with `stdout`. */
const host = (version: string, stdout: string) =>
  vi.fn(async (_command: string, args: string[]) => ({
    stdout: args[0] === '--version' ? version : stdout,
  }));
const on1x = (stdout: string) => host('1.19.5\n', stdout);

describe('opencodeLaunchProfileModels', () => {
  it('asks the host for models and their variants', async () => {
    const exec = on1x(fixture('google'));

    await expect(opencodeLaunchProfileModels(exec)).resolves.toEqual([
      { id: 'google/gemini-2.5-flash', variants: ['high', 'max'] },
      { id: 'google/gemini-2.5-flash-lite', variants: ['high', 'max'] },
    ]);
    expect(exec).toHaveBeenCalledWith('opencode', OPENCODE_MODELS_ARGS);
  });

  it('asks verbosely, which is what carries the variants', () => {
    // Without `--verbose` the output is bare `provider/model` lines and the
    // variant field would have nothing to offer for any model.
    expect(OPENCODE_MODELS_ARGS).toContain('--verbose');
  });

  it('reports a local model as having no variants rather than as unknown', async () => {
    const exec = on1x(fixture('ollama'));

    await expect(opencodeLaunchProfileModels(exec)).resolves.toEqual([
      { id: 'ollama/gemma4:latest', variants: [] },
    ]);
  });

  it('fails rather than reporting a host with no models', async () => {
    // An empty list would flag every model the user types as wrong. "We could
    // not ask" and "there is nothing here" are different answers and the caller
    // shows them differently.
    const exec = on1x('');

    await expect(opencodeLaunchProfileModels(exec)).rejects.toThrow(/no models/);
  });

  it('lets a failure to run the command through to the caller', async () => {
    // OpenCode not being installed on that host is exactly the case the form
    // degrades for, so it must not be swallowed into an empty catalogue.
    const exec = vi.fn(async () => {
      throw new Error('command not found: opencode');
    });

    await expect(opencodeLaunchProfileModels(exec)).rejects.toThrow(/command not found/);
  });

  it('asks OpenCode 2 through its API, which lists variants as entries', async () => {
    const exec = host(
      'opencode v2.3.0\n',
      JSON.stringify({
        data: [
          {
            id: 'claude-fable-5-2',
            providerID: 'anthropic',
            variants: [
              { id: 'low', settings: {} },
              { id: 'high', settings: {} },
            ],
            enabled: true,
          },
          { id: 'local', providerID: 'ollama' },
          { id: 'retired', providerID: 'anthropic', enabled: false },
        ],
      })
    );

    await expect(opencodeLaunchProfileModels(exec)).resolves.toEqual([
      { id: 'anthropic/claude-fable-5-2', variants: ['low', 'high'] },
      { id: 'ollama/local', variants: [] },
    ]);
    expect(exec).toHaveBeenCalledWith('opencode', OPENCODE2_MODELS_ARGS);
    expect(exec).not.toHaveBeenCalledWith('opencode', OPENCODE_MODELS_ARGS);
  });

  it('fails on OpenCode 2 output that is not a model list', async () => {
    await expect(opencodeLaunchProfileModels(host('2.3.0', '{"error":"x"}'))).rejects.toThrow(
      /no model list/
    );
  });

  it('does not guess which OpenCode a host has', async () => {
    await expect(opencodeLaunchProfileModels(host('opencode', 'x'))).rejects.toThrow(
      /printed no version/
    );
  });
});
