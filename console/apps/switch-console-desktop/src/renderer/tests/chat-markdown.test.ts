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

  describe('math', () => {
    const tex = (html: string) =>
      [...html.matchAll(/<annotation encoding="application\/x-tex">(.*?)<\/annotation>/gs)].map(
        (m) => m[1]
      );

    it('renders $…$ as inline KaTeX amid prose', () => {
      const html = render('so $\\tfrac{3\\sqrt{2}}{2}$ here');
      expect(html).toContain('class="katex"');
      expect(html).not.toContain('katex-display');
      expect(html).toContain('<mfrac>');
      expect(html).toContain('<msqrt>');
      expect(html).toContain('so ');
      expect(html).toContain(' here');
    });

    it('renders multiline $$…$$ as display KaTeX', () => {
      const html = render('$$\n|z|^2 = \\frac{a}{b} \\pm \\bar z\n$$');
      expect(html).toContain('katex-display');
      expect(html).toContain('<mfrac>');
      expect(html).toContain('±');
      expect(html).toContain('accent="true"');
    });

    it('keeps code literal: inline, fenced, indented and quoted', () => {
      const html = render('`$a$`\n\n```\n$b$\n```\n\n> `$c$`\n\n    $d$');
      expect(html).not.toContain('katex');
      for (const t of ['$a$', '$b$', '$c$', '$d$']) expect(html).toContain(t);
      expect(html).toContain('data-slot="code-block"');
    });

    it('keeps math-labelled and look-alike fences as code beside real $ math', () => {
      const labels = [
        'math',
        'switch-math',
        'switch-math-inline',
        'switch-math-display',
        'math-literal',
        'math-inline',
        'math-display',
      ];
      const fences = labels.map((label) => '```' + label + '\nx^2\n```').join('\n\n');
      const html = render(`inline $a+b$ then\n\n${fences}\n\n$$\nc=d\n$$`);
      // Only the two real formulas become KaTeX.
      expect(tex(html)).toEqual(['a+b', 'c=d']);
      expect(html).toContain('katex-display');
      expect(html.match(/data-slot="code-block"/g)).toHaveLength(labels.length);
      for (const label of labels) expect(html).toContain(`>${label}</span>`);
    });

    it('keeps a math fence with meta text as code', () => {
      const html = render('```math title="t"\nx^2\n```\n\n$y$');
      expect(tex(html)).toEqual(['y']);
      expect(html).toContain('data-slot="code-block"');
    });

    it('does not let raw HTML claim to be math', () => {
      const html = render('<code class="language-math math-inline">x^2</code> and $y$');
      expect(tex(html)).toEqual(['y']);
    });

    it('does not read backslash delimiters or bare parentheses as math (baseline)', () => {
      const html = render('(\\tfrac{1}{2}) and \\(x\\)');
      expect(html).not.toContain('katex');
      expect(html).toContain('\\tfrac{1}{2}');
    });

    it('keeps escaped dollars literal', () => {
      const html = render('cost \\$5 and \\$10');
      expect(html).not.toContain('katex');
      expect(html).toContain('cost $5 and $10');
    });

    it('known ambiguity: unescaped "$5 and $10" is read as math', () => {
      // Single-dollar math matches the session transcript; a literal amount
      // must be escaped as \$5.
      const html = render('cost $5 and $10 ok');
      expect(tex(html)).toEqual(['5 and ']);
      expect(html).toContain('10 ok');
    });

    it('leaves unmatched or partial math as text without throwing', () => {
      for (const partial of ['$x^', '$unclosed text', 'a $ b', '$$']) {
        expect(() => render(partial)).not.toThrow();
      }
      const html = render('before $unclosed text');
      expect(html).not.toContain('katex');
      expect(html).toContain('before $unclosed text');
    });

    it('does not throw on invalid TeX and keeps surrounding text', () => {
      const html = render('a $\\frac{1$ b');
      expect(html).toContain('a ');
      expect(html).toContain(' b');
    });

    it('does not produce a live javascript: href from TeX', () => {
      const html = render('$\\href{javascript:alert(1)}{x}$');
      expect(html).not.toMatch(/href="javascript:/i);
      expect(html).not.toContain('<a ');
    });

    it('still renders Console links and drops raw HTML next to math', () => {
      const html = render('$x$ [go](switchdash://rooms/1) <script>alert(1)</script>');
      expect(html).toContain('class="katex"');
      expect(html).toContain('href="switchdash://rooms/1"');
      expect(html).not.toContain('<script');
    });
  });
});
