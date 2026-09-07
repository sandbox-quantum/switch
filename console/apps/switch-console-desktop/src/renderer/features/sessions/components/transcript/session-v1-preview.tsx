import { SessionChatClient } from '@switch-console/shared/session-v1';
import type {
  ClientCommand,
  CommandStatus,
  ServerEvent,
  SessionTransport,
  Snapshot,
} from '@switch-console/shared/session-v1';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBoundary } from '@renderer/lib/components/error-boundary';
import { ThemeProvider } from '@renderer/lib/providers/theme-provider';
import { queryClient } from '@renderer/lib/query-client';
import { Button } from '@renderer/lib/ui/button';
import { SessionV1Chat } from './session-v1-chat';

/** Development-only transport. It never contacts Switch or a provider. */
class PreviewTransport implements SessionTransport {
  private sequence = 0;
  private readonly events: ServerEvent[] = [];
  private readonly receipts = new Map<string, CommandStatus>();
  private listener: ((event: unknown) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private online = true;

  async snapshot(): Promise<Snapshot> {
    if (!this.online) throw new Error('Mock connection is offline.');
    return {
      contractVersion: 1,
      throughSequence: 0,
      session: {
        sessionId: 'preview',
        agentId: 'preview-agent',
        provider: 'claude',
        hostId: 'preview-host',
        epoch: 'preview-epoch',
        status: 'ready',
        connectivity: 'online',
        capabilities: {
          input: 'queue',
          approvals: false,
          questions: false,
          interrupt: false,
          reset: false,
          compact: false,
          modelChange: false,
          attachmentMimeTypes: [],
        },
        pendingRequestIds: [],
      },
      turns: [],
      items: [],
      requests: [],
      commandStatuses: [],
      nextPageToken: null,
    };
  }
  subscribe(
    _sessionId: string,
    after: number,
    listener: (event: unknown) => void,
    onError: (error: Error) => void
  ): () => void {
    this.listener = listener;
    this.onError = onError;
    for (const event of this.events) if (event.sequence > after) listener(event);
    return () => {
      this.listener = null;
      this.onError = null;
    };
  }
  async commandStatus(_sessionId: string, commandId: string): Promise<CommandStatus> {
    const receipt = this.receipts.get(commandId);
    if (!receipt) throw new Error('Command not found.');
    return receipt;
  }
  async submit(command: ClientCommand): Promise<CommandStatus> {
    if (!this.online) throw new Error('Mock connection is offline.');
    const saved = this.receipts.get(command.commandId);
    if (saved) return saved;
    if (command.body.type !== 'message.send') throw new Error('Unsupported preview command.');
    const receipt: CommandStatus = {
      type: 'command.status',
      commandId: command.commandId,
      status: 'accepted',
      code: null,
      message: null,
    };
    this.receipts.set(command.commandId, receipt);
    const turnId = command.commandId;
    this.emit(receipt);
    this.emit({ type: 'turn.upsert', turnId, status: 'running', commandId: command.commandId });
    const base = {
      turnId,
      revision: 1,
      attachments: [],
      origin: null,
      audience: { kind: 'session-members' as const },
    };
    this.emit({
      type: 'item.upsert',
      item: {
        ...base,
        itemId: `${turnId}-user`,
        kind: 'user-message',
        status: 'completed',
        title: '',
        text: command.body.text,
        origin: {
          surface: 'console',
          actorId: 'preview-user',
          roomId: null,
          threadId: null,
          messageId: null,
        },
      },
    });
    this.emit({
      type: 'item.upsert',
      item: {
        ...base,
        itemId: `${turnId}-tool`,
        kind: 'tool-activity',
        status: 'in-progress',
        title: 'Inspect project files',
        text: '',
      },
    });
    const text =
      'This is a **mock session-v1 response**.\n\nChat and tool activity use complete item replacements. Reconnecting replays the saved events without duplicating this message.';
    let length = 0;
    let revision = 0;
    const timer = setInterval(() => {
      length = Math.min(length + 18, text.length);
      revision += 1;
      this.emit({
        type: 'item.upsert',
        item: {
          ...base,
          revision,
          itemId: `${turnId}-assistant`,
          kind: 'assistant-message',
          status: length === text.length ? 'completed' : 'in-progress',
          title: '',
          text: text.slice(0, length),
        },
      });
      if (length === text.length) {
        clearInterval(timer);
        this.emit({
          type: 'item.upsert',
          item: {
            ...base,
            revision: 2,
            itemId: `${turnId}-tool`,
            kind: 'tool-activity',
            status: 'completed',
            title: 'Inspect project files',
            text: 'Mock inspection complete.',
          },
        });
        this.emit({
          type: 'turn.upsert',
          turnId,
          status: 'completed',
          commandId: command.commandId,
        });
        const applied = { ...receipt, status: 'applied' as const };
        this.receipts.set(command.commandId, applied);
        this.emit(applied);
      }
    }, 250);
    return receipt;
  }
  toggle(): boolean {
    this.online = !this.online;
    if (!this.online) {
      this.onError?.(new Error('Mock connection lost. Draft and execution state are retained.'));
      this.listener = null;
    }
    return this.online;
  }
  private emit(body: ServerEvent['body']): void {
    const event: ServerEvent = {
      contractVersion: 1,
      eventId: crypto.randomUUID(),
      sessionId: 'preview',
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
      body,
    };
    this.events.push(event);
    this.listener?.(event);
  }
}

function PreviewContent() {
  const [transport] = useState(() => new PreviewTransport());
  const [client] = useState(() => new SessionChatClient('preview', transport));
  const [online, setOnline] = useState(true);
  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between bg-background-1 p-3 text-sm text-foreground">
        <span>Session-v1 preview · Mock transport · No agent runs</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const connected = transport.toggle();
            setOnline(connected);
            if (connected) void client.connect();
          }}
        >
          {online ? 'Disconnect mock' : 'Reconnect mock'}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <SessionV1Chat client={client} />
      </div>
    </div>
  );
}

export function SessionV1Preview() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <PreviewContent />
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
