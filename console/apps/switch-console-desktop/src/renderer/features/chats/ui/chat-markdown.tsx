import type * as React from 'react';
import {
  defaultComponents,
  defaultRehypePlugins,
  defaultUrlTransform,
  Streamdown,
  type Components,
  type ExtraProps,
  type UrlTransform,
} from 'streamdown';
import type { PluggableList } from 'unified';
import { followConsoleLink } from '@renderer/features/deeplinks/console-link-handler';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { cn } from '@renderer/utils/utils';
import { CONSOLE_LINK_PREFIX, CONSOLE_LINK_SCHEME } from '@shared/core/deeplinks/console-links';
import { CodeBlock } from './code-block';
import { PLATFORM_LOGO_PREFIX, platformOfLogoUrl } from './platform-logo';

const HTTP_URL_PATTERN = /^https?:\/\//i;

/**
 * Streamdown's defaults minus `rehype-raw`: chat text is written by agents and
 * other people, so HTML in it is dropped rather than parsed (`skipHtml` below
 * removes the raw nodes; without `rehype-raw` nothing would turn them into
 * elements anyway). Sanitize and harden stay.
 */
const REHYPE_PLUGINS: PluggableList = [
  withConsoleLinks(defaultRehypePlugins.sanitize),
  defaultRehypePlugins.harden,
];

type SanitizeSchema = { protocols?: Record<string, string[]> };

/**
 * The sanitizer, letting links to Console pages keep their `href`, and
 * messaging-app logos their `src`: its schema allows web and mail addresses
 * only, and a `switchdash:` one would arrive stripped, as text marked blocked.
 */
function withConsoleLinks(sanitize: PluggableList[number]): PluggableList[number] {
  const [plugin, schema] = sanitize as [unknown, SanitizeSchema];
  return [
    plugin,
    {
      ...schema,
      protocols: {
        ...schema.protocols,
        href: [...(schema.protocols?.href ?? []), CONSOLE_LINK_SCHEME],
        src: [...(schema.protocols?.src ?? []), CONSOLE_LINK_SCHEME],
      },
    },
  ] as PluggableList[number];
}

/**
 * Links to Console pages and messaging-app logos pass; everything else gets
 * the usual unsafe-protocol filter.
 */
const urlTransform: UrlTransform = (url, key, node) =>
  (key === 'href' && url.startsWith(CONSOLE_LINK_PREFIX)) ||
  (key === 'src' && url.startsWith(PLATFORM_LOGO_PREFIX))
    ? url
    : defaultUrlTransform(url, key, node);

type WithChildren = { children?: React.ReactNode } & ExtraProps;

function ChatLink({ href, children }: React.ComponentProps<'a'> & ExtraProps) {
  const isHttp = typeof href === 'string' && HTTP_URL_PATTERN.test(href);
  return (
    <a
      href={href}
      className="text-foreground underline decoration-foreground-passive underline-offset-2 hover:decoration-foreground"
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        // Never let a link navigate the app window: a link to a Console page
        // moves the app there, and only http(s) links leave the app, through
        // the confirm dialog.
        event.preventDefault();
        if (typeof href === 'string' && href.startsWith(CONSOLE_LINK_PREFIX))
          followConsoleLink(href);
        else if (isHttp) confirmOpenExternalLink(href);
      }}
    >
      {children}
    </a>
  );
}

function ChatCode({
  node: _node,
  children,
  className,
  ...props
}: React.ComponentProps<'code'> & ExtraProps) {
  if ('data-block' in props) {
    const language = /language-([\w+-]+)/.exec(className ?? '')?.[1];
    return <CodeBlock code={String(children).replace(/\n$/, '')} language={language} />;
  }
  return (
    <code className="rounded bg-background-2 px-1 py-0.5 font-mono text-[0.92em]">{children}</code>
  );
}

/**
 * A messaging app where the message names one with its logo: the logo and the
 * app's name (the image's alt text) in bold, inline and on one line; any other
 * image as usual.
 */
function ChatImage(props: React.ComponentProps<'img'> & ExtraProps) {
  const platform = platformOfLogoUrl(props.src);
  if (platform === null) {
    const DefaultImage = defaultComponents.img;
    return <DefaultImage {...props} />;
  }
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      {hasBridgeIcon(platform) && (
        <span aria-hidden className="translate-y-[2px]">
          <BridgeIcon bridgeType={platform} size={14} />
        </span>
      )}
      <strong className="font-semibold">{props.alt}</strong>
    </span>
  );
}

const COMPONENTS: Components = {
  a: ChatLink,
  img: ChatImage,
  code: ChatCode,
  p: ({ children }: WithChildren) => <p className="my-2 leading-relaxed">{children}</p>,
  h1: ({ children }: WithChildren) => (
    <h1 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }: WithChildren) => (
    <h2 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }: WithChildren) => (
    <h3 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }: WithChildren) => (
    <h4 className="mt-3 mb-1 text-sm font-medium first:mt-0">{children}</h4>
  ),
  h5: ({ children }: WithChildren) => (
    <h5 className="mt-2 mb-1 text-xs font-medium first:mt-0">{children}</h5>
  ),
  h6: ({ children }: WithChildren) => (
    <h6 className="mt-2 mb-1 text-xs font-medium text-foreground-muted first:mt-0">{children}</h6>
  ),
  ul: ({ children }: WithChildren) => (
    <ul className="my-2 ml-5 list-disc space-y-1 marker:text-foreground-passive">{children}</ul>
  ),
  ol: ({ children }: WithChildren) => (
    <ol className="my-2 ml-5 list-decimal space-y-1 marker:text-foreground-passive">{children}</ol>
  ),
  li: ({ children }: WithChildren) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }: WithChildren) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-foreground-muted">
      {children}
    </blockquote>
  ),
  table: ({ children }: WithChildren) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-max border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: WithChildren) => (
    <thead className="border-b border-border bg-background-2">{children}</thead>
  ),
  th: ({ children }: WithChildren) => (
    <th className="border-r border-border px-2.5 py-1.5 font-semibold last:border-r-0">
      {children}
    </th>
  ),
  td: ({ children }: WithChildren) => (
    <td className="border-t border-r border-border px-2.5 py-1.5 align-top last:border-r-0">
      {children}
    </td>
  ),
  hr: (_props: ExtraProps) => <hr className="my-4 border-border" />,
  strong: ({ children }: WithChildren) => <strong className="font-semibold">{children}</strong>,
};

/** Markdown for chat messages, tolerant of a reply that is still streaming in. */
export function ChatMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <Streamdown
      className={cn('min-w-0 text-sm text-foreground', className)}
      components={COMPONENTS}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={urlTransform}
      skipHtml
      controls={false}
      linkSafety={{ enabled: false }}
    >
      {children}
    </Streamdown>
  );
}
