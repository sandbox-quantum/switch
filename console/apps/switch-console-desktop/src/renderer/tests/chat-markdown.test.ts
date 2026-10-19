import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatMarkdown } from '@renderer/features/chats/ui/chat-markdown';

vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));

vi.mock('@renderer/lib/open-external-link', () => ({
  confirmOpenExternalLink: vi.fn(),
}));

function render(markdown: string): string {
  return renderToStaticMarkup(React.createElement(ChatMarkdown, null, markdown));
}

describe('ChatMarkdown', () => {
  it('renders markdown', () => {
    const html = render('Hello **world**');
    expect(html).toContain('<strong');
    expect(html).toContain('world');
  });

  it('shows raw HTML from the message as text instead of rendering it', () => {
    const html = render('before <img src="x" onerror="alert(1)"> <script>alert(2)</script> after');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not render a block of raw HTML either', () => {
    const html = render(
      'text\n\n<div onclick="alert(1)"><iframe src="https://example.com"></iframe></div>\n\nmore'
    );
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<div onclick');
  });

  it('does not render a javascript: link as a live href', () => {
    const html = render('[click](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
  });

  it('renders a fenced block through the chat code block', () => {
    const html = render('```ts\nconst a = 1;\n```');
    expect(html).toContain('data-slot="code-block"');
    expect(html).toContain('ts');
  });
});
