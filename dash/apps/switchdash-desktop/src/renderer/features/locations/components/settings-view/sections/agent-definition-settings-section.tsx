import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  advancedFields,
  attributesFromForm,
  DefinitionFieldInput,
  emptyForm,
  formFromAttributes,
  type FormState,
  type FormValue,
} from '@renderer/features/locations/components/agent-definition-fields';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldDescription, FieldLabel, FieldTitle } from '@renderer/lib/ui/field';
import { log } from '@renderer/utils/logger';

/**
 * Per-agent "Advanced configuration" editor in the Settings tab: the provider's
 * definition attributes (model, effort, tools, system prompt, …) for an existing
 * agent, prefilled from its on-disk definition and saved back by rewriting it
 * (`.claude/agents/<name>.md`). The name is immutable — it is the agent's
 * identity — so only advanced attributes are editable here (CHOO-1440).
 */
export function AgentDefinitionSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  agentId: string | undefined;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });
  const agent = (agents ?? []).find((a) => a.id === agentId);
  const providerId = agent?.providerId ?? null;
  const editable = !!agent && agent.definitionName != null;

  const { data: allFields } = useQuery({
    queryKey: ['agentDefinitionFields', providerId],
    queryFn: () => (providerId ? rpc.agents.definitionFields({ providerId }) : Promise.resolve([])),
    enabled: !!providerId,
  });
  const fields = useMemo(() => advancedFields(allFields ?? []), [allFields]);

  const { data: current } = useQuery({
    queryKey: ['agent-definition', agentId],
    queryFn: () => (agentId ? rpc.agents.readAgentDefinition({ agentId }) : Promise.resolve(null)),
    enabled: !!agentId && editable,
  });

  const savedForm = useMemo(
    () => (current ? formFromAttributes(fields, current) : emptyForm(fields)),
    [fields, current]
  );

  const [form, setForm] = useState<FormState>({});
  // Seed (and re-seed after save/agent change) from the persisted values. During
  // editing no refetch fires, so local edits are preserved until Save.
  useEffect(() => {
    setForm(savedForm);
  }, [savedForm]);

  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      rpc.agents.updateAgentDefinition({
        agentId: agentId as string,
        attributes: attributesFromForm(fields, form),
      }),
    onSuccess: () => {
      toast({ title: 'Advanced configuration saved' });
      void queryClient.invalidateQueries({ queryKey: ['agent-definition', agentId] });
    },
    onError: (error) => {
      log.error('Failed to save agent definition', { agentId, error });
      toast({
        title: 'Failed to save configuration',
        description: String(error),
        variant: 'destructive',
      });
    },
  });

  if (!editable || fields.length === 0) return null;

  const dirty =
    JSON.stringify(attributesFromForm(fields, form)) !==
    JSON.stringify(attributesFromForm(fields, savedForm));

  const setField = (key: string, value: FormValue) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <Field>
      <FieldTitle>Advanced configuration</FieldTitle>
      <FieldDescription className="text-foreground-muted">
        The agent&apos;s model, reasoning effort, tools, and system prompt. Saving rewrites its
        on-disk definition; the agent name is fixed.
      </FieldDescription>
      <div className="flex flex-col gap-4 rounded-md border border-border px-3 py-3">
        {fields.map((field) => (
          <Field key={field.key}>
            <FieldLabel htmlFor={`agent-definition-${field.key}`}>
              {field.label}
              {field.required || field.type === 'boolean' ? '' : ' (optional)'}
            </FieldLabel>
            <DefinitionFieldInput
              field={field}
              value={form[field.key] ?? (field.type === 'boolean' ? false : '')}
              onChange={(value) => setField(field.key, value)}
            />
            {field.help && (
              <FieldDescription className="text-foreground-muted">{field.help}</FieldDescription>
            )}
          </Field>
        ))}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!dirty || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </Field>
  );
}
