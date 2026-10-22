import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ParticipantPicker } from '@renderer/lib/components/participant-picker';
import type { Participant } from '@renderer/lib/components/participant-search';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { MessagingAppSelector, messagingOptions, SWITCH_CONSOLE } from './messaging-app-selector';

vi.mock('@renderer/lib/stores/use-avatar-settings', () => ({
  useAvatarSettings: () => ({ thirdPartyAvatarsEnabled: false }),
  useThirdPartyAvatarsEnabled: () => false,
}));

const slack: RemoteBridge = {
  id: 'b-slack',
  type: 'slack',
  displayName: 'Acme Slack',
  status: 'active',
  isDefault: true,
  homeUrl: null,
  channelCreationSupported: true,
  canCreateChannels: true,
} as RemoteBridge;

const helper: Participant = {
  kind: 'agent',
  id: 'a1',
  name: 'helper',
  iconUrl: 'https://example.com/helper.png',
  detail: 'Agent · Claude Code',
};
const bob: Participant = {
  kind: 'person',
  id: 'u2',
  name: 'Bob Member',
  detail: 'bob@example.com',
};

describe('MessagingAppSelector', () => {
  it('is hidden when Switch Console is the only choice', () => {
    const html = renderToStaticMarkup(
      createElement(MessagingAppSelector, {
        bridges: [],
        value: SWITCH_CONSOLE,
        onChange: () => {},
      })
    );
    expect(html).toBe('');
  });

  it('shows the chosen app with its icon, and lists Switch Console and each app', () => {
    const html = renderToStaticMarkup(
      createElement(MessagingAppSelector, {
        bridges: [slack],
        value: 'b-slack',
        onChange: () => {},
      })
    );
    expect(html).toContain('Acme Slack');
    expect(html).toContain('<svg');
    expect(
      renderToStaticMarkup(
        createElement(MessagingAppSelector, {
          bridges: [slack],
          value: SWITCH_CONSOLE,
          onChange: () => {},
        })
      )
    ).toContain('Switch Console');
    expect(messagingOptions([slack])).toEqual([
      { value: SWITCH_CONSOLE, label: 'Switch Console', type: null },
      { value: 'b-slack', label: 'Acme Slack', type: 'slack' },
    ]);
  });
});

describe('ParticipantPicker', () => {
  it('shows the picked agents and people as removable chips inside the field', () => {
    const html = renderToStaticMarkup(
      createElement(ParticipantPicker, {
        candidates: [helper, bob],
        picked: [helper, bob],
        onChange: () => {},
        serverId: 's',
        loading: false,
        inputId: 'participants',
        autoFocus: false,
        busy: false,
        overlay: false,
      })
    );
    expect(html).toContain('aria-label="Remove helper"');
    expect(html).toContain('aria-label="Remove Bob Member"');
    expect(html).toContain('src="https://example.com/helper.png"');
    expect(html).toContain('>BM<');
  });
});
