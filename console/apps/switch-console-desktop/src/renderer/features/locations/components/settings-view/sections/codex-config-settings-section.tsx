import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import {
  DefinitionFieldInput,
  type FormState,
  type FormValue,
} from '@renderer/features/locations/components/agent-definition-fields';
import {
  CODEX_CONFIG_FIELDS,
  codexConfigFromForm,
  codexFormFromConfig,
} from '@renderer/features/locations/components/codex-config-fields';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { isProvisioned } from '@renderer/features/sessions/stores/session-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldDescription, FieldLabel, FieldTitle } from '@renderer/lib/ui/field';
import { log } from '@renderer/utils/logger';

/**
 * Per-agent "Codex configuration" editor in the Settings tab: the model,
 * reasoning effort and instructions folded into the agent's Codex profile at
 * launch.
 *
 * It sits alongside the definition-settings section rather than inside it
 * because the two edit different things. A Claude agent's equivalent settings
 * are its on-disk definition, which that section rewrites; Codex has no
 * definition surface at all, and keeps these on the agent row — so this is the
 * only editor for them, and it renders for Codex agents only.
 *
 * A running session is not affected by a save: the profile is read by the CLI
 * once, at spawn. Rather than let the field look applied when it is not, a live
 * session is named here with a Restart that stops and resumes the agent to pick
 * the new profile up.
 */
export const CodexConfigSettingsSection = observer(function CodexConfigSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  agentId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const agentsQueryKey = ['location-agents', locationId];

  const { data: agents } = useQuery({
    queryKey: agentsQueryKey,
    queryFn: () => rpc.agents.getAgents(locationId),
  });
  const agent = (agents ?? []).find((a) => a.id === agentId);

  const savedForm = useMemo(
    () => codexFormFromConfig(agent?.providerConfig ?? null),
    [agent?.providerConfig]
  );

  const [form, setForm] = useState<FormState>(savedForm);
  // Re-seed from the persisted values on save and on agent change. Nothing
  // refetches mid-edit, so local edits survive until Save.
  useEffect(() => {
    setForm(savedForm);
  }, [savedForm]);

  const liveSessionIds = useLiveSessionIds(locationId, agentId);

  const save = useMutation({
    mutationFn: () =>
      rpc.agents.setAgentProviderConfig({
        agentId: agentId as string,
        config: codexConfigFromForm(form),
      }),
    onSuccess: () => {
      toast({ title: 'Codex configuration saved' });
      void queryClient.invalidateQueries({ queryKey: agentsQueryKey });
    },
    onError: (error) => {
      log.error('Failed to save Codex configuration', { agentId, error });
      toast({
        title: 'Failed to save Codex configuration',
        description: String(error),
        variant: 'destructive',
      });
    },
  });

  const restart = useMutation({
    mutationFn: async () => {
      for (const sessionId of liveSessionIds) {
        await rpc.sessions.restartAgent(sessionId);
      }
    },
    onSuccess: () => toast({ title: 'Session restarted with the new configuration' }),
    onError: (error) => {
      log.error('Failed to restart session after a Codex configuration change', { agentId, error });
      toast({
        title: 'Failed to restart the session',
        description: String(error),
        variant: 'destructive',
      });
    },
  });

  if (!agent || agent.providerId !== 'codex') return null;

  const dirty = CODEX_CONFIG_FIELDS.some(
    (field) => String(form[field.key] ?? '') !== String(savedForm[field.key] ?? '')
  );
  const setField = (key: string, value: FormValue) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <Field>
      <FieldTitle>Codex configuration</FieldTitle>
      <FieldDescription className="text-foreground-muted">
        The model, reasoning effort and system prompt this agent&apos;s Codex sessions start with.
        Blank fields leave your own Codex defaults in place.
      </FieldDescription>
      <div className="flex flex-col gap-4 rounded-md border border-border px-3 py-3">
        {CODEX_CONFIG_FIELDS.map((field) => (
          <Field key={field.key}>
            <FieldLabel htmlFor={`codex-config-${field.key}`}>{field.label} (optional)</FieldLabel>
            <DefinitionFieldInput
              field={field}
              value={form[field.key] ?? ''}
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
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>

        {liveSessionIds.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p className="text-xs text-foreground-muted">
              {liveSessionIds.length} running session
              {liveSessionIds.length === 1 ? '' : 's'} {liveSessionIds.length === 1 ? 'is' : 'are'}{' '}
              still on the previous configuration — Codex reads it only when a session starts. It
              applies to the next session — or use Restart to apply it now (the conversation is
              resumed).
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={dirty || restart.isPending}
              onClick={() => restart.mutate()}
            >
              {restart.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Restart
            </Button>
          </div>
        )}
      </div>
    </Field>
  );
});

/**
 * The agent's sessions that currently have a running agent process — the ones a
 * configuration change cannot reach without a restart. Read from the session
 * store rather than queried, so it tracks sessions starting and stopping live.
 */
function useLiveSessionIds(locationId: string, agentId: string | undefined): string[] {
  const manager = getSessionManagerStore(locationId);
  if (!manager || !agentId) return [];
  return [...manager.sessions.values()]
    .filter((session) => isProvisioned(session) && session.data.agentId === agentId)
    .map((session) => session.data.id);
}
