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
  pagerduty: { light: "#06AC38", dark: "#06AC38" },
  grafana: { light: "#F46800", dark: "#F46800" },
  supabase: { light: "#3FCF8E", dark: "#3FCF8E" },
  cloudflare: { light: "#F38020", dark: "#F38020" },
  stripe: { light: "#635BFF", dark: "#635BFF" },
  shopify: { light: "#7AB55C", dark: "#7AB55C" },
  hubspot: { light: "#FF7A59", dark: "#FF7A59" },
  clickup: { light: "#7B68EE", dark: "#7B68EE" },
  trello: { light: "#0052CC", dark: FOREGROUND },
  dropbox: { light: "#0061FF", dark: FOREGROUND },
  snowflake: { light: "#29B5E8", dark: "#29B5E8" },
  bigquery: { light: "#669DF6", dark: "#669DF6" },
  intercom: { light: FOREGROUND, dark: "#6AFDEF" },
  zendesk: { light: "#03363D", dark: FOREGROUND },
  calendly: { light: "#006BFF", dark: FOREGROUND },
  zoom: { light: "#0B5CFF", dark: FOREGROUND },
  miro: { light: "#050038", dark: FOREGROUND },
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
