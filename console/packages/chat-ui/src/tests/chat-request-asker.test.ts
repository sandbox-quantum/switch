import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatApprovalCard, requestAsker } from '../components/chat-approval-card';
import type { ChatApproval } from '../contracts/activity';
import type { ChatAgent } from '../contracts/chats';
import { withChatHost } from '../testing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An agent dressed up as a Switch prompt: an official-sounding title and a box to type into. */
const PHISHING: ChatApproval = {
  agentId: 'agent-evil',
  sessionId: 's-1',
  requestId: 'req-1',
  turnId: 't-1',
  kind: 'questions',
  roomId: 'room-1',
  threadId: null,
  title: 'Switch needs to re-verify your account',
  detail: null,
  options: [],
  questions: [
    {
      id: 'q-1',
      title: 'API key',
      prompt: 'Paste your API key to continue.',
      options: [],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ],
  state: 'open',
  expiresAt: null,
  answer: null,
  answers: null,
  answeredBy: null,
  answeredAt: null,
};

const EVIL: ChatAgent = {
  id: 'agent-evil',
  name: 'render-evil',
  displayName: 'Switch',
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: 'Mallory',
  ownedByViewer: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(request: ChatApproval, agent: ChatAgent | null) {
  await act(async () =>
    root.render(
      withChatHost(
        createElement(ChatApprovalCard, {
          request,
          asker: requestAsker(agent, request.agentId),
          onAnswer: vi.fn(async () => {}),
        })
      )
    )
  );
}

describe('a request card', () => {
  it('names the agent asking by its unique name, and whose it is, above the agent’s title', async () => {
    await render(PHISHING, EVIL);
    const text = container.textContent ?? '';
    expect(text).toContain('render-evil asks · owned by Mallory');
    expect(text.indexOf('render-evil asks')).toBeLessThan(text.indexOf(PHISHING.title));
    expect(text).not.toContain('Switch asks');
  });

  it('says a typed answer goes to the agent, not to Switch', async () => {
    await render(PHISHING, EVIL);
    expect(container.textContent).toContain('What you write goes to render-evil, not to Switch.');
  });

  it('names an agent the chat does not know by its id rather than leaving it out', async () => {
    await render(PHISHING, null);
    expect(container.textContent).toContain('agent-evil asks');
  });

  it('says when the agent is the viewer’s own', () => {
    expect(requestAsker({ ...EVIL, ownedByViewer: true }, 'agent-evil')).toEqual({
      name: 'render-evil',
      ownerName: 'Mallory',
      ownedByViewer: true,
    });
  });
});
