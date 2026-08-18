import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The connector's own installer, reached in the repo rather than through the
// workspace: `connectors/opencode-plugin` is published on its own and is
// deliberately not a workspace member.
import {
  install,
  installedVersion,
  uninstall,
} from '../../../../../../../connectors/opencode-plugin/install.js';

/**
 * What a user runs when there is no Switch Console. It edits a file the user
 * owns and shares with every other OpenCode session on the machine, so the
 * failure that matters is not "the install did not happen" — it is an install
 * that takes something else out with it.
 */
describe('the OpenCode connector installer', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'opencode-connector-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function config(): Record<string, any> {
    return JSON.parse(readFileSync(join(configDir, 'opencode.json'), 'utf8'));
  }

  function writeConfig(value: unknown): void {
    writeFileSync(join(configDir, 'opencode.json'), `${JSON.stringify(value, null, 2)}\n`);
  }

  it('registers the Switch MCP server', async () => {
    await install(configDir);

    expect(config().mcp.switch).toMatchObject({ type: 'local', enabled: true });
  });

  it('registers it exactly as the connector declares it', async () => {
    const declared = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../../../../connectors/opencode-plugin/opencode.json'),
        'utf8'
      )
    ) as { mcp: Record<string, unknown> };

    await install(configDir);

    expect(config().mcp.switch).toEqual(declared.mcp.switch);
  });

  it('writes every skill the connector ships, including the standalone one', async () => {
    await install(configDir);

    expect(existsSync(join(configDir, 'skills', 'switch', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(configDir, 'skills', 'configure', 'SKILL.md'))).toBe(true);
  });

  it('names each skill directory to match the skill, as OpenCode requires', async () => {
    await install(configDir);

    for (const name of ['switch', 'configure']) {
      const content = readFileSync(join(configDir, 'skills', name, 'SKILL.md'), 'utf8');
      expect(/^---\n(?:.*\n)*?name:\s*"?([\w-]+)"?\s*$/m.exec(content)?.[1]).toBe(name);
    }
  });

  /**
   * The config is the user's, not ours. An install that resets their model or
   * drops an MCP server they added is a worse outcome than one that fails.
   */
  it('leaves the rest of the config alone', async () => {
    writeConfig({
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4-5',
      mcp: { other: { type: 'local', command: ['true'] } },
    });

    await install(configDir);

    expect(config().model).toBe('anthropic/claude-sonnet-4-5');
    expect(config().mcp.other).toEqual({ type: 'local', command: ['true'] });
  });

  it('takes only its own entry back out on uninstall', async () => {
    writeConfig({ mcp: { other: { type: 'local', command: ['true'] } } });
    await install(configDir);

    await uninstall(configDir);

    expect(config().mcp.other).toBeDefined();
    expect(config().mcp.switch).toBeUndefined();
    expect(existsSync(join(configDir, 'skills', 'switch'))).toBe(false);
    expect(existsSync(join(configDir, 'skills', 'configure'))).toBe(false);
  });

  it('is idempotent', async () => {
    await install(configDir);
    const first = config();

    await install(configDir);

    expect(config()).toEqual(first);
  });

  /**
   * OpenCode adds `$schema` to its own config when it is missing, so writing it
   * here keeps an install from showing up as a spurious change the next time
   * OpenCode rewrites the file.
   */
  it('writes the schema OpenCode would add itself', async () => {
    await install(configDir);

    expect(config().$schema).toBe('https://opencode.ai/config.json');
  });

  /**
   * Each of these parses as JSON, or looks close enough to work, and each one
   * silently did the wrong thing before: an array root took the assignments and
   * dropped them on serialise, so the install reported success having changed
   * nothing; a non-object `mcp` was spread into a numeric-keyed object, quietly
   * reshaping whatever was there.
   */
  describe('a config it cannot safely edit', () => {
    it('refuses one that is not valid JSON', async () => {
      writeFileSync(join(configDir, 'opencode.json'), '{ this is not json');

      await expect(install(configDir)).rejects.toThrow(/not valid JSON/);
    });

    it.each([
      ['an array root', '[1, 2, 3]'],
      ['a string root', '"nope"'],
      ['a null root', 'null'],
    ])('refuses %s rather than reporting success', async (_name, content) => {
      writeFileSync(join(configDir, 'opencode.json'), content);

      await expect(install(configDir)).rejects.toThrow(/not a JSON object/);
    });

    it.each([
      ['an array', '{"mcp": ["not", "an", "object"]}'],
      ['a string', '{"mcp": "oops"}'],
    ])('refuses an mcp value that is %s, rather than reshaping it', async (_name, content) => {
      writeFileSync(join(configDir, 'opencode.json'), content);

      await expect(install(configDir)).rejects.toThrow(/"mcp" value that is not an object/);
      expect(readFileSync(join(configDir, 'opencode.json'), 'utf8')).toBe(content);
    });

    it('refuses on uninstall too, instead of crashing part way through', async () => {
      writeFileSync(join(configDir, 'opencode.json'), '{"mcp": "oops"}');

      await expect(uninstall(configDir)).rejects.toThrow(/"mcp" value that is not an object/);
    });
  });

  /**
   * `switch` and `configure` are ordinary words, and the skill directory is
   * shared with whatever the user writes there themselves. Install used to
   * overwrite a same-named skill without a word, and uninstall then removed the
   * whole directory — taking files this tool never wrote with it.
   */
  describe("a skill directory it does not own", () => {
    it('refuses to overwrite a skill someone else wrote', async () => {
      mkdirSync(join(configDir, 'skills', 'configure'), { recursive: true });
      writeFileSync(join(configDir, 'skills', 'configure', 'SKILL.md'), '# my own notes\n');

      await expect(install(configDir)).rejects.toThrow(/was not written by this connector/);
      expect(readFileSync(join(configDir, 'skills', 'configure', 'SKILL.md'), 'utf8')).toBe(
        '# my own notes\n'
      );
    });

    it('refuses before touching the config, so the two cannot get out of step', async () => {
      mkdirSync(join(configDir, 'skills', 'switch'), { recursive: true });
      writeFileSync(join(configDir, 'skills', 'switch', 'SKILL.md'), 'mine\n');
      writeConfig({ model: 'anthropic/claude-sonnet-4-5' });

      await expect(install(configDir)).rejects.toThrow();
      expect(config().mcp).toBeUndefined();
    });

    it('keeps files the user left beside a skill it did write', async () => {
      await install(configDir);
      writeFileSync(join(configDir, 'skills', 'switch', 'my-notes.md'), 'notes\n');

      await uninstall(configDir);

      expect(existsSync(join(configDir, 'skills', 'switch', 'my-notes.md'))).toBe(true);
      expect(existsSync(join(configDir, 'skills', 'switch', 'SKILL.md'))).toBe(false);
      expect(existsSync(join(configDir, 'skills', 'configure'))).toBe(false);
    });

    /**
     * A skill sharing a name with one this package ships, that no install ever
     * wrote. Uninstall must not take it, and must not pretend it did.
     */
    it('names what it left behind rather than abandoning it silently', async () => {
      await install(configDir);
      writeFileSync(
        join(configDir, 'switch-connector.json'),
        JSON.stringify({ version: '0.1.2', skills: ['switch'] })
      );
      writeFileSync(join(configDir, 'skills', 'configure', 'SKILL.md'), '# my own notes\n');

      const { removedSkills, left } = await uninstall(configDir);

      expect(removedSkills).toEqual(['switch']);
      expect(left).toEqual([join(configDir, 'skills', 'configure', 'SKILL.md')]);
      expect(readFileSync(join(configDir, 'skills', 'configure', 'SKILL.md'), 'utf8')).toBe(
        '# my own notes\n'
      );
    });

    it('re-installing over its own skills is fine', async () => {
      await install(configDir);

      await expect(install(configDir)).resolves.toBeDefined();
    });
  });

  /**
   * Switch Console writes this connector itself, and its record names no
   * skills — so every machine that already has the connector looks, to a naive
   * ownership check, like one where a stranger wrote the skill. That is the
   * normal case, not an edge one, and refusing there makes the command
   * unusable for almost everybody.
   */
  describe('over an install Switch Console already wrote', () => {
    function asSwitchConsoleLeftIt({ skillContent }: { skillContent: string }): void {
      mkdirSync(join(configDir, 'skills', 'switch'), { recursive: true });
      writeFileSync(join(configDir, 'skills', 'switch', 'SKILL.md'), skillContent);
      writeFileSync(
        join(configDir, 'switch-connector.json'),
        JSON.stringify({ version: '0.1.2', runtime: '@sandboxaq/switch-agent-runtime@0.3.1' })
      );
      writeConfig({ mcp: { switch: { type: 'local', command: ['npx'] } } });
    }

    it('installs over it', async () => {
      asSwitchConsoleLeftIt({ skillContent: 'whatever it shipped\n' });

      await expect(install(configDir)).resolves.toBeDefined();
      expect(existsSync(join(configDir, 'skills', 'configure', 'SKILL.md'))).toBe(true);
    });

    it('uninstalls it rather than reporting success and leaving it', async () => {
      asSwitchConsoleLeftIt({ skillContent: 'whatever it shipped\n' });

      const { removedSkills, left } = await uninstall(configDir);

      expect(removedSkills).toContain('switch');
      expect(left).toEqual([]);
      expect(existsSync(join(configDir, 'skills', 'switch'))).toBe(false);
    });
  });

  describe('reporting what is installed', () => {
    it('reports nothing before an install', async () => {
      expect(await installedVersion(configDir)).toBeNull();
    });

    it('reports the version afterwards', async () => {
      await install(configDir);

      expect(await installedVersion(configDir)).toMatch(/^\d+\.\d+\.\d+/);
    });

    /**
     * The marker alone is not proof. Editing `opencode.json` by hand can leave
     * it behind with no server registered, and reporting that as installed
     * hides the reason the session has no Switch tools.
     */
    it('reports nothing when the server is gone but the marker remains', async () => {
      await install(configDir);
      writeConfig({ mcp: {} });

      expect(await installedVersion(configDir)).toBeNull();
    });

    it('reports nothing after an uninstall', async () => {
      await install(configDir);
      await uninstall(configDir);

      expect(await installedVersion(configDir)).toBeNull();
    });
  });

  /**
   * OpenCode reads `opencode.json` and `opencode.jsonc` and merges both, and on
   * a key they both define the `.jsonc` wins — measured against OpenCode 1.18.
   * An install that writes the `.json` while a `.jsonc` defines the same server
   * would report success and then be ignored by every session.
   */
  describe('when a .jsonc config is also present', () => {
    it('refuses when it defines the same server, rather than being shadowed', async () => {
      writeFileSync(
        join(configDir, 'opencode.jsonc'),
        JSON.stringify({ mcp: { switch: { type: 'local', command: ['theirs'] } } })
      );

      await expect(install(configDir)).rejects.toThrow(/takes precedence/);
      expect(existsSync(join(configDir, 'opencode.json'))).toBe(false);
    });

    it('installs normally when it defines something else', async () => {
      writeFileSync(
        join(configDir, 'opencode.jsonc'),
        JSON.stringify({ mcp: { other: { type: 'local', command: ['theirs'] } } })
      );

      await install(configDir);

      expect(config().mcp.switch).toBeDefined();
    });
  });

  /**
   * The command, rather than the functions the tests above import.
   *
   * npm installs a `bin` as a symlink, so what a user runs is a link in
   * `node_modules/.bin` — a path no import-based test takes. That is how a
   * version of this shipped that did nothing at all and exited 0 when installed
   * the normal way, while passing every test and working when run as a file.
   */
  describe('run as the command npm installs', () => {
    let binDir: string;
    let bin: string;

    beforeEach(() => {
      binDir = mkdtempSync(join(tmpdir(), 'opencode-bin-'));
      bin = join(binDir, 'switch-connector-opencode');
      symlinkSync(
        resolve(__dirname, '../../../../../../../connectors/opencode-plugin/install.js'),
        bin
      );
    });

    afterEach(() => {
      rmSync(binDir, { recursive: true, force: true });
    });

    function run(...args: string[]): { status: number; output: string } {
      try {
        return {
          status: 0,
          output: execFileSync(process.execPath, [bin, ...args, '--config-dir', configDir], {
            encoding: 'utf8',
            stdio: 'pipe',
          }),
        };
      } catch (error) {
        const failure = error as { status: number; stdout: string; stderr: string };
        return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
      }
    }

    it('installs', () => {
      const { status, output } = run('install');

      expect(status).toBe(0);
      expect(output).toContain('Installed the Switch connector');
      expect(existsSync(join(configDir, 'skills', 'configure', 'SKILL.md'))).toBe(true);
    });

    it('reports status, and fails when nothing is installed', () => {
      expect(run('status').status).toBe(1);

      run('install');

      const installed = run('status');
      expect(installed.status).toBe(0);
      expect(installed.output).toMatch(/Switch connector \d+\.\d+\.\d+ installed/);
    });

    it('uninstalls', () => {
      run('install');

      const { status } = run('uninstall');

      expect(status).toBe(0);
      expect(config().mcp).toBeUndefined();
    });

    it('surfaces a refusal rather than exiting as though it worked', () => {
      writeFileSync(join(configDir, 'opencode.json'), '[1, 2, 3]');

      const { status, output } = run('install');

      expect(status).toBe(1);
      expect(output).toContain('not a JSON object');
    });

    it('rejects an unknown command and an unknown flag', () => {
      expect(run('frobnicate').status).toBe(2);
      expect(run('install', '--frobnicate').status).toBe(1);
    });
  });

  it('creates the config directory when there is none', async () => {
    const fresh = join(configDir, 'nested', 'opencode');
    mkdirSync(join(configDir, 'nested'));

    await install(fresh);

    expect(existsSync(join(fresh, 'opencode.json'))).toBe(true);
  });
});
