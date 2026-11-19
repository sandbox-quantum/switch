import {
  type ConsoleLink,
  type ConsolePage,
  parseConsoleLink,
} from "@switch-console/chat-ui/model/console-links";

/**
 * Where a Switch Console link (`switchdash://open/…`, as switch-buddy writes
 * them) goes in the web dashboard: the page here that does the same job, or
 * null for one with no counterpart on the web yet.
 */
export function webPathOf(link: ConsoleLink): string | null {
  return WEB_PAGES[link.page](link.id === null ? "" : encodeURIComponent(link.id), link.tab);
}

const WEB_PAGES: Record<ConsolePage, (id: string, tab: string | null) => string | null> = {
  home: () => "/",
  agents: () => "/agents",
  "agents/new": () => "/agents",
  agent: (id, tab) => (tab === "chats" ? `/chats/agents/${id}` : `/agents/${id}`),
  buddy: () => "/chats",
  rooms: () => "/rooms",
  room: (id) => `/chats/rooms/${id}`,
  chat: (id) => `/chats/${id}`,
  templates: () => "/templates",
  template: (id) => `/templates/${id}`,
  "messaging-apps/connect": () => "/settings/messaging-apps",
  connections: () => "/connectors",
  invite: () => "/settings/users",
  admin: (_id, tab) => adminPath(tab),
  settings: (_id, tab) => settingsPath(tab),
  server: () => null,
};

function adminPath(tab: string | null): string | null {
  switch (tab) {
    case "messaging-apps":
      return "/settings/messaging-apps";
    case "connectors":
      return "/settings/org/connectors";
    case "switch-trust":
      return "/settings/guardrails";
    case "apps":
      return "/platform/connectors";
    default:
      return "/settings";
  }
}

function settingsPath(tab: string | null): string | null {
  switch (tab) {
    case "messaging-apps":
      return "/settings/messaging-apps";
    case "api-keys":
      return "/settings/api-keys";
    case "devices":
    case "remote-hosts":
    case "managed-agents":
      return "/settings/devices";
    default:
      return null;
  }
}

/** What opening `href` does from a chat on the web. */
export type WebLinkTarget =
  | { kind: "external"; href: string }
  | { kind: "page"; path: string }
  | { kind: "console-only" }
  | { kind: "ignored" };

export function webLinkTarget(href: string): WebLinkTarget {
  if (/^https?:\/\//i.test(href)) return { kind: "external", href };
  const parsed = parseConsoleLink(href);
  if (!parsed.ok) return { kind: "ignored" };
  // A link meant for another server or workspace stays with Console, which can switch to it.
  if (parsed.link.server !== null || parsed.link.workspace !== null)
    return { kind: "console-only" };
  const path = webPathOf(parsed.link);
  return path === null ? { kind: "console-only" } : { kind: "page", path };
}
