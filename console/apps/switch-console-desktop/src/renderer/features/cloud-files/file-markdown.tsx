import type * as React from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';

/**
 * A Markdown file from the person's cloud, shown as Markdown with nothing in
 * it that can run or fetch: raw HTML is dropped (`skipHtml`, and no
 * `rehype-raw` to parse it), an image shows as its alt text only (so no
 * remote or local request is ever made), and only an `https:` link does
 * anything, through the same confirm as every external link. `javascript:`,
 * `data:`, `file:`, plain `http:` and relative links are inert text.
 */

const HTTPS = /^https:\/\//i;

/** Whether a link in a cloud Markdown file may open: `https:` only. */
export function opensLink(href: unknown): href is string {
  return typeof href === 'string' && HTTPS.test(href.trim());
}

function FileLink({ href, children }: React.ComponentProps<'a'> & ExtraProps) {
  if (!opensLink(href)) return <span className="underline decoration-dotted">{children}</span>;
  return (
    <a
      href={href}
      className="underline underline-offset-2"
      onClick={(event) => {
        // Never let the link move the app window; it leaves only through the confirm.
        event.preventDefault();
        confirmOpenExternalLink(href);
      }}
    >
      {children}
    </a>
  );
}

/** An image as its alt text: nothing is loaded, from the box or anywhere else. */
function FileImage({ alt }: React.ComponentProps<'img'> & ExtraProps) {
  return (
    <span className="rounded bg-background-2 px-1 text-foreground-muted" data-image-placeholder="">
      {alt ? `[image: ${alt}]` : '[image]'}
    </span>
  );
}

type Children = { children?: React.ReactNode };

/**
 * Console's usual prose look (the same classes as its Markdown renderer for
 * documents), so a README reads like one: sized headings, paragraph gaps,
 * padded table cells. Only the look is shared; links and images stay the safe
 * ones above, and code is plain text with no highlighter.
 */
const COMPONENTS: Components = {
  a: FileLink,
  img: FileImage,
  h1: ({ children }: Children) => (
    <h1 className="mt-6 mb-4 border-b border-border pb-2 text-2xl font-semibold text-foreground first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }: Children) => (
    <h2 className="mt-6 mb-3 border-b border-border pb-2 text-xl font-semibold text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }: Children) => (
    <h3 className="mt-4 mb-2 text-lg font-semibold text-foreground">{children}</h3>
  ),
  h4: ({ children }: Children) => (
    <h4 className="mt-4 mb-2 text-base font-semibold text-foreground">{children}</h4>
  ),
  h5: ({ children }: Children) => (
    <h5 className="mt-3 mb-1 text-sm font-semibold text-foreground">{children}</h5>
  ),
  h6: ({ children }: Children) => (
    <h6 className="mt-3 mb-1 text-sm font-semibold text-foreground-muted">{children}</h6>
  ),
  p: ({ children }: Children) => <p className="mb-3 leading-relaxed">{children}</p>,
  ul: ({ children }: Children) => <ul className="mb-3 ml-6 list-disc space-y-1">{children}</ul>,
  ol: ({ children }: Children) => <ol className="mb-3 ml-6 list-decimal space-y-1">{children}</ol>,
  li: ({ children }: Children) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }: Children) => (
    <blockquote className="mb-3 border-l-4 border-border py-1 pl-4 text-foreground-muted italic">
      {children}
    </blockquote>
  ),
  pre: ({ children }: Children) => (
    <pre className="mb-3 overflow-x-auto rounded-md border border-border bg-background-1 p-3 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }: Children) => (
    <code className="rounded bg-background-1 px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
  table: ({ children }: Children) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: Children) => (
    <thead className="border-b border-border bg-background-1">{children}</thead>
  ),
  th: ({ children }: Children) => <th className="px-3 py-2 text-left font-semibold">{children}</th>,
  td: ({ children }: Children) => <td className="border-t border-border px-3 py-2">{children}</td>,
  hr: () => <hr className="my-6 border-border" />,
  strong: ({ children }: Children) => <strong className="font-semibold">{children}</strong>,
};

export function FileMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-sm text-foreground">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}

/** Text or code from the person's cloud: React text in a `<pre>`, so nothing in it is ever markup. */
export function FileText({ text }: { text: string }) {
  return <pre className="font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>;
}
