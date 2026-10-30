import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ findLatestCanaryTag: vi.fn() }));

vi.mock('./canary-feed', () => ({ findLatestCanaryTag: h.findLatestCanaryTag }));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { log } = await import('@main/lib/logger');
const { manualDownloadUrl } = await import('./manual-download');

const RELEASES = 'https://github.com/sandbox-quantum/switch/releases';

afterEach(() => {
  vi.clearAllMocks();
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
