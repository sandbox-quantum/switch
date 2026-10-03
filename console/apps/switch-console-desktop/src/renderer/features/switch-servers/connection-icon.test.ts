import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasConnectionIcon } from './connection-icon';

const here = dirname(fileURLToPath(import.meta.url));
const ICON_DIR = join(here, '../../../assets/images/connections');
const CATALOG_DIR = join(here, '../../../../../../../core/switch_core/connections/catalog');

const catalogSlugs = readdirSync(CATALOG_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const bundled = readdirSync(ICON_DIR)
  .filter((file) => file.endsWith('.svg'))
  .map((file) => file.replace(/\.svg$/, ''));

describe('connection brand icons', () => {
  it('reads the catalog it checks against', () => {
    expect(catalogSlugs).toContain('github');
  });

  it.each(catalogSlugs)('%s has a logo the loader resolves', (slug) => {
    expect(hasConnectionIcon(slug)).toBe(true);
  });

  it('falls back for a slug this build does not know', () => {
    expect(hasConnectionIcon('some-future-service')).toBe(false);
  });

  it('bundles no logo for a slug outside the catalog', () => {
    for (const slug of bundled) expect(catalogSlugs).toContain(slug);
  });

  it.each(bundled)('%s.svg is self-contained and scalable', (slug) => {
    const svg = readFileSync(join(ICON_DIR, `${slug}.svg`), 'utf8');
    expect(svg).toMatch(/<svg [^>]*viewBox="[^"]+"/);
    expect(svg).not.toMatch(
      /<script|<image|<foreignObject|<metadata|xlink:href|href="http|\son\w+=/i
    );
  });

  it('records provenance for every bundled logo', () => {
    const notice = readFileSync(join(ICON_DIR, 'NOTICE.md'), 'utf8');
    for (const slug of bundled) expect(notice).toContain(`\`${slug}.svg\``);
  });
});
