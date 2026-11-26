import type { TemplateSummary } from "../../data/api";
import { type TemplateKind, TEMPLATE_KINDS, kindOf, ownerLabel, useCaseLabel } from "./templateRows";

/** Whose templates a tab shows: Official come with Switch, Workspace is every
 * other one the viewer can see, so the two add up to All. */
export type TemplateScope = "all" | "official" | "workspace";

export const TEMPLATE_SCOPES: readonly { value: TemplateScope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "official", label: "Official" },
  { value: "workspace", label: "Workspace" },
];

export type TypeFilter = "all" | TemplateKind;

export interface TemplateFilter {
  scope: TemplateScope;
  type: TypeFilter;
  query: string;
  /** Only the viewer's own, which leaves out every official template. */
  onlyMine: boolean;
  viewerId: string | null;
}

export const NO_FILTER: Omit<TemplateFilter, "viewerId"> = {
  scope: "all",
  type: "all",
  query: "",
  onlyMine: false,
};

/** Whether anything narrows the library beyond the tab. */
export function narrowed(filter: TemplateFilter): boolean {
  return filter.query.trim() !== "" || filter.type !== "all" || filter.onlyMine;
}

function inScope(template: TemplateSummary, scope: TemplateScope): boolean {
  if (scope === "all") return true;
  return template.official === (scope === "official");
}

function isMine(template: TemplateSummary, viewerId: string | null): boolean {
  return !template.official && viewerId !== null && template.owner_id === viewerId;
}

/** Name, description, use case and owner, case-insensitively. */
export function matchesQuery(template: TemplateSummary, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    template.name,
    template.description,
    template.use_case ? useCaseLabel(template.use_case) : "",
    ownerLabel(template),
  ]
    .join("\n")
    .toLocaleLowerCase()
    .includes(needle);
}

/** Search and Only mine: what every count on the page is taken over. */
function searched(templates: readonly TemplateSummary[], filter: TemplateFilter): TemplateSummary[] {
  return templates.filter(
    (t) => matchesQuery(t, filter.query) && (!filter.onlyMine || isMine(t, filter.viewerId)),
  );
}

/** Each tab's count: what picking it would show, whatever tab is picked,
 * so the counts follow search and Only mine but not the tab itself or the
 * type. */
export function scopeCounts(
  templates: readonly TemplateSummary[],
  filter: TemplateFilter,
): Record<TemplateScope, number> {
  const pool = searched(templates, filter);
  return {
    all: pool.length,
    official: pool.filter((t) => t.official).length,
    workspace: pool.filter((t) => !t.official).length,
  };
}

/** Each type chip's count, within the tab, search and Only mine: what
 * pressing it would show. */
export function typeCounts(
  templates: readonly TemplateSummary[],
  filter: TemplateFilter,
): Record<TypeFilter, number> {
  const pool = searched(templates, filter).filter((t) => inScope(t, filter.scope));
  const counts: Record<TypeFilter, number> = { all: pool.length, agent: 0, room: 0, group: 0 };
  for (const t of pool) counts[kindOf(t)] += 1;
  return counts;
}

/** In the All tab the Official section shows this many, with a way to the
 * rest; the official list runs to thirty and more. */
export const OFFICIAL_PREVIEW = 6;

export interface LibrarySection {
  id: "workspace" | "official";
  label: string;
  /** How many match, which may be more than `items` shows. */
  total: number;
  items: TemplateSummary[];
  /** Cut to a preview, so it offers "See all". */
  preview: boolean;
}

/** The templates the filter leaves, most used first, in two sections: this
 * workspace's own, the short local list, then the official ones. A section
 * with nothing in it is left out. */
export function librarySections(
  templates: readonly TemplateSummary[],
  filter: TemplateFilter,
): LibrarySection[] {
  const matched = searched(templates, filter)
    .filter((t) => inScope(t, filter.scope) && (filter.type === "all" || kindOf(t) === filter.type))
    .sort((a, b) => b.run_count - a.run_count);
  const sections: LibrarySection[] = [];
  const workspace = matched.filter((t) => !t.official);
  if (workspace.length > 0) {
    sections.push({ id: "workspace", label: "Workspace", total: workspace.length, items: workspace, preview: false });
  }
  const official = matched.filter((t) => t.official);
  if (official.length > 0) {
    const preview = filter.scope === "all" && official.length > OFFICIAL_PREVIEW;
    sections.push({
      id: "official",
      label: "Official",
      total: official.length,
      items: preview ? official.slice(0, OFFICIAL_PREVIEW) : official,
      preview,
    });
  }
  return sections;
}

export const TYPE_FILTERS: readonly { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...TEMPLATE_KINDS,
];
