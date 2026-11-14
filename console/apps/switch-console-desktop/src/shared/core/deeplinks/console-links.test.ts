import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSOLE_PAGES,
  type ConsolePage,
  consoleLink,
  parseConsoleLink,
} from '@switch-console/chat-ui/model/console-links';
import { describe, expect, it } from 'vitest';

const ok = (raw: string) => {
  const result = parseConsoleLink(raw);
  if (!result.ok) throw new Error(result.reason);
  return result.link;
};

describe('parseConsoleLink', () => {
  it('reads a page, its id, its tab and its server', () => {
    expect(
      ok('switchdash://open/agent/a-1?tab=settings&server=https%3A%2F%2Fswitch.example.com')
    ).toEqual({
      page: 'agent',
      id: 'a-1',
      tab: 'settings',
      server: 'https://switch.example.com',
      workspace: null,
      use: false,
    });
    expect(ok('switchdash://open/agents/new')).toMatchObject({ page: 'agents/new', id: null });
    expect(ok('switchdash://open/messaging-apps/connect')).toMatchObject({
      page: 'messaging-apps/connect',
    });
    expect(ok('switchdash://open/home/')).toMatchObject({ page: 'home', server: null });
    expect(ok('switchdash://open/server?server=http%3A%2F%2F127.0.0.1%3A3000')).toEqual({
      page: 'server',
      id: null,
      tab: null,
      server: 'http://127.0.0.1:3000',
      workspace: null,
      use: false,
    });
  });

  it("reads the workspace a link means, and a template link's ask for its Use form", () => {
    expect(
      ok('switchdash://open/template/official:switch-expert?workspace=t-2&use=1')
    ).toMatchObject({
      page: 'template',
      id: 'official:switch-expert',
      workspace: 't-2',
      use: true,
    });
    // Only a template has a Use form.
    expect(ok('switchdash://open/room/r-1?use=1')).toMatchObject({ use: false });
    expect(ok('switchdash://open/template/t-1?use=yes')).toMatchObject({ use: false });
  });

  it('says why a link cannot be followed', () => {
    const reason = (raw: string) => {
      const result = parseConsoleLink(raw);
      return result.ok ? null : result.reason;
    };
    expect(reason('switchdash://session?room=r')).toMatch(/Not a Switch Console link/);
    expect(reason('switchdash://open/nowhere')).toMatch(/no page "nowhere"/);
    expect(reason('switchdash://open/agent')).toMatch(/does not say which one/);
    expect(reason('switchdash://open/room/<room-id>')).toMatch(/does not say which one/);
    expect(reason('switchdash://open/agent/a-1?tab=logs')).toMatch(/no "logs" tab/);
    expect(reason('switchdash://open/home?tab=general')).toMatch(/no "general" tab/);
    expect(reason('switchdash://open/server/srv-1')).toMatch(/no page "server\/srv-1"/);
  });

  it('reads back every link it writes', () => {
    for (const page of Object.keys(CONSOLE_PAGES) as ConsolePage[]) {
      const spec = CONSOLE_PAGES[page] as { id?: string; tabs?: readonly string[] };
      const link = consoleLink(page, {
        id: spec.id ? 'x-1' : undefined,
        tab: spec.tabs?.[0],
        server: 'http://127.0.0.1:3000',
        workspace: 't-1',
        use: page === 'template',
      });
      expect(ok(link)).toEqual({
        page,
        id: spec.id ? 'x-1' : null,
        tab: spec.tabs?.[0] ?? null,
        server: 'http://127.0.0.1:3000',
        workspace: 't-1',
        use: page === 'template',
      });
    }
  });
});

describe("switch-buddy's instructions", () => {
  // AGENT.md, plus the playbook it points at for the rarer pages.
  const instructions = ['AGENT.md', 'PLAYBOOK.md']
    .map((name) =>
      readFileSync(
        join(
          __dirname,
          '../../../../../../../core/switch_core/official_templates/switch-buddy',
          name
        ),
        'utf8'
      )
    )
    .join('\n');
  const links = [...instructions.matchAll(/switchdash:\/\/open\/[^\s`)|]+/g)].map((match) =>
    match[0].replace(/<[a-z-]+>/g, 'sample-id')
  );

  it('only link to pages Switch Console opens', () => {
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(parseConsoleLink(link), link).toMatchObject({ ok: true });
  });

  it('list every page Switch Console opens', () => {
    const documented = new Set(links.map((link) => ok(link).page));
    expect([...documented].sort()).toEqual(Object.keys(CONSOLE_PAGES).sort());
  });
});
