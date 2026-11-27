import { randomBytes } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CallerContext,
  callOperation,
  callOperationOutcome,
  fetchMediaToFile,
  mediaIdOf,
  serveMcpOverHttp,
  SwitchToolCatalog,
  type ToolDefinition,
} from './hosted';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(overrides: Partial<CallerContext> = {}): CallerContext {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-test-'));
  dirs.push(dir);
  return {
    identity: { endpoint: 'https://switch.test', agentId: 'agent', token: 'agent-token' },
    connectionId: 'connection',
    selector: {
      'X-Switch-Session-Id': 'session',
      'X-Switch-Session-Host-Id': 'host',
      'X-Switch-Session-Epoch': 'epoch',
    },
    room: 'room',
    mediaDir: join(dir, 'media'),
    cwd: dir,
    deadConnection: (operation) => `dead: ${operation}`,
    ...overrides,
  };
}

describe('an operation call while Switch may be away', () => {
  it('sends the host key as a header, and only when there is one', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: { event_id: 'e' } }));
    vi.stubGlobal('fetch', fetchMock);
    await callOperationOutcome(context({ clientTxnId: 'reply:k' }), 'post_message', { body: 'x' });
    await callOperationOutcome(context(), 'post_message', { body: 'x' });
    const headers = fetchMock.mock.calls.map(
      (call) => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>
    );
    expect(headers[0]!['X-Switch-Client-Txn-Id']).toBe('reply:k');
    expect(headers[1]).not.toHaveProperty('X-Switch-Client-Txn-Id');
  });

  it.each([
    ['no Switch to connect to', () => Promise.reject(new TypeError('fetch failed')), true],
    [
      'a gateway with no Switch behind it (502)',
      async () => new Response('bad gateway', { status: 502 }),
      true,
    ],
    ['503', async () => new Response('unavailable', { status: 503 }), true],
    ['504', async () => new Response('timeout', { status: 504 }), true],
    [
      'a connection Switch forgot when it restarted',
      async () => new Response('connection connection is not open', { status: 409 }),
      true,
    ],
    [
      'a Switch just started, its agent client not yet running (older Switch: 400)',
      async () => new Response('{"detail":"Agent client not running"}', { status: 400 }),
      true,
    ],
    ['a refusal (403)', async () => new Response('not a member', { status: 403 }), false],
    ['a bad request (400)', async () => new Response('bad', { status: 400 }), false],
    ['Switch failing (500)', async () => new Response('boom', { status: 500 }), false],
  ])('says whether %s is Switch being away', async (_name, answer, unavailable) => {
    vi.stubGlobal('fetch', vi.fn(answer));
    const outcome = await callOperationOutcome(context(), 'post_message', { body: 'x' });
    expect(outcome.result.isError).toBe(true);
    expect(outcome.unavailable).toBe(unavailable);
  });

  it('counts a success as available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { event_id: 'e' } }))
    );
    const outcome = await callOperationOutcome(context(), 'post_message', { body: 'x' });
    expect(outcome).toEqual({
      result: {
        content: [{ type: 'text', text: JSON.stringify({ event_id: 'e' }, null, 2) }],
        structuredContent: { event_id: 'e' },
      },
      unavailable: false,
    });
  });
});

describe('an operation call', () => {
  it('is made as the caller: its connection and the session selector', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: { room_id: 'room' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callOperation(context(), 'connect_to_room', { room_id: 'room' });
    expect(result.structuredContent).toEqual({ room_id: 'room' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.test/agents/agent/ops/connect_to_room');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer agent-token',
      'X-Switch-Connection-Id': 'connection',
      'X-Switch-Session-Id': 'session',
      'X-Switch-Session-Host-Id': 'host',
      'X-Switch-Session-Epoch': 'epoch',
    });
  });

  it('words a connection Switch no longer knows as the caller says', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('connection connection is not open', { status: 409 }))
    );
    const result = await callOperation(context(), 'post_message', {});
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'dead: post_message' }],
    });
  });
});

describe('the tool catalog', () => {
  const catalog = new SwitchToolCatalog([
    { name: 'post_message', description: 'Post.', input_schema: { type: 'object' } },
  ]);

  it('lists every operation and the two attachment tools', () => {
    expect(catalog.tools().map((tool) => tool.name)).toEqual([
      'post_message',
      'download_attachment',
      'send_attachment',
    ]);
  });

  it('refuses a tool it does not serve', async () => {
    await expect(catalog.call(context(), 'nope', {})).rejects.toThrow('Unknown tool: nope');
  });

  it('reads a relative attachment path against the session, not this process', async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json({ event_id: 'event' }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = context();
    writeFileSync(join(ctx.cwd, 'notes.md'), 'hello');
    const result = await catalog.call(ctx, 'send_attachment', { path: 'notes.md' });
    expect(result.isError).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://switch.test/agents/agent/rooms/room/media'
    );
  });

  it('tells the agent what Switch Trust did to what it sent', async () => {
    const trust = { outcome: 'redacted', delivered: 'see [redacted]', alert: 'errored' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ event_id: 'event', trust }))
    );
    const ctx = context();
    writeFileSync(join(ctx.cwd, 'notes.md'), 'hello');
    const result = await catalog.call(ctx, 'send_attachment', {
      path: 'notes.md',
      caption: 'see secret',
    });
    expect(result.content[0]!.text).toContain(`Switch Trust: ${JSON.stringify(trust)}`);
  });

  describe('send_attachment', () => {
    /** A file outside the session's directories, and the session whose cwd is `work`. */
    function outsideFile(): { ctx: CallerContext; secret: string } {
      const elsewhere = mkdtempSync(join(tmpdir(), 'hosted-elsewhere-'));
      dirs.push(elsewhere);
      const secret = join(elsewhere, 'id_ed25519');
      writeFileSync(secret, 'PRIVATE KEY');
      const ctx = context();
      mkdirSync(join(ctx.cwd, 'work'));
      return { ctx: { ...ctx, cwd: join(ctx.cwd, 'work') }, secret };
    }

    async function send(ctx: CallerContext, args: Record<string, unknown>) {
      const fetchMock = vi.fn(async (_url: string) => Response.json({ event_id: 'event' }));
      vi.stubGlobal('fetch', fetchMock);
      const result = await catalog.call(ctx, 'send_attachment', args);
      return { result, uploads: fetchMock.mock.calls.length };
    }

    it('refuses a file outside the working directory, and uploads nothing', async () => {
      const { ctx, secret } = outsideFile();
      const { result, uploads } = await send(ctx, { path: secret });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(`Refused to send ${secret}`);
      expect(result.content[0]!.text).toContain('Copy the file into the working directory');
      expect(uploads).toBe(0);
    });

    it('refuses a path that climbs out of the working directory', async () => {
      const { ctx } = outsideFile();
      writeFileSync(join(ctx.cwd, '..', 'beside.txt'), 'not in the workspace');
      const { result, uploads } = await send(ctx, { path: '../beside.txt' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Refused to send ../beside.txt');
      expect(uploads).toBe(0);
    });

    it('refuses a symbolic link inside the working directory to a file outside it', async () => {
      const { ctx, secret } = outsideFile();
      symlinkSync(secret, join(ctx.cwd, 'innocent.txt'));
      const { result, uploads } = await send(ctx, { path: 'innocent.txt' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Refused to send innocent.txt');
      expect(uploads).toBe(0);
    });

    it('refuses a hard link inside the working directory to a file outside it', async () => {
      const { ctx, secret } = outsideFile();
      linkSync(secret, join(ctx.cwd, 'innocuous.txt'));
      expect(readFileSync(join(ctx.cwd, 'innocuous.txt'), 'utf8')).toBe('PRIVATE KEY');
      const { result, uploads } = await send(ctx, { path: 'innocuous.txt' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(
        'Refused to send innocuous.txt: it has 2 hard links'
      );
      expect(result.content[0]!.text).toContain('Copy it into the working directory');
      expect(uploads).toBe(0);
    });

    it('refuses a file in the working directory once it has a hard link anywhere else', async () => {
      const { ctx, secret } = outsideFile();
      writeFileSync(join(ctx.cwd, 'notes.md'), 'hello');
      linkSync(join(ctx.cwd, 'notes.md'), `${secret}.copy`);
      const { result, uploads } = await send(ctx, { path: 'notes.md' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('hard links');
      expect(uploads).toBe(0);
    });

    it('sends an attachment it downloaded, under any of its hard links', async () => {
      const { ctx } = outsideFile();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('downloaded'))
      );
      const download = await catalog.call(ctx, 'download_attachment', {
        mxc: 'mxc://server/media-id',
        filename: 'a.txt',
      });
      const downloaded = download.content[0]!.text;
      linkSync(downloaded, join(ctx.cwd, 'a.txt'));
      const { result, uploads } = await send(ctx, { paths: [downloaded, 'a.txt'] });
      expect(result.isError).toBeUndefined();
      expect(uploads).toBe(1);
    });

    it('refuses a file another took the name of a downloaded attachment for', async () => {
      const { ctx, secret } = outsideFile();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('downloaded'))
      );
      const download = await catalog.call(ctx, 'download_attachment', {
        mxc: 'mxc://server/media-id',
        filename: 'a.txt',
      });
      const downloaded = download.content[0]!.text;
      rmSync(downloaded);
      linkSync(secret, downloaded);
      const { result, uploads } = await send(ctx, { path: downloaded });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('hard links');
      expect(uploads).toBe(0);
    });

    it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
      'sends a file in the working directory named in another case, as the file system reads it',
      async ({ skip }) => {
        const { ctx } = outsideFile();
        writeFileSync(join(ctx.cwd, 'Notes.md'), 'hello');
        const named = join(dirname(ctx.cwd), 'WORK', 'NOTES.MD');
        if (!existsSync(named)) skip('this volume tells case apart');
        const { result, uploads } = await send(ctx, { path: named });
        expect(result.isError).toBeUndefined();
        expect(uploads).toBe(1);
      }
    );

    it('sends nothing when one of several files is refused', async () => {
      const { ctx, secret } = outsideFile();
      writeFileSync(join(ctx.cwd, 'notes.md'), 'hello');
      const { result, uploads } = await send(ctx, { paths: ['notes.md', secret] });
      expect(result.isError).toBe(true);
      expect(uploads).toBe(0);
    });

    it('sends a file inside the working directory, and one it downloaded', async () => {
      const { ctx } = outsideFile();
      mkdirSync(join(ctx.cwd, 'src'));
      writeFileSync(join(ctx.cwd, 'src', 'a.ts'), 'export {};');
      mkdirSync(ctx.mediaDir);
      writeFileSync(join(ctx.mediaDir, 'media-id-a.png'), 'png');
      const { result, uploads } = await send(ctx, {
        paths: [join(ctx.cwd, 'src', 'a.ts'), join(ctx.mediaDir, 'media-id-a.png')],
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('Sent 2 files (a.ts, media-id-a.png)');
      expect(uploads).toBe(1);
    });
  });

  it('writes a download into the media directory, replacing a link planted at its name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('downloaded'))
    );
    const ctx = context();
    const target = join(ctx.cwd, 'outside.txt');
    writeFileSync(target, 'left alone');
    mkdirSync(ctx.mediaDir);
    symlinkSync(target, join(ctx.mediaDir, 'media-id-a.txt'));
    const result = await catalog.call(ctx, 'download_attachment', {
      mxc: 'mxc://server/media-id',
      filename: 'a.txt',
    });
    expect(result.content[0]!.text).toBe(join(ctx.mediaDir, 'media-id-a.txt'));
    expect(readFileSync(target, 'utf8')).toBe('left alone');
    expect(readFileSync(join(ctx.mediaDir, 'media-id-a.txt'), 'utf8')).toBe('downloaded');
  });

  it.skipIf(process.platform === 'win32')(
    'keeps downloads to this user: the directory 0700 and each file 0600',
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('bytes'))
      );
      const ctx = context();
      const umask = process.umask(0o022);
      try {
        const result = await catalog.call(ctx, 'download_attachment', {
          mxc: 'mxc://server/media-id',
          filename: 'a.txt',
        });
        expect(statSync(ctx.mediaDir).mode & 0o777).toBe(0o700);
        expect(statSync(result.content[0]!.text).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(umask);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a media directory an earlier build left open',
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('bytes'))
      );
      const ctx = context();
      mkdirSync(ctx.mediaDir, { mode: 0o755 });
      await catalog.call(ctx, 'download_attachment', { mxc: 'mxc://server/media-id' });
      expect(statSync(ctx.mediaDir).mode & 0o777).toBe(0o700);
    }
  );

  it('downloads into the caller’s media directory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bytes'))
    );
    const ctx = context();
    const result = await catalog.call(ctx, 'download_attachment', {
      mxc: 'mxc://server/media-id',
      filename: 'a.txt',
    });
    const written = result.content[0]!.text;
    expect(written.startsWith(ctx.mediaDir)).toBe(true);
    expect(readFileSync(written, 'utf8')).toBe('bytes');
  });

  it('encodes roomId when downloading an attachment to prevent path traversal', async () => {
    const fetchMock = vi.fn(async () => new Response('bytes'));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = context();
    await catalog.call(ctx, 'download_attachment', {
      mxc: 'mxc://example.com/test',
      filename: 'a.txt',
      room_id: '../../internal/admin/credentials?',
    });
    expect(fetchMock).toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://switch.test/agents/agent/rooms/..%2F..%2Finternal%2Fadmin%2Fcredentials%3F/media?mxc=mxc%3A%2F%2Fexample.com%2Ftest'
    );
  });

  it('rejects a destName that escapes the media directory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bytes'))
    );
    const ctx = context();
    const identity = ctx.identity;
    await expect(
      fetchMediaToFile(identity, ctx.mediaDir, 'room', 'mxc://s/id', '../../etc/passwd')
    ).rejects.toThrow('Destination escapes media directory');
  });

  it('stops reading an attachment once it passes the size limit', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
        if (sent > 200) controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    const ctx = context();
    await expect(
      fetchMediaToFile(ctx.identity, ctx.mediaDir, 'room', 'mxc://s/id', 'big.bin')
    ).rejects.toThrow('Attachment too large');
    expect(sent).toBeLessThanOrEqual(102);
    expect(existsSync(join(ctx.mediaDir, 'big.bin'))).toBe(false);
  });

  it('rejects an attachment whose Content-Length exceeds the size limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('small', {
            headers: { 'Content-Length': String(200 * 1024 * 1024) },
          })
      )
    );
    const ctx = context();
    await expect(
      fetchMediaToFile(ctx.identity, ctx.mediaDir, 'room', 'mxc://s/id', 'big.bin')
    ).rejects.toThrow('Attachment too large');
  });

  it('encodes roomId when sending an attachment to prevent path traversal', async () => {
    const fetchMock = vi.fn(async () => Response.json({ event_id: 'event' }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = context();
    writeFileSync(join(ctx.cwd, 'notes.md'), 'hello');
    await catalog.call(ctx, 'send_attachment', {
      path: 'notes.md',
      room_id: '../../internal/admin/credentials?',
    });
    expect(fetchMock).toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://switch.test/agents/agent/rooms/..%2F..%2Finternal%2Fadmin%2Fcredentials%3F/media'
    );
  });
});

describe('an attachment handle', () => {
  it('names its media id', () => {
    expect(mediaIdOf('switch-media://0123abcd')).toBe('0123abcd');
    expect(mediaIdOf('mxc://example.org/AbC_d-9')).toBe('AbC_d-9');
    expect(mediaIdOf('mxc://example.org:8448/media')).toBe('media');
  });

  it.each([
    '',
    'https://internal.example/secret',
    'mxc://example.org/../../admin',
    'mxc://example.org/a/b',
    'mxc://example.org/',
    'mxc://ex ample.org/id',
    'mxc://example.org/id?x=1',
    'switch-media://a/b',
    'switch-media://../x',
    'switch-media://',
    'mxc://example.org/id\n',
  ])('refuses %j', (uri) => {
    expect(() => mediaIdOf(uri)).toThrow('Not an attachment media URI');
  });
});

describe('fetching an attachment', () => {
  it('asks nothing of the bridge for a malformed media URI', async () => {
    const fetchMock = vi.fn(async () => new Response('bytes'));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = context();
    const result = await new SwitchToolCatalog([]).call(ctx, 'download_attachment', {
      mxc: 'mxc://server/../../agents/other/rooms/x/media',
      filename: 'a.txt',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Not an attachment media URI');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the file after the media id and stays in the media directory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bytes'))
    );
    const ctx = context();
    const result = await new SwitchToolCatalog([]).call(ctx, 'download_attachment', {
      mxc: 'switch-media://0123abcd',
      filename: '../../escape.txt',
    });
    const written = result.content[0]!.text;
    expect(dirname(written)).toBe(ctx.mediaDir);
    expect(written).toBe(join(ctx.mediaDir, '0123abcd-.._.._escape.txt'));
  });

  it.each(['sub/name', '..', '.', ''])(
    'refuses the destination %j before fetching',
    async (destName) => {
      const fetchMock = vi.fn(async () => new Response('bytes'));
      vi.stubGlobal('fetch', fetchMock);
      const ctx = context();
      await expect(
        fetchMediaToFile(ctx.identity, ctx.mediaDir, 'room', 'mxc://s/id', destName)
      ).rejects.toThrow('Destination escapes media directory');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('the loopback MCP server', () => {
  const tools: ToolDefinition[] = [
    { name: 'echo', description: 'Echo.', inputSchema: { type: 'object' } },
  ];

  async function serve(token: string, callTool = vi.fn()) {
    return serveMcpOverHttp(token, { listTools: async () => tools, callTool });
  }

  async function connect(url: string, token: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
    );
    return client;
  }

  it('refuses a caller without the token', async () => {
    const token = randomBytes(32).toString('hex');
    const server = await serve(token);
    try {
      expect(new URL(server.url).hostname).toBe('127.0.0.1');
      const none = await fetch(server.url, { method: 'POST', body: '{}' });
      expect(none.status).toBe(401);
      const wrong = await fetch(server.url, {
        method: 'POST',
        body: '{}',
        headers: { Authorization: `Bearer ${randomBytes(32).toString('hex')}` },
      });
      expect(wrong.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('lists the tools and hands each call over', async () => {
    const token = randomBytes(32).toString('hex');
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: `${name}:${JSON.stringify(args)}` }],
    }));
    const server = await serve(token, callTool);
    const client = await connect(server.url, token);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
      const result = await client.callTool({ name: 'echo', arguments: { a: 1 } });
      expect(result.content).toEqual([{ type: 'text', text: 'echo:{"a":1}' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('answers a call that fails as an error result naming why', async () => {
    const token = randomBytes(32).toString('hex');
    const server = await serve(
      token,
      vi.fn(async () => {
        throw new Error('the watcher is not running');
      })
    );
    const client = await connect(server.url, token);
    try {
      const result = await client.callTool({ name: 'echo', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('the watcher is not running');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
