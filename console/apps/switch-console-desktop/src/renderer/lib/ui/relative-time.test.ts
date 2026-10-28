import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelativeTime } from './relative-time';

const NOW = new Date('2026-10-28T12:00:00Z');

function renderText(props: Parameters<typeof RelativeTime>[0]): string {
  const html = renderToStaticMarkup(createElement(RelativeTime, props));
  return html.replace(/<[^>]+>/g, '');
}

describe('RelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const fiveMinutesAgo = new Date(NOW.getTime() - 5 * 60_000);

  it('says "ago" once in the full form', () => {
    expect(renderText({ value: fiveMinutesAgo })).toBe('5 minutes ago');
  });

  it('says "ago" once in the full form when asked for it', () => {
    expect(renderText({ value: fiveMinutesAgo, ago: true })).toBe('5 minutes ago');
  });

  it('leaves "ago" off the compact form unless asked', () => {
    expect(renderText({ value: fiveMinutesAgo, compact: true })).toBe('5m');
  });

  it('adds "ago" to the compact form when asked', () => {
    expect(renderText({ value: fiveMinutesAgo, compact: true, ago: true })).toBe('5m ago');
  });

  it('does not add "ago" to "now" in the compact form', () => {
    expect(renderText({ value: NOW, compact: true, ago: true })).toBe('now');
  });
});
