import { get } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { listenForSignIn, type SignInListener } from './sign-in-listener';

vi.mock('@main/app/window', () => ({ focusMainWindow: vi.fn() }));

/** GETs the listener with an explicit Host, as a browser sent to that name sends it. */
function call(
  port: number,
  host: string,
  query: string
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = get(
      {
        host: '127.0.0.1',
        port,
        path: `/switch-services/callback${query}`,
        headers: { Host: host },
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      }
    );
    request.on('error', reject);
  });
}

let listener: SignInListener | null = null;
afterEach(() => {
  listener?.close();
  listener = null;
});

async function listen() {
  const codes: string[] = [];
  listener = await listenForSignIn({
    name: 'Example',
    path: '/switch-services/callback',
    state: 'STATE',
    maxCodeLength: 8192,
    ports: null,
    complete: async (code) => {
      codes.push(code);
    },
  });
  return { port: listener.port, codes };
}

it('takes the code back under the 127.0.0.1 name', async () => {
  const { port, codes } = await listen();
  expect((await call(port, `127.0.0.1:${port}`, '?state=STATE&code=CODE')).status).toBe(
    200
  );
  expect(codes).toEqual(['CODE']);
});

it('takes the code back under the localhost name, as a vendor that registers only it sends it', async () => {
  const { port, codes } = await listen();
  expect((await call(port, `localhost:${port}`, '?state=STATE&code=CODE')).status).toBe(
    200
  );
  expect(codes).toEqual(['CODE']);
});

it('takes the code when the browser is sent to the localhost URL itself', async () => {
  // The real network path a vendor's redirect takes: the URL's own name,
  // resolved by the client, no header spoofing. This is what catches an
  // IPv6-only `localhost` resolution missing the IPv4-bound listener.
  const { port, codes } = await listen();
  const response = await fetch(
    `http://localhost:${port}/switch-services/callback?state=STATE&code=CODE`
  );
  expect(response.status).toBe(200);
  expect(codes).toEqual(['CODE']);
});

it('refuses a code under any other name, which keeps a DNS-rebinding page out', async () => {
  const { port, codes } = await listen();
  for (const host of [`evil.example.test:${port}`, `127.0.0.1.evil.test:${port}`, `localtest:${port}`]) {
    expect((await call(port, host, '?state=STATE&code=CODE')).status).toBe(400);
  }
  expect(codes).toEqual([]);
});
