import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../registry';
import { OPENCODE_LATEST_URL, opencodeWindowsReleaseUrl } from './opencode/index';

// Installers fetched by a command and run as a script. A vendor that moves its
// installer often leaves a web page at the old address, which the shell then
// tries to run: the live check below catches that. It needs the network, so it
// runs only when SWITCH_CHECK_INSTALL_URLS is set (see install-urls.yml).
function installerUrls(): Map<string, string[]> {
  const urls = new Map<string, string[]>();
  for (const d of pluginRegistry.getAll()) {
    for (const [platform, options] of Object.entries(
      d.capabilities.hostDependency.installCommands
    )) {
      for (const opt of options ?? []) {
        if (opt.method !== 'curl' && opt.method !== 'powershell') continue;
        for (const found of opt.command.matchAll(/https:\/\/[^\s'"|)]+/g)) {
          // The start of an address the command finishes at run time, such as
          // a release download named by the version it looks up first.
          if (/^['"]\s*\+/.test(opt.command.slice(found.index + found[0].length))) continue;
          const url = found[0];
          const users = urls.get(url) ?? [];
          users.push(`${d.metadata.id} (${platform})`);
          urls.set(url, users);
        }
      }
    }
  }
  return urls;
}

describe('provider installer URLs', () => {
  it('finds an installer URL in every curl and powershell install command', () => {
    for (const d of pluginRegistry.getAll()) {
      for (const [platform, options] of Object.entries(
        d.capabilities.hostDependency.installCommands
      )) {
        for (const opt of options ?? []) {
          if (opt.method !== 'curl' && opt.method !== 'powershell') continue;
          expect(opt.command, `${d.metadata.id} (${platform})`).toMatch(/https:\/\//);
        }
      }
    }
    expect(installerUrls().has('https://app.factory.ai/cli/windows')).toBe(true);
  });

  describe.skipIf(!process.env.SWITCH_CHECK_INSTALL_URLS)('live', () => {
    it.each([...installerUrls()].map(([url, users]) => [url, users.join(', ')]))(
      '%s serves a script, not a web page (%s)',
      async (url) => {
        const res = await fetch(url, { redirect: 'follow' });
        expect(res.status, url).toBe(200);
        const type = res.headers.get('content-type') ?? '';
        const body = (await res.text()).trimStart().slice(0, 200).toLowerCase();
        expect(type, `${url} content-type`).not.toMatch(/html/);
        expect(body.startsWith('<'), `${url} body starts with markup: ${body}`).toBe(false);
      },
      30_000
    );

    it('the OpenCode Windows install finds a release zip for the latest version', async () => {
      const latest = await fetch(OPENCODE_LATEST_URL);
      expect(latest.status, OPENCODE_LATEST_URL).toBe(200);
      const { version } = (await latest.json()) as { version: string };
      const url = opencodeWindowsReleaseUrl(version);
      // The first bytes only: a zip starts with `PK`, and the whole file is large.
      const res = await fetch(url, { redirect: 'follow', headers: { range: 'bytes=0-3' } });
      expect([200, 206], url).toContain(res.status);
      const head = new Uint8Array(await res.arrayBuffer()).slice(0, 2);
      expect(String.fromCharCode(...head), `${url} is not a zip`).toBe('PK');
    }, 30_000);
  });
});
