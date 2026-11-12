import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CanaryFeed from './canary-feed';

const h = vi.hoisted(() => ({ findLatestCanaryTag: vi.fn() }));

vi.mock('./canary-feed', () => ({
  findLatestCanaryTag: h.findLatestCanaryTag,
}));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { log } = await import('@main/lib/logger');
const actualCanaryFeed = await vi.importActual<typeof CanaryFeed>('./canary-feed');
const { manualDownloadUrl } = await import('./manual-download');

const RELEASES = 'https://github.com/sandbox-quantum/switch/releases';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('manualDownloadUrl', () => {
  it('sends a stable build to the release GitHub marks Latest', async () => {
    await expect(manualDownloadUrl(false)).resolves.toBe(`${RELEASES}/latest`);
    expect(h.findLatestCanaryTag).not.toHaveBeenCalled();
  });

  it('sends a canary build to the newest canary that exists', async () => {
    h.findLatestCanaryTag.mockResolvedValue('v0.41.0-canary.1');

    await expect(manualDownloadUrl(true)).resolves.toBe(`${RELEASES}/tag/v0.41.0-canary.1`);
  });

  it('falls back to the releases list, and says so, when the lookup fails', async () => {
    h.findLatestCanaryTag.mockRejectedValue(new Error('GitHub answered HTTP 403'));

    await expect(manualDownloadUrl(true)).resolves.toBe(RELEASES);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ errorCode: 'canary_lookup_failed' })
    );
  });
});

describe('manualDownloadUrl against the real canary lookup', () => {
  function lookUpForReal(fetchImpl: () => Promise<Response>): void {
    h.findLatestCanaryTag.mockImplementation(actualCanaryFeed.findLatestCanaryTag);
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
  }

  it('falls back to the releases list when GitHub cannot be reached', async () => {
    lookUpForReal(() => Promise.reject(new TypeError('fetch failed')));

    await expect(manualDownloadUrl(true)).resolves.toBe(RELEASES);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        errorCode: 'canary_lookup_failed',
        error: expect.stringContaining('fetch failed'),
      })
    );
  });

  it('falls back to the releases list when GitHub answers with an error', async () => {
    lookUpForReal(async () => new Response('rate limited', { status: 403 }));

    await expect(manualDownloadUrl(true)).resolves.toBe(RELEASES);
  });

  it('falls back to the releases list when no canary is published', async () => {
    lookUpForReal(
      async () =>
        new Response(JSON.stringify([{ tag_name: 'switch-console-v1.0.0', draft: false }]), {
          status: 200,
        })
    );

    await expect(manualDownloadUrl(true)).resolves.toBe(RELEASES);
  });

  it('skips a draft canary, which has no page to open', async () => {
    lookUpForReal(
      async () =>
        new Response(
          JSON.stringify([
            { tag_name: 'v0.42.0-canary.1', draft: true },
            { tag_name: 'v0.41.0-canary.3', draft: false },
          ]),
          { status: 200 }
        )
    );

    await expect(manualDownloadUrl(true)).resolves.toBe(`${RELEASES}/tag/v0.41.0-canary.3`);
  });
});
