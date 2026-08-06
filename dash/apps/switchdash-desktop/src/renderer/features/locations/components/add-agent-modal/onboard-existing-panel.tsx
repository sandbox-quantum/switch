import { Checkbox } from '@renderer/lib/ui/checkbox';

/**
 * How an agent found in the directory will be brought into this switchdash.
 *
 * - `import` — a provider definition that already carries Switch credentials;
 *   its identity is reused.
 * - `adopt` — a plain provider definition with no Switch setup; switchdash mints
 *   an identity for it.
 * - `attach` — credentials found in the directory with no definition of ours to
 *   go with them, which is what an agent set up by another switchdash (or for a
 *   provider with no definition concept, such as Codex) looks like. Its identity
 *   is reused and nothing in the directory is written (CHOO-1937).
 */
export type AdoptKind = 'import' | 'adopt' | 'attach';

/** A discovered agent the modal can bring in. Structurally a subset of the
 * main-process discovery types, kept local so the renderer does not import
 * across the process boundary. */
export type OnboardableAgent = {
  name: string;
  description: string | null;
  kind: AdoptKind;
  /** For `attach`: the provider that will run it. Null when nothing on disk
   * names one and the modal has no provider picked to fall back on, in which
   * case the row cannot be selected. */
  providerLabel: string | null;
};

const BADGE: Record<AdoptKind, string> = {
  import: 'Switch agent · import',
  adopt: 'adopt as new',
  attach: 'configured here · attach',
};

/**
 * Multi-select list of agents found in a directory that aren't yet switchdash
 * agents on this client — provider definitions (CHOO-1440) and agents another
 * install already configured here (CHOO-1937), in one list because the user is
 * answering one question: which of these should this switchdash manage.
 */
export function OnboardExistingPanel({
  agents,
  selected,
  onToggle,
}: {
  agents: OnboardableAgent[];
  selected: Set<string>;
  onToggle: (name: string, checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background-1 px-3 py-2.5 text-sm">
      <span className="text-foreground-muted">
        {agents.length} agent{agents.length === 1 ? '' : 's'} in this directory{' '}
        {agents.length === 1 ? "isn't" : "aren't"} in switchdash yet — pick which to bring in, or
        create a new one below.
      </span>
      <div className="flex flex-col gap-0.5">
        {agents.map((a) => {
          const blocked = a.kind === 'attach' && a.providerLabel === null;
          return (
            <label
              key={a.name}
              className={`flex items-start gap-2 rounded px-1.5 py-1 ${
                blocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-background-2'
              }`}
            >
              <Checkbox
                checked={selected.has(a.name)}
                disabled={blocked}
                onCheckedChange={(checked) => onToggle(a.name, checked === true)}
                className="mt-0.5"
              />
              <div className="flex min-w-0 flex-col">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-foreground">{a.name}</span>
                  <span className="rounded bg-background-2 px-1 py-0.5 text-[10px] text-foreground-muted">
                    {BADGE[a.kind]}
                  </span>
                  {a.kind === 'attach' && a.providerLabel !== null && (
                    <span className="rounded bg-background-2 px-1 py-0.5 text-[10px] text-foreground-muted">
                      {a.providerLabel}
                    </span>
                  )}
                </div>
                {blocked ? (
                  <span className="text-xs text-foreground-muted">
                    Pick an agent type above to attach this one — the directory does not say which
                    runs it.
                  </span>
                ) : (
                  a.description && (
                    <span className="truncate text-xs text-foreground-muted">{a.description}</span>
                  )
                )}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
