import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useState } from 'react';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Textarea } from '@renderer/lib/ui/textarea';
import { log } from '@renderer/utils/logger';
import { useAgentEdit } from './agent-edits';

/**
 * The agent's instructions — what it is for, in its own words (CHOO-2228).
 *
 * A main attribute of the agent rather than one of its provider's settings, so
 * it sits with the name and description at the top of the page instead of
 * inside advanced configuration. One box for every provider: whichever the
 * agent runs on renders it into whatever that provider actually reads.
 *
 * Saving goes through the page's shared bar rather than a button of its own,
 * so an edit here and an edit to advanced configuration are one save.
 */
export function AgentInstructionsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  agentId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const fieldId = useId();

  const { data: saved } = useQuery({
    queryKey: ['agent-instructions', agentId],
    queryFn: () =>
      agentId ? rpc.agents.readInstructions({ agentId }) : Promise.resolve<string>(''),
    enabled: !!agentId,
  });

  const savedValue = saved ?? '';
  const [value, setValue] = useState('');

  // Re-seed when the stored value changes — after a save, and when the page
  // swaps to a different agent without remounting. No refetch fires while
  // editing, so this does not overwrite what is being typed.
  useEffect(() => {
    setValue(savedValue);
  }, [savedValue]);

  const save = useMutation({
    mutationFn: (instructions: string) =>
      rpc.agents.updateInstructions({ agentId: agentId as string, instructions }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-instructions', agentId] });
      // The instructions are written into the same file as the advanced
      // settings, and saving them regenerates the provider's own file.
      void queryClient.invalidateQueries({ queryKey: ['agent-advanced-config', agentId] });
      void queryClient.invalidateQueries({ queryKey: ['location-agents', locationId] });
    },
    onError: (error) => {
      log.error('Failed to save agent instructions', { agentId, error });
      const { headline, detail } = describeFailure(error, 'Could not save the instructions.');
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
      void queryClient.invalidateQueries({ queryKey: ['agent-instructions', agentId] });
    },
  });

  const saveMutation = save.mutateAsync;
  const onSave = useCallback(async () => {
    await saveMutation(value);
  }, [saveMutation, value]);

  const onRevert = useCallback(() => setValue(savedValue), [savedValue]);

  useAgentEdit({
    id: 'agent-instructions',
    // Before the advanced settings: both rewrite the same config file, and this
    // is the one the page leads with.
    order: 0,
    dirty: !!agentId && value !== savedValue,
    save: onSave,
    revert: onRevert,
  });

  if (!agentId) return null;

  return (
    <Field>
      <FieldLabel htmlFor={fieldId}>
        Agent instructions <span className="text-foreground-muted">(optional)</span>
      </FieldLabel>
      <Textarea
        id={fieldId}
        rows={4}
        placeholder="How this agent should work"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </Field>
  );
}
