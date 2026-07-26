import { Checkbox } from '@renderer/lib/ui/checkbox';

/** A discovered definition the modal can onboard. Structurally a subset of the
 * main-process `DiscoveredLocationAgent`, kept local so the renderer does not
 * import across the process boundary. */
export type OnboardableAgent = {
  name: string;
  description: string | null;
  /** Already a Switch agent on disk (import its identity) vs a plain provider
   * definition to adopt (mint a fresh identity). */
  registered: boolean;
};

/**
 * Multi-select list of provider definitions found in a directory that aren't yet
 * switchdash agents on this client — including ones already registered on the
 * gateway by another client (imported, not re-minted). The user picks which to
 * onboard, or switches to creating a brand-new agent (CHOO-1440).
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
        {agents.length} agent{agents.length === 1 ? '' : 's'} defined in this directory{' '}
        {agents.length === 1 ? "isn't" : "aren't"} in switchdash yet — pick which to onboard, or
        create a new one below.
      </span>
      <div className="flex flex-col gap-0.5">
        {agents.map((a) => (
          <label
            key={a.name}
            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-background-2"
          >
            <Checkbox
              checked={selected.has(a.name)}
              onCheckedChange={(checked) => onToggle(a.name, checked === true)}
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-col">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-foreground">{a.name}</span>
                <span className="rounded bg-background-2 px-1 py-0.5 text-[10px] text-foreground-muted">
                  {a.registered ? 'Switch agent · import' : 'adopt as new'}
                </span>
              </div>
              {a.description && (
                <span className="truncate text-xs text-foreground-muted">{a.description}</span>
              )}
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
