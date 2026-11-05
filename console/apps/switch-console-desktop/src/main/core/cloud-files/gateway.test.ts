import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Console's side of Core's cloud-files routes, through the real gateway client
// with only `fetch` and the session store faked.

const getSessionCookie = vi.hoisted(() => vi.fn());
vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  managedServerHostBlocked: () => null,
  managedServerStoppedPhase: () => null,
  noteManagedServerUnanswered: vi.fn(),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getSessionCookie,
  setSessionCookie: vi.fn(),
}));
vi.mock('@main/core/switch-servers/auth', () => ({
  refreshSession: vi.fn(),
  reauthenticateManagedServer: vi.fn(),
  extractAuthCookie: vi.fn(() => null),
}));
vi.mock('@main/core/switch-servers/console-identity', () => ({
  consoleIdentityHeaders: async () => ({}),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { CloudFilesError } = await import('@shared/core/cloud-files/cloud-files');
const {
  FILES_ELSEWHERE_BACKOFF_MS,
  listCloudFiles,
  readCloudFile,
  readCloudFileRange,
  withFilesElsewhereRetry,
} = await import('./gateway');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'https://switch.example.com',
  dashboardUrl: null,
  managed: false,
} as never;

function jwt(): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 7200 })}.sig`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refused = (status: number, code: string) => json({ detail: { code } }, status);
const chunk = (bytes: Uint8Array, start: number, total: number, type = 'text/html') =>
  new Response(new Uint8Array(bytes), {
    status: 206,
    headers: {
      'content-type': type,
      'content-range': `bytes ${start}-${start + bytes.byteLength - 1}/${total}`,
    },
  });
const pastEnd = (total: number) =>
  new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const urlOf = (call: number) => new URL(fetchMock.mock.calls[call]![0]);

beforeEach(() => {
  vi.clearAllMocks();
  getSessionCookie.mockResolvedValue(jwt());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('listCloudFiles', () => {
  it('reads one page, and asks for the next with its cursor', async () => {
    const entry = {
      name: 'web',
      kind: 'folder',
      size: 0,
      mtime: 1,
      label: 'Web',
      agent: 'web-frontend',
    };
    fetchMock.mockResolvedValueOnce(json({ entries: [entry], cursor: 'c2' }));
    fetchMock.mockResolvedValueOnce(json({ entries: [], cursor: null }));
    expect(await listCloudFiles(SERVER, 'shared/crumb-and-co')).toEqual({
      entries: [entry],
      cursor: 'c2',
    });
    expect(await listCloudFiles(SERVER, 'shared/crumb-and-co', 'c2')).toEqual({ entries: [] });
    expect(urlOf(0).pathname).toBe('/gateway/cloud-files/list');
    expect(urlOf(0).searchParams.get('path')).toBe('shared/crumb-and-co');
    expect(urlOf(1).searchParams.get('cursor')).toBe('c2');
  });

  it('drops an entry that breaks the shape, and refuses a body with no entries', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        entries: [
          { name: 'ok', kind: 'file', size: 1, mtime: 1 },
          { name: 'bad', kind: 'link' },
          { name: 'bad2', kind: 'folder', size: 0, mtime: 1, agent: 7 },
        ],
      })
    );
    expect((await listCloudFiles(SERVER, '')).entries.map((e) => e.name)).toEqual(['ok']);
    fetchMock.mockResolvedValueOnce(json({ nope: true }));
    await expect(listCloudFiles(SERVER, '')).rejects.toMatchObject({ code: 'bad_reply' });
  });

  it.each([
    [409, 'box_resting'],
    [404, 'no_files'],
    [403, 'denied'],
    [403, 'outside_root'],
    [404, 'not_found'],
    [400, 'bad_path'],
    [400, 'bad_request'],
    [429, 'busy'],
    [504, 'timeout'],
    [502, 'bad_reply'],
    [500, 'failed'],
  ])('maps %i %s to its code, with no path in the message', async (status, code) => {
    fetchMock.mockResolvedValueOnce(refused(status, code));
    const error = await listCloudFiles(SERVER, 'secret/place').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudFilesError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain('secret');
  });
});

describe('withFilesElsewhereRetry', () => {
  it('retries 503 files_elsewhere three times with backoff, then says it could not reach the cloud', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const call = vi.fn(async () => {
      throw new CloudFilesError('files_elsewhere', 503);
    });
    await expect(withFilesElsewhereRetry(call, sleep)).rejects.toMatchObject({
      code: 'unreachable',
    });
    expect(call).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...FILES_ELSEWHERE_BACKOFF_MS]);
  });

  it('succeeds on a retry, and never retries any other code', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    expect(
      await withFilesElsewhereRetry(async () => {
        if (calls++ === 0) throw new CloudFilesError('files_elsewhere', 503);
        return 'ok';
      }, sleep)
    ).toBe('ok');
    const resting = vi.fn(async () => {
      throw new CloudFilesError('box_resting', 409);
    });
    await expect(withFilesElsewhereRetry(resting, sleep)).rejects.toMatchObject({
      code: 'box_resting',
    });
    expect(resting).toHaveBeenCalledTimes(1);
  });

  it('a real 503 files_elsewhere from Core is retried through the client', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(refused(503, 'files_elsewhere'));
      fetchMock.mockResolvedValueOnce(json({ entries: [] }));
      const listing = listCloudFiles(SERVER, '');
      await vi.advanceTimersByTimeAsync(FILES_ELSEWHERE_BACKOFF_MS[0]);
      expect(await listing).toEqual({ entries: [] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reading a file', () => {
  it('an HTML file comes back as its bytes, in 128 KiB ranges joined by Content-Range', async () => {
    const page = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    fetchMock.mockResolvedValueOnce(chunk(page.slice(0, 10), 0, page.byteLength));
    fetchMock.mockResolvedValueOnce(chunk(page.slice(10), 10, page.byteLength));
    const bytes = await readCloudFile(SERVER, 'site/page.html', 1024);
    expect(new TextDecoder().decode(bytes)).toBe(new TextDecoder().decode(page));
    expect(urlOf(0).pathname).toBe('/gateway/cloud-files/content');
    expect(urlOf(0).searchParams.get('offset')).toBe('0');
    expect(urlOf(1).searchParams.get('offset')).toBe('10');
  });

  it('a 200 instead of a 206 with Content-Range is a bad reply', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(3), { status: 200 }));
    await expect(readCloudFileRange(SERVER, 'a.bin', 0)).rejects.toMatchObject({
      code: 'bad_reply',
    });
  });

  it('416 at the end of a file ends the read cleanly', async () => {
    fetchMock.mockResolvedValueOnce(pastEnd(5));
    expect(await readCloudFileRange(SERVER, 'a.txt', 5)).toEqual({ done: true, total: 5 });
  });

  it('an empty file reads as nothing', async () => {
    fetchMock.mockResolvedValueOnce(pastEnd(0));
    expect((await readCloudFile(SERVER, 'empty.txt', 1024)).byteLength).toBe(0);
  });

  it('a 26 MB file is too large, refused on the first range', async () => {
    const total = 26 * 1024 * 1024;
    fetchMock.mockResolvedValueOnce(chunk(new Uint8Array(128 * 1024), 0, total));
    await expect(readCloudFile(SERVER, 'big.bin', 25 * 1024 * 1024)).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Core's own 413 too_large is passed on", async () => {
    fetchMock.mockResolvedValueOnce(refused(413, 'too_large'));
    await expect(readCloudFile(SERVER, 'big.bin', 25 * 1024 * 1024)).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('a range that starts somewhere other than asked is a bad reply', async () => {
    fetchMock.mockResolvedValueOnce(chunk(new Uint8Array(4), 8, 12));
    await expect(readCloudFileRange(SERVER, 'a.bin', 0)).rejects.toMatchObject({
      code: 'bad_reply',
    });
  });
});
