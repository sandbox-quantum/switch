export type TemplateKind = 'agent' | 'room' | 'group';

export type TemplateScope = 'all' | 'official' | 'workspace' | 'yours';

export const TEMPLATE_SCOPES: readonly { value: TemplateScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'official', label: 'Official' },
  { value: 'workspace', label: 'Workspace' },
  { value: 'yours', label: 'Yours' },
];

type TemplateSummary = {
  kind: string;
  official: boolean;
  ownerId: string | null;
  name: string;
  description: string;
  creator: string;
};

export function kindOf(kind: string): TemplateKind {
  return kind === 'agent' || kind === 'group' ? kind : 'room';
}

export function inScope(
  template: TemplateSummary,
  scope: TemplateScope,
  meId: string | null
): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'official':
      return template.official;
    case 'workspace':
      return !template.official;
    case 'yours':
      return !template.official && meId !== null && template.ownerId === meId;
  }
}

export function scopeCounts(
  templates: readonly TemplateSummary[],
  meId: string | null
): Record<TemplateScope, number> {
  const counts: Record<TemplateScope, number> = { all: 0, official: 0, workspace: 0, yours: 0 };
  for (const t of templates) {
    for (const { value } of TEMPLATE_SCOPES) {
      if (inScope(t, value, meId)) counts[value] += 1;
    }
  }
  return counts;
}

export type TemplateFilter = {
  scope: TemplateScope;
  kinds: readonly TemplateKind[];
  query: string;
  meId: string | null;
};

export function matchesFilter(template: TemplateSummary, filter: TemplateFilter): boolean {
  if (!inScope(template, filter.scope, filter.meId)) return false;
  if (filter.kinds.length > 0 && !filter.kinds.includes(kindOf(template.kind))) return false;
  const needle = filter.query.trim().toLowerCase();
  return (
    needle.length === 0 ||
    template.name.toLowerCase().includes(needle) ||
    template.description.toLowerCase().includes(needle) ||
    template.creator.toLowerCase().includes(needle)
  );
}

export function toggleKind(
  kinds: readonly TemplateKind[],
  kind: TemplateKind
): readonly TemplateKind[] {
  return kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
}
