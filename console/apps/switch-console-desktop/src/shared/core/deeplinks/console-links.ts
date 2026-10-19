/**
 * Links to places in Switch Console: `switchdash://open/<page>[/<id>]`.
 *
 * What switch-buddy, a room message or a web page uses to point someone at a
 * screen instead of describing the way there. They ride the scheme the OS
 * already hands to Switch Console for room links, so a click anywhere opens
 * the app on the page; a click inside the app's own chat moves it there
 * directly.
 *
 * `server` names the Switch server the link means, by its address.
 * Without it the link opens on the server the person is looking at, which is
 * what an agent wants: it talks to them on that server and does not know the
 * address Console reaches it by.
 *
 * `CONSOLE_PAGES` is the whole catalogue. switch-buddy's instructions list the
 * same pages, and a test holds the two together.
 */

export const CONSOLE_LINK_SCHEME = 'switchdash';
export const CONSOLE_LINK_PREFIX = `${CONSOLE_LINK_SCHEME}://open/`;

type PageSpec = {
  /** What the page is, for the catalogue a person or agent reads. */
  description: string;
  /** Whether the page names one thing, as the link's last segment. */
  id?: 'agent' | 'room' | 'template';
  /** The values `tab` may take, when the page has tabs. */
  tabs?: readonly string[];
};

export const CONSOLE_PAGES = {
  home: { description: "The server's home: messaging apps, guardrails and who you are." },
  agents: { description: 'Every agent on the server.' },
  'agents/new': { description: 'Add a new agent.' },
  agent: {
    description: "An agent's page.",
    id: 'agent',
    tabs: ['chats', 'connections', 'settings'],
  },
  rooms: { description: 'Every room on the server.' },
  room: { description: 'A room.', id: 'room' },
  chat: { description: 'A direct chat with an agent.', id: 'room' },
  buddy: { description: "switch-buddy's own page.", tabs: ['chats', 'connections', 'settings'] },
  templates: { description: 'Templates.', tabs: ['agent', 'room', 'group'] },
  template: { description: 'A template.', id: 'template' },
  'messaging-apps/connect': {
    description: 'Connect a messaging app (Slack, Discord, Telegram, Teams).',
  },
  connections: { description: 'Connectors: services such as GitHub, for you and your agents.' },
  invite: { description: 'Invite people to the workspace.' },
  settings: {
    description: "Switch Console's settings.",
    tabs: ['general', 'clis-models', 'remote-hosts', 'managed-agents', 'interface'],
  },
} as const satisfies Record<string, PageSpec>;

export type ConsolePage = keyof typeof CONSOLE_PAGES;

export type ConsoleLink = {
  page: ConsolePage;
  /** The agent, room or template the page shows; null for a page with no id. */
  id: string | null;
  tab: string | null;
  /** The address of the server the link means, or null for the current one. */
  server: string | null;
};

export type ConsoleLinkResult = { ok: true; link: ConsoleLink } | { ok: false; reason: string };

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** Read a `switchdash://open/…` link; a reason, for the person, when it is not one. */
export function parseConsoleLink(raw: string): ConsoleLinkResult {
  if (!raw.startsWith(CONSOLE_LINK_PREFIX)) {
    return { ok: false, reason: 'Not a Switch Console link.' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'This link is malformed.' };
  }
  const segments = raw
    .slice(CONSOLE_LINK_PREFIX.length)
    .split(/[?#]/, 1)[0]!
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));

  const pages = Object.keys(CONSOLE_PAGES) as ConsolePage[];
  const page =
    pages.find((name) => segments.join('/') === name) ??
    pages.find((name) => 'id' in CONSOLE_PAGES[name] && segments.slice(0, -1).join('/') === name);
  if (!page) {
    return { ok: false, reason: `Switch Console has no page "${segments.join('/')}".` };
  }
  const spec: PageSpec = CONSOLE_PAGES[page];
  const id = spec.id ? (segments.at(-1) ?? null) : null;
  if (spec.id && (id === null || segments.join('/') === page || !ID.test(id))) {
    return { ok: false, reason: `This link to a ${spec.id} does not say which one.` };
  }
  const tab = url.searchParams.get('tab');
  if (tab !== null && !(spec.tabs ?? []).includes(tab)) {
    return { ok: false, reason: `That page has no "${tab}" tab.` };
  }
  return { ok: true, link: { page, id, tab, server: url.searchParams.get('server') } };
}

/** The link to `page`, as switch-buddy or a test writes it. */
export function consoleLink(
  page: ConsolePage,
  options: { id?: string; tab?: string; server?: string }
): string {
  const path = options.id ? `${page}/${encodeURIComponent(options.id)}` : page;
  const query = new URLSearchParams();
  if (options.tab) query.set('tab', options.tab);
  if (options.server) query.set('server', options.server);
  const search = query.toString();
  return `${CONSOLE_LINK_PREFIX}${path}${search ? `?${search}` : ''}`;
}
