import { describe, expect, it, vi } from 'vitest';
import {
  buildPromptInjectionPayload,
  pastePromptInjection,
} from '@renderer/lib/pty/prompt-injection';

describe('prompt injection', () => {
  it('wraps single-line input in bracketed paste so @ does not trigger autocomplete', () => {
    // A raw `@` would open Claude Code's file-path autocomplete and swallow the
    // follow-up Enter (CHOO-1395); bracketed paste inserts it literally.
    expect(buildPromptInjectionPayload('[Switch] alice addressed you: @worker ping')).toBe(
      '\x1b[200~[Switch] alice addressed you: @worker ping \x1b[201~'
    );
  });

  it('terminates a trailing @mention so the cursor does not sit on an open picker', () => {
    // End-of-message tags always reproduced CHOO-1395 even with bracketing: the
    // cursor landed on the @token and reopened the picker. The trailing space
    // moves the cursor past it.
    expect(buildPromptInjectionPayload('ping @worker')).toBe('\x1b[200~ping @worker \x1b[201~');
  });

  it('wraps multiline input in bracketed paste', () => {
    expect(buildPromptInjectionPayload('Line one\nLine two')).toBe(
      '\x1b[200~Line one\nLine two \x1b[201~'
    );
  });

  it('trims surrounding whitespace before wrapping', () => {
    expect(buildPromptInjectionPayload('  hello  ')).toBe('\x1b[200~hello \x1b[201~');
  });

  it('returns empty for whitespace-only input so callers can skip it', () => {
    expect(buildPromptInjectionPayload('   ')).toBe('');
  });

  it('strips an embedded end marker so a message cannot close the paste early', () => {
    // A room message any participant can write. Without stripping, the embedded
    // ESC[201~ ends the paste and everything after it reaches the agent's TUI as
    // live keystrokes.
    const payload = buildPromptInjectionPayload('hi\x1b[201~\r/exit');

    // Only the two markers we add are left, so the paste stays open to the end.
    expect((payload.match(/\x1b/g) ?? []).length).toBe(2);
    expect(payload).toBe('\x1b[200~hi[201~/exit \x1b[201~');
    expect(payload).not.toContain('\r');
  });

  it('keeps tabs and newlines so pasted content is unchanged', () => {
    expect(buildPromptInjectionPayload('a\n\tb')).toBe('\x1b[200~a\n\tb \x1b[201~');
  });

  it('sends the bracketed payload through sendInput', async () => {
    const sendInput = vi.fn().mockResolvedValue(undefined);

    await pastePromptInjection({ text: '/var/folders/example image.png', sendInput });

    expect(sendInput).toHaveBeenCalledWith('\x1b[200~/var/folders/example image.png \x1b[201~');
  });

  it('does not call sendInput for empty input', async () => {
    const sendInput = vi.fn().mockResolvedValue(undefined);

    await pastePromptInjection({ text: '   ', sendInput });

    expect(sendInput).not.toHaveBeenCalled();
  });
});
