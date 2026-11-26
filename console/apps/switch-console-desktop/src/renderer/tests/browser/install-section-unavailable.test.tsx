import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/stores/use-agent-installation-statuses', () => ({
  useAgentInstallationStatus: () => ({
    data: null,
    installations: [],
    used: { kind: 'auto' },
    status: 'missing',
    isInstalling: false,
    isUpdating: false,
    isUninstalling: false,
    installingMethod: undefined,
    updatingMethod: undefined,
    uninstallingMethod: undefined,
    install: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    setUsed: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    fetchLatestVersion: vi.fn(() => Promise.resolve()),
    probeOverride: vi.fn(() => Promise.resolve(null)),
  }),
}));

import { InstallSection } from '@renderer/features/settings/agents-page/InstallSection';
import type { AgentPayload, InstallOption } from '@shared/core/providers/agent-payload';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function payload(installDocs: string | null): AgentPayload {
  return {
    id: 'kiro',
    name: 'Kiro',
    websiteUrl: 'https://kiro.dev/docs/cli/acp/',
    installDocs,
    capabilities: {
      hostDependency: {
        updates: { kind: 'none' },
        uninstall: { kind: 'none' },
      },
    },
  } as unknown as AgentPayload;
}

async function render(installOptions: InstallOption[], installDocs: string | null = null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <InstallSection
        agentId="kiro"
        agentPayload={payload(installDocs)}
        installOptions={installOptions}
      />
    )
  );
  return container;
}

describe('InstallSection when nothing is installed (CHOO-4463)', () => {
  it('says the agent is not available to install on this OS when it has no command', async () => {
    const el = await render([]);
    expect(el.textContent).toContain('Not available to install on this OS.');
    expect(el.textContent).not.toContain('Install it below');
    expect(el.textContent).not.toContain('—');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Install')).toBe(false);
  });

  it('links the install docs, or the website when there are none', async () => {
    let el = await render([], 'https://kiro.dev/docs/getting-started/installation/');
    let link = [...el.querySelectorAll('a')].find((a) =>
      /Installation docs/.test(a.textContent ?? '')
    );
    expect(link?.getAttribute('href')).toBe('https://kiro.dev/docs/getting-started/installation/');
    expect(link?.getAttribute('target')).toBe('_blank');

    await act(async () => root?.unmount());
    container?.remove();
    el = await render([]);
    link = [...el.querySelectorAll('a')].find((a) => /Installation docs/.test(a.textContent ?? ''));
    expect(link?.getAttribute('href')).toBe('https://kiro.dev/docs/cli/acp/');
  });

  it('points at the install command below when there is one, without an em dash', async () => {
    const el = await render([
      {
        method: 'powershell',
        command:
          'powershell -ExecutionPolicy ByPass -c "irm https://cli.kiro.dev/install.ps1 | iex"',
      },
    ]);
    expect(el.textContent).toContain('Not found. Install it below.');
    expect(el.textContent).not.toContain('Not available to install');
    expect(el.textContent).not.toContain('—');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Install')).toBe(true);
  });
});
