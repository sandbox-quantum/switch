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
