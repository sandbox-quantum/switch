import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import {
  AGENT_PROVIDERS,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';

export function ManagedProvidersStep({
  selected,
  onSelectionChange,
  onContinue,
  onSkip,
}: {
  selected: AgentProviderId[];
  onSelectionChange: (providers: AgentProviderId[]) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Choose agents to connect</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <p className="text-sm text-foreground-muted">
          Choose the providers you want to use with Switch. You’ll add credentials next.
        </p>
        <div role="group" aria-label="Agent providers" className="space-y-2">
          {AGENT_PROVIDERS.map((provider) => {
            const available = true;
            return (
              <label
                key={provider.id}
                className={`flex items-center gap-3 rounded-lg border border-border p-3 ${available ? 'cursor-pointer hover:bg-background-tertiary-2' : 'cursor-not-allowed opacity-60'}`}
              >
                <Checkbox
                  checked={selected.includes(provider.id)}
                  disabled={!available}
                  onCheckedChange={(checked) => {
                    if (!available) return;
                    onSelectionChange(
                      checked
                        ? [...selected, provider.id]
                        : selected.filter((id) => id !== provider.id)
                    );
                  }}
                />
                <AgentIcon id={provider.id} size={24} />
                <span className="flex-1 text-sm font-medium">{provider.name}</span>
                <span className="text-xs text-foreground-muted">
                  {available ? 'Available' : 'Coming soon'}
                </span>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-foreground-muted">
          Credentials are checked on the worker before it becomes ready. Selecting a provider does
          not start an agent.
        </p>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onSkip}>
          Set up later
        </Button>
        <Button disabled={selected.length === 0} onClick={onContinue}>
          Continue
        </Button>
      </DialogFooter>
    </>
  );
}
