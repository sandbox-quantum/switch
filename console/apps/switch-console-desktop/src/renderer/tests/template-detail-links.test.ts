// @vitest-environment jsdom
/**
 * A template's repository and sources are links its author chose, and anyone
 * in a workspace can write a template: opening one goes through the same
 * confirmation as a link in a chat, which shows the whole address, never
 * straight to the browser.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseTemplateAgents } from '@main/core/agent-templates/template-document';
import type { LoadedTemplate } from '@renderer/features/templates/agent-template-data';

const REPO = 'https://github.com/example/helper';
const PHISH = 'https://sw1tch-sso.example/login?next=%2Fverify';

const showModal = vi.hoisted(() => vi.fn());
const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));
const loadTemplateById = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal }));
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { serverId: 'srv', templateId: 'tpl-1' } }),
  useNavigate: () => ({ navigate: vi.fn() }),
}));
vi.mock('@renderer/features/templates/agent-template-data', () => ({ loadTemplateById }));
vi.mock('@renderer/features/templates/recent-templates', () => ({
  recordTemplateOpened: vi.fn(),
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws' },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    servers: [{ id: 'srv', name: 'Server' }],
    statusFor: () => ({ user: { id: 'me', role: 'member' } }),
  },
}));

const { templateDetailView } = await import('@renderer/features/templates/template-detail-view');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const document_ = [
  'agent:',
  '  name: helper',
  '  instructions: Help.',
  `  repo: ${REPO}`,
  '  sources:',
  `    - url: ${PHISH}`,
  '      label: Company handbook',
].join('\n');

const TEMPLATE = {
  name: 'Helper',
  description: '',
  kind: 'agent',
  server: {
    id: 'tpl-1',
    name: 'Helper',
    description: '',
    kind: 'agent',
    creator: 'Someone',
    ownerId: 'u-2',
    official: false,
    version: 1,
    readVisibility: 'public',
    writeVisibility: 'private',
    canEdit: false,
    canManage: false,
  },
  agents: parseTemplateAgents(document_).agents,
  room: null,
  summary: { kind: 'agent', rooms: 0, agents: 1, inputs: 0, creates: [] },
  document: document_,
  problem: null,
} satisfies LoadedTemplate;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  showModal.mockReset();
  openExternalUrl.mockClear();
  loadTemplateById.mockResolvedValue(TEMPLATE);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function button(text: string): Promise<HTMLButtonElement> {
  await act(async () => root.render(createElement(templateDetailView.MainPanel)));
  const deadline = Date.now() + 3_000;
  for (;;) {
    const found = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`No "${text}" button in: ${container.textContent}`);
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

it.each([
  ['the repository', 'github.com/example/helper', REPO],
  ['a source under its author’s label', 'Company handbook', PHISH],
])('asks before opening %s, showing the whole address', async (_what, text, url) => {
  const link = await button(text);
  await act(async () => link.click());

  expect(openExternalUrl).not.toHaveBeenCalled();
  expect(showModal).toHaveBeenCalledWith(
    'confirmExternalLinkModal',
    expect.objectContaining({ url })
  );
});
