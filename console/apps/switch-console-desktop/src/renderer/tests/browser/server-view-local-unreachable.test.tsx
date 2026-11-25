import type * as ReactQuery from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

// The home page of the server on this computer when it is not answering says
// so, with the way to its status page, rather than blaming the connection.
const state = vi.hoisted(() => ({
  status: null as unknown,
  unreachable: false,
  kind: 'no-answer' as 'no-answer' | 'not-switch',
  reason:
    "Can't reach localhost:41001: nothing is answering at that address and port (ECONNREFUSED).",
  localStart: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { serverId: 'local' } }),
  useNavigate: () => ({ navigate: state.navigate }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => {} }));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get servers() {
      return [LOCAL];
    },
    serverById: () => LOCAL,
    statusFor: () => ({ connected: true }),
    refreshing: new Set(),
    isUnreachable: () => state.unreachable,
    unreachableReason: () => (state.unreachable ? state.reason : null),
    unreachableKind: () => (state.unreachable ? state.kind : null),
    isHostBlocked: () => false,
    refreshStatus: () => Promise.resolve(),
    ensureAuthConfig: () => Promise.resolve(),
    refreshServer: () => Promise.resolve(),
    retryConnection: () => Promise.resolve(),
    error: null,
    errorDetail: null,
  },
}));
vi.mock('@renderer/features/switch-servers/local-server-store', () => ({
  localServerStore: {
    get status() {
      return state.status;
    },
    get isRunning() {
      return (state.status as { phase: string }).phase === 'running';
    },
    busy: false,
    docker: null,
    isNative: true,
    message: null,
    start: (...args: unknown[]) => state.localStart(...args),
  },
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-store', () => ({
  hostReachabilityStore: {
    hydrate: () => Promise.resolve(),
    get: () => null,
    isBlocked: () => false,
  },
}));
vi.mock('@renderer/features/remote-hosts/host-unreachable-panel', () => ({
  HostUnreachablePanel: () => null,
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { load: () => Promise.resolve() },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { refreshRoomState: () => Promise.resolve() },
}));
vi.mock('@renderer/features/switch-servers/MessagingAppsCard', () => ({
  MessagingAppsCard: () => null,
}));
vi.mock('@renderer/features/switch-servers/GuardrailsSection', () => ({
  GuardrailsSection: () => null,
}));
vi.mock('@renderer/features/switch-servers/home/use-ai-connected', () => ({
  useAiConnected: () => ({ connected: null, buddy: null }),
}));
// Stubbed whole: loading the real panels would pull in modules these tests mock only in part.
vi.mock('@renderer/features/switch-servers/home/home-panels', () => ({
  SignedOutPanel: () => null,
  ConnectAiPanel: () => null,
  AskBuddyPanel: () => null,
  useHomeChips: () => null,
}));
vi.mock('@renderer/features/switch-servers/server-sign-in', () => ({
  ServerSignInFields: () => null,
  useServerSignIn: () => ({}),
  machineUnavailableReason: () => null,
}));

import { serverView } from '@renderer/features/switch-servers/view';
import '@renderer/index.css';

const LOCAL: { managed: boolean; [key: string]: unknown } = {
  id: 'local',
  name: 'Local server',
  url: 'http://localhost:41001',
  dashboardUrl: null,
  managed: true,
  managementKind: 'local',
  sshHost: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const base = {
  checked: true,
  upgrade: null,
  drift: null,
  runtime: 'native',
  error: null,
  failedTo: null,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  state.status = { ...base, phase: 'running' };
  state.unreachable = false;
  state.localStart.mockReset();
  state.navigate.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render() {
  const Page = serverView.MainPanel;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Page />));
}

function button(label: RegExp): HTMLElement | undefined {
  return [...document.querySelectorAll('button')].find((b) =>
    label.test(b.textContent?.trim() ?? '')
  );
}
it('does not blame the connection when the local server is not answering', async () => {
  state.unreachable = true;
  await render();

  expect(document.body.textContent).toContain("Local server isn't answering");
  expect(document.body.textContent).not.toContain('Check the address and your connection');
  expect(button(/^Server status$/)).toBeDefined();
});

it('names the address an unmanaged server cannot be reached at, and why', async () => {
  state.unreachable = true;
  LOCAL.managed = false;
  try {
    await render();
    expect(document.body.textContent).toContain("Can't reach localhost:41001");
    expect(document.body.textContent).toContain(
      'Nothing is answering at that address and port (ECONNREFUSED).'
    );
    expect(button(/^Server status$/)).toBeUndefined();
  } finally {
    LOCAL.managed = true;
  }
});

async function renderNotSwitch(reason: string) {
  state.unreachable = true;
  state.kind = 'not-switch';
  state.reason = reason;
  LOCAL.managed = false;
  try {
    await render();
    return document.body.textContent ?? '';
  } finally {
    LOCAL.managed = true;
    state.kind = 'no-answer';
    state.reason =
      "Can't reach localhost:41001: nothing is answering at that address and port (ECONNREFUSED).";
  }
}

it('heads a redirect as not a Switch server, naming the address once', async () => {
  const text = await renderNotSwitch(
    "localhost:41001 doesn't answer as a Switch server: it redirects to elsewhere.example.org. Check the address."
  );
  expect(text).toContain("localhost:41001 isn't answering as a Switch server");
  expect(text).toContain('It redirects to elsewhere.example.org. Check the address.');
  expect(text).not.toContain("Doesn't answer as a Switch server");
  expect(text).not.toContain("Can't reach");
  expect(text.split('localhost:41001').length - 1).toBe(1);
});

it('heads a web page in place of the API as not a Switch server', async () => {
  const text = await renderNotSwitch(
    'Server does not answer at http://localhost:41001/gateway: a web page came back (HTTP 200).'
  );
  expect(text).toContain("localhost:41001 isn't answering as a Switch server");
  expect(text).toContain('a web page came back (HTTP 200)');
  expect(text).not.toContain("Can't reach");
});
