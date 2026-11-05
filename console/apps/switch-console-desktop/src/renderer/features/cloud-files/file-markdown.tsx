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

const COMPONENTS: Components = { a: FileLink, img: FileImage };

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
