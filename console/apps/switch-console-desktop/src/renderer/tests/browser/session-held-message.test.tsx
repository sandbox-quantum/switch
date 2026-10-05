/**
 * A message sent to a cloud agent whose machine sleeps is held and sent once
 * the session is ready. The composer says where the machine is, never leaves
 * the message stuck with Send locked, and keeps it when the user leaves the
 * session and comes back.
 */
import {
  type ClientCommand,
  SessionChatClient,
  type SessionTransport,
} from '@switch-console/shared/session-v1';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { heldMessages } from '@renderer/features/sessions/components/transcript/held-message';
import { SessionV1Chat } from '@renderer/features/sessions/components/transcript/session-v1-chat';
import { SessionHeaderSlotsProvider } from '@renderer/features/sessions/session-header-slots';
import type { CloudAgentPhase } from '@shared/core/cloud-agents/cloud-agents';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const SESSION = 'session-held';

const snapshot = {
  contractVersion: 1,
  throughSequence: 1,
  session: {
    sessionId: SESSION,
    agentId: 'agent-demo',
    provider: 'claude',
    hostId: 'host-demo',
    epoch: 'epoch-demo',
    status: 'ready',
    connectivity: 'online',
    capabilities: {
      input: 'queue',
      approvals: true,
      questions: true,
      interrupt: true,
      reset: false,
      compact: false,
      modelChange: false,
      attachmentMimeTypes: [],
    },
    pendingRequestIds: [],
  },
  turns: [],
  items: [],
  requests: [],
  commandStatuses: [],
  nextPageToken: null,
};

/** A worker behind the relay: unreachable while its machine sleeps. */
function worker() {
  const state = { awake: false, submitted: [] as ClientCommand[] };
  const transport: SessionTransport = {
    snapshot: async () => {
      if (!state.awake) throw new Error('The relay refused: worker_sleeping');
      return structuredClone(snapshot);
    },
    subscribe: () => () => {},
    submit: async (command) => {
      state.submitted.push(command);
      return {
        type: 'command.status',
        commandId: command.commandId,
        status: 'accepted',
        code: null,
        message: null,
      };
    },
    commandStatus: async () => {
      throw new Error('Not recorded.');
    },
  };
  return { state, transport };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  heldMessages.set(SESSION, null);
});

const wake = vi.fn(async () => undefined);

async function render(
  client: SessionChatClient,
  phase: CloudAgentPhase | null,
  blocked: string | null,
  restartHost?: () => Promise<void>,
  machineReady = false
): Promise<HTMLDivElement> {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(
      <SessionHeaderSlotsProvider>
        <SessionV1Chat
          client={client}
          hostState={null}
          autoWake={{ phase, machineReady, blocked, wake }}
          restartHost={restartHost}
        />
      </SessionHeaderSlotsProvider>
    )
  );
  await settle();
  return container;
}

async function settle(ms = 20) {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, ms)));
}

async function remount() {
  await act(async () => root!.unmount());
  root = createRoot(container!);
}

function textarea(el: HTMLElement): HTMLTextAreaElement {
  return el.querySelector('textarea[aria-label="Message the agent"]')!;
}

function button(el: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

async function type(el: HTMLElement, text: string) {
  const input = textarea(el);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function holdMessage(text: string) {
  const { state, transport } = worker();
  const client = new SessionChatClient(SESSION, transport);
  const el = await render(client, 'sleeping', null);
  await type(el, text);
  await act(async () => button(el, /^send$/i)!.click());
  await settle();
  return { el, client, state, transport };
}

it('says waking while the machine wakes, and connecting once it is awake', async () => {
  const { el, client } = await holdMessage('hello');
  expect(wake).toHaveBeenCalled();
  expect(el.textContent).toContain('Waking… about 1–2 min.');

  await render(client, null, null);
  expect(el.textContent).not.toContain('Waking…');
  expect(el.textContent).toContain('The machine is awake. Connecting to the session');
  expect(button(el, /^connecting…$/i)?.disabled).toBe(true);
});

it('says the agent is starting when only the agent starts on a machine already up', async () => {
  const { transport } = worker();
  const client = new SessionChatClient(SESSION, transport);
  const el = await render(client, 'waking', null, undefined, true);
  await type(el, 'hello');
  await act(async () => button(el, /^send$/i)!.click());
  await settle();
  expect(el.textContent).toContain('Starting the agent… Your message is sent when it is ready.');
  expect(el.textContent).not.toContain('Waking…');
  expect(button(el, /^starting…$/i)?.disabled).toBe(true);
});

it('says waking while the machine itself starts', async () => {
  const { transport } = worker();
  const client = new SessionChatClient(SESSION, transport);
  const el = await render(client, 'waking', null, undefined, false);
  await type(el, 'hello');
  await act(async () => button(el, /^send$/i)!.click());
  await settle();
  expect(el.textContent).toContain('Waking… about 1–2 min.');
  expect(el.textContent).not.toContain('Starting the agent');
});

it('keeps the connection error in view while it holds a message', async () => {
  const { el } = await holdMessage('hello');
  expect(el.textContent).toContain('The relay refused: worker_sleeping');
});

it('cancels a held message back into an editable draft', async () => {
  const { el } = await holdMessage('hello');
  await act(async () => button(el, /^cancel$/i)!.click());
  expect(el.textContent).not.toContain('Waking…');
  expect(textarea(el).value).toBe('hello');
  expect(textarea(el).readOnly).toBe(false);
  expect(button(el, /^send$/i)?.disabled).toBe(false);
});

it('stops holding when the message will not be delivered, says why and unlocks the draft', async () => {
  const { el, client } = await holdMessage('hello');
  await render(
    client,
    'machine_error',
    'The cloud machine is in error. Retry it in Your Agents, then send again.'
  );
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    'The cloud machine is in error. Retry it in Your Agents, then send again. Your message was not sent.'
  );
  expect(el.textContent).not.toContain('Waking…');
  expect(textarea(el).value).toBe('hello');
  expect(textarea(el).readOnly).toBe(false);
});

it('keeps holding a message after leaving the session, and sends it once on return', async () => {
  const { transport, state } = await holdMessage('hello');
  await remount();
  const client = new SessionChatClient(SESSION, transport);
  const el = await render(client, 'waking', null);
  expect(el.textContent).toContain('Waking…');
  expect(textarea(el).value).toBe('hello');

  state.awake = true;
  await render(client, null, null);
  await act(async () => await client.connect());
  await settle();
  expect(state.submitted.map((command) => command.body)).toEqual([
    expect.objectContaining({ type: 'message.send', text: 'hello' }),
  ]);
  expect(el.textContent).not.toContain('The machine is awake');
  expect(textarea(el).value).toBe('');
});

/**
 * A worker whose relay reattaches after its machine restarts, but whose session
 * host stays offline until the session is restarted.
 */
function restartable(restart: () => Promise<void>) {
  const { state, transport } = worker();
  const host = { online: false };
  const restartHost = vi.fn(async () => {
    await restart();
    host.online = true;
  });
  const client = new SessionChatClient(SESSION, {
    ...transport,
    snapshot: async (...args) => {
      const current = (await transport.snapshot(...args)) as typeof snapshot;
      return {
        ...current,
        session: { ...current.session, connectivity: host.online ? 'online' : 'offline' },
      };
    },
  });
  return { state, client, restartHost };
}

it('restarts an offline session host once for a message held across a machine restart, and sends it once', async () => {
  const { state, client, restartHost } = restartable(async () => undefined);
  const el = await render(client, 'sleeping', null, restartHost);
  await type(el, 'hello');
  await act(async () => button(el, /^send$/i)!.click());
  await settle();
  expect(el.textContent).toContain('Waking…');

  state.awake = true;
  await render(client, null, null, restartHost);
  await act(async () => await client.connect());
  await settle();
  await render(client, null, null, restartHost);
  expect(restartHost).toHaveBeenCalledTimes(1);
  expect(state.submitted.map((command) => command.body)).toEqual([
    expect.objectContaining({ type: 'message.send', text: 'hello' }),
  ]);
  expect(el.textContent).not.toContain('The machine is awake');
  expect(textarea(el).value).toBe('');
});

it('lets the user send to an offline session on an awake machine, restarting its host first', async () => {
  const { state, client, restartHost } = restartable(async () => undefined);
  state.awake = true;
  const el = await render(client, null, null, restartHost);
  await type(el, 'hello');
  expect(textarea(el).readOnly).toBe(false);
  expect(button(el, /^send$/i)?.disabled).toBe(false);
  expect(restartHost).not.toHaveBeenCalled();

  await act(async () => button(el, /^send$/i)!.click());
  await settle();
  expect(restartHost).toHaveBeenCalledTimes(1);
  expect(state.submitted.map((command) => command.body)).toEqual([
    expect.objectContaining({ type: 'message.send', text: 'hello' }),
  ]);
  expect(textarea(el).value).toBe('');
});

it('stops holding when the session host does not restart, says why and unlocks the draft', async () => {
  const { state, client, restartHost } = restartable(async () => {
    throw new Error('The worker did not start the session.');
  });
  state.awake = true;
  const el = await render(client, null, null, restartHost);
  await type(el, 'hello');
  await act(async () => button(el, /^send$/i)!.click());
  await settle();
  expect(restartHost).toHaveBeenCalledTimes(1);
  expect(state.submitted).toEqual([]);
  expect(el.textContent).not.toContain('The machine is awake');
  expect(
    [...el.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent).join('\n')
  ).toContain('The worker did not start the session. Your message was not sent.');
  expect(textarea(el).value).toBe('hello');
  expect(textarea(el).readOnly).toBe(false);
});
