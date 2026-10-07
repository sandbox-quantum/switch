import { describe, expect, it } from 'vitest';
import { isNewer, latestRelease, releasesRepository } from './update';

function release(tag: string, extra: Partial<{ draft: boolean; prerelease: boolean }> = {}) {
  const version = tag.replace('switch-agent-controller-v', '');
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    ...extra,
    assets: [
      {
        name: `switch-agent-controller-${version}.tgz`,
        browser_download_url: `https://example.invalid/${tag}/switch-agent-controller-${version}.tgz`,
      },
    ],
  };
}

const answering = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('isNewer', () => {
  it('compares x.y.z numerically, and never ranks a version it cannot read', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('1.0.0-rc.1', '0.1.0')).toBe(false);
  });
});

describe('latestRelease', () => {
  it('picks the highest controller release, leaving out other products, drafts and prereleases', async () => {
    const latest = await latestRelease(
      answering([
        release('switch-agent-controller-v0.2.0'),
        release('switch-agent-controller-v0.10.0'),
        release('switch-agent-controller-v0.11.0', { prerelease: true }),
        release('switch-agent-controller-v0.12.0', { draft: true }),
        { ...release('switch-v9.9.9'), tag_name: 'switch-v9.9.9' },
        { ...release('switch-agent-controller-v0.13.0'), assets: [] },
      ]),
      'owner/repo'
    );
    expect(latest).toEqual({
      version: '0.10.0',
      packageUrl:
        'https://example.invalid/switch-agent-controller-v0.10.0/switch-agent-controller-0.10.0.tgz',
    });
  });

  it('is null with no controller release, and fails loud when GitHub refuses', async () => {
    expect(await latestRelease(answering([]), 'owner/repo')).toBeNull();
    await expect(latestRelease(answering({}, 403), 'owner/repo')).rejects.toThrow(/403/);
  });
});

describe('releasesRepository', () => {
  it('defaults to the Switch repository and takes a fork named owner/name', () => {
    expect(releasesRepository({})).toBe('sandbox-quantum/switch');
    expect(
      releasesRepository({ SWITCH_CONTROLLER_RELEASES_REPOSITORY: 'someone/switch-fork' })
    ).toBe('someone/switch-fork');
    expect(() =>
      releasesRepository({ SWITCH_CONTROLLER_RELEASES_REPOSITORY: 'https://evil.invalid/x' })
    ).toThrow(/owner\/name/);
  });
});
