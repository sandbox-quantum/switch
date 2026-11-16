// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import buddyAvatar from '@/assets/images/switch-buddy/avatar.png';
import { BUDDY_ICON_URL } from '@shared/core/agents/switch-buddy';

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    switchServers: { avatarSettings: vi.fn(async () => ({ thirdPartyAvatarsEnabled: false })) },
  },
}));

const { AgentAvatar, agentAvatarSrc, wearsBuddyPicture } =
  await import('@renderer/lib/components/agent-avatar');
const { recordOwnBuddy } = await import('@renderer/features/switch-buddy/own-buddies');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BUDDY_TEMPLATE = { id: 'official:switch-buddy', key: 'buddy', revision: 1 };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  recordOwnBuddy('srv', [
    { agentId: 'agent-buddy', name: 'switch-buddy-ada', template: BUDDY_TEMPLATE },
    { agentId: 'agent-other', name: 'helper', template: null },
  ]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function avatarOf(agentId: string | null, name: string): Promise<HTMLImageElement | null> {
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(AgentAvatar, {
          agentId,
          name,
          iconUrl: BUDDY_ICON_URL,
          serverId: 'srv',
          size: 24,
        })
      )
    )
  );
  return container.querySelector('img');
}

describe('switch-buddy’s picture', () => {
  it('is worn by the person’s own buddy', async () => {
    expect((await avatarOf('agent-buddy', 'switch-buddy-ada'))?.getAttribute('src')).toBe(
      buddyAvatar
    );
  });

  it('is not worn by another agent carrying its URL, whatever it calls itself', async () => {
    // On a server that allows no generated avatars, an agent with no picture shows its initials.
    expect(await avatarOf('agent-impostor', 'switch-buddy-ada')).toBeNull();
    expect(container.textContent).not.toBe('');
  });

  it('is worn by a buddy shown before it exists, a picture Console chose itself', async () => {
    expect((await avatarOf(null, 'switch-buddy-ada'))?.getAttribute('src')).toBe(buddyAvatar);
  });

  it('follows the managed agents as they are read again', async () => {
    recordOwnBuddy('srv', [{ agentId: 'agent-other', name: 'helper', template: null }]);
    expect(wearsBuddyPicture('srv', 'agent-buddy')).toBe(false);
    expect(wearsBuddyPicture('elsewhere', 'agent-buddy')).toBe(false);
  });
});

describe('agentAvatarSrc', () => {
  it('draws an agent carrying the buddy’s URL as if it chose no picture, unless it is the buddy', () => {
    expect(agentAvatarSrc(BUDDY_ICON_URL, 'helper', true, true)).toBe(buddyAvatar);
    expect(agentAvatarSrc(BUDDY_ICON_URL, 'helper', true, false)).toBe(
      agentAvatarSrc(null, 'helper', true, false)
    );
    expect(agentAvatarSrc(BUDDY_ICON_URL, 'helper', false, false)).toBeNull();
  });
});
