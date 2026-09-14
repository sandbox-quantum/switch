import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileText, Monitor, Server } from 'lucide-react';
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
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { openRoom } from '@renderer/features/switch-rooms/open-room';
import { policyHasDeadRule } from '@renderer/features/switch-servers/addressing-policy-editor';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import type { AgentTemplateData } from '@renderer/features/templates/agent-template-data';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import {
  useModalContext,
  useShowModal,
  type BaseModalProps,
} from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
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
  /** When set, the modal pre-fills the agent from this template, prepares its
   * working directory, and puts it in the template's room once it exists. */
  template?: AgentTemplateData | null;
  /** When set, pre-fills the agent name (e.g. from a room template slot). */
  prefillName?: string | null;
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
  template,
  prefillName,
}: AddLocationModalProps) {
  // A template adds two steps around the creation itself: the working
  // directory (and repository clone) before, the room after.
  const [submitState, setSubmitState] = useState<
    'idle' | 'preparing' | 'creating' | 'creating-room'
  >('idle');
  const { navigate } = useNavigate();
  const { setCloseGuard } = useModalContext();
  const showAddServerModal = useShowModal('addServerModal');

  const pickState = usePickMode();
  const form = useConfigureAgentForm();

  // Pre-fill form from a template or a prefilled name (once, on mount). A
  // slot name from the room-template wizard wins over the template's own
  // suggestion: the wizard is asking for that agent by name.
  const [templateApplied, setTemplateApplied] = useState(false);
  useEffect(() => {
    if (templateApplied) return;
    if (template) {
      form.setDescription(template.description);
      form.setInstructions(template.instructions);
      if (template.agentName && !prefillName) form.setAgentName(template.agentName);
      setTemplateApplied(true);
    }
    if (prefillName) {
      form.setAgentName(prefillName);
      setTemplateApplied(true);
    }
  }, [template, prefillName, templateApplied, form]);

  // Run location: 'local' (default) or an onboarded remote host's SSH alias. A
  // remote agent runs its sessions on the host and needs a remote working dir.
  const [runHost, setRunHost] = useState<string>(LOCAL_RUN_LOCATION);
  // Typed directly, with no commit step: it used to need one because committing
  // fired the directory scans, and there are none left to fire.
  const [remoteRepoDir, setRemoteRepoDir] = useState('');

  // A template should not stop at "choose a directory": suggest one, named
  // after the agent, under the directory the Console keeps its locations in.
  // It is created on submit, not now, so cancelling leaves nothing behind.
  // The suggestion follows the name until the person picks a directory
  // themselves; a path they chose is theirs and a rename leaves it alone.
  const lastSuggestedDir = useRef<string | null>(null);
  const { handlePathChange, path: pickedPath } = pickState;
  useEffect(() => {
    if (!template || runHost !== LOCAL_RUN_LOCATION || !form.nameIsValid) return;
    if (pickedPath !== '' && pickedPath !== lastSuggestedDir.current) return;
    let stale = false;
    void rpc.agentTemplates.suggestDirectory({ agentName: form.agentName }).then((dir) => {
      if (stale) return;
      lastSuggestedDir.current = dir;
      handlePathChange(dir);
    });
    return () => {
      stale = true;
    };
  }, [template, runHost, form.agentName, form.nameIsValid, pickedPath, handlePathChange]);
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
    if (result.kind === 'already-configured') {
      toast({
        title: 'An agent with this name is already configured here',
        description:
          'This directory already holds credentials for an agent of that name. Load the existing agent instead of creating a new one.',
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'invalid-name') {
      toast({
        title: 'Switch rejected these agent details',
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

  /**
   * Put the agent the template just created into the template's room, and post
   * its kickoff. The agent already exists at this point, so a failure here is
   * reported as exactly that — the agent stays, the room did not happen — and
   * the caller falls back to opening the agent instead.
   */
  const createTemplateRoom = async (
    t: AgentTemplateData,
    serverId: string,
    agentName: string
  ): Promise<string | null> => {
    if (!t.roomYaml) return null;
    setSubmitState('creating-room');
    try {
      const room = await rpc.switchServers.createRoomFromTemplate(serverId, t.roomYaml, {
        agent: agentName,
      });
      await refreshSidebarRoomState(true);
      if (room.failedAttachments.length > 0) {
        const kickoff = room.failedAttachments.find((f) => f.kind === 'kickoff');
        const others = room.failedAttachments.filter((f) => f.kind !== 'kickoff');
        toast({
          title: kickoff
            ? `${agentName} is in "${room.roomName}", but nobody has spoken to it yet`
            : `"${room.roomName}" was created with gaps`,
          description: [
            kickoff ? `The first message could not be posted: ${kickoff.error}` : null,
            others.length > 0
              ? `Could not add: ${others.map((f) => `${f.id} (${f.error})`).join(', ')}`
              : null,
          ]
            .filter(Boolean)
            .join(' '),
          variant: 'destructive',
        });
      }
      return room.roomId;
    } catch (error) {
      log.error(error);
      const { headline, detail } = describeFailure(
        error,
        `The agent was created, but its room could not be. Create a room and add ${agentName} to it.`
      );
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
      return null;
    }
  };

  /** Create a brand-new flat agent in the chosen directory (local or remote):
   * mint its identity, write its `.claude/agents/<name>.md` definition + its
   * per-agent credentials, and create the row — all via `addAgent`. */
  const createNewAgent = async () => {
    if (!pickState.serverId || !pickState.providerId) return;
    setCloseGuard(true);
    try {
      // The template's working directory may not exist yet (it was only
      // suggested), and its repository is cloned alongside so the agent reads
      // current source from its first answer. Local only: a remote directory
      // is typed by hand and the agent clones for itself there.
      if (template && !isRemoteRun) {
        setSubmitState('preparing');
        const prepared = await rpc.agentTemplates.prepareWorkspace({
          dir: pickState.path,
          repoUrl: template.repoUrl,
        });
        if (prepared.repo?.outcome === 'failed') {
          toast({
            title: 'Could not fetch the repository',
            description: `${prepared.repo.error ?? 'git clone failed'} — the agent will try to clone it itself on its first run.`,
            variant: 'destructive',
          });
        }
      }
      setSubmitState('creating');
      const result = await getLocationManagerStore().addAgentAndOpen({
        sshHost: isRemoteRun ? runHost : null,
        dir: isRemoteRun ? trimmedRemoteDir : pickState.path,
        name: form.agentName,
        providerId: pickState.providerId,
        serverId: pickState.serverId,
        description: form.description.trim(),
        displayName: form.displayName.trim() || null,
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
      if (template?.roomYaml) {
        const roomId = await createTemplateRoom(template, pickState.serverId, result.agent.name);
        if (roomId) {
          setCloseGuard(false);
          setSubmitState('idle');
          onClose();
          await openRoom(roomId);
          return;
        }
      }
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
          <DialogTitle>{template ? `New agent from "${template.name}"` : 'New agent'}</DialogTitle>
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
                      {submitState === 'preparing'
                        ? template?.repoUrl
                          ? 'Fetching repository…'
                          : 'Preparing…'
                        : submitState === 'creating'
                          ? 'Adding…'
                          : submitState === 'creating-room'
                            ? 'Creating its room…'
                            : template?.roomYaml
                              ? 'Add agent and open its room'
                              : 'Add agent'}
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

        {template && (
          <Alert>
            <FileText />
            <AlertDescription className="flex flex-col gap-1">
              {template.repoUrl && (
                <span>
                  Works from{' '}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 underline underline-offset-2"
                    onClick={() =>
                      void openExternalUrl(template.repoUrl!, 'Could not open the repository')
                    }
                  >
                    {template.repoUrl.replace(/^https?:\/\//, '')}
                    <ExternalLink className="size-3" />
                  </button>
                  , cloned into its directory before it first runs.
                </span>
              )}
              {template.sources.length > 0 && (
                <span>
                  Reads:{' '}
                  {template.sources.map((source, i) => (
                    <span key={source.url}>
                      {i > 0 && ', '}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 underline underline-offset-2"
                        onClick={() => void openExternalUrl(source.url, 'Could not open the page')}
                      >
                        {source.label ?? source.url.replace(/^https?:\/\//, '')}
                        <ExternalLink className="size-3" />
                      </button>
                    </span>
                  ))}
                </span>
              )}
              {template.roomYaml && (
                <span>
                  Once it exists it is put in a room
                  {template.roomName
                    ? ` called "${template.roomName.replace('{agent}', form.agentName || 'it')}"`
                    : ''}{' '}
                  with you, and spoken to, so it starts working right away.
                </span>
              )}
              {template.warnings.map((w) => (
                <span key={w} className="text-foreground-muted">
                  {w}
                </span>
              ))}
            </AlertDescription>
          </Alert>
        )}

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
