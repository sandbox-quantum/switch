import { coerceRawSvgContent } from '@renderer/utils/mcp-icon-data';
import { connectionMonogram } from './connections-filter';

// Brand logos for the connection catalog, keyed by the catalog slug. Provenance
// and licensing for each file is in `assets/images/connections/NOTICE.md`.
const svgs = import.meta.glob('../../../assets/images/connections/*.svg', {
  query: '?raw',
  eager: true,
});

const svgBySlug = new Map(
  Object.entries(svgs)
    .map(([path, data]) => [
      path
        .split('/')
        .pop()!
        .replace(/\.svg$/, ''),
      coerceRawSvgContent(data),
    ])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
);

// The single-colour marks draw in `currentColor`. Each takes its official brand
// colour, except on the theme where that colour would vanish into the tile: there
// it uses the one-colour black or white version the brand's guidelines provide.
// Canva, Microsoft 365 and Salesforce ship their own full-colour marks, which
// read on both themes, and need no entry.
const MARK_COLOR: Record<string, string> = {
  github: 'text-foreground',
  notion: 'text-foreground',
  vercel: 'text-foreground',
  linear: 'text-[#5E6AD2]',
  'google-workspace': 'text-[#4285F4]',
  asana: 'text-[#F06A6A]',
  gitlab: 'text-[#FC6D26]',
  atlassian: 'text-[#0052CC] emdark:text-foreground',
  bitbucket: 'text-[#0052CC] emdark:text-foreground',
  box: 'text-[#0061D5] emdark:text-foreground',
  datadog: 'text-[#632CA6] emdark:text-foreground',
  'new-relic': 'text-foreground emdark:text-[#1CE783]',
};

export function hasConnectionIcon(slug: string): boolean {
  return svgBySlug.has(slug);
}

const TILE_SIZE = {
  md: { tile: 'size-9 rounded-md text-sm', mark: 'size-6' },
  lg: { tile: 'size-11 rounded-lg text-base', mark: 'size-7' },
  xl: { tile: 'size-16 rounded-xl text-2xl', mark: 'size-10' },
} as const;

/** A connection's brand logo on a neutral tile, or its monogram for a slug this build has no logo for. */
export function ConnectionIcon({
  slug,
  name,
  size = 'md',
}: {
  slug: string;
  name: string;
  /** The tile's size: the catalog's lists use `md`. */
  size?: keyof typeof TILE_SIZE;
}) {
  const svg = svgBySlug.get(slug);
  const { tile, mark } = TILE_SIZE[size];
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center bg-background-2 font-semibold text-foreground-muted ${tile}`}
    >
      {svg ? (
        <span
          className={`${mark} ${MARK_COLOR[slug] ?? ''}`}
          // Bundled brand assets, not user input.
          dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg class="size-full" ') }}
        />
      ) : (
        connectionMonogram(name)
      )}
    </span>
  );
}
