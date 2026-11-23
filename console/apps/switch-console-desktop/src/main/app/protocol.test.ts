import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const handle = vi.hoisted(() => vi.fn());
const fetchFile = vi.hoisted(() =>
  vi.fn(async (url: string) => {
    const path = decodeURIComponent(new URL(url).pathname);
    return new Response(readFileSync(path), { headers: { 'Content-Type': 'text/html' } });
  })
);

vi.mock('electron', () => ({
  net: { fetch: fetchFile },
  protocol: { handle, registerSchemesAsPrivileged: vi.fn() },
  session: {},
}));

const { setupAppProtocol } = await import('./protocol');
const { RENDERER_CSP } = await import('./content-security-policy');

const root = mkdtempSync(join(tmpdir(), 'renderer-root-'));
writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('setupAppProtocol', () => {
  it('serves the app with its Content-Security-Policy', async () => {
    setupAppProtocol(root);
    const serve = handle.mock.lastCall![1] as (request: Request) => Promise<Response>;

    const response = await serve(new Request('app://switch-console/index.html'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toBe(RENDERER_CSP);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(await response.text()).toContain('<div id="root">');
  });
});

describe('RENDERER_CSP', () => {
  const directive = (name: string) =>
    RENDERER_CSP.split('; ')
      .find((entry) => entry.startsWith(`${name} `))
      ?.slice(name.length + 1);

  it('runs only the app’s own script files', () => {
    expect(directive('script-src')).toBe("'self'");
    expect(directive('worker-src')).toBe("'self'");
    expect(directive('object-src')).toBe("'none'");
    expect(directive('base-uri')).toBe("'none'");
  });

  it('sends nothing to another origin from the window', () => {
    expect(directive('connect-src')).not.toMatch(/https?:|\*/);
  });
});

describe('the renderer’s index.html', () => {
  it('has no inline script, which the policy would refuse', () => {
    const html = readFileSync(resolve(__dirname, '../../renderer/index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc=/);
      expect(body.trim()).toBe('');
    }
  });
});
