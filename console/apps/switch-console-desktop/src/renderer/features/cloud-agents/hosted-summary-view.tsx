import { Bot } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { Progress } from '@renderer/lib/ui/progress';
import { cn } from '@renderer/utils/utils';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import {
  CAPACITY_WORDS,
  type CapacityLine,
  DISK_NOT_AVAILABLE,
  hostedSummary,
} from './hosted-summary';
import { useCloudMachines } from './use-cloud-agents';
import { yourCloudView } from './your-cloud';

const localTime = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** One capacity line with its bar, and "Nearly full" or "Full right now" beside it when it applies. */
function CapacityRow({ line, name }: { line: CapacityLine; name: string }) {
  const warn = line.step !== 'ok';
  return (
    <div data-capacity={name} data-step={line.step}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-foreground">{line.label}</span>
        {warn && (
          <span
            className={cn(
              'font-medium',
              line.step === 'full' ? 'text-destructive' : 'text-foreground-warning'
            )}
          >
            {CAPACITY_WORDS[line.step as Exclude<CapacityLine['step'], 'ok'>]}
          </span>
        )}
      </div>
      <Progress value={line.usedPercent} aria-label={line.label} className="mt-1" />
    </div>
  );
}

/**
 * Your cloud's numbers as rows: awake out of the box's limit, memory, and the
 * workspace disk (or "Disk: not available" until the box measures it). The
 * same rows on the workspace page and in Your Agents' cloud card.
 */
export function HostedCapacityRows({
  machine,
}: {
  machine: Pick<CloudMachine, 'agents' | 'awake' | 'room' | 'disk'>;
}) {
  const summary = hostedSummary(machine);
  return (
    <div className="space-y-2">
      {summary.awake && <CapacityRow line={summary.awake} name="awake" />}
      {summary.memory && <CapacityRow line={summary.memory} name="memory" />}
      {summary.disk ? (
        <CapacityRow line={summary.disk} name="disk" />
      ) : (
        <p className="text-xs text-foreground-muted" data-capacity="disk">
          {DISK_NOT_AVAILABLE}
        </p>
      )}
    </div>
  );
}

/**
 * The workspace page's Your cloud summary (hosted agents v2 only): how many
 * hosted agents, the box's state, and its capacity, with a way to Your Agents.
 * Shows nothing without `hosted_v2`, or when the person has no box.
 */
export const YourCloudSummary = observer(function YourCloudSummary({
  serverId,
}: {
  serverId: string;
}) {
  const v2 = useFeatureFlags(serverId).hosted_v2;
  const machines = useCloudMachines(v2 ? serverId : null);
  const { navigate } = useNavigate();
  const box = machines.data?.find(
    (machine) => machine.backend === 'box' && machine.state !== 'deleted'
  );
  if (!v2 || !box) return null;
  const view = yourCloudView(box, localTime);
  const summary = hostedSummary(box);
  return (
    <section
      aria-label="Your cloud"
      className="bg-card rounded-lg border border-border px-4 py-3"
      data-your-cloud-summary=""
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Your cloud</h3>
          <p className="text-xs text-foreground-muted">
            <span className="font-medium text-foreground">{view.heading}</span> · {summary.agents}
          </p>
          {view.resting && <p className="mt-1 text-xs text-foreground-muted">{view.line}</p>}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => navigate('serverAgents', { serverId })}
        >
          <Bot className="size-4" />
          Your Agents
        </Button>
      </div>
      {!view.resting && (
        <div className="mt-3 max-w-[420px]">
          <HostedCapacityRows machine={box} />
        </div>
      )}
    </section>
  );
});
