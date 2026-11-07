import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AMP_PLUGIN_FILENAME } from './approval-plugin';
import {
  ampMcpServer,
  ampSessionDirectory,
  ampUserConfigRoot,
  prepareAmpSessionHome,
  removeAmpSessionHome,
} from './home';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function userHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'amp-home-'));
  dirs.push(home);
  return home;
}

describe('ampUserConfigRoot', () => {
  it('follows XDG_CONFIG_HOME, else ~/.config', () => {
    expect(ampUserConfigRoot({ XDG_CONFIG_HOME: '/x', HOME: '/h' })).toBe('/x');
    expect(ampUserConfigRoot({ HOME: '/h' })).toBe(join('/h', '.config'));
  });
});

describe('ampMcpServer', () => {
  it('writes an HTTP server with its headers and a stdio server naming forwarded variables', () => {
    expect(
      ampMcpServer({ transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { a: 'b' } }, {})
    ).toEqual({ url: 'http://127.0.0.1:1/mcp', headers: { a: 'b' } });
    expect(
      ampMcpServer(
        { transport: 'stdio', command: 'node', args: ['s.js'], envVars: ['TOKEN', 'MISSING'] },
        { TOKEN: 'secret' }
      )
    ).toEqual({ command: 'node', args: ['s.js'], env: { TOKEN: '${TOKEN}' } });
  });
});

describe('prepareAmpSessionHome', () => {
  it('writes the plugin, links the user’s configuration and merges the settings', async () => {
    const home = await userHome();
    await mkdir(join(home, '.config', 'amp', 'plugins'), { recursive: true });
    await mkdir(join(home, '.config', 'git'), { recursive: true });
    await writeFile(join(home, '.config', 'git', 'config'), '[user]\n');
    await writeFile(join(home, '.config', 'amp', 'secrets.json'), '{}');
    await writeFile(join(home, '.config', 'amp', 'plugins', 'mine.ts'), 'export default () => {}');
    await writeFile(
      join(home, '.config', 'amp', 'settings.jsonc'),
      '{\n  // mine\n  "amp.showCosts": false,\n  "amp.mcpServers": { "switch": { "url": "http://stale" }, "linear": { "url": "https://mcp.linear.app/sse" } },\n}\n'
    );
    const directory = ampSessionDirectory(join(home, 'sessions'), 'session-1');
    const prepared = await prepareAmpSessionHome({
      directory,
      env: { HOME: home },
      mcpServers: {
        switch: {
          transport: 'http',
          url: 'http://127.0.0.1:9/mcp',
          headers: { authorization: 'Bearer t' },
        },
      },
      sessionEnv: {},
    });
    expect(prepared.configHome).toBe(join(directory, 'xdg'));
    const plugin = await readFile(
      join(prepared.configHome, 'amp', 'plugins', AMP_PLUGIN_FILENAME),
      'utf8'
    );
    expect(plugin).toContain("amp.on('tool.call'");
    expect(await readlink(join(prepared.configHome, 'git'))).toBe(join(home, '.config', 'git'));
    expect(await readlink(join(prepared.configHome, 'amp', 'secrets.json'))).toBe(
      join(home, '.config', 'amp', 'secrets.json')
    );
    await expect(stat(join(prepared.configHome, 'amp', 'plugins', 'mine.ts'))).rejects.toThrow();
    const settings = JSON.parse(await readFile(prepared.settingsFile, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(settings['amp.showCosts']).toBe(false);
    expect(settings['amp.updates.mode']).toBe('disabled');
    expect(settings['amp.mcpServers']).toEqual({
      linear: { url: 'https://mcp.linear.app/sse' },
      switch: { url: 'http://127.0.0.1:9/mcp', headers: { authorization: 'Bearer t' } },
    });
    expect((await stat(prepared.settingsFile)).mode & 0o777).toBe(0o600);
    await removeAmpSessionHome(directory);
    await expect(stat(directory)).rejects.toThrow();
  });

  it('works without any Amp configuration of the user’s', async () => {
    const home = await userHome();
    const directory = ampSessionDirectory(join(home, 'sessions'), 'session-2');
    const prepared = await prepareAmpSessionHome({
      directory,
      env: { HOME: home },
      mcpServers: {},
      sessionEnv: {},
    });
    expect(JSON.parse(await readFile(prepared.settingsFile, 'utf8'))).toEqual({
      'amp.mcpServers': {},
      'amp.updates.mode': 'disabled',
      'amp.notifications.enabled': false,
    });
  });

  it('refuses a settings file it cannot read rather than dropping it', async () => {
    const home = await userHome();
    await mkdir(join(home, '.config', 'amp'), { recursive: true });
    await writeFile(join(home, '.config', 'amp', 'settings.json'), '{ not json');
    await expect(
      prepareAmpSessionHome({
        directory: ampSessionDirectory(join(home, 'sessions'), 'session-3'),
        env: { HOME: home },
        mcpServers: {},
        sessionEnv: {},
      })
    ).rejects.toThrow(/settings.json is not valid JSON/);
  });
});
