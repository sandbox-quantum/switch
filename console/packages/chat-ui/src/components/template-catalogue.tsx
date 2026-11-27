import { ChevronDown, Loader2, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../model/cn';
import { TEMPLATE_SCOPES, type TemplateKind, type TemplateScope } from '../model/template-filters';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { KIND_ICON } from './template-card';

const KIND_CHIPS: readonly { value: TemplateKind; label: string }[] = [
  { value: 'agent', label: 'Agents' },
  { value: 'room', label: 'Rooms' },
  { value: 'group', label: 'Groups' },
];

/** The page's Create template button; `children` are the ways to create one. */
export function CreateTemplateMenu({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button>
            <Plus className="size-4" />
            Create template
            <ChevronDown className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TemplateScopeTabs({
  value,
  onChange,
  counts,
  showYours,
}: {
  value: TemplateScope;
  onChange: (scope: TemplateScope) => void;
  counts: Record<TemplateScope, number>;
  /** Only someone signed in has templates to call theirs. */
  showYours: boolean;
}) {
  const scopes = TEMPLATE_SCOPES.filter((s) => showYours || s.value !== 'yours');
  return (
    <div role="tablist" aria-label="Whose templates" className="flex gap-6 border-b border-border">
      {scopes.map((scope) => {
        const active = scope.value === value;
        return (
          <button
            key={scope.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(scope.value)}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-1 pb-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-foreground/70 hover:text-foreground'
            )}
          >
            {scope.label}
            <span className="rounded-md bg-background-2 px-1.5 text-[11px] leading-4 text-foreground">
              {counts[scope.value]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FilterChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex h-9 items-center gap-[7px] rounded-lg border px-3 text-sm font-medium transition-colors',
        pressed
          ? 'border-foreground/40 bg-background-2 text-foreground'
          : 'border-border bg-background text-foreground/70 hover:bg-background-1 hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

/** The search box above a row of chips, one per kind, each toggled on its own. */
export function TemplateFilters({
  search,
  kinds,
  onToggleKind,
}: {
  search: ReactNode;
  kinds: readonly TemplateKind[];
  onToggleKind: (kind: TemplateKind) => void;
}) {
  return (
    <div className="space-y-3">
      {search}

      <div className="flex flex-wrap items-center gap-2" aria-label="Show templates of these kinds">
        {KIND_CHIPS.map(({ value, label }) => {
          const Icon = KIND_ICON[value];
          return (
            <FilterChip
              key={value}
              pressed={kinds.includes(value)}
              onClick={() => onToggleKind(value)}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </FilterChip>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-6">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The cards under the filters: the recently opened ones first, when there are
 * any, then every match; or why there are none.
 */
export function TemplateResults<T>({
  loading,
  error,
  onRetry,
  recent,
  shown,
  filtering,
  scope,
  card,
}: {
  loading: boolean;
  /** Why the templates could not be read; shown instead of an empty list. */
  error: string | null;
  onRetry: () => void;
  recent: readonly T[];
  shown: readonly T[];
  /** Whether a search or a kind narrows the list. */
  filtering: boolean;
  scope: TemplateScope;
  card: (template: T) => ReactNode;
}) {
  const grid = 'grid grid-cols-3 gap-6';
  if (loading)
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-foreground-muted" />
      </div>
    );
  if (error)
    return (
      <div className="flex flex-col items-start gap-2 rounded-2xl border border-border px-4 py-4">
        <p className="text-sm text-foreground-muted">{error}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  return (
    <div className="space-y-10 pt-2">
      {recent.length > 0 && (
        <Section title="Recent">
          <div className={grid}>{recent.map(card)}</div>
        </Section>
      )}
      {shown.length > 0 ? (
        recent.length > 0 ? (
          <Section title="All results">
            <div className={grid}>{shown.map(card)}</div>
          </Section>
        ) : (
          <div className={grid}>{shown.map(card)}</div>
        )
      ) : filtering || scope !== 'all' ? (
        <p className="text-sm text-foreground-muted">
          {scope === 'yours' && !filtering
            ? 'None of yours yet. Create a template and it shows up here.'
            : 'No template matches.'}
        </p>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border px-4 py-5">
          <p className="text-sm text-foreground-muted">
            No template here yet. Create one, and everyone on this workspace finds it here.
          </p>
        </div>
      )}
    </div>
  );
}
