import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdvancedConfigProblem } from '@renderer/features/locations/components/add-agent-modal/agent-advanced-config';
import {
  attributesFromForm,
  emptyForm,
  formFromAttributes,
  type FormState,
  type FormValue,
} from '@renderer/features/locations/components/agent-definition-fields';
import { type ModelCatalogueResult } from '@renderer/features/locations/components/agent-model-catalogue';
import { choicesNotOffered } from '@renderer/features/locations/components/local-advanced-fields';
import { useAgentEdit } from '@renderer/features/locations/components/main-panel/agent-edits';
import { useLocalAdvancedFields } from '@renderer/features/locations/components/use-local-advanced-fields';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { isProvisioned } from '@renderer/features/sessions/stores/session-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { log } from '@renderer/utils/logger';
import { AdvancedConfigDisclosure, summariseValues } from './advanced-config-disclosure';

/**
 * Per-agent "Advanced configuration" in the Settings tab: the model, reasoning
 * effort, tools and system prompt for an existing agent.
 *
 * Providers keep these in different places — Claude Code in the repo-agent
 * definition it launches by name, Codex in the profile it loads at startup —
 * but they are the same settings collected as the same fields, so this is one
 * section for both. The main process routes the read and the write to whichever
 * surface the provider actually uses (`agent-advanced-config.ts`); the agent
 * name is immutable either way, so only advanced attributes are editable here
 * (CHOO-1440, CHOO-1985).
 */
export const AgentAdvancedSettingsSection = observer(function AgentAdvancedSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  agentId: string | undefined;
}) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });
  const agent = (agents ?? []).find((a) => a.id === agentId);
  const providerId = agent?.providerId ?? null;
  const editable = !!agent;

  // The fields are the agent's Switch server's; where the provider keeps the
  // values decides whether a running session can be brought onto them.
  const { fields, surface, problem } = useLocalAdvancedFields(agent?.serverId ?? null, providerId);

  const { data: locations } = useQuery({
    queryKey: ['locations'],
    queryFn: () => rpc.locations.getLocations(),
  });
  const location = (locations ?? []).find((l) => l.id === locationId);

  // What the agent's own host offers, for the fields bound to it. Fetched per
  // host rather than per keystroke: it shells out to the provider CLI, over SSH
  // for a remote agent.
  const { data: catalogue } = useQuery({
    queryKey: ['agent-model-catalogue', providerId, location?.sshHost ?? 'local', location?.dir],
    queryFn: (): Promise<ModelCatalogueResult> =>
      providerId && location
        ? rpc.agents.modelCatalogue({ providerId, sshHost: location.sshHost, dir: location.dir })
        : Promise.resolve({ kind: 'unavailable', reason: 'No host to ask.' }),
    enabled: !!providerId && !!location && editable,
    staleTime: 60_000,
  });

  const { data: current } = useQuery({
    queryKey: ['agent-advanced-config', agentId],
    queryFn: () => (agentId ? rpc.agents.readAdvancedConfig({ agentId }) : Promise.resolve(null)),
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

  const staleSessionIds = sessionsStartedBeforeChanges(locationId, agentId);

  // A stored setting the form does not show — the server's fields could not be
  // read, or this Console cannot apply one — is kept rather than dropped unseen.
  const save = useMutation({
    mutationFn: () =>
      rpc.agents.updateAdvancedConfig({
        agentId: agentId as string,
        attributes: { ...current, ...attributesFromForm(fields, form) },
      }),
    onSuccess: () => {
      toast({ title: 'Advanced configuration saved' });
      void queryClient.invalidateQueries({ queryKey: ['agent-advanced-config', agentId] });
      void queryClient.invalidateQueries({ queryKey: ['location-agents', locationId] });
    },
    onError: (error) => {
      log.error('Failed to save agent advanced configuration', { agentId, error });
      const { headline, detail } = describeFailure(error, 'Could not save the configuration.');
      toast({
        title: headline,
        description: detail ?? undefined,
        variant: 'destructive',
      });
      // A save can fail after the row was written — pushing the change to a
      // remote host is a separate step that can fail on its own. Re-read rather
      // than leave the form showing values that are no longer what is stored.
      void queryClient.invalidateQueries({ queryKey: ['agent-advanced-config', agentId] });
      void queryClient.invalidateQueries({ queryKey: ['location-agents', locationId] });
    },
  });

  // The Settings page swaps agents in place rather than remounting, so a save on
  // the previous agent must not leave its restart notice over the next one.
  const resetSave = save.reset;
  useEffect(() => {
    resetSave();
  }, [agentId, resetSave]);

  const saveMutation = save.mutateAsync;
  const onSave = useCallback(async () => {
    await saveMutation();
  }, [saveMutation]);
  const onRevert = useCallback(() => {
    setForm(savedForm);
  }, [savedForm]);

  const [restartFailed, setRestartFailed] = useState<string[]>([]);
  const restart = useMutation({
    mutationFn: async () => {
      // Restart the ones that have not already been restarted: a retry after a
      // partial failure must not kill and respawn the sessions that succeeded.
      const targets = restartFailed.length > 0 ? restartFailed : staleSessionIds;
      const results = await Promise.allSettled(
        targets.map((sessionId) => rpc.sessions.restartAgent(sessionId))
      );
      const failed = targets.filter((_, i) => results[i]?.status === 'rejected');
      setRestartFailed(failed);
      if (failed.length > 0) {
        const reasons = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => String(r.reason));
        throw new Error(`${failed.length} of ${targets.length} failed — ${reasons.join('; ')}`);
      }
    },
    onSuccess: () => {
      toast({ title: 'Session restarted on the new configuration' });
      // Everything running now carries the saved values.
      save.reset();
    },
    onError: (error) => {
      log.error('Failed to restart a session after an advanced configuration change', {
        agentId,
        error,
      });
      const { headline, detail } = describeFailure(error, 'Could not restart the session.');
      toast({
        title: headline,
        description: detail ?? undefined,
        variant: 'destructive',
      });
    },
  });

  const dirty =
    editable &&
    fields.length > 0 &&
    JSON.stringify(attributesFromForm(fields, form)) !==
      JSON.stringify(attributesFromForm(fields, savedForm));

  const setField = (key: string, value: FormValue) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Saved from the page's bar rather than a button here: an edit to these and an
  // edit to the instructions above are one set of pending changes to the reader.
  useAgentEdit({
    id: 'agent-advanced-config',
    order: 1,
    dirty,
    save: onSave,
    revert: onRevert,
  });

  if (!editable) return null;

  const shownProblem = problem ?? (current ? choicesNotOffered(fields, current) : null);
  if (fields.length === 0) return <AdvancedConfigProblem problem={shownProblem} />;

  // A launch profile is read once, when the session starts, so a change cannot
  // reach a running session without one — and a resume carries the new profile,
  // which is what makes the restart safe to offer. A repo-agent definition
  // (Claude) reads at launch too and very likely wants the same treatment, but
  // that is a change to Claude's behaviour and is being raised on its own.
  const restartable = surface === 'launch-profile';
  const showStaleNotice = restartable && staleSessionIds.length > 0 && (dirty || save.isSuccess);

  return (
    <div className="flex flex-col gap-2">
      <AdvancedConfigDisclosure
        fields={fields}
        form={form}
        summary={summariseValues(fields, savedForm)}
        catalogue={catalogue}
        intro="The agent's model, reasoning effort and tools. Its instructions are above, and its name is fixed."
        onFieldChange={setField}
      >
        {showStaleNotice && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p className="text-xs text-foreground-muted">
              {staleSessionIds.length === 1
                ? 'A session is running'
                : `${staleSessionIds.length} sessions are running`}{' '}
              on the previous configuration — it is read only when a session starts.{' '}
              {dirty
                ? 'Save, then Restart to apply it now.'
                : 'It applies to the next session — or use Restart to apply it now (the conversation is resumed).'}
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
              {restartFailed.length > 0 ? 'Retry restart' : 'Restart'}
            </Button>
          </div>
        )}
      </AdvancedConfigDisclosure>
      <AdvancedConfigProblem problem={shownProblem} />
    </div>
  );
});

/**
 * The agent's sessions that already started a conversation, and so are running
 * on whatever configuration was in place at the time.
 *
 * `providerSessionId` is the test rather than "is provisioned": a remote session
 * is provisioned at creation so it can carry room traffic, but its agent process
 * is only launched when the session is first opened. Counting those would claim
 * a running session that does not exist — and restarting one cannot resume a
 * conversation that never started. Read from the session store rather than
 * queried, so it tracks sessions coming and going; call only from an `observer`.
 */
function sessionsStartedBeforeChanges(locationId: string, agentId: string | undefined): string[] {
  const manager = getSessionManagerStore(locationId);
  if (!manager || !agentId) return [];
  return [...manager.sessions.values()]
    .filter(
      (session) =>
        isProvisioned(session) &&
        session.data.agentId === agentId &&
        !!session.data.providerSessionId
    )
    .map((session) => session.data.id);
}
