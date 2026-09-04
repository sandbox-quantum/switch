import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { useQuery } from '@tanstack/react-query';
import { Monitor, Server } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { HostReachabilityNotice } from '@renderer/features/remote-hosts/host-reachability-notice';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import {
  HostReadinessNotice,
  useRemoteHostReadiness,
} from '@renderer/features/remote-hosts/host-readiness-notice';
import { policyHasDeadRule } from '@renderer/features/switch-servers/addressing-policy-editor';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import {
  useModalContext,
  useShowModal,
  type BaseModalProps,
} from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { log } from '@renderer/utils/logger';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import { type ProvisionAgentResult } from '@shared/core/switch-servers/switch-servers';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { AgentAdvancedConfig } from './agent-advanced-config';
import { AgentTypePicker } from './agent-type-picker';
import { AgentIdentityFields, AgentSettingsSection } from './configure-agent-panel';
import { LaunchProfileConfig } from './launch-profile-config';
import { LocalDirectorySelector } from './local-directory-selector';
import { useConfigureAgentForm, usePickMode } from './modes';

// Switch Console adds a Switch *agent* by pointing at a local directory that the
// switch-connector `configure` skill has set up (its `.claude/settings.local.json`
// carries the SWITCH_* env block). The richer Switch Console flows — SSH, clone, create
// new GitHub repo — are out of scope for v0, so this modal is local + pick only.
export type AddLocationModalProps = BaseModalProps<void> & {
  /**
   * Which control opened this dialog. Required rather than defaulted: four
   * places open it, and a default would silently file whichever one forgot
   * under the same heading as the ones that did not.
   */
  entryPoint: UiEntryPoint;
};

/** Sentinel `runHost` value meaning "run on this machine" (no remote host). */
const LOCAL_RUN_LOCATION = 'local';

/** Canonical working-directory path: trimmed, with trailing slashes removed
 * (except a bare root), so `/repo` and `/repo/` behave identically through
 * detection, discovery, and location keying — the flow must not care (CHOO-1440). */
function canonicalDir(dir: string): string {
  const trimmed = dir.trim();
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped || (trimmed.startsWith('/') ? '/' : '');
}

export const AddAgentModal = observer(function AddAgentModal({
  onClose,
  entryPoint,
}: AddLocationModalProps) {
  const [submitState, setSubmitState] = useState<'idle' | 'creating'>('idle');
  const { navigate } = useNavigate();
  const { setCloseGuard } = useModalContext();
  const showAddServerModal = useShowModal('addServerModal');

  const pickState = usePickMode();
  const form = useConfigureAgentForm();

  // Run location: 'local' (default) or an onboarded remote host's SSH alias. A
  // remote agent runs its sessions on the host and needs a remote working dir.
  const [runHost, setRunHost] = useState<string>(LOCAL_RUN_LOCATION);
  // Typed directly, with no commit step: it used to need one because committing
  // fired the directory scans, and there are none left to fire.
  const [remoteRepoDir, setRemoteRepoDir] = useState('');
  const { data: remoteHosts } = useQuery({
    queryKey: ['remote-hosts'],
    queryFn: () => rpc.remoteHosts.listHosts(),
  });
  const onboardedHosts = useMemo(() => remoteHosts ?? [], [remoteHosts]);
  const isRemoteRun = runHost !== LOCAL_RUN_LOCATION;
  // The trigger has to say the host's name, not the value behind it: the value
  // for this machine is the sentinel "local", which is not what it is called.
  const runLocationLabel = isRemoteRun
    ? (onboardedHosts.find((h) => h.sshHost === runHost)?.name ?? runHost)
    : 'This computer';

  // An agent always binds to the active (scoped) server — the user does not pick
  // one here. Ensure the server list + active id are loaded when the modal opens
  // standalone, otherwise nothing seeds the pick state.
  useEffect(() => {
    void switchServersStore.init();
  }, []);

  // Seed the pick state from the active server so detection/verification and
  // provisioning target the server whose view they are adding the agent into.
  // When no server is active yet but exactly one exists (e.g. right after the
  // first server was added, before it was ever activated), preselect it so the
  // common single-server case needs no extra click.
  const activeServerId = switchServersStore.activeServerId;
  const soleServerId =
    switchServersStore.servers.length === 1 ? switchServersStore.servers[0].id : null;
  const targetServerId = activeServerId ?? soleServerId;
  const { serverId: pickedServerId, setServerId } = pickState;
  useEffect(() => {
    if (targetServerId && pickedServerId !== targetServerId) {
      setServerId(targetServerId);
    }
  }, [targetServerId, pickedServerId, setServerId]);

  // A managed server is only reachable from certain run locations, so constrain
  // the picker to them: a remote-managed server from this computer or its own
  // host (the desktop reaches it through the SSH forward; the host reaches it on
  // loopback — nothing else has a route); a local-managed server from this
  // computer only. External servers are unconstrained — the user owns their
  // reachability.
  const targetServer = switchServersStore.servers.find((s) => s.id === targetServerId) ?? null;
  const targetKind = targetServer?.managementKind ?? null;
  const targetHost = targetServer?.sshHost ?? null;
  const allowedHosts = useMemo(
    () =>
      onboardedHosts.filter((host) =>
        targetKind === 'remote' ? host.sshHost === targetHost : targetKind !== 'local'
      ),
    [onboardedHosts, targetKind, targetHost]
  );
  const runLocationConstrained = targetServer?.managed ?? false;
  // If the current choice falls outside what the target server allows (e.g. the
  // server changed), snap back to local.
  useEffect(() => {
    if (runHost !== LOCAL_RUN_LOCATION && !allowedHosts.some((h) => h.sshHost === runHost)) {
      setRunHost(LOCAL_RUN_LOCATION);
    }
  }, [allowedHosts, runHost]);

  // Everything chosen below the run location belongs to the machine it was
  // chosen on, so changing machines clears it.
  //
  // The working directory is the obvious case — a path from one host means
  // nothing on another. The agent type is the one that bit: availability is
  // per-machine, so picking Codex locally and then switching to a host without
  // Codex left Codex selected, and the form went on looking valid for a choice
  // the new machine cannot honour. Clearing it sends the picker back through
  // its own availability check for the host now selected.
  //
  // The name and description are not among them: they describe the agent, not
  // the machine, and clearing them threw away typed text on the way to a
  // second thought about where to run it.
  const { setProviderId } = pickState;
  useEffect(() => {
    setRemoteRepoDir('');
    setProviderId(null);
  }, [runHost, setProviderId]);

  const { suggestAutoApprove } = form;
  useEffect(() => {
    suggestAutoApprove(isRemoteRun);
  }, [isRemoteRun, suggestAutoApprove]);

  // Advanced definition attributes (model, effort, tools, system prompt, …) the
  // user set in the collapsed Advanced section. Held in a ref (not state) so the
  // section can report changes without re-rendering the modal.
  const advancedAttributesRef = useRef<RepoAgentAttributes>({});
  const onAdvancedChange = useCallback((attributes: RepoAgentAttributes) => {
    advancedAttributesRef.current = attributes;
  }, []);

  // Per-agent launch-profile config (model, and whatever else the provider
  // exposes), held in a ref for the same reason. Null when the user left the
  // section untouched, or when the provider has no launch profile at all.
  const launchProfileConfigRef = useRef<AgentProviderConfig | null>(null);
  const onLaunchProfileConfigChange = useCallback((config: AgentProviderConfig | null) => {
    launchProfileConfigRef.current = config;
  }, []);

  const trimmedRemoteDir = canonicalDir(remoteRepoDir);
  const dir = isRemoteRun ? trimmedRemoteDir : pickState.path;

  // Never create an agent on a host we know we cannot reach — it would be born
  // into the failing state this ticket exists to surface (CHOO-1676).
  const runHostReachable = !isRemoteRun || !hostReachabilityStore.isBlocked(runHost);

  // A reachable host that is missing git (or node, or the connector) will
  // produce an agent that cannot start. Refuse, rather than letting the failure
  // surface later as a mystery (CHOO-1809). An unchecked host is probed first
  // and only then judged — `checking` withholds the verdict, it is not one.
  const hostReadiness = useRemoteHostReadiness(
    isRemoteRun ? runHost : null,
    pickState.providerId ?? null
  );
  const runHostReady = !isRemoteRun || (!hostReadiness.blocked && !hostReadiness.checking);

  // Where the block stops the flow. A host missing its own prerequisites cannot
  // run anything, so nothing below the location picker is worth filling in.
  const hostLevelBlocked = isRemoteRun && hostReadiness.blocked && hostReadiness.scope === 'host';
  const canChooseAgentType = runHostReachable && !hostLevelBlocked;
  const canConfigureAgent = canChooseAgentType && runHostReady;

  const canSubmit =
    form.isValid &&
    !policyHasDeadRule(form.addressingPolicy) &&
    !!pickState.serverId &&
    !!pickState.providerId &&
    dir.trim().length > 0 &&
    runHostReachable &&
    runHostReady &&
    submitState === 'idle';

  // Why "Add agent" is greyed out, in one line, shown on hover over the button.
  const disabledReason: string | null =
    submitState !== 'idle'
      ? null
      : !pickState.serverId
        ? 'Add a Switch server to register this agent on.'
        : form.agentName.trim().length === 0
          ? 'Enter a name for the agent.'
          : !form.nameIsValid
            ? 'Fix the agent name: lowercase letters, digits, . - _, starting with a letter or digit.'
            : form.description.trim().length === 0
              ? 'Add a description so people and agents know what this agent is for.'
              : !runHostReachable
                ? `${runLocationLabel} can’t be reached right now — pick a run location that can.`
                : hostReadiness.checking
                  ? `Checking what ${runLocationLabel} has installed…`
                  : hostReadiness.blocked
                    ? `${runLocationLabel} is missing setup this agent needs — the notice below has the details.`
                    : !pickState.providerId
                      ? 'Choose an agent type.'
                      : dir.trim().length === 0
                        ? isRemoteRun
                          ? 'Enter the agent’s working directory on the host.'
                          : 'Choose the agent’s working directory.'
                        : policyHasDeadRule(form.addressingPolicy)
                          ? 'One addressing rule can never match — fix it under Settings.'
                          : null;

  /** `agentName` is what picks the agent out of the location — a location can
   * hold several, so navigating on `locationId` alone opens the directory
   * rather than the agent that was just created. */
  const finishWith = (agent: { locationId: string; name: string }) => {
    setCloseGuard(false);
    setSubmitState('idle');
    onClose();
    navigate('location', { locationId: agent.locationId, agentName: agent.name });
  };

  const reportProvisionError = (result: ProvisionAgentResult) => {
    if (result.kind === 'unauthenticated' && pickState.serverId) {
      toast({
        title: 'Sign in to register the agent',
        description: 'You are not signed in to the selected server yet.',
        variant: 'destructive',
      });
      navigate('server', { serverId: pickState.serverId });
      return;
    }
    if (result.kind === 'name-conflict') {
      toast({
        title: 'Agent name already taken',
        description:
          'An agent with this name already exists in this directory or on the server. Pick another name.',
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'credentials-conflict') {
      toast({
        title: 'That name belongs to another Switch server here',
        description: `This directory already holds credentials for an agent of that name on ${result.endpoint}. Overwriting them would destroy that agent's API token, so nothing was created — pick another name, or a different directory.`,
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'directory-missing') {
      toast({
        title: 'That working directory cannot be used. Nothing was created.',
        description:
          result.inspection.status === 'file'
            ? `${result.inspection.dir} is a file on ${result.sshHost}.`
            : `Neither ${result.inspection.dir} nor its parent exists on ${result.sshHost} — create the parent directory first.`,
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'invalid-name') {
      toast({
        title: 'That agent name cannot be used',
        description: result.message,
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'error') {
      toast({
        title: 'The agent could not be registered on the server. Nothing was created.',
        description: result.message,
        variant: 'destructive',
      });
    }
  };

  /** Create a brand-new flat agent in the chosen directory (local or remote):
   * mint its identity, write its `.claude/agents/<name>.md` definition + its
   * per-agent credentials, and create the row — all via `addAgent`. */
  const createNewAgent = async () => {
    if (!pickState.serverId || !pickState.providerId) return;
    setSubmitState('creating');
    setCloseGuard(true);
    try {
      const result = await getLocationManagerStore().addAgentAndOpen({
        sshHost: isRemoteRun ? runHost : null,
        dir: isRemoteRun ? trimmedRemoteDir : pickState.path,
        name: form.agentName,
        providerId: pickState.providerId,
        serverId: pickState.serverId,
        description: form.description.trim(),
        instructions: form.instructions,
        iconUrl: form.iconUrl,
        autoSession: form.autoSession,
        autoApprove: form.autoApprove,
        definitionAttributes: advancedAttributesRef.current,
        providerConfig: launchProfileConfigRef.current,
        entryPoint,
      });
      if (result.kind !== 'created') {
        reportProvisionError(result);
        setCloseGuard(false);
        setSubmitState('idle');
        return;
      }
      if (form.addressingPolicy !== null && result.agent.switchAgentId) {
        await rpc.switchServers.updateAddressingPolicy({
          serverId: pickState.serverId,
          agentId: result.agent.switchAgentId,
          policy: form.addressingPolicy,
        });
      }
      await agentsStore.load();
      finishWith(result.agent);
    } catch (error) {
      log.error(error);
      setCloseGuard(false);
      setSubmitState('idle');
      const { headline, detail } = describeFailure(
        error,
        'Could not add the agent. Nothing was created — check the directory is reachable and writable, then try again.'
      );
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    }
  };

  const handleCreate = () => createNewAgent();

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton={submitState === 'idle'}>
          <DialogTitle>New agent</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          {isRemoteRun && hostReadiness.checking && (
            <span className="mr-auto self-center text-xs text-foreground-muted">
              Waiting for {runLocationLabel}…
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitState !== 'idle'}
          >
            Cancel
          </Button>
          <TooltipProvider delay={150}>
            <Tooltip>
              {/* Span, not button, carries the tooltip: a disabled button emits no pointer events. */}
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <ConfirmButton
                      type="button"
                      onClick={() => void handleCreate()}
                      disabled={!canSubmit}
                    >
                      {submitState === 'creating' ? 'Adding…' : 'Add agent'}
                    </ConfirmButton>
                  </span>
                }
              />
              {disabledReason !== null && (
                <TooltipContent side="top">{disabledReason}</TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </DialogFooter>
      }
    >
      <DialogContentArea
        data-autofocus
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem-var(--modal-chrome,8.5rem))] gap-4"
      >
        <AgentIdentityFields form={form} />

        <Field>
          <FieldLabel>Run location</FieldLabel>
          {/* Icons and the right-hand kind, because the list mixes two sorts of
              thing: this machine, and hosts reached over SSH. The names alone
              do not say which is which. */}
          <Select value={runHost} onValueChange={(v) => setRunHost(v ?? LOCAL_RUN_LOCATION)}>
            <SelectTrigger className="w-full">
              <SelectValue>
                {isRemoteRun ? (
                  <Server className="size-4 text-foreground-muted" />
                ) : (
                  <Monitor className="size-4 text-foreground-muted" />
                )}
                <span className="truncate">{runLocationLabel}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={LOCAL_RUN_LOCATION}>
                <Monitor className="size-4 text-foreground-muted" />
                <span className="flex-1">This computer</span>
                <span className="text-xs text-foreground-muted">local</span>
              </SelectItem>
              {allowedHosts.map((host) => (
                <SelectItem key={host.sshHost} value={host.sshHost}>
                  <Server className="size-4 text-foreground-muted" />
                  <span className="flex-1 truncate">{host.name}</span>
                  <span className="text-xs text-foreground-muted">ssh</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {runLocationConstrained && (
            <p className="text-xs text-foreground-muted">
              {targetServer?.managementKind === 'remote'
                ? `This server runs on ${targetServer.sshHost}, so its agents run on this computer or on ${targetServer.sshHost}.`
                : 'This server runs on this computer, so its agents run here too.'}
            </p>
          )}
          {isRemoteRun && <HostReachabilityNotice sshHost={runHost} />}
          {/* Not while it is still checking: the provider picker below is
              already saying so, and two spinners for one question read as two
              questions. Its verdict — the part only it can report — still
              lands here. */}
          {isRemoteRun && runHostReachable && !hostReadiness.checking && (
            <HostReadinessNotice
              sshHost={runHost}
              readiness={hostReadiness}
              onNavigateAway={onClose}
            />
          )}
        </Field>

        {/* The host still gates what comes below it: with it unreachable, or
            missing its own prerequisites, we cannot know which providers it
            has, so offering the tiles would be guessing. What no longer gates
            anything is the directory — nothing is scanned in it, so it can be
            filled in while the host is still being surveyed. */}
        {canChooseAgentType && (
          <Field>
            <FieldLabel>Directory</FieldLabel>
            {isRemoteRun ? (
              // No file picker for a host: the directory is on the other end of
              // an SSH connection, so it is typed rather than browsed.
              <Input
                value={remoteRepoDir}
                placeholder="/home/agent/repo"
                onChange={(e) => setRemoteRepoDir(e.target.value)}
              />
            ) : (
              <LocalDirectorySelector
                title="Choose the agent's working directory"
                message="The agent runs its sessions here."
                path={pickState.path}
                onPathChange={pickState.handlePathChange}
              />
            )}
          </Field>
        )}

        {canChooseAgentType && (
          <AgentTypePicker
            value={pickState.providerId}
            onChange={pickState.setProviderId}
            sshHost={isRemoteRun ? runHost : undefined}
            onNavigateAway={onClose}
          />
        )}

        {canConfigureAgent && !!pickState.providerId && (
          <>
            <AgentAdvancedConfig providerId={pickState.providerId} onChange={onAdvancedChange} />
            <LaunchProfileConfig
              providerId={pickState.providerId}
              sshHost={isRemoteRun ? runHost : null}
              dir={dir}
              onChange={onLaunchProfileConfigChange}
            />
          </>
        )}

        {/* Last, below Advanced configuration. Everything above it is a choice
            the agent cannot exist without; these have working defaults and are
            changeable afterwards from the agent's own settings. */}
        {canConfigureAgent && (
          <AgentSettingsSection
            form={form}
            serverId={pickState.serverId}
            onAddServer={() => showAddServerModal({})}
            onOpenMessagingApps={() => {
              onClose();
              if (pickState.serverId) navigate('server', { serverId: pickState.serverId });
            }}
          />
        )}
      </DialogContentArea>
    </ModalLayout>
  );
});
