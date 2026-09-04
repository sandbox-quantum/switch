import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  McpServerSpec,
  ModelSelection,
  ProviderRuntimeEvent,
  RuntimeMode,
  UserInputAnswers,
} from '@switch-console/agent-providers';
import { SWITCH_AGENT_RUNTIME_PIN } from '@switch-console/plugins/distribution';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { isAppFocused, maybeShowNotification } from '@main/core/agent-hooks/notification';
import { providerAdapterRegistry } from '@main/core/agent-runtime/impl/provider-adapter-registry';
import { toAgentEvent } from '@main/core/agent-runtime/impl/provider-agent-status';
import { ProviderTranscript } from '@main/core/agent-runtime/impl/provider-transcript';
import type { AgentRuntimeProvider, ProviderSessionRuntime } from '@main/core/agent-runtime/types';
import { agentCredsSlug } from '@main/core/agents/agent-creds-slug';
import { agentLaunchSpecialization } from '@main/core/agents/agent-launch-config';
import { getAgentById } from '@main/core/agents/getAgentById';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { buildAgentEnv } from '@main/core/pty/pty-env';
import { saveNativeSessionId } from '@main/core/sessions/operations/save-provider-session-id';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { providerRoomRelay } from '@main/core/switch-rooms/provider-room-relay';
import { readAgentSwitchEnvFromFs } from '@main/core/switch-rooms/switch-credentials';
import { switchNotificationPoller } from '@main/core/switch-rooms/switch-notification-poller';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { events } from '@main/lib/events';
import { runWithLogContext } from '@main/lib/log-context';
import { log } from '@main/lib/logger';
import { agentSessionExitedChannel } from '@shared/core/providers/agentEvents';
import { makePtyId } from '@shared/core/pty/ptyId';
import {
  sessionTranscriptChannel,
  type SessionTranscript,
  type TranscriptUpdate,
  type TranscriptUserSource,
} from '@shared/core/sessions/session-transcript';
import type { Session } from '@shared/core/sessions/sessions';

/**
 * A session driven through a `@switch-console/agent-providers` adapter instead
 * of a TUI in a PTY.
 *
 * **Local only for now.** The sidecar is a second implementation of session
 * spawning and injection for a remote host, and it does not host an adapter —
 * so `buildAgentRuntime` only reaches this on a local transport, and an agent
 * on an SSH host keeps its tmux pane whatever its toggle says. Giving the
 * sidecar the adapter is its own change; see "The Sidecar Mirrors Switch
 * Console" in `console/AGENTS.md`.
 *
 * What it owns, and why each is here rather than where a PTY session's
 * equivalent lives:
 *
 * - **The transcript.** There is no terminal to scrape, so the session's own
 *   record of itself is built from the provider's events and pushed to the
 *   renderer over `sessionTranscriptChannel`.
 * - **Status.** There are no hooks either: the provider's turn and request
 *   events are translated into the same `AgentEvent`s the hook server would
 *   have produced, so the sidebar badge, the attention sound and the room's
 *   "working on it…" are downstream of exactly what they were before.
 * - **The Switch connection.** Opened before the session starts, for the same
 *   reason a PTY session opens one: the id has to exist in the environment the
 *   MCP server is spawned with, and the server refuses a tool call naming a
 *   connection that is not open.
 */
export class ProviderAgentRuntime implements AgentRuntimeProvider, ProviderSessionRuntime {
  private readonly transcript: ProviderTranscript;
  private readonly listeners = new Set<(update: TranscriptUpdate) => void>();
  private unsubscribeAdapter: (() => void) | null = null;
  private started = false;
  /** True across a deliberate `stop`, so its exit is not reported as a death. */
  private stopping = false;
  private providerId = '';
  /** Set once the provider reports its own session id, for `resume` and the row. */
  private nativeSessionId: string | null = null;

  constructor(
    private readonly params: {
      locationId: string;
      sessionId: string;
      sessionPath: string;
      sessionEnvVars: Record<string, string>;
    }
  ) {
    this.transcript = new ProviderTranscript(params.sessionId);
  }

  async start(
    session: Session,
    _initialSize?: { cols: number; rows: number },
    _isResuming?: boolean,
    initialPrompt?: string
  ): Promise<void> {
    return runWithLogContext(
      {
        component: 'provider-agent-runtime',
        sessionId: this.params.sessionId,
        agentId: session.agentId,
        agentName: session.agentName ?? undefined,
      },
      () => this.startInternal(session, initialPrompt)
    );
  }

  private async startInternal(session: Session, initialPrompt?: string): Promise<void> {
    if (this.started) return;
    this.providerId = session.providerId;
    const adapter = providerAdapterRegistry.get(session.providerId);

    const agentRecord = await getAgentById(session.agentId);
    const autoApprove = agentRecord?.autoApprove ?? session.autoApprove ?? false;
    const runtimeMode: RuntimeMode = autoApprove ? 'full-access' : 'approval-required';

    // The identity the session speaks to Switch as. Same file, same precedence
    // as a PTY session: the agent's own `.switch/agents/<slug>.json`.
    const workspaceFs = createPluginFs(this.params.sessionPath);
    const identityVars = await readAgentSwitchEnvFromFs(workspaceFs, agentCredsSlug(session), log);

    // Before `startSession`, exactly as a PTY launch does it: the MCP server is
    // spawned by the provider as part of starting the session and stamps this
    // id on every tool call it makes.
    const connectionId = await switchNotificationPoller.ensureForSession({
      sessionId: this.params.sessionId,
      providerId: session.providerId,
      ptyId: makePtyId(session.providerId, this.params.sessionId),
    });

    const switchVars: Record<string, string> = {
      ...identityVars,
      ...(connectionId ? { SWITCH_CONNECTION_ID: connectionId } : {}),
      // Switch Console reads this session's room itself, over the connection it
      // just opened. The runtime's own poll loop would be a second reader of
      // the same queue, racing this one for every event.
      SWITCH_CHANNEL_DISABLE_POLL: '1',
    };

    const env: Record<string, string> = {
      // No hook: a provider session reports through its event stream, and a
      // `SWITCHDASH_HOOK_*` in its environment would invite the connector's
      // hooks to report a second, contradictory status for the same turn.
      ...buildAgentEnv({}),
      ...this.params.sessionEnvVars,
      ...switchVars,
    };

    const mcpServers: Record<string, McpServerSpec> = {
      switch: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', SWITCH_AGENT_RUNTIME_PIN],
        env: switchVars,
      },
    };

    this.unsubscribeAdapter = adapter.subscribe((event) => {
      if (event.sessionId !== this.params.sessionId) return;
      this.handleProviderEvent(event);
    });

    try {
      const model = await this.resolveModel(session.agentId);
      await adapter.startSession({
        sessionId: this.params.sessionId,
        cwd: this.params.sessionPath,
        runtimeMode,
        env,
        mcpServers,
        ...(session.providerSessionId
          ? { resume: { nativeSessionId: session.providerSessionId } }
          : {}),
        ...(model ? { model } : {}),
      });
    } catch (error) {
      this.unsubscribeAdapter?.();
      this.unsubscribeAdapter = null;
      this.publish(this.transcript.recordNotice('error', String(error)));
      throw error;
    }
    this.started = true;

    log.info('ProviderAgentRuntime: session started', {
      event: 'provider_session_started',
      sessionId: this.params.sessionId,
      providerId: session.providerId,
      runtimeMode,
      resumed: session.providerSessionId !== undefined,
    });

    // The opening prompt is a turn like any other here — there is no TUI to
    // pass it to on argv, and nothing to wait for before it can be typed.
    if (initialPrompt?.trim()) {
      await this.sendTurn(initialPrompt.trim(), 'system');
    }
  }

  /**
   * The per-agent model, as the adapter names one. OpenCode's launch profile
   * calls it `model` and its reasoning control `variant`; anything else the
   * profile carries is a config-file concern the adapter has no use for.
   */
  private async resolveModel(agentId: string): Promise<ModelSelection | undefined> {
    const specialization = await agentLaunchSpecialization(agentId);
    const id = specialization?.model?.trim();
    if (!id) return undefined;
    const variant = specialization?.variant?.trim();
    return { id, ...(variant ? { options: { variant } } : {}) };
  }

  private handleProviderEvent(event: ProviderRuntimeEvent): void {
    this.publish(this.transcript.apply(event));

    if (event.type === 'session.started') {
      this.nativeSessionId = event.nativeSessionId;
      void saveNativeSessionId(this.params.sessionId, event.nativeSessionId).catch((error) => {
        log.warn('ProviderAgentRuntime: failed to persist the native session id', {
          sessionId: this.params.sessionId,
          error: String(error),
        });
      });
    }

    if (event.type === 'request.opened' || event.type === 'user-input.requested') {
      providerRoomRelay.onRequestOpened(this.params.sessionId, event);
    }
    if (event.type === 'request.resolved' || event.type === 'user-input.resolved') {
      providerRoomRelay.onRequestResolved(this.params.sessionId, event.requestId);
    }

    const agentEvent = toAgentEvent(event, {
      sessionId: this.params.sessionId,
      providerId: this.providerId,
    });
    if (agentEvent) {
      const appFocused = isAppFocused();
      void maybeShowNotification(agentEvent, appFocused);
      agentHookService.emitAgentEvent(agentEvent, appFocused);
    }

    if (event.type === 'session.exited') {
      this.started = false;
      // A stop we asked for is not an exit anyone needs telling about: the
      // consumers of these two exist to notice a session dying under them, and
      // firing them here would report every deliberate teardown as a failure.
      if (this.stopping) {
        log.info('ProviderAgentRuntime: the provider session stopped', {
          event: 'provider_session_stopped',
          sessionId: this.params.sessionId,
          reason: event.reason,
        });
        return;
      }
      log.warn('ProviderAgentRuntime: the provider session ended', {
        event: 'provider_session_exited',
        sessionId: this.params.sessionId,
        reason: event.reason,
      });
      events.emit(agentSessionExitedChannel, { sessionId: this.params.sessionId });
      // In-process counterpart for main-process consumers — `events` only
      // reaches the renderer (see session-hooks).
      sessionHooks._emit('session:agent-exited', {
        sessionId: this.params.sessionId,
        decision: 'failed',
      });
    }
  }

  async sendTurn(text: string, source: TranscriptUserSource): Promise<{ turnId: string }> {
    const adapter = providerAdapterRegistry.get(this.providerId);
    const turnId = randomUUID();
    const result = await adapter.sendTurn({ sessionId: this.params.sessionId, turnId, text });
    // A steered message joins the turn already running, so the transcript has
    // to file it under that turn rather than the id we minted for it.
    const effectiveTurnId = result.steeredInto ?? result.turnId;
    this.publish(this.transcript.recordUserTurn({ turnId: effectiveTurnId, text, source }));
    return { turnId: effectiveTurnId };
  }

  async interrupt(): Promise<void> {
    await providerAdapterRegistry.get(this.providerId).interruptTurn(this.params.sessionId);
  }

  async respondToRequest(requestId: string, decision: ApprovalDecision): Promise<void> {
    await providerAdapterRegistry
      .get(this.providerId)
      .respondToRequest(this.params.sessionId, requestId, decision);
  }

  async respondToUserInput(requestId: string, answers: UserInputAnswers): Promise<void> {
    await providerAdapterRegistry
      .get(this.providerId)
      .respondToUserInput(this.params.sessionId, requestId, answers);
    this.publish(this.transcript.noteAnswers(requestId, answers));
  }

  /** Say something in the transcript that the provider did not say. */
  notice(level: 'info' | 'warning' | 'error', text: string): void {
    this.publish(this.transcript.recordNotice(level, text));
  }

  getTranscript(): SessionTranscript {
    return this.transcript.snapshot();
  }

  subscribe(listener: (update: TranscriptUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(updates: TranscriptUpdate[]): void {
    for (const update of updates) {
      events.emit(sessionTranscriptChannel, { sessionId: this.params.sessionId, update });
      for (const listener of [...this.listeners]) {
        try {
          listener(update);
        } catch (error) {
          log.warn('ProviderAgentRuntime: a transcript listener threw', {
            sessionId: this.params.sessionId,
            error: String(error),
          });
        }
      }
    }
  }

  /** The provider's own id for this session, once it has reported one. */
  get nativeSession(): string | null {
    return this.nativeSessionId;
  }

  /**
   * Both no-ops: there is no terminal to close and nothing to re-attach to. The
   * provider session keeps running, which is what a user closing a session view
   * expects.
   */
  async dehydrate(): Promise<void> {}

  async detach(): Promise<void> {}

  async stop(): Promise<void> {
    switchNotificationPoller.disconnect(this.params.sessionId);
    switchRoomService.clearSession(this.params.sessionId);
    providerRoomRelay.unbind(this.params.sessionId);
    // The subscription outlives the stop deliberately: `stopSession` is what
    // emits the session's own `stopped` state and its exit, and dropping the
    // listener first would leave the transcript claiming the session is still
    // ready long after it is gone.
    try {
      const adapter = this.providerId ? providerAdapterRegistry.get(this.providerId) : null;
      if (this.started && adapter?.hasSession(this.params.sessionId)) {
        this.stopping = true;
        await adapter.stopSession(this.params.sessionId);
      }
    } finally {
      this.stopping = false;
      this.started = false;
      this.unsubscribeAdapter?.();
      this.unsubscribeAdapter = null;
    }
  }

  async destroy(): Promise<void> {
    await this.stop();
    this.listeners.clear();
  }
}
