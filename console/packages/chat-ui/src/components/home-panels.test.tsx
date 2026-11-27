import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskBuddyPanel, ConnectAiPanel } from './home-panels';

describe('AskBuddyPanel', () => {
  afterEach(() => cleanup());

  it('sends what is typed, from no suggestion, and clears the box', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn().mockResolvedValue(undefined);
    render(<AskBuddyPanel onAsk={onAsk} chips={[]} />);

    const box = screen.getByPlaceholderText('Ask switch-buddy anything') as HTMLTextAreaElement;
    await user.type(box, '  test message ');
    await user.click(screen.getByLabelText('Send'));

    expect(onAsk).toHaveBeenCalledWith('test message', null);
    expect(box.value).toBe('');
  });

  it('keeps the message in the box when sending fails', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn().mockRejectedValue(new Error('no'));
    render(<AskBuddyPanel onAsk={onAsk} chips={[]} />);

    const box = screen.getByPlaceholderText('Ask switch-buddy anything') as HTMLTextAreaElement;
    await user.type(box, 'test message{Enter}');

    expect(onAsk).toHaveBeenCalledOnce();
    expect(box.value).toBe('test message');
    expect(box.disabled).toBe(false);
  });

  it("sends a suggestion's words, naming the suggestion", async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn().mockResolvedValue(undefined);
    render(<AskBuddyPanel onAsk={onAsk} chips={['first_agent', 'team_room']} />);

    await user.click(screen.getByRole('button', { name: 'Create a room for my team' }));

    expect(screen.getByRole('button', { name: 'Create my first agent' })).toBeTruthy();
    expect(onAsk).toHaveBeenCalledWith('Create a room for my team', 'team_room');
  });

  it('does not send an empty box', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    render(<AskBuddyPanel onAsk={onAsk} chips={[]} />);

    await user.click(screen.getByLabelText('Send'));

    expect(onAsk).not.toHaveBeenCalled();
  });
});

describe('ConnectAiPanel', () => {
  afterEach(() => cleanup());

  it('connects from its button', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(<ConnectAiPanel onConnect={onConnect} unavailableReason={null} />);

    await user.click(screen.getByRole('button', { name: 'Connect to AI' }));

    expect(onConnect).toHaveBeenCalledOnce();
  });

  it('is off, saying why, when there is nothing to connect', () => {
    render(<ConnectAiPanel onConnect={null} unavailableReason="No switch-buddy here." />);

    const button = screen.getByRole('button', { name: 'Connect to AI' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement!.title).toBe('No switch-buddy here.');
  });
});
