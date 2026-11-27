import { ImageIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '../primitives/button';

/** Stands in for the page an image's address is resolved against; never fetched. */
const PAGE = 'https://renderer.invalid/';

/**
 * Whether showing an image from `src` would fetch it from another computer:
 * an address on the web, or one this page cannot vouch for. Fetching it tells
 * whoever chose the address that this person is reading, from where, and with
 * which app. `data:` and `blob:` images are already here, and a relative
 * address is the app's own.
 */
export function loadsFromElsewhere(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src, PAGE);
  } catch {
    return true;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
  return url.origin !== new URL(PAGE).origin;
}

/** Where an image would be fetched from, as the person reads an address. */
function hostOf(src: string): string {
  try {
    return new URL(src, PAGE).host || src;
  } catch {
    return src;
  }
}

/**
 * An image someone else chose the address of, held back until the person
 * asks for it: `children`, the image itself, is drawn only after "Load image".
 */
export function AskBeforeLoading({
  src,
  alt,
  children,
}: {
  src: string;
  alt: string;
  children: ReactNode;
}) {
  const [load, setLoad] = useState(false);
  if (load) return <>{children}</>;
  return (
    <span
      data-slot="image-not-loaded"
      title={src}
      className="my-2 inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-background-1 px-2 py-1 align-top text-xs text-foreground-muted"
    >
      <ImageIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {alt ? `${alt} · ` : ''}Image from {hostOf(src)}
      </span>
      <Button type="button" size="xs" variant="outline" onClick={() => setLoad(true)}>
        Load image
      </Button>
    </span>
  );
}
