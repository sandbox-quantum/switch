import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../registry';

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
        for (const url of opt.command.match(/https:\/\/[^\s'"|)]+/g) ?? []) {
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
  });
});
