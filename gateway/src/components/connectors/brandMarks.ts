/** Brand logos for the connection catalog, keyed by catalog slug. Provenance
 *  and licensing for each file is in `src/assets/connections/NOTICE.md`. */
const files = import.meta.glob<string>("../../assets/connections/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

const svgBySlug = new Map(
  Object.entries(files).map(([path, svg]) => [path.split("/").pop()!.replace(/\.svg$/, ""), svg]),
);

/** The logo's markup, sized to fill its box, or undefined for a slug this
 *  build has no logo for. Bundled assets, not user input. */
export function brandSvg(slug: string): string | undefined {
  return svgBySlug.get(slug)?.replace(/<svg(?=[\s>])/, '<svg width="100%" height="100%"');
}

const FOREGROUND = "var(--sw-foreground)";

/** The single-colour marks draw in `currentColor`. Each takes its brand
 *  colour, except on the scheme where that colour would vanish into the tile:
 *  there it takes the one-colour black or white version the brand's
 *  guidelines provide. Canva, Google, Microsoft 365 and Salesforce ship full-colour
 *  marks that read on both schemes, and need no entry. */
export const MARK_COLOR: Readonly<Record<string, { light: string; dark: string }>> = {
  github: { light: FOREGROUND, dark: FOREGROUND },
  notion: { light: FOREGROUND, dark: FOREGROUND },
  vercel: { light: FOREGROUND, dark: FOREGROUND },
  linear: { light: "#5E6AD2", dark: "#5E6AD2" },
  asana: { light: "#F06A6A", dark: "#F06A6A" },
  gitlab: { light: "#FC6D26", dark: "#FC6D26" },
  atlassian: { light: "#0052CC", dark: FOREGROUND },
  bitbucket: { light: "#0052CC", dark: FOREGROUND },
  box: { light: "#0061D5", dark: FOREGROUND },
  datadog: { light: "#632CA6", dark: FOREGROUND },
  "new-relic": { light: FOREGROUND, dark: "#1CE783" },
  airtable: { light: FOREGROUND, dark: "#18BFFF" },
};

/** Up to two initials, for a service with no logo: "New Relic" -> "NR". */
export function monogram(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter((word) => /^\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word[0]!.toLocaleUpperCase())
    .join("");
}
