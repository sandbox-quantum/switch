import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatHostProvider } from '../host';
import { stubChatHost } from '../testing';
import { MessagingAppBanner } from './messaging-app-banner';

describe('MessagingAppBanner', () => {
  afterEach(cleanup);

  it('is one button named for connecting a messaging app, with Slack and Discord stacked out of reach of a screen reader', () => {
    const onConnect = vi.fn();
    const { container } = render(
      <ChatHostProvider host={stubChatHost()}>
        <MessagingAppBanner onConnect={onConnect} />
      </ChatHostProvider>
    );
    const button = screen.getByRole('button', { name: 'Connect a messaging app' });
    expect(button).toHaveAccessibleDescription('Bring your agents to Slack or Discord');
    const icons = [...container.querySelectorAll('[data-bridge-icon]')];
    expect(icons.map((icon) => icon.getAttribute('data-bridge-icon'))).toEqual([
      'slack',
      'discord',
    ]);
    expect(icons.every((icon) => icon.closest('[aria-hidden]') !== null)).toBe(true);
    fireEvent.click(button);
    expect(onConnect).toHaveBeenCalledOnce();
  });
});
