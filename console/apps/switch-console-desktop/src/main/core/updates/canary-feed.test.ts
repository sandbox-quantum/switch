import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCanaryFeedUrl } from './canary-feed';

const DOWNLOAD = 'https://github.com/sandbox-quantum/switch/releases/download';

function controllerBuilds(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    tag_name: `switch-agent-controller-v0.31.1-dev.${i}.gabc1234`,
    draft: false,
  }));
}

function serve(pages: unknown[][]) {
  const fetchMock = vi.fn(async (url: string) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveCanaryFeedUrl', () => {
  it('finds a canary pushed off the first page by agents controller builds', async () => {
    const fetchMock = serve([
      controllerBuilds(100),
      [
        { tag_name: 'switch-console-v0.40.1', draft: false },
        { tag_name: 'v0.41.0-canary.1', draft: false },
        { tag_name: 'v0.40.0-canary.13', draft: false },
      ],
    ]);

    await expect(resolveCanaryFeedUrl()).resolves.toBe(`${DOWNLOAD}/v0.41.0-canary.1`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips a draft, whose assets may still be uploading', async () => {
    serve([
      [
        { tag_name: 'v0.41.0-canary.2', draft: true },
        { tag_name: 'v0.41.0-canary.rc.1', draft: false },
      ],
    ]);

    await expect(resolveCanaryFeedUrl()).resolves.toBe(`${DOWNLOAD}/v0.41.0-canary.rc.1`);
  });

  it('fails loudly when no canary is published', async () => {
    serve([controllerBuilds(3)]);

    await expect(resolveCanaryFeedUrl()).rejects.toThrow(/No published canary release/);
  });

  it('stops paging after a bounded number of pages', async () => {
    const fetchMock = serve(Array.from({ length: 10 }, () => controllerBuilds(100)));

    await expect(resolveCanaryFeedUrl()).rejects.toThrow(/No published canary release/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('surfaces a GitHub error rather than reporting no canary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 403 }))
    );

    await expect(resolveCanaryFeedUrl()).rejects.toThrow(/HTTP 403/);
  });
});
