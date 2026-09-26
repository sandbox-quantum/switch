import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  loadAgentTemplateByOrigin,
  templateOriginExists,
} from '@renderer/features/templates/agent-template-data';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
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

  const { data: saved, error: readError } = useQuery({
    queryKey: ['agent-instructions', agentId],
    queryFn: () =>
      agentId ? rpc.agents.readInstructions({ agentId }) : Promise.resolve<string>(''),
    enabled: !!agentId,
  });

  // The template this agent was created from, if any. A template's
  // instructions change over time (the Switch expert's are maintained in the
  // repository) while the agent keeps the copy it was created with, so the
  // page offers to load the current version into the editor. Nothing is
  // saved until the user saves the edit.
  const { data: origin } = useQuery({
    queryKey: ['agent-template-origin', agentId],
    queryFn: () => (agentId ? rpc.agents.readTemplateOrigin({ agentId }) : Promise.resolve(null)),
    enabled: !!agentId,
  });
  const [refreshing, setRefreshing] = useState(false);
  const refreshFromTemplate = async () => {
    if (!origin) return;
    setRefreshing(true);
    try {
      const template = await loadAgentTemplateByOrigin(origin);
      if (template.instructions === value) {
        toast({ title: `Already up to date with "${origin.name}"` });
        return;
      }
      setValue(template.instructions);
      setExpanded(true);
      toast({
        title: `Instructions replaced with the current "${origin.name}"`,
        description: 'Nothing is saved yet. Read them over, then save or revert.',
      });
    } catch (error) {
      const { headline, detail } = describeFailure(
        error,
        `Could not load the template "${origin.name}".`
      );
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setRefreshing(false);
    }
  };

  const savedValue = saved ?? '';
  const [value, setValue] = useState('');
  const [expanded, setExpanded] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const [clipped, setClipped] = useState(false);

  // Whether the box is actually holding more than it can show. Measured rather
  // than guessed from the text's length: how much fits depends on how the lines
  // wrap, so it changes with the width of the page as well as with the text.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [value, expanded]);

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
      // The instructions are written into the same file as the advanced settings.
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

  // No editor over settings that could not be read: whatever was typed would be
  // saved over a file nobody has seen, or fail to save at all.
  if (readError) {
    const { headline, detail } = describeFailure(
      readError,
      'Could not read this agent’s settings.'
    );
    return (
      <Field>
        <FieldLabel>Agent instructions</FieldLabel>
        <p role="alert" className="text-sm text-foreground-destructive">
          {headline}
          {detail ? <span className="block text-foreground-muted">{detail}</span> : null}
        </p>
      </Field>
    );
  }

  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={fieldId}>
          Agent instructions <span className="text-foreground-muted">(optional)</span>
        </FieldLabel>
        <span className="flex items-center gap-3">
          {origin && templateOriginExists(origin) && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={refreshing}
              onClick={() => void refreshFromTemplate()}
              title={`This agent was created from the "${origin.name}" template`}
            >
              {refreshing ? 'Loading…' : `Update from "${origin.name}"`}
            </Button>
          )}
          {/* Offered only once there is something being withheld, so a two-line
            instruction does not carry a control that would do nothing. */}
          {(clipped || expanded) && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={fieldId}
              onClick={() => setExpanded((open) => !open)}
              className="cursor-pointer text-sm text-foreground-muted hover:text-foreground"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </span>
      </div>
      <Textarea
        ref={boxRef}
        id={fieldId}
        rows={4}
        placeholder="How this agent should work"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className={expanded ? 'max-h-none' : undefined}
      />
    </Field>
  );
}
