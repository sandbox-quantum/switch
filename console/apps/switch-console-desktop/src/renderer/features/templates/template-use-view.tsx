import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParsedAgentEntry, TemplateKind } from '@main/core/agent-templates/controller';
import type { AgentTemplateOrigin } from '@main/core/agents/agent-config-file';
import type { ParamSpec, ParsedTemplate } from '@main/core/room-templates/controller';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { AgentTypePicker } from '@renderer/features/locations/components/add-agent-modal/agent-type-picker';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { HostReachabilityNotice } from '@renderer/features/remote-hosts/host-reachability-notice';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import {
  HostReadinessNotice,
  useRemoteHostReadiness,
} from '@renderer/features/remote-hosts/host-readiness-notice';
import { blockedHandoffs } from '@renderer/features/room-templates/agent-handoff';
import {
  AgentListField,
  type EntityLists,
  UserListField,
} from '@renderer/features/room-templates/entity-fields';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { remoteAgentsQueryKey, useRemoteAgents } from '@renderer/lib/stores/use-remote-agents';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { cn } from '@renderer/utils/utils';
import { AGENT_NAME_PATTERN } from '@shared/core/agents/agent-slug';
import {
  AGENT_PROVIDER_IDS,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';
import { ownerAndMyAgentsPolicy, ownerOnlyPolicy } from '@shared/core/switch-servers/owner-policy';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import { findBundledTemplate } from './bundled-templates';
import {
  type AgentSlot,
  AgentSlotCard,
  newSlot,
  ResolvedDocument,
  RoomCard,
  type SlotStatus,
  slotWantedName,
} from './use/creates-rail';
import { ParamField } from './use/param-field';
import {
  LOCAL_RUN_LOCATION,
  RunLocationSelect,
  runLocationLabel,
  useAllowedHosts,
} from './use/run-location-select';
import {
  defaultsFor,
  hasPlaceholder,
  interpolate,
  missingParams,
  serverInputs,
  unsetParams,
  type Values,
} from './use/use-template-model';

type Params = {
  serverId: string;
  /** A registry row or bundled id to load. */
  templateId?: string;
  /** A document in hand instead (pasted, dropped, a recent). */
  yamlText?: string;
  sourceName?: string;
  /** Put the agent it creates in this room instead of making the template's own. */
  intoRoomId?: string;
};

function useViewParams(): Params {
  return useParams('templateUse').params as Params;
}

/** The document, where it came from, and the persona a bundled one keeps beside it. */
type Loaded = {
  name: string;
  yamlText: string;
  instructions: string | null;
  origin: AgentTemplateOrigin | null;
  kind: TemplateKind;
  agents: ParsedAgentEntry[];
  /** A lone `agent:` block: its room names it `{agent}` and the page fills that in. */
  singular: boolean;
  /** The declared inputs, Console-only ones included. */
  params: ParamSpec[];
  parsed: ParsedTemplate | null;
  coreYaml: string | null;
  warnings: string[];
};

async function loadForUse(serverId: string, params: Params): Promise<Loaded> {
  let name: string;
  let yamlText: string;
  let instructions: string | null = null;
  let origin: AgentTemplateOrigin | null = null;
  if (params.templateId) {
    const bundled = findBundledTemplate(params.templateId);
    if (bundled) {
      name = bundled.name;
      yamlText = bundled.content;
      instructions = bundled.instructions;
      origin = { id: bundled.id, name: bundled.name, source: 'bundled' };
    } else {
      const detail = await rpc.switchServers.getTemplateDetail({
        serverId,
        templateId: params.templateId,
      });
      name = detail.name;
      yamlText = detail.definition;
      origin = { id: detail.id, name: detail.name, source: 'server', serverId };
    }
  } else if (params.yamlText) {
    name = params.sourceName?.replace(/(\.template)?\.ya?ml$/i, '') ?? 'Pasted template';
    yamlText = params.yamlText;
  } else {
    throw new Error('Nothing to use: no template was given.');
  }
  const kind = await rpc.agentTemplates.kind({ yamlText });
  const { agents, singular, warnings } = await rpc.agentTemplates.parseAgents({
    yamlText,
    instructions,
  });
  // Two cuts of the server half: one with the Console's own params still in,
  // which the form reads, and the one the server gets.
  const forForm = await rpc.agentTemplates.coreDocument({ yamlText, keepConsoleParams: true });
  const coreYaml = await rpc.agentTemplates.coreDocument({ yamlText });
  const schema = await rpc.switchServers.fetchTemplateSchema(serverId).catch(() => null);
  const parsed = forForm
    ? await rpc.roomTemplates.parse({ yamlText: forForm, schema: schema ?? undefined })
    : null;
  // An agent-only document still declares inputs its names may use.
  const declaredParams = parsed?.params ?? (await rpc.roomTemplates.params({ yamlText }));
  return {
    name,
    yamlText,
    instructions,
    origin,
    kind,
    agents,
    singular,
    params: declaredParams,
    parsed,
    coreYaml,
    warnings: [...warnings, ...(parsed?.warnings ?? [])],
  };
}

const TemplateUseTitlebar = observer(function TemplateUseTitlebar() {
  const { serverId } = useViewParams();
  const { navigate } = useNavigate();
  return (
    <ServerSectionTitlebar
      serverId={serverId}
      icon={FileText}
      label="Templates"
      item={{ label: 'Use template' }}
      onSectionClick={() => navigate('templates', { serverId })}
    />
  );
});

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {hint && <p className="text-[12.5px] leading-relaxed text-foreground-muted">{hint}</p>}
    </div>
  );
}

const TemplateUsePanel = observer(function TemplateUsePanel() {
  const params = useViewParams();
  const { serverId, intoRoomId = null } = params;
  const { navigate } = useNavigate();
  const { showModal } = useModalContext();
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [slots, setSlots] = useState<AgentSlot[]>([]);
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [editedAgents, setEditedAgents] = useState<string[]>([]);
  const [editedUsers, setEditedUsers] = useState<string[]>([]);
  const [runHost, setRunHost] = useState<string>(LOCAL_RUN_LOCATION);
  const [pickedProvider, setPickedProvider] = useState<AgentProviderId | null>(null);
  const [phase, setPhase] = useState<'form' | 'creating'>('form');
  const [roomStatus, setRoomStatus] = useState<SlotStatus>('idle');
  const [createError, setCreateError] = useState<string | null>(null);

  // The params identify the document; only a different document resets the form.
  const { templateId, yamlText: givenYaml, sourceName } = params;
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    loadForUse(serverId, { serverId, templateId, yamlText: givenYaml, sourceName })
      .then((result) => {
        if (cancelled) return;
        setLoaded(result);
        setValues(
          defaultsFor(result.params.filter((p) => !(result.singular && p.name === 'agent')))
        );
        setSlots(result.agents.map(newSlot));
        // The editable list is the room's fixed members that are not slots the
        // template creates; those are named by their cards.
        const slotNames = new Set(result.agents.map((a) => a.name ?? ''));
        setEditedAgents((result.parsed?.hardcodedAgents ?? []).filter((a) => !slotNames.has(a)));
        setEditedUsers(result.parsed?.hardcodedUsers ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(failureText(e, 'Could not load this template.'));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, templateId, givenYaml, sourceName]);

  const parsed = loaded?.parsed ?? null;
  // A lone `agent:` room names it `{agent}`; the page fills that in itself.
  const templateParams = useMemo(
    () => (loaded?.params ?? []).filter((p) => !(loaded?.singular && p.name === 'agent')),
    [loaded]
  );
  const createsAgents = (loaded?.agents.length ?? 0) > 0;
  const isGroupDoc = (parsed?.rooms.length ?? 0) > 1 || parsed?.groupName !== null;
  const isRemoteRun = runHost !== LOCAL_RUN_LOCATION;
  const sshHost = isRemoteRun ? runHost : null;

  // ── Server lists (pickers, identities, bridges) ─────────────────────────
  const agents = useRemoteAgents(serverId);
  const roomsQuery = useQuery({
    queryKey: ['remote-rooms', serverId],
    queryFn: () => rpc.switchServers.listRemoteRooms(serverId),
  });
  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
  });
  const knownUsersQuery = useQuery({
    queryKey: ['remote-external-users', serverId],
    queryFn: () => rpc.switchServers.listRemoteExternalUsers(serverId),
  });
  const { identities, refresh: refreshIdentities } = useMyIdentities(serverId);
  const bridges = useMemo(() => bridgesQuery.data ?? [], [bridgesQuery.data]);

  // The bridge the room lands on: a bridge-typed param's pick, else the one
  // the template names, else the server's default.
  const templateBridge = useMemo(() => {
    const bridgeParam = templateParams.find((p) => p.type === 'bridge');
    const picked = bridgeParam ? String(values[bridgeParam.name] ?? '') : '';
    const named = picked !== '' ? picked : (parsed?.bridge ?? null);
    if (named) return bridges.find((b) => b.displayName === named) ?? null;
    return bridges.find((b) => b.isDefault) ?? (bridges.length === 1 ? bridges[0] : null);
  }, [bridges, parsed, templateParams, values]);
  const creatorIdentity = useMemo(() => {
    if (identities === null) return null;
    if (templateBridge) {
      return identities.find((i) => i.bridgeId === templateBridge.id)?.externalUsername ?? null;
    }
    return identities[0]?.externalUsername ?? null;
  }, [identities, templateBridge]);
  // Without a messaging app the server names the creator itself, so only a
  // bridged room needs the account linked.
  const creatorBlocked =
    parsed?.usesCreator === true &&
    templateBridge !== null &&
    identities !== null &&
    creatorIdentity === null;
  const linkAccount = templateBridge
    ? () =>
        showModal('claimIdentityModal', {
          serverId,
          bridgeId: templateBridge.id,
          onSuccess: () => refreshIdentities(),
        })
    : null;
  const noMessagingApp = parsed !== null && bridgesQuery.data !== undefined && bridges.length === 0;

  // "Existing agent" on a slot means one that runs where the new ones will:
  // this Console's records say which host each of its agents lives on.
  const locationsQuery = useQuery({
    queryKey: ['locations'],
    queryFn: () => rpc.locations.getLocations(),
  });
  const agentsAtLocation = useMemo(() => {
    const hostOf = new Map((locationsQuery.data ?? []).map((l) => [l.id, l.sshHost]));
    const here = new Set(
      agentsStore
        .agentsOnServer(serverId)
        .filter((a) => (hostOf.get(a.locationId) ?? null) === sshHost)
        .map((a) => a.name)
    );
    return (agents.data ?? []).filter((a) => here.has(a.name));
  }, [agents.data, locationsQuery.data, serverId, sshHost]);

  const lists = useMemo(
    (): EntityLists => ({
      serverId,
      agents: agents.data ?? [],
      agentsLoading: agents.isLoading,
      rooms: roomsQuery.data ?? [],
      roomsLoading: roomsQuery.isLoading,
      bridges,
      identities,
      knownUsers: knownUsersQuery.data ?? [],
      bridgeId: templateBridge?.id ?? null,
    }),
    [
      serverId,
      agents.data,
      agents.isLoading,
      roomsQuery.data,
      roomsQuery.isLoading,
      bridges,
      identities,
      knownUsersQuery.data,
      templateBridge,
    ]
  );

  // ── Where the agents run, and what runs them ────────────────────────────
  const allowedHosts = useAllowedHosts(serverId);
  useEffect(() => {
    if (isRemoteRun && !allowedHosts.some((h) => h.sshHost === runHost)) {
      setRunHost(LOCAL_RUN_LOCATION);
    }
  }, [allowedHosts, isRemoteRun, runHost]);
  // Availability is per machine: a new machine gets a fresh pick.
  useEffect(() => {
    setPickedProvider(null);
    setSlots((prev) => prev.map((s) => (s.dirPicked ? s : { ...s, dir: '' })));
  }, [runHost]);
  const providerParam = templateParams.find((p) => p.type === 'provider') ?? null;
  const pageProvider: AgentProviderId | null = providerParam
    ? ((values[providerParam.name] as AgentProviderId) ?? null) || null
    : pickedProvider;
  const providerFor = (entry: ParsedAgentEntry): AgentProviderId | null => {
    const own = entry.provider ? interpolate(entry.provider, values) : null;
    if (own && (AGENT_PROVIDER_IDS as readonly string[]).includes(own)) {
      return own as AgentProviderId;
    }
    return pageProvider;
  };
  const hostReachable = !isRemoteRun || !hostReachabilityStore.isBlocked(runHost);
  const hostReadiness = useRemoteHostReadiness(sshHost, pageProvider);
  const hostReady = !isRemoteRun || (!hostReadiness.blocked && !hostReadiness.checking);

  // ── Names: wanted, taken, and the first free variant ────────────────────
  const takenNames = useMemo(() => new Set((agents.data ?? []).map((a) => a.name)), [agents.data]);
  const slotNames = useMemo(() => {
    const used = new Set<string>();
    return slots.map((slot, i) => {
      const wanted = slotWantedName(slot, values, i === 0 ? nameOverride : null);
      if (slot.mode === 'existing') return { wanted, final: slot.existingName };
      if (wanted === '' || hasPlaceholder(wanted)) return { wanted, final: wanted };
      let candidate = wanted;
      for (let n = 2; takenNames.has(candidate) || used.has(candidate); n++) {
        candidate = `${wanted}-${n}`;
      }
      used.add(candidate);
      return { wanted, final: candidate };
    });
  }, [slots, values, nameOverride, takenNames]);

  // A directory per new agent, named after it, under the Console's locations
  // directory (or the host's home). It follows the name until picked by hand.
  const suggestSeq = useRef(0);
  useEffect(() => {
    if (!hostReachable || phase !== 'form') return;
    const seq = ++suggestSeq.current;
    slots.forEach((slot, i) => {
      if (slot.mode !== 'new' || slot.dirPicked) return;
      const name = slotNames[i]?.final ?? '';
      if (name === '' || hasPlaceholder(name) || !AGENT_NAME_PATTERN.test(name)) return;
      void rpc.agentTemplates
        .suggestDirectory({ agentName: name, sshHost })
        .then((dir) => {
          if (seq !== suggestSeq.current) return;
          setSlots((prev) => {
            const s = prev[i];
            if (!s || s.dirPicked || s.dir === dir) return prev; // same array: no re-run
            return prev.map((x, j) => (j === i ? { ...x, dir } : x));
          });
        })
        .catch(() => {});
    });
  }, [slots, slotNames, sshHost, hostReachable, phase]);

  // ── What still stands in the way ────────────────────────────────────────
  const missing = missingParams(templateParams, values);
  const slotProblems: string[] = [];
  slots.forEach((slot, i) => {
    const { wanted, final } = slotNames[i] ?? { wanted: '', final: '' };
    if (slot.mode === 'existing') {
      if (final === '')
        slotProblems.push(`Pick the existing agent for ${wanted || `agent ${i + 1}`}.`);
      return;
    }
    if (final === '' || hasPlaceholder(final)) return; // an input still fills it in
    if (!AGENT_NAME_PATTERN.test(final)) {
      slotProblems.push(
        `${final} is not a valid agent name: lowercase letters, digits, . - _, starting with a letter or digit.`
      );
    }
    if (!providerFor(slot.entry))
      slotProblems.push('Choose which coding agent backs the new agents.');
    if (slot.dir.trim() === '') slotProblems.push(`Choose a directory for ${final}.`);
  });
  const newSlots = slots.filter((s) => s.mode === 'new');
  const blockedReason: string | null =
    phase !== 'form'
      ? null
      : loaded === null
        ? 'Loading…'
        : missing.length > 0
          ? `Fill in ${missing.map((p) => p.name).join(', ')}`
          : slotProblems.length > 0
            ? slotProblems[0]
            : newSlots.length > 0 && !hostReachable
              ? `${runLocationLabel(runHost, allowedHosts)} cannot be reached right now.`
              : newSlots.length > 0 && !hostReady
                ? hostReadiness.checking
                  ? `Checking what ${runLocationLabel(runHost, allowedHosts)} has installed…`
                  : `${runLocationLabel(runHost, allowedHosts)} is missing setup the agents need.`
                : intoRoomId
                  ? null // no room is made, so nothing below applies
                  : creatorBlocked
                    ? 'Link your messaging account first.'
                    : parsed !== null && noMessagingApp && parsed.usesCreator
                      ? 'This server has no messaging app, so the room would have no chat.'
                      : null;
  const stillNeeded =
    missing.length > 0
      ? `${missing.length} input${missing.length === 1 ? '' : 's'} still needed`
      : slotProblems.length > 0
        ? `${slotProblems.length} thing${slotProblems.length === 1 ? '' : 's'} to settle`
        : 'Every input filled in';

  // Agents already on the server that the room will hold and that will not
  // hear each other. New agents are created with the template's addressing.
  const handoffBlocked = useMemo(() => {
    if (!parsed) return [];
    const names = new Set<string>(editedAgents);
    for (const param of templateParams) {
      if (param.type === 'agent') {
        const v = values[param.name];
        if (typeof v === 'string' && v !== '') names.add(v);
      }
    }
    for (const slot of slots)
      if (slot.mode === 'existing' && slot.existingName) names.add(slot.existingName);
    return blockedHandoffs((agents.data ?? []).filter((a) => names.has(a.name)));
  }, [parsed, editedAgents, templateParams, values, slots, agents.data]);
  const [allowingHandoffs, setAllowingHandoffs] = useState(false);
  const allowHandoffs = useCallback(async () => {
    const byName = new Map((agents.data ?? []).map((a) => [a.name, a]));
    setAllowingHandoffs(true);
    try {
      for (const targetName of new Set(handoffBlocked.map((b) => b.to))) {
        const target = byName.get(targetName);
        if (!target) continue;
        const sources = handoffBlocked
          .filter((b) => b.to === targetName)
          .map((b) => byName.get(b.from))
          .filter((a): a is NonNullable<typeof a> => a !== undefined);
        const rules = (target.addressingPolicy?.rules ?? []).map((rule) => {
          const next = { ...rule };
          for (const source of sources) {
            if (target.ownerId !== null && source.ownerId === target.ownerId) {
              next.owner_agents = true;
            } else if (next.agents !== '*' && !next.agents.includes(source.id)) {
              next.agents = [...next.agents, source.id];
            }
          }
          return next;
        });
        await rpc.switchServers.updateAddressingPolicy({
          serverId,
          agentId: target.id,
          policy: { rules },
        });
      }
      await queryClient.invalidateQueries({ queryKey: remoteAgentsQueryKey(serverId) });
    } catch (e) {
      toast({ title: failureText(e, 'Could not update the agents.'), variant: 'destructive' });
    } finally {
      setAllowingHandoffs(false);
    }
  }, [agents.data, handoffBlocked, serverId, queryClient]);

  // ── Create ──────────────────────────────────────────────────────────────
  const setSlot = (i: number, patch: Partial<AgentSlot>) =>
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const createAll = async () => {
    if (!loaded || blockedReason !== null) return;
    setPhase('creating');
    setCreateError(null);
    setFieldErrors({});
    const finalNames = slotNames.map((n) => n.final);
    const created: { slotIndex: number; name: string; switchAgentId: string | null }[] = [];

    // Agents first, one at a time, each card saying where it is.
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.mode !== 'new' || slot.status === 'created') continue;
      const name = slot.createdName ?? finalNames[i];
      const providerId = providerFor(slot.entry);
      if (!providerId) continue;
      setSlot(i, { status: 'creating', error: null });
      try {
        // An agent that exists from an earlier try only needs its policy set.
        let switchAgentId = slot.createdSwitchAgentId;
        if (!switchAgentId) {
          const prepared = await rpc.agentTemplates.prepareWorkspace({
            dir: slot.dir.trim(),
            repoUrl: slot.cloneRepo ? slot.entry.repoUrl : null,
            sshHost,
          });
          if (prepared.repo?.outcome === 'failed') {
            toast({
              title: `Could not fetch the repository for ${name}`,
              description: `${prepared.repo.error ?? 'git clone failed'}. The agent will try to clone it itself on its first run.`,
              variant: 'destructive',
            });
          }
          const result = await rpc.agents.addAgent({
            sshHost,
            dir: slot.dir.trim(),
            name,
            providerId,
            serverId,
            description: slot.entry.description,
            displayName: null,
            iconUrl: null,
            autoSession: true,
            autoApprove: isRemoteRun,
            instructions: slot.entry.instructions,
            definitionAttributes: {},
            providerConfig: null,
            entryPoint: 'server_page',
            templateOrigin: loaded.origin,
          });
          if (result.kind !== 'created') {
            setSlot(i, { status: 'failed', error: provisionErrorText(result) });
            setPhase('form');
            return;
          }
          switchAgentId = result.agent.switchAgentId ?? null;
          // Checkpoint before the policy: a retry must not make a second agent.
          setSlot(i, { createdName: result.agent.name, createdSwitchAgentId: switchAgentId });
        }
        // A new agent answers only its owner by default; the template's
        // `anyone` has to be written as the open policy, not left alone.
        if (switchAgentId && slot.entry.addressing) {
          await rpc.switchServers.updateAddressingPolicy({
            serverId,
            agentId: switchAgentId,
            policy:
              slot.entry.addressing === 'owner-agents'
                ? ownerAndMyAgentsPolicy()
                : slot.entry.addressing === 'owner'
                  ? ownerOnlyPolicy()
                  : null,
          });
        }
        created.push({ slotIndex: i, name, switchAgentId });
        setSlot(i, { status: 'created' });
      } catch (e) {
        setSlot(i, { status: 'failed', error: failureText(e, 'Could not create the agent.') });
        setPhase('form');
        return;
      }
    }
    if (created.length > 0) {
      await agentsStore.load();
      await queryClient.invalidateQueries({ queryKey: remoteAgentsQueryKey(serverId) });
    }
    rpc.roomTemplates
      .saveRecent({ serverId, name: loaded.name, yamlText: loaded.yamlText })
      .catch(() => {});

    // Into a room that already exists: nothing else to make.
    if (intoRoomId) {
      const byName = new Map((agents.data ?? []).map((a) => [a.name, a.id]));
      const ids = slots
        .map((s) =>
          s.mode === 'existing' ? (byName.get(s.existingName) ?? null) : s.createdSwitchAgentId
        )
        .concat(created.map((c) => c.switchAgentId))
        .filter((id): id is string => !!id);
      try {
        if (ids.length > 0) {
          await rpc.switchServers.addRoomAgents({
            serverId,
            roomId: intoRoomId,
            agentIds: [...new Set(ids)],
            direction: 'agents_to_room',
          });
        }
        await refreshSidebarRoomState(true);
        toast({
          title: 'In the room',
          description: 'Mention an agent there to start it. A message from you is what wakes it.',
        });
        navigate('room', { roomId: intoRoomId });
      } catch (e) {
        setCreateError(
          failureText(e, 'The agents were created, but could not be added to the room.')
        );
        setPhase('form');
      }
      return;
    }

    if (!loaded.coreYaml || !parsed) {
      const first = created[0];
      if (first) {
        const local = agentsStore.agentsOnServer(serverId).find((a) => a.name === first.name);
        if (local) navigate('location', { locationId: local.locationId, agentName: local.name });
        else navigate('serverAgents', { serverId });
      }
      return;
    }

    // Then the room half, with every slot spelled the way the server will find it.
    setRoomStatus('creating');
    try {
      const replacements: Record<string, string> = {};
      slots.forEach((slot, i) => {
        const expression = slot.entry.name ?? '';
        const actual =
          slot.mode === 'existing' ? slot.existingName : (slot.createdName ?? finalNames[i]);
        if (expression && actual && expression !== actual) replacements[expression] = actual;
      });
      let coreYaml = await rpc.agentTemplates.substituteSlots({
        coreYaml: loaded.coreYaml,
        replacements,
      });
      coreYaml = await rpc.agentTemplates.dropParams({
        coreYaml,
        names: unsetParams(templateParams, values),
      });
      if (!isGroupDoc) {
        // The lists are rebuilt from the parse, so the slots renamed above
        // have to be renamed here too or the rewrite would put them back.
        const slotNamesSet = new Set(slots.map((s) => s.entry.name ?? ''));
        const keep = (list: string[]) =>
          list
            .filter((a) => hasPlaceholder(a) || slotNamesSet.has(a))
            .map((a) => replacements[a] ?? a);
        coreYaml = await rpc.roomTemplates.rewriteYaml({
          yamlText: coreYaml,
          agents: [...new Set([...keep(parsed.agents), ...editedAgents])],
          users: [...keep(parsed.users), ...editedUsers],
        });
      }
      const inputs = serverInputs(templateParams, values);
      if (loaded.singular && slots.length === 1) {
        // A lone `agent:` room names it `{agent}`; the server fills that in.
        const slot = slots[0];
        inputs.agent =
          slot.mode === 'existing' ? slot.existingName : (slot.createdName ?? finalNames[0] ?? '');
      }
      const result = await rpc.switchServers.createRoomFromTemplate(serverId, coreYaml, inputs);
      setRoomStatus('created');
      await refreshSidebarRoomState(true);
      if (result.kind === 'room') {
        if (result.failedAttachments.length > 0) {
          const kickoff = result.failedAttachments.find((f) => f.kind === 'kickoff');
          const others = result.failedAttachments.filter((f) => f.kind !== 'kickoff');
          toast({
            title: kickoff
              ? `"${result.roomName}" exists, but nobody has spoken in it yet`
              : `"${result.roomName}" was created with gaps`,
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
        // The room is the thing to watch: the kickoff lands there and the
        // agents answer there. Their sessions show up in the sidebar.
        navigate('room', { roomId: result.roomId });
      } else {
        const gaps = [
          ...result.errors.map((e) => e.error),
          ...result.rooms.flatMap((r) =>
            r.failedAttachments.map((f) => `${r.roomName}: ${f.id} (${f.error})`)
          ),
        ];
        if (gaps.length > 0) {
          toast({
            title: `"${result.groupName}" was created with gaps`,
            description: gaps.join('; '),
            variant: 'destructive',
          });
        } else {
          toast({
            title: `"${result.groupName}" is ready`,
            description: `${result.rooms.length} room${result.rooms.length === 1 ? '' : 's'} created.`,
          });
        }
        const first = result.rooms[0];
        if (first) navigate('room', { roomId: first.roomId });
        else navigate('serverRooms', { serverId });
      }
    } catch (e) {
      setRoomStatus('failed');
      const serverDetail =
        e instanceof RpcError && e.code === 'GatewayError' ? e.stringField('detail') : undefined;
      const message =
        serverDetail ?? failureText(e, 'Could not create the room from this template.');
      const paramMatch = message.match(/param(?:\(s\))?:?\s*['"]?(\w+)/i);
      if (paramMatch && templateParams.some((p) => p.name === paramMatch[1])) {
        setFieldErrors({ [paramMatch[1]]: message });
      } else {
        setCreateError(
          created.length > 0
            ? `The agents were created, but the room could not be: ${message}`
            : message
        );
      }
      setPhase('form');
    }
  };

  // What the rail shows: the inputs, plus the lone agent's name where the room
  // says `{agent}`, and every slot as it will actually be named.
  const railValues: Values =
    loaded?.singular && slotNames[0]
      ? { ...values, agent: slotNames[0].final || '{agent}' }
      : values;
  const railRenames = useMemo(() => {
    const out: Record<string, string> = {};
    slots.forEach((slot, i) => {
      const expression = slot.entry.name ?? '';
      const actual =
        slot.mode === 'existing' ? slot.existingName : (slot.createdName ?? slotNames[i]?.final);
      if (expression && actual && expression !== actual) out[expression] = actual;
    });
    return out;
  }, [slots, slotNames]);

  // ── Render ──────────────────────────────────────────────────────────────
  const partlyDone =
    slots.some((s) => s.status === 'created' || s.status === 'failed') || roomStatus === 'failed';
  const primaryLabel = partlyDone
    ? 'Retry remaining steps'
    : intoRoomId
      ? 'Create and add to room'
      : loaded?.kind === 'group'
        ? 'Create all'
        : loaded?.kind === 'agent'
          ? 'Create agent'
          : 'Create room';
  const intoRoomName = intoRoomId ? switchRoomsStore.roomNameById(intoRoomId) : null;
  // Back to where the person came from: the room, the editor with their
  // document still in it, the template's page, or the listing.
  const cancel = () =>
    intoRoomId
      ? navigate('room', { roomId: intoRoomId })
      : params.templateId
        ? navigate('templateDetail', { serverId, templateId: params.templateId })
        : params.yamlText
          ? navigate('templateImport', {
              serverId,
              yamlText: params.yamlText,
              sourceName: params.sourceName,
              edit: true,
            })
          : navigate('templates', { serverId });
  const showNameField = loaded?.kind === 'agent' && slots.length === 1 && slots[0].mode === 'new';
  const showAgentLists =
    parsed !== null &&
    !isGroupDoc &&
    (parsed.hardcodedAgents.length > 0 || editedAgents.length > 0);
  const showUserLists =
    parsed !== null && !isGroupDoc && (parsed.hardcodedUsers.length > 0 || editedUsers.length > 0);

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-start gap-4 border-b border-border px-8 pt-8 pb-5 [-webkit-app-region:drag]">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs text-foreground-passive">
            {intoRoomId ? `Add an agent to ${intoRoomName ?? 'the room'}` : 'Use template'}
          </span>
          <h2 className="truncate text-xl font-semibold tracking-tight">
            {loaded?.name ?? params.sourceName ?? 'Template'}
          </h2>
          {partlyDone && phase === 'form' && (
            <span className="text-xs text-foreground-muted">
              What was created stays created; the button carries on from the first step that did not
              finish.
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 [-webkit-app-region:no-drag]">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={cancel} disabled={phase === 'creating'}>
              {params.yamlText && !intoRoomId ? 'Back to the document' : 'Cancel'}
            </Button>
            <Button
              size="sm"
              onClick={() => void createAll()}
              disabled={blockedReason !== null || phase === 'creating'}
              title={blockedReason ?? undefined}
            >
              {phase === 'creating' ? 'Creating…' : primaryLabel}
            </Button>
          </div>
          {blockedReason && loaded && phase === 'form' && (
            <span className="max-w-md text-right text-[11.5px] text-foreground-muted">
              {blockedReason}
            </span>
          )}
        </div>
      </div>

      {loadError ? (
        <div className="px-8 py-6">
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        </div>
      ) : !loaded || (!parsed && loaded.coreYaml) ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-foreground-muted" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Left: inputs */}
          <div className="flex w-[46%] min-w-[340px] shrink-0 flex-col gap-6 overflow-auto px-8 py-6">
            {createError && (
              <Alert variant="destructive">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
            {loaded.warnings.map((w, i) => (
              <Alert key={i}>
                <AlertDescription>{w}</AlertDescription>
              </Alert>
            ))}
            {creatorBlocked && !intoRoomId && (
              <Alert>
                <AlertDescription>
                  <div className="flex flex-col gap-2">
                    <span>
                      This template puts you in the room, and this server does not know which
                      account is yours{templateBridge ? ` on ${templateBridge.displayName}` : ''}.
                    </span>
                    {linkAccount && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={linkAccount}
                      >
                        Link account
                      </Button>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
            )}
            {handoffBlocked.length > 0 && (
              <Alert>
                <AlertDescription>
                  <div className="flex flex-col gap-2">
                    <span>
                      These agents will not hear each other:{' '}
                      {handoffBlocked.map((b) => `${b.to} ignores ${b.from}`).join(', ')}.
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      disabled={allowingHandoffs}
                      onClick={() => void allowHandoffs()}
                    >
                      {allowingHandoffs ? 'Updating…' : 'Let them hear each other'}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            <SectionTitle
              title="Inputs"
              hint="Values are substituted into the template. Nothing is created until you confirm."
            />
            {templateParams.length === 0 && !showNameField && (
              <p className="text-sm text-foreground-muted">This template asks for nothing.</p>
            )}
            {showNameField && (
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[12.5px] font-medium">name</span>
                  <span className="text-[11px] text-foreground-passive">text</span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-amber-600 dark:text-amber-400">Required</span>
                </div>
                <p className="text-xs text-foreground-muted">
                  What the agent is called on this server. In rooms it is addressed by this name.
                </p>
                <Input
                  className="font-mono"
                  value={nameOverride ?? slotNames[0]?.wanted ?? ''}
                  onChange={(e) => setNameOverride(e.target.value)}
                  disabled={phase === 'creating'}
                />
              </div>
            )}
            {templateParams.map((param) => (
              <ParamField
                key={param.name}
                param={param}
                value={values[param.name] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [param.name]: v }))}
                error={fieldErrors[param.name] ?? null}
                lists={lists}
                sshHost={sshHost}
                onNavigateAway={() => navigate('settings', { tab: 'clis-models' })}
              />
            ))}
            {showAgentLists && (
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[12.5px] font-medium">agents</span>
                  <span className="text-[11px] text-foreground-passive">already on the server</span>
                </div>
                <AgentListField items={editedAgents} onChange={setEditedAgents} lists={lists} />
                <p className="text-xs text-foreground-muted">
                  Agents the template puts in the room. Drop any the server does not have, or add
                  more.
                </p>
              </div>
            )}
            {showUserLists && (
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[12.5px] font-medium">users</span>
                  <span className="text-[11px] text-foreground-passive">people</span>
                </div>
                <UserListField items={editedUsers} onChange={setEditedUsers} lists={lists} />
                <p className="text-xs text-foreground-muted">
                  People the template invites. A name the server has not seen is looked up in the
                  messaging app's directory when the room is created.
                </p>
              </div>
            )}

            {createsAgents && (
              <>
                <SectionTitle
                  title={slots.length === 1 ? 'Where the agent runs' : 'Where the agents run'}
                  hint="Each new agent gets its own directory there, named after it."
                />
                <div className="flex flex-col gap-2">
                  <span className="text-[11px] text-foreground-passive">Run location</span>
                  <RunLocationSelect
                    value={runHost}
                    onChange={setRunHost}
                    hosts={allowedHosts}
                    disabled={phase === 'creating'}
                  />
                  {isRemoteRun && <HostReachabilityNotice sshHost={runHost} />}
                  {isRemoteRun && hostReachable && !hostReadiness.checking && (
                    <HostReadinessNotice
                      sshHost={runHost}
                      readiness={hostReadiness}
                      onNavigateAway={() => navigate('remoteHosts')}
                    />
                  )}
                </div>
                {!providerParam && (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-foreground-muted">
                      Which coding agent backs {slots.length === 1 ? 'it' : 'them'}. Only what{' '}
                      {runLocationLabel(runHost, allowedHosts)} has installed is offered.
                    </p>
                    {hostReachable ? (
                      <AgentTypePicker
                        value={pickedProvider}
                        onChange={setPickedProvider}
                        sshHost={sshHost ?? undefined}
                        onNavigateAway={() => navigate('settings', { tab: 'clis-models' })}
                      />
                    ) : (
                      <p className="text-xs text-foreground-passive">Waiting for the host…</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right: what this will create */}
          <div className="flex min-w-0 flex-1 flex-col border-l border-border bg-background-1">
            <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
              <span className="min-w-0 flex-1 text-[13px] font-semibold">
                What this will create
              </span>
              <span
                className={cn(
                  'shrink-0 text-[11.5px]',
                  missing.length > 0 || slotProblems.length > 0
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-emerald-700 dark:text-emerald-400'
                )}
              >
                {stillNeeded}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
              <div className="flex flex-col gap-2">
                {intoRoomId ? (
                  <p className="text-xs text-foreground-muted">
                    The new agent joins the room you came from; no room is made.
                  </p>
                ) : (
                  parsed?.rooms.map((room, i) => (
                    <RoomCard
                      key={i}
                      room={room}
                      values={railValues}
                      renames={railRenames}
                      bridgeName={templateBridge?.displayName ?? parsed.bridge}
                      creatorIdentity={creatorIdentity}
                      status={roomStatus}
                    />
                  ))
                )}
                {slots.map((slot, i) => (
                  <AgentSlotCard
                    key={i}
                    slot={slot}
                    wantedName={slotNames[i]?.wanted ?? ''}
                    finalName={slotNames[i]?.final ?? ''}
                    onChange={(next) =>
                      setSlots((prev) => prev.map((s, j) => (j === i ? next : s)))
                    }
                    lists={{ ...lists, agents: agentsAtLocation }}
                    locationLabel={runLocationLabel(runHost, allowedHosts)}
                    sshHost={sshHost}
                    busy={phase === 'creating'}
                  />
                ))}
              </div>
              <ResolvedDocument
                yamlText={loaded.yamlText}
                values={railValues}
                renames={railRenames}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

function provisionErrorText(
  result: Exclude<Awaited<ReturnType<typeof rpc.agents.addAgent>>, { kind: 'created' }>
): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Sign in to this server first.';
    case 'name-conflict':
      return 'An agent with this name already exists in this directory or on the server.';
    case 'credentials-conflict':
      return `This directory already holds credentials for an agent of that name on ${result.endpoint}. Pick another directory.`;
    case 'already-configured':
      return 'This directory already holds credentials for an agent of that name. Load it instead.';
    case 'invalid-name':
      return result.message;
    default:
      return result.message;
  }
}

export const templateUseView = {
  WrapView: ({ children }: { children: React.ReactNode } & Params) => <>{children}</>,
  TitlebarSlot: TemplateUseTitlebar,
  MainPanel: TemplateUsePanel,
  canActivate: (params: unknown): GuardResult => {
    const p = params as Partial<Params> | null;
    if (typeof p?.serverId !== 'string') return { ok: false, redirect: 'home' };
    if (!p.templateId && !p.yamlText)
      return { ok: false, redirect: 'templates', params: { serverId: p.serverId } };
    return { ok: true };
  },
} satisfies ViewDefinition<Params>;
