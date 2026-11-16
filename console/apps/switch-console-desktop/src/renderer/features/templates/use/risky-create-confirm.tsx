import { type ReactNode, useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import type { AgentReach } from './agent-permissions';
import { reachIsOpen, reachText, type SlotRuntime } from './creates-rail';

/** A new agent the run would let run commands unasked, or let anyone talk to. */
export type CreateRisk = {
  name: string;
  /** Where it runs, as the preview names it. */
  where: string | null;
  bypass: boolean | null;
  reach: AgentReach;
};

/** The agents about to be created that run unasked or answer anyone, with what makes each risky. */
export function createRisks(agents: { name: string; runtime: SlotRuntime }[]): CreateRisk[] {
  return agents
    .filter(({ runtime }) => runtime.bypass !== false || reachIsOpen(runtime.reach))
    .map(({ name, runtime }) => ({
      name,
      where: runtime.location,
      bypass: runtime.bypass,
      reach: runtime.reach,
    }));
}

function riskLines(risk: CreateRisk): string[] {
  const where = risk.where?.replace(/^This computer\b/, 'this computer') ?? 'its machine';
  const lines: string[] = [];
  if (risk.bypass === true) lines.push(`It runs every command without asking you, on ${where}.`);
  if (risk.bypass === null)
    lines.push(
      `Whether it asks before running commands is set in a form Switch Console cannot read, so it may run every command without asking, on ${where}.`
    );
  if (risk.reach.kind === 'anyone')
    lines.push(
      risk.bypass === false
        ? 'Anyone in the workspace can talk to it.'
        : `Anyone in the workspace can talk to it, and so have it run commands on ${where}.`
    );
  else if (risk.reach.kind === 'unknown')
    lines.push('Who can talk to it is set in a form Switch Console cannot read.');
  else if (risk.bypass !== false) lines.push(`Who can talk to it: ${reachText(risk.reach)}.`);
  return lines;
}

/**
 * Ask before a template run creates an agent that runs commands without
 * asking or that anyone can talk to: anyone in a workspace can write a
 * template, and one click on a link to it opens this page. A run with neither
 * goes ahead without asking.
 */
export function useRiskyCreateConfirm(): {
  request: (risks: CreateRisk[], author: string, create: () => void) => void;
  dialog: ReactNode;
} {
  // Kept while the dialog animates closed, so its wording does not empty on the way out.
  const [pending, setPending] = useState<{
    risks: CreateRisk[];
    author: string;
    create: () => void;
  } | null>(null);
  const [open, setOpen] = useState(false);

  const request = (risks: CreateRisk[], author: string, create: () => void) => {
    if (risks.length === 0) {
      create();
      return;
    }
    setPending({ risks, author, create });
    setOpen(true);
  };

  const risks = pending?.risks ?? [];
  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {risks.length === 1
              ? `Create ${risks[0]!.name} with these permissions?`
              : `Create ${risks.length} agents with these permissions?`}
          </DialogTitle>
        </DialogHeader>
        <DialogContentArea>
          <div className="flex flex-col gap-3">
            {risks.map((risk) => (
              <div key={risk.name} className="flex flex-col gap-1">
                <span className="font-mono text-[13px] font-medium">{risk.name}</span>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-foreground-muted">
                  {riskLines(risk).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
            <DialogDescription>
              {pending?.author ?? 'The template'} set this up, not Switch Console. Create it only if
              you trust what its instructions tell the agent to do.
            </DialogDescription>
          </div>
        </DialogContentArea>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setOpen(false);
              pending?.create();
            }}
          >
            Create anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { request, dialog };
}
